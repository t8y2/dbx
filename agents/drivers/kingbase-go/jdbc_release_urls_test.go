package main

import "testing"

func TestKingbaseJDBCReleaseURLsUseStructuredConnection(t *testing.T) {
	for _, prefix := range []string{"kingbase", "kingbase8", "kingbase83", "kingbase86"} {
		t.Run(prefix, func(t *testing.T) {
			cp := connectParams{Host: "db.example.test", Port: 54321, Database: "test", Username: "test_user"}
			want := buildDSNWithSSLMode(cp, "require")
			cp.ConnectionString = "jdbc:" + prefix + "://db.example.test:54321/test"
			if got := buildDSNWithSSLMode(cp, "require"); got != want {
				t.Fatalf("JDBC marker must not be forwarded as a native DSN: got %q, want %q", got, want)
			}
		})
	}
}
