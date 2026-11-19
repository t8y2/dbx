package main

import (
	"context"
	"errors"
	"strings"
)

// Match the JDBC connection_info contract used to open native job contexts.
// Version metadata is optional: dictionary visibility must not prevent the
// caller from checking the session user and reading its own jobs.
func (s *server) connectionInfo() (map[string]any, error) {
	if _, err := s.requireDB(); err != nil {
		return nil, err
	}
	info := map[string]string{
		"productName":            "Oracle",
		"unquotedIdentifierCase": "upper",
		"quotedIdentifierCase":   "mixed",
	}
	for _, query := range oracleDatabaseVersionQueries {
		rows, err := s.queryRowsWithTimeout(query, nil, int(oracleDatabaseVersionProbeTimeout.Seconds()))
		if err != nil {
			s.activeCancelMu.Lock()
			probeTimedOut := s.activeTimedOut
			s.activeCancelMu.Unlock()
			if errors.Is(err, context.Canceled) && !probeTimedOut {
				return nil, err
			}
			continue
		}
		var version string
		valid := rows.Next()
		if valid {
			err = rows.Scan(&version)
		}
		if err == nil {
			err = rows.Err()
		}
		s.closeRows(rows)
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		if valid && err == nil && strings.TrimSpace(version) != "" {
			info["productVersion"] = strings.TrimSpace(version)
			break
		}
	}
	return map[string]any{"identifierQuote": `"`, "databaseInfo": info}, nil
}
