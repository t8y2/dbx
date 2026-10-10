package main

import (
    "encoding/json"
    "strings"
    "testing"
)

func databaseLinkParams(values map[string]string) map[string]json.RawMessage {
    result := map[string]json.RawMessage{}
    for key, value := range values { encoded, _ := json.Marshal(value); result[key] = encoded }
    return result
}

func TestDatabaseLinkSecureConfiguration(t *testing.T) {
    values := map[string]string{"name":"REMOTE.EXAMPLE", "scope":"public", "authentication":"fixedUser", "username":"REMOTEUSER", "password":"marker-secret", "host":"service'alias"}
    sql, err := oracleDatabaseLinkSQL(databaseLinkParams(values))
    if err != nil || !strings.HasPrefix(sql, "CREATE PUBLIC DATABASE LINK REMOTE.EXAMPLE ") || !strings.Contains(sql, "service''alias") { t.Fatal("public link configuration was not encoded") }
    for _, invalid := range []map[string]string{{"name":"REMOTE; DROP TABLE X"}, {"scope":"tenant"}, {"authentication":"currentUser"}, {"password":""}, {"password":"unsafe\"password"}} {
        candidate := map[string]string{}
        for key, value := range values { candidate[key] = value }
        for key, value := range invalid { candidate[key] = value }
        if _, err := oracleDatabaseLinkSQL(databaseLinkParams(candidate)); err == nil { t.Fatal("unsafe configuration accepted") }
    }
}

func TestDatabaseLinkFailureReturnsOnlySafeClassification(t *testing.T) {
    s := &server{}
    result := s.createDatabaseLinkSecure(databaseLinkParams(map[string]string{"name":"REMOTE", "scope":"private", "authentication":"fixedUser", "username":"REMOTEUSER", "password":"marker-secret", "host":"service"}))
    encoded, _ := json.Marshal(result)
    if strings.Contains(string(encoded), "marker-secret") || strings.Contains(string(encoded), "CREATE ") || result["ok"] != false { t.Fatal("sensitive or incorrect response") }
}
