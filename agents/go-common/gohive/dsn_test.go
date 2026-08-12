package gohive

import "testing"

func TestParseDSNDefaultsToPlainAuthentication(t *testing.T) {
	value, err := ParseDSN("hive://hs2.example.com/default")
	if err != nil {
		t.Fatal(err)
	}
	if value.Auth != "NONE" || value.TransportMode != "binary" || value.Port != 10000 {
		t.Fatalf("unexpected DSN defaults: %#v", value)
	}
}

func TestParseDSNPreservesUserInfo(t *testing.T) {
	value, err := ParseDSN("hive://user%40example.com:p%40ss%3Aword@hs2.example.com:10001/default?auth=LDAP&transport=http")
	if err != nil {
		t.Fatal(err)
	}
	if value.Username != "user@example.com" || value.Password != "p@ss:word" || value.Auth != "LDAP" || value.TransportMode != "http" {
		t.Fatalf("unexpected DSN: %#v", value)
	}
}
