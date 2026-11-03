package main

import (
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"strings"
)

const (
	oracleCompilationErrorCode = 24344
	oracleCompilationErrorMax  = 20
	oracleIdentifierPattern    = `("[^"]+"|[^\s."();,]+)`
	oracleQualifiedNamePattern = oracleIdentifierPattern + `(?:\s*\.\s*` + oracleIdentifierPattern + `)?`
)

var (
	oracleCreateCompiledObjectPattern = regexp.MustCompile(`(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NO\s*)?FORCE\s+)?(?:EDITIONING\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:EDITIONING\s+)?` +
		`(PROCEDURE|FUNCTION|PACKAGE\s+BODY|PACKAGE|TRIGGER|TYPE\s+BODY|TYPE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?` + oracleQualifiedNamePattern)
	oracleAlterCompileObjectPattern = regexp.MustCompile(`(?is)^\s*ALTER\s+(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|VIEW)\s+(?:IF\s+EXISTS\s+)?` + oracleQualifiedNamePattern +
		`\s+COMPILE(?:\s+DEBUG)?(?:\s+(BODY|SPECIFICATION|PACKAGE)\b)?`)
)

// oracleCompiledObject is the catalog identity of the object a DDL statement
// compiles. An empty owner means the session's current schema.
type oracleCompiledObject struct {
	owner  string
	name   string
	types  []string
	action string
}

// oracleCompilationError reports a stored object that Oracle kept in an INVALID
// state. The server treats this as success with information, so neither driver
// returns it as an error and it has to be read back from the catalog.
type oracleCompilationError struct {
	message string
}

func (e oracleCompilationError) Error() string { return e.message }

// Code feeds the structured error contract the same way a driver error does.
func (e oracleCompilationError) Code() int { return oracleCompilationErrorCode }

func oracleCatalogIdentifier(identifier string) string {
	if strings.HasPrefix(identifier, `"`) {
		return strings.Trim(identifier, `"`)
	}
	return strings.ToUpper(identifier)
}

func parseOracleCompiledObject(sqlText string) (oracleCompiledObject, bool) {
	statement := stripStatementSQLComments(sqlText)
	if match := oracleCreateCompiledObjectPattern.FindStringSubmatch(statement); match != nil {
		object := oracleCompiledObject{action: "created", types: []string{strings.ToUpper(strings.Join(strings.Fields(match[1]), " "))}}
		object.owner, object.name = oracleQualifiedCatalogName(match[2], match[3])
		return object, true
	}
	match := oracleAlterCompileObjectPattern.FindStringSubmatch(statement)
	if match == nil {
		return oracleCompiledObject{}, false
	}
	object := oracleCompiledObject{action: "compiled", types: []string{strings.ToUpper(match[1])}}
	object.owner, object.name = oracleQualifiedCatalogName(match[2], match[3])
	if object.types[0] == "PACKAGE" || object.types[0] == "TYPE" {
		body := object.types[0] + " BODY"
		switch strings.ToUpper(match[4]) {
		case "BODY":
			object.types = []string{body}
		case "SPECIFICATION":
		default:
			object.types = append(object.types, body)
		}
	}
	return object, true
}

func oracleQualifiedCatalogName(first, second string) (owner, name string) {
	if second == "" {
		return "", oracleCatalogIdentifier(first)
	}
	return oracleCatalogIdentifier(first), oracleCatalogIdentifier(second)
}

func oracleCompilationErrorsSQL(object oracleCompiledObject) (string, []any) {
	args := []any{object.name}
	owner := "SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')"
	if object.owner != "" {
		args = append(args, object.owner)
		owner = ":2"
	}
	placeholders := make([]string, len(object.types))
	for index, objectType := range object.types {
		args = append(args, objectType)
		placeholders[index] = fmt.Sprintf(":%d", len(args))
	}
	return "SELECT OWNER, NAME, TYPE, LINE, POSITION, TEXT FROM ALL_ERRORS WHERE NAME = :1 AND OWNER = " + owner +
		" AND TYPE IN (" + strings.Join(placeholders, ", ") + ") AND ATTRIBUTE = 'ERROR' ORDER BY TYPE, SEQUENCE", args
}

// compilationErrorForStatement must run on the session that executed the
// statement, because an unqualified name resolves through its current schema.
// A failed catalog read keeps the statement's own successful outcome.
func (s *server) compilationErrorForStatement(sqlText string) error {
	object, ok := parseOracleCompiledObject(sqlText)
	if !ok {
		return nil
	}
	query, args := oracleCompilationErrorsSQL(object)
	rows, err := s.queryRows(query, args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[oracle] compilation error readback failed: %v\n", err)
		return nil
	}
	defer rows.Close()
	return readOracleCompilationError(rows, object)
}

func readOracleCompilationError(rows *sql.Rows, object oracleCompiledObject) error {
	var heading string
	var lines []string
	omitted := false
	for rows.Next() {
		if len(lines) == oracleCompilationErrorMax {
			omitted = true
			break
		}
		var owner, name, objectType, text sql.NullString
		var line, position sql.NullInt64
		if err := rows.Scan(&owner, &name, &objectType, &line, &position, &text); err != nil {
			fmt.Fprintf(os.Stderr, "[oracle] compilation error readback failed: %v\n", err)
			return nil
		}
		if heading == "" {
			heading = fmt.Sprintf("ORA-%05d: %s %s.%s was %s with compilation errors:", oracleCompilationErrorCode, objectType.String, owner.String, name.String, object.action)
		}
		lines = append(lines, fmt.Sprintf("Line %d, column %d: %s", line.Int64, position.Int64, strings.TrimSpace(text.String)))
	}
	if heading == "" {
		return nil
	}
	if omitted {
		lines = append(lines, "More errors are listed in ALL_ERRORS.")
	}
	return oracleCompilationError{message: heading + "\n" + strings.Join(lines, "\n")}
}
