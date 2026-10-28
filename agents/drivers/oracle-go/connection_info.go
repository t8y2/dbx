package main

import "strings"

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
			continue
		}
		var version string
		valid := rows.Next() && rows.Scan(&version) == nil && rows.Err() == nil
		s.closeRows(rows)
		if valid && strings.TrimSpace(version) != "" {
			info["productVersion"] = strings.TrimSpace(version)
			break
		}
	}
	return map[string]any{"identifierQuote": `"`, "databaseInfo": info}, nil
}
