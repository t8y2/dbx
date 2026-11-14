package main

import (
	"database/sql"
	"fmt"
	"strings"
)

// Read comments only for the returned page, keeping dictionary joins out of the
// object enumeration query (which can be expensive on older Oracle versions).
func (s *server) enrichObjectComments(objects []objectInfo, schema string, sessionUser bool) {
	indexes := make(map[string][]int)
	names := make([]string, 0, len(objects))
	for i, object := range objects {
		if object.Comment != nil || (object.ObjectType != "TABLE" && object.ObjectType != "VIEW" && object.ObjectType != "MATERIALIZED_VIEW") {
			continue
		}
		if _, exists := indexes[object.Name]; !exists {
			names = append(names, object.Name)
		}
		indexes[object.Name] = append(indexes[object.Name], i)
	}
	const batchSize = 500 // Below Oracle 11g's 1000-expression IN-list limit.
	for start := 0; start < len(names); start += batchSize {
		end := start + batchSize
		if end > len(names) {
			end = len(names)
		}
		comments, err := s.objectCommentBatch(schema, names[start:end], sessionUser)
		if err != nil {
			// Comments are optional: permissions, cancellation and dictionary failures
			// must not discard the object list or repeat the same failing read.
			return
		}
		for name, comment := range comments {
			for _, i := range indexes[name] {
				value := comment
				objects[i].Comment = &value
			}
		}
	}
}

func (s *server) objectCommentBatch(schema string, names []string, sessionUser bool) (map[string]string, error) {
	query := "SELECT TABLE_NAME, COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = :1 AND "
	args := []any{schema}
	if sessionUser {
		query = "SELECT TABLE_NAME, COMMENTS FROM USER_TAB_COMMENTS WHERE "
		args = nil
	}
	binds := make([]string, 0, len(names))
	for _, name := range names {
		args = append(args, name)
		binds = append(binds, fmt.Sprintf(":%d", len(args)))
	}
	query += "TABLE_NAME IN (" + strings.Join(binds, ", ") + ") AND COMMENTS IS NOT NULL"
	rows, err := s.queryRowsWithTimeout(query, args, 2)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	comments := make(map[string]string)
	for rows.Next() {
		var name string
		var comment sql.NullString
		if err := rows.Scan(&name, &comment); err != nil {
			return nil, err
		}
		if comment.Valid {
			comments[name] = comment.String
		}
	}
	return comments, rows.Err()
}
