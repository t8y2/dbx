package main

import (
	"regexp"
	"strings"
)

// sqlPlusExecuteRegexp matches the SQL*Plus EXECUTE command: EXEC or EXECUTE
// followed by whitespace and a PL/SQL statement.
var sqlPlusExecuteRegexp = regexp.MustCompile(`(?is)^exec(?:ute)?\s+(.+)$`)

// rewriteSQLPlusExecute turns the SQL*Plus client command
//
//	EXEC[UTE] statement
//
// into the anonymous block the command is defined as: `BEGIN statement; END;`.
// EXEC is not SQL, so the server rejects it with ORA-00900, yet it is how most
// Oracle users run a stored procedure (SQL*Plus, SQL Developer and PL/SQL
// Developer all accept it; the trailing semicolon is optional there as well).
//
// EXECUTE IMMEDIATE is a PL/SQL statement, not this command, and stays untouched
// so the server keeps reporting what it always did for it. The terminator sits on
// its own line so a trailing line comment in the call cannot swallow it.
func rewriteSQLPlusExecute(sqlText string) (string, bool) {
	start := trimLeadingSQLComments(sqlText)
	matches := sqlPlusExecuteRegexp.FindStringSubmatch(start)
	if matches == nil {
		return "", false
	}
	body := strings.TrimSpace(matches[1])
	body = strings.TrimSpace(strings.TrimSuffix(body, ";"))
	if body == "" || startsWithSQLKeyword(body, "immediate") {
		return "", false
	}
	return "BEGIN\n  " + body + "\n;\nEND;", true
}
