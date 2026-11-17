//go:build !windows

package main

import "os"

// POSIX precedence for the date category: LC_ALL overrides LC_TIME, which
// overrides LANG. LC_MESSAGES governs messages, not dates, so it does not
// belong here.
func systemLocaleName() string {
	for _, key := range []string{"LC_ALL", "LC_TIME", "LANG"} {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return ""
}
