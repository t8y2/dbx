package main

import (
 "context"
 "encoding/json"
 "errors"
 "regexp"
 "strconv"
 "strings"
 "time"
)

// No driver error, panic value or generated SQL may escape this RPC boundary.
func (s *server) createDatabaseLinkSecure(params map[string]json.RawMessage) (result map[string]any) {
 result = map[string]any{"ok": false, "errorCode": "DBLINK_CREATE_FAILED"}
 defer func() { if recover() != nil { result = map[string]any{"ok": false, "errorCode": "DBLINK_OUTCOME_UNKNOWN"} } }()
 sqlText, err := oracleDatabaseLinkSQL(params)
 if err != nil { return map[string]any{"ok": false, "errorCode": "DBLINK_INVALID_CONFIGURATION"} }
 if s.hasManualTransaction() { return map[string]any{"ok": false, "errorCode": "DBLINK_MANUAL_TRANSACTION_UNSUPPORTED"} }
 ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
 defer cancel()
 // One driver call, no retry or generic query error formatting.
 if _, err := s.execContext(ctx, sqlText); err != nil {
  result["errorCode"] = "DBLINK_OUTCOME_UNKNOWN"
  // Extract only the numeric Oracle code inside the sensitive boundary.
  code := regexp.MustCompile(`ORA-([0-9]{5})`).FindStringSubmatch(err.Error())
  if len(code) == 2 {
   number, _ := strconv.Atoi(code[1])
   result["vendorCode"] = number
   if number != 1013 && number != 3113 && number != 3114 && number < 12000 { result["errorCode"] = "DBLINK_CREATE_FAILED" }
  }
  return result
 }
 return map[string]any{"ok": true}
}

func oracleDatabaseLinkSQL(params map[string]json.RawMessage) (string, error) {
 name, scope := stringParam(params, "name"), stringParam(params, "scope")
 username, password, host := stringParam(params, "username"), stringParam(params, "password"), stringParam(params, "host")
 invalid := errors.New("DBLINK_INVALID_CONFIGURATION")
 if !regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_$#]*(\.[A-Za-z0-9_$#]+)*$`).MatchString(name) || len(name) > 128 ||
  (scope != "private" && scope != "public") || username == "" || password == "" || strings.TrimSpace(host) == "" ||
  strings.ContainsAny(username+password+host, "\x00\r\n") || strings.Contains(password, `"`) {
  return "", invalid
 }
 if stringParam(params, "authentication") != "fixedUser" { return "", invalid }
 prefix := "CREATE "
 if scope == "public" { prefix += "PUBLIC " }
 return prefix + "DATABASE LINK " + name + " CONNECT TO " + quoteIdentifier(username) + " IDENTIFIED BY \"" + password + "\" USING '" + strings.ReplaceAll(host, "'", "''") + "'", nil
}
