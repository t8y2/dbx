package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/converters"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
)

const oracleLegacyCharsetOption = "DBX_LEGACY_CHARSET"

// Some old US7ASCII databases contain unconverted GBK/UTF-8 bytes. This is an
// explicit interpretation of those bytes, not an Oracle client character set:
// advertising GBK to the server would request the very conversion we must avoid.
// National character data keeps its separately negotiated Unicode converter.
type oracleLegacyCharset struct {
	name     string
	encoding encoding.Encoding // nil means UTF-8
}

func oracleLegacyOptions(params connectParams) (connectParams, *oracleLegacyCharset, error) {
	original := params
	var selected string
	var hasLegacyOption bool
	var hasClientCharset bool
	strip := func(raw string) (string, error) {
		values, err := url.ParseQuery(strings.TrimPrefix(raw, "?"))
		if err != nil {
			return "", errors.New("invalid Oracle URL parameters")
		}
		for key, entries := range values {
			switch strings.ToUpper(strings.TrimSpace(key)) {
			case oracleLegacyCharsetOption:
				hasLegacyOption = true
				for _, value := range entries {
					value = strings.ToUpper(strings.TrimSpace(value))
					if selected != "" && value != selected {
						return "", errors.New("conflicting DBX_LEGACY_CHARSET values")
					}
					selected = value
				}
				delete(values, key)
			case "CHARSET", "CLIENT CHARSET":
				hasClientCharset = true
			}
		}
		return values.Encode(), nil
	}
	var err error
	params.URLParams, err = strip(params.URLParams)
	if err != nil {
		return params, nil, err
	}
	if index := strings.IndexByte(params.ConnectionString, '?'); index >= 0 {
		query, err := strip(params.ConnectionString[index+1:])
		if err != nil {
			return params, nil, err
		}
		params.ConnectionString = params.ConnectionString[:index]
		if query != "" {
			params.ConnectionString += "?" + query
		}
	}
	if !hasLegacyOption {
		return original, nil, nil
	}
	if selected == "" {
		return params, nil, nil
	}
	if usesOCIProfile(params) {
		return params, nil, errors.New("DBX_LEGACY_CHARSET requires the Oracle Thin driver; select Thin for legacy US7ASCII data")
	}
	if hasClientCharset {
		return params, nil, errors.New("DBX_LEGACY_CHARSET cannot be combined with CHARSET or CLIENT CHARSET")
	}
	codec := &oracleLegacyCharset{name: selected}
	switch selected {
	case "ZHS16GBK":
		codec.encoding = simplifiedchinese.GBK
	case "ZHS32GB18030":
		codec.encoding = simplifiedchinese.GB18030
	case "ZHT16MSWIN950":
		codec.encoding = traditionalchinese.Big5
	case "AL32UTF8":
	default:
		return params, nil, errors.New("DBX_LEGACY_CHARSET must be ZHS16GBK, ZHS32GB18030, ZHT16MSWIN950 or AL32UTF8")
	}
	return params, codec, nil
}

func (c oracleLegacyCharset) Encode(value string) []byte {
	if c.encoding == nil {
		return []byte(value)
	}
	// User SQL/binds are validated before execution. The converter interface has
	// no error return; never fall back to writing UTF-8 into a GBK byte stream.
	encoded, _ := c.encoding.NewEncoder().Bytes([]byte(value))
	return encoded
}
func (c oracleLegacyCharset) Decode(value []byte) string {
	if c.encoding == nil {
		return string(value)
	}
	decoded, _ := c.encoding.NewDecoder().Bytes(value)
	return string(decoded)
}
func (c oracleLegacyCharset) GetLangID() int                     { return 1 } // US7ASCII: no server conversion
func (c oracleLegacyCharset) Clone() converters.IStringConverter { return c }

func (c oracleLegacyCharset) validate(value string) error {
	if !utf8.ValidString(value) {
		return errors.New("Oracle text is not valid UTF-8")
	}
	if c.encoding != nil {
		if _, err := c.encoding.NewEncoder().Bytes([]byte(value)); err != nil {
			return fmt.Errorf("Oracle text cannot be represented in legacy %s: %w", c.name, err)
		}
	}
	return nil
}

func (c oracleLegacyCharset) validateValue(value any) error {
	switch v := value.(type) {
	case string:
		return c.validate(v)
	case *string:
		if v != nil {
			return c.validate(*v)
		}
	case sql.NullString:
		if v.Valid {
			return c.validate(v.String)
		}
	case *sql.NullString:
		if v != nil {
			return c.validateValue(*v)
		}
	case go_ora.Clob:
		if v.Valid {
			return c.validate(v.String)
		}
	case *go_ora.Clob:
		if v != nil {
			return c.validateValue(*v)
		}
	case *[]string:
		if v != nil {
			return c.validateValue(*v)
		}
	case sql.Out:
		if v.In {
			return c.validateValue(v.Dest)
		}
	case go_ora.Out:
		if v.In {
			return c.validateValue(v.Dest)
		}
	case []string:
		for _, item := range v {
			if err := c.validate(item); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range v {
			if err := c.validateValue(item); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c oracleLegacyCharset) validateArgs(args []driver.NamedValue) error {
	for _, arg := range args {
		if err := c.validateValue(arg.Value); err != nil {
			return err
		}
	}
	return nil
}

func newOracleThinConnector(params connectParams, fallback converters.IStringConverter) (driver.Connector, error) {
	cleaned, legacy, err := oracleLegacyOptions(params)
	if err != nil {
		return nil, err
	}
	dsn, err := buildDSNForConnect(cleaned)
	if err != nil {
		return nil, err
	}
	connector := go_ora.NewConnector(dsn)
	if legacy != nil {
		go_ora.SetStringConverter(connector, *legacy, nil)
		connector = oracleLegacyConnector{Connector: connector, codec: *legacy}
	} else if fallback != nil {
		go_ora.SetStringConverter(connector, fallback, nil)
	}
	return oracleQueryConnector{connector}, nil
}

type oracleLegacyConnector struct {
	driver.Connector
	codec oracleLegacyCharset
}

func (c oracleLegacyConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	thin, ok := conn.(oracleThinConnection)
	if !ok {
		_ = conn.Close()
		return nil, errors.New("Oracle legacy connection requires context interfaces")
	}
	rows, err := thin.QueryContext(ctx, "SELECT VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER = 'NLS_CHARACTERSET'", nil)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	values := make([]driver.Value, 1)
	err = rows.Next(values)
	closeErr := rows.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil && values[0] != "US7ASCII" {
		err = errors.New("DBX_LEGACY_CHARSET is only supported for US7ASCII databases; disable legacy encoding for this connection")
	}
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &oracleLegacyConnection{oracleThinConnection: thin, codec: c.codec}, nil
}

type oracleLegacyConnection struct {
	oracleThinConnection
	codec oracleLegacyCharset
}

func (c *oracleLegacyConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if err := c.codec.validate(query); err != nil {
		return nil, err
	}
	if err := c.codec.validateArgs(args); err != nil {
		return nil, err
	}
	return c.oracleThinConnection.QueryContext(ctx, query, args)
}
func (c *oracleLegacyConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if err := c.codec.validate(query); err != nil {
		return nil, err
	}
	if err := c.codec.validateArgs(args); err != nil {
		return nil, err
	}
	return c.oracleThinConnection.ExecContext(ctx, query, args)
}
func (c *oracleLegacyConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if err := c.codec.validate(query); err != nil {
		return nil, err
	}
	stmt, err := c.oracleThinConnection.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return &oracleLegacyStatement{Stmt: stmt, codec: c.codec}, nil
}
func (c *oracleLegacyConnection) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

type oracleLegacyStatement struct {
	driver.Stmt
	codec oracleLegacyCharset
}

func (s *oracleLegacyStatement) CheckNamedValue(value *driver.NamedValue) error {
	if checker, ok := s.Stmt.(driver.NamedValueChecker); ok {
		return checker.CheckNamedValue(value)
	}
	return driver.ErrSkip
}
func (s *oracleLegacyStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	if err := s.codec.validateArgs(args); err != nil {
		return nil, err
	}
	return s.Stmt.(driver.StmtExecContext).ExecContext(ctx, args)
}
func (s *oracleLegacyStatement) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	if err := s.codec.validateArgs(args); err != nil {
		return nil, err
	}
	return s.Stmt.(driver.StmtQueryContext).QueryContext(ctx, args)
}
