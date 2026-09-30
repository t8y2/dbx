package faultproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode"
)

type statement struct {
	command, hash string
	rollbackTo    bool
}

func supportedCommand(s string) bool {
	switch s {
	case "SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "SET", "SHOW", "CREATE", "ALTER", "DROP", "TRUNCATE":
		return true
	}
	return false
}
func validHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// classify is deliberately a conservative boundary lexer, not a SQL parser.
// PostgreSQL remains responsible for syntax. Quotes/comments are scanned only
// to reject multiple statements and unsupported top-level commands before send.
func classify(sql string) (statement, error) {
	fail := func() (statement, error) {
		return statement{}, errors.New("unsupported SQL: one ordinary statement per cycle; COPY, CALL, DO, SQL PREPARE/EXECUTE, 2PC and replication are disabled")
	}
	if len(sql) > 1<<20 {
		return fail()
	}
	var words []string
	ended := false
	for i := 0; i < len(sql); {
		c := sql[i]
		if unicode.IsSpace(rune(c)) {
			i++
			continue
		}
		if i+1 < len(sql) && sql[i:i+2] == "--" {
			i += 2
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			continue
		}
		if i+1 < len(sql) && sql[i:i+2] == "/*" {
			i += 2
			depth := 1
			for i < len(sql) && depth > 0 {
				if i+1 < len(sql) && sql[i:i+2] == "/*" {
					depth++
					i += 2
				} else if i+1 < len(sql) && sql[i:i+2] == "*/" {
					depth--
					i += 2
				} else {
					i++
				}
			}
			if depth != 0 {
				return fail()
			}
			continue
		}
		if ended {
			return fail()
		}
		if c == ';' {
			ended = true
			i++
			continue
		}
		if c == '\'' || c == '"' {
			quote := c
			i++
			closed := false
			for i < len(sql) {
				if sql[i] == '\\' { // Reject escape strings conservatively: no lexer/parser disagreement.
					return fail()
				}
				if sql[i] == quote {
					if i+1 < len(sql) && sql[i+1] == quote {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if !closed {
				return fail()
			}
			continue
		}
		if c == '$' {
			j := i + 1
			for j < len(sql) && (sql[j] == '_' || sql[j] >= 'a' && sql[j] <= 'z' || sql[j] >= 'A' && sql[j] <= 'Z' || sql[j] >= '0' && sql[j] <= '9') {
				j++
			}
			if j < len(sql) && sql[j] == '$' {
				tag := sql[i : j+1]
				end := strings.Index(sql[j+1:], tag)
				if end < 0 {
					return fail()
				}
				i = j + 1 + end + len(tag)
				continue
			}
		}
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_' {
			j := i + 1
			for j < len(sql) && (sql[j] == '_' || sql[j] >= 'a' && sql[j] <= 'z' || sql[j] >= 'A' && sql[j] <= 'Z' || sql[j] >= '0' && sql[j] <= '9') {
				j++
			}
			if len(words) < 4 {
				words = append(words, strings.ToUpper(sql[i:j]))
			}
			i = j
			continue
		}
		i++
	}
	if len(words) == 0 {
		h := sha256.Sum256([]byte(sql))
		return statement{command: "EMPTY", hash: hex.EncodeToString(h[:])}, nil
	}
	if !supportedCommand(words[0]) {
		return fail()
	}
	cmd := words[0]
	if (cmd == "COMMIT" || cmd == "ROLLBACK") && len(words) > 1 && words[1] == "PREPARED" {
		return fail()
	}
	if cmd == "START" && (len(words) < 2 || words[1] != "TRANSACTION") {
		return fail()
	}
	if cmd == "SET" && strings.Contains(strings.ToUpper(sql), "STANDARD_CONFORMING_STRINGS") {
		return fail()
	}
	if (cmd == "CREATE" || cmd == "DROP" || cmd == "ALTER") && len(words) > 1 && (words[1] == "DATABASE" || words[1] == "TABLESPACE" || words[1] == "SYSTEM") {
		return fail()
	}
	h := sha256.Sum256([]byte(sql))
	rollbackTo := cmd == "ROLLBACK" && (len(words) > 1 && words[1] == "TO" || len(words) > 2 && words[2] == "TO")
	return statement{command: cmd, hash: hex.EncodeToString(h[:]), rollbackTo: rollbackTo}, nil
}
func (q statement) commit() bool { return q.command == "COMMIT" || q.command == "END" }
