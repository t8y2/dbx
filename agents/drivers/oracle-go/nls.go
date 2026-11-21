package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// The agent normalizes NLS_LANGUAGE to AMERICAN so its own metadata and error
// handling stay deterministic. That also forces English month names on user
// statements, so a Chinese PL/SQL Developer export ('13-11月-26 上午') fails
// with ORA-01843. Keep the AMERICAN normalization and override only the date
// language, which is what implicit date/timestamp parsing consults. It also
// changes TO_CHAR month names in query results, matching what PL/SQL Developer
// and DataGrip return on the same client; NLS_LANG pins English month names.
const oracleSessionNLSLanguage = "AMERICAN"

// applyOracleSessionNLS initializes one physical Oracle session. exec runs a
// single statement on that same session; callers adapt *sql.Conn or
// driver.ExecerContext to it.
//
// dateLanguage is the explicit NLS_LANG language (empty when unset) and
// fallbackDateLanguage the OS locale one, tried when the server rejects the
// explicit value (a mistyped or unsupported language name).
//
// NLS_LANGUAGE also resets NLS_DATE_LANGUAGE, so the statements keep this
// order.
func applyOracleSessionNLS(exec func(query string) error, dateLanguage, fallbackDateLanguage string) error {
	if err := exec("ALTER SESSION SET NLS_LANGUAGE='" + oracleSessionNLSLanguage + "'"); err != nil {
		return fmt.Errorf("set Oracle session NLS language: %w", err)
	}
	if dateLanguage == "" {
		dateLanguage, fallbackDateLanguage = fallbackDateLanguage, ""
	}
	if dateLanguage == "" || dateLanguage == oracleSessionNLSLanguage {
		return nil
	}
	languages := []string{dateLanguage}
	if fallbackDateLanguage != "" && fallbackDateLanguage != dateLanguage {
		languages = append(languages, fallbackDateLanguage)
	}
	for _, language := range languages {
		err := exec("ALTER SESSION SET NLS_DATE_LANGUAGE='" + language + "'")
		if err == nil {
			return nil
		}
		// A driver or transport failure leaves the session unusable; only a
		// server rejection means "this language was refused, keep AMERICAN".
		// Returning a broken session to the pool would let the next statement
		// read its leftover response bytes (see oracleProtocolDecodeError).
		if !isOracleServerRejection(err) {
			return fmt.Errorf("set Oracle session date language: %w", err)
		}
		fmt.Fprintf(os.Stderr, "oracle-go: NLS_DATE_LANGUAGE %q was not applied: %v\n", language, err)
	}
	return nil
}

func isOracleServerRejection(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "ORA-")
}

// closeOracleSessionConn closes a connection while a failed handshake may have
// left the driver in a state where Close itself panics.
func closeOracleSessionConn(conn driver.Conn) {
	if conn == nil {
		return
	}
	defer func() { _ = recover() }()
	_ = conn.Close()
}

// oracleNLSConnector initializes every physical thin connection. Running the
// ALTERs once against the pool would miss connections opened for concurrent
// work and replacements after SetConnMaxLifetime.
type oracleNLSConnector struct {
	driver.Connector
	dateLanguage         string
	fallbackDateLanguage string
}

func newOracleNLSConnector(connector driver.Connector) oracleNLSConnector {
	dateLanguage, fallbackDateLanguage := sessionNLSDateLanguages()
	return oracleNLSConnector{
		Connector:            connector,
		dateLanguage:         dateLanguage,
		fallbackDateLanguage: fallbackDateLanguage,
	}
}

func (c oracleNLSConnector) Connect(ctx context.Context) (conn driver.Conn, err error) {
	// database/sql also calls Connect from its connection opener goroutine,
	// where a driver panic has no recover and would kill the agent process.
	defer func() {
		if recovered := recover(); recovered != nil {
			closeOracleSessionConn(conn)
			conn, err = nil, fmt.Errorf("initialize Oracle session: %v", recovered)
		}
	}()
	conn, err = c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	execer, ok := conn.(driver.ExecerContext)
	if !ok {
		closeOracleSessionConn(conn)
		return nil, errors.New("Oracle thin connection does not support session initialization")
	}
	if err := applyOracleSessionNLS(func(query string) error {
		_, err := execer.ExecContext(ctx, query, nil)
		return err
	}, c.dateLanguage, c.fallbackDateLanguage); err != nil {
		closeOracleSessionConn(conn)
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		closeOracleSessionConn(conn)
		return nil, err
	}
	return conn, nil
}

// V$NLS_VALID_VALUES lists every NLS_LANGUAGE as ASCII letters and spaces.
var oracleNLSDateLanguagePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z ]{0,39}$`)

// sessionNLSDateLanguages returns the NLS_LANG language (empty when unset) and
// the OS-locale language used as its fallback.
func sessionNLSDateLanguages() (string, string) {
	return oracleNLSDateLanguageFromNLS(os.Getenv("NLS_LANG")), oracleNLSDateLanguageFromLocale(systemLocaleName())
}

func oracleNLSDateLanguageFromNLS(nlsLang string) string {
	language := strings.TrimSpace(nlsLang)
	if index := strings.Index(language, "."); index >= 0 {
		language = language[:index]
	}
	if index := strings.LastIndex(language, "_"); index > 0 {
		language = language[:index]
	}
	language = strings.ToUpper(strings.TrimSpace(language))
	if language == "CHINESE" {
		// Not an NLS_LANGUAGE value, but a common way to write NLS_LANG.
		return "SIMPLIFIED CHINESE"
	}
	if !oracleNLSDateLanguagePattern.MatchString(language) {
		// Empty, or anything that could escape the SQL literal below. Valid
		// names pass through because the server's vocabulary is the
		// whitelist; a local copy would only lag behind it.
		return ""
	}
	return language
}

var oracleNLSDateLanguageByLocale = map[string]string{
	"en": "AMERICAN",
	"ja": "JAPANESE",
	"ko": "KOREAN",
	"de": "GERMAN",
	"fr": "FRENCH",
	"es": "SPANISH",
	"it": "ITALIAN",
	"pt": "PORTUGUESE",
	"ru": "RUSSIAN",
}

func oracleNLSDateLanguageFromLocale(locale string) string {
	normalized := strings.ToLower(strings.TrimSpace(locale))
	if index := strings.IndexAny(normalized, ".@"); index >= 0 {
		normalized = normalized[:index]
	}
	parts := strings.FieldsFunc(normalized, func(r rune) bool { return r == '-' || r == '_' })
	if len(parts) == 0 {
		return ""
	}
	if parts[0] == "zh" {
		for _, part := range parts[1:] {
			switch part {
			case "tw", "hk", "mo", "hant":
				return "TRADITIONAL CHINESE"
			}
		}
		return "SIMPLIFIED CHINESE"
	}
	return oracleNLSDateLanguageByLocale[parts[0]]
}
