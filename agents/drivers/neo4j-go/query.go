package main

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
)

func (s *server) executeQuery(options queryOptions) (queryResult, error) {
	started := time.Now()
	cypher := trimCypher(options.SQL)
	if cypher == "" {
		return emptyQueryResult(time.Since(started)), nil
	}
	ctx, cancel := s.beginOperation(options.TimeoutSecs)
	defer s.endOperation(cancel)
	session := s.newSession(ctx, options.Database, neo4j.AccessModeWrite, effectiveFetchSize(options))
	defer session.Close(ctx)
	result, err := session.Run(ctx, cypher, nil)
	if err != nil {
		return queryResult{}, err
	}
	maxRows := effectiveMaxRows(options.MaxRows)
	rows, columns, columnTypes, truncated, err := readResultPage(ctx, result, maxRows)
	if err != nil {
		return queryResult{}, err
	}
	return queryResult{
		Columns:         columns,
		ColumnTypes:     columnTypes,
		Rows:            rows,
		AffectedRows:    0,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       truncated,
	}, nil
}

func (s *server) executeQueryPage(options queryOptions, pageSize int) (queryPageResult, error) {
	started := time.Now()
	cypher := trimCypher(options.SQL)
	if cypher == "" {
		return emptyQueryPage(time.Since(started)), nil
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	maxRows := effectiveMaxRows(options.MaxRows)
	if pageSize > maxRows {
		pageSize = maxRows
	}
	ctx, cancel := s.beginOperation(options.TimeoutSecs)
	session := s.newSession(ctx, options.Database, neo4j.AccessModeWrite, effectivePageFetchSize(options, pageSize))
	result, err := session.Run(ctx, cypher, nil)
	if err != nil {
		_ = session.Close(ctx)
		s.endOperation(cancel)
		return queryPageResult{}, err
	}
	rows, columns, columnTypes, hasMore, err := readResultPage(ctx, result, pageSize)
	if err != nil {
		_ = session.Close(ctx)
		s.endOperation(cancel)
		return queryPageResult{}, err
	}
	remaining := maxRows - len(rows)
	if !hasMore || remaining <= 0 {
		_ = session.Close(ctx)
		s.endOperation(cancel)
		return queryPageResult{
			Columns: columns, ColumnTypes: columnTypes, Rows: rows,
			ExecutionTimeMS: time.Since(started).Milliseconds(), Truncated: hasMore && remaining <= 0,
			HasMore: false,
		}, nil
	}
	id := s.nextQuerySessionID()
	s.querySessions[id] = &querySession{
		session: session, result: result, ctx: ctx, cancel: cancel,
		columns: columns, columnTypes: columnTypes, remaining: remaining,
	}
	return queryPageResult{
		Columns: columns, ColumnTypes: columnTypes, Rows: rows,
		ExecutionTimeMS: time.Since(started).Milliseconds(), SessionID: &id, HasMore: true,
	}, nil
}

func (s *server) fetchQueryPage(id string, pageSize int) (queryPageResult, error) {
	started := time.Now()
	query := s.querySessions[id]
	if query == nil {
		return queryPageResult{}, fmt.Errorf("query session not found: %s", id)
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	if pageSize > query.remaining {
		pageSize = query.remaining
	}
	rows, _, _, hasMore, err := readResultPage(query.ctx, query.result, pageSize)
	if err != nil {
		s.closeQuerySession(id)
		return queryPageResult{}, err
	}
	query.remaining -= len(rows)
	truncated := hasMore && query.remaining <= 0
	if !hasMore || query.remaining <= 0 {
		s.closeQuerySession(id)
		return queryPageResult{
			Columns: query.columns, ColumnTypes: query.columnTypes, Rows: rows,
			ExecutionTimeMS: time.Since(started).Milliseconds(), Truncated: truncated, HasMore: false,
		}, nil
	}
	return queryPageResult{
		Columns: query.columns, ColumnTypes: query.columnTypes, Rows: rows,
		ExecutionTimeMS: time.Since(started).Milliseconds(), SessionID: &id, HasMore: true,
	}, nil
}

func (s *server) closeQuerySession(id string) map[string]bool {
	query := s.querySessions[id]
	delete(s.querySessions, id)
	if query == nil {
		return map[string]bool{"ok": true}
	}
	_ = query.session.Close(query.ctx)
	s.endOperation(query.cancel)
	return map[string]bool{"ok": true}
}

func (s *server) closeAllQuerySessions() error {
	ids := make([]string, 0, len(s.querySessions))
	for id := range s.querySessions {
		ids = append(ids, id)
	}
	for _, id := range ids {
		s.closeQuerySession(id)
	}
	return nil
}

func (s *server) nextQuerySessionID() string {
	s.nextSessionID++
	return fmt.Sprintf("neo4j-query-%d", s.nextSessionID)
}

func (s *server) executeTransaction(params map[string]json.RawMessage) (queryResult, error) {
	started := time.Now()
	statements := stringSliceParam(params, "statements")
	ctx, cancel := s.beginOperation(intParam(params, "timeoutSecs"))
	defer s.endOperation(cancel)
	session := s.newSession(ctx, stringParam(params, "database"), neo4j.AccessModeWrite, neo4j.FetchDefault)
	defer session.Close(ctx)
	transaction, err := session.BeginTransaction(ctx)
	if err != nil {
		return queryResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = transaction.Rollback(ctx)
		}
		_ = transaction.Close(ctx)
	}()
	for _, statement := range statements {
		cypher := trimCypher(statement)
		if cypher == "" {
			continue
		}
		result, runErr := transaction.Run(ctx, cypher, nil)
		if runErr != nil {
			return queryResult{}, runErr
		}
		if _, consumeErr := result.Consume(ctx); consumeErr != nil {
			return queryResult{}, consumeErr
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return queryResult{}, err
	}
	committed = true
	return emptyQueryResult(time.Since(started)), nil
}

func (s *server) executeBatch(params map[string]json.RawMessage) (queryResult, error) {
	started := time.Now()
	for _, statement := range stringSliceParam(params, "statements") {
		result, err := s.executeQuery(queryOptions{
			SQL: statement, Database: stringParam(params, "database"), TimeoutSecs: intParam(params, "timeoutSecs"),
		})
		if err != nil {
			return queryResult{}, err
		}
		_ = result
	}
	return emptyQueryResult(time.Since(started)), nil
}

func readResultPage(ctx context.Context, result neo4j.Result, limit int) ([][]any, []string, []string, bool, error) {
	if limit < 0 {
		limit = 0
	}
	columns, err := result.Keys()
	if err != nil {
		return nil, nil, nil, false, err
	}
	rows := make([][]any, 0, min(limit, 1024))
	columnTypes := make([]string, len(columns))
	for index := range columnTypes {
		columnTypes[index] = "Unknown"
	}
	for len(rows) < limit && result.Next(ctx) {
		record := result.Record()
		if len(rows) == 0 {
			columnTypes = recordColumnTypes(record, len(columns))
		} else {
			refineColumnTypes(columnTypes, record)
		}
		rows = append(rows, normalizeRecord(record, len(columns)))
	}
	if err := result.Err(); err != nil {
		return nil, nil, nil, false, err
	}
	hasMore := false
	if result.IsOpen() {
		hasMore = result.Peek(ctx)
		if err := result.Err(); err != nil {
			return nil, nil, nil, false, err
		}
	}
	return rows, columns, columnTypes, hasMore, nil
}

func normalizeRecord(record *neo4j.Record, width int) []any {
	row := make([]any, width)
	if record == nil {
		return row
	}
	for index := 0; index < width && index < len(record.Values); index++ {
		row[index] = normalizeQueryValue(record.Values[index])
	}
	return row
}

func normalizeQueryValue(value any) any {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case []byte:
		return string(typed)
	case neo4j.Node:
		return formatNode(typed)
	case neo4j.Relationship:
		return formatRelationship(typed)
	case neo4j.Path:
		return formatJSONValue(typed)
	case fmt.Stringer:
		return typed.String()
	default:
		return formatJSONValue(typed)
	}
}

func formatNode(node neo4j.Node) string {
	labels := ""
	if len(node.Labels) > 0 {
		labels = ":" + strings.Join(node.Labels, ":")
	}
	properties := formatJSONValue(node.Props)
	if properties == "{}" {
		return "(" + labels + ")"
	}
	return "(" + labels + " " + properties + ")"
}

func formatRelationship(relationship neo4j.Relationship) string {
	properties := formatJSONValue(relationship.Props)
	if properties == "{}" {
		return "[:" + relationship.Type + "]"
	}
	return "[:" + relationship.Type + " " + properties + "]"
}

func formatJSONValue(value any) string {
	normalized := normalizeNestedValue(value)
	data, err := json.Marshal(normalized)
	if err == nil {
		return string(data)
	}
	return fmt.Sprint(value)
}

func normalizeNestedValue(value any) any {
	switch typed := value.(type) {
	case nil, bool, string, int, int64, float64:
		return typed
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = normalizeNestedValue(item)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[key] = normalizeNestedValue(item)
		}
		return result
	case neo4j.Node:
		return map[string]any{"elementId": typed.ElementId, "labels": typed.Labels, "properties": normalizeNestedValue(typed.Props)}
	case neo4j.Relationship:
		return map[string]any{
			"elementId": typed.ElementId, "startElementId": typed.StartElementId, "endElementId": typed.EndElementId,
			"type": typed.Type, "properties": normalizeNestedValue(typed.Props),
		}
	case neo4j.Path:
		nodes := make([]any, len(typed.Nodes))
		for index, node := range typed.Nodes {
			nodes[index] = normalizeNestedValue(node)
		}
		relationships := make([]any, len(typed.Relationships))
		for index, relationship := range typed.Relationships {
			relationships[index] = normalizeNestedValue(relationship)
		}
		return map[string]any{"nodes": nodes, "relationships": relationships}
	case fmt.Stringer:
		return typed.String()
	default:
		reflection := reflect.ValueOf(value)
		if reflection.IsValid() && (reflection.Kind() == reflect.Slice || reflection.Kind() == reflect.Array) {
			result := make([]any, reflection.Len())
			for index := 0; index < reflection.Len(); index++ {
				result[index] = normalizeNestedValue(reflection.Index(index).Interface())
			}
			return result
		}
		return fmt.Sprint(value)
	}
}

func recordColumnTypes(record *neo4j.Record, width int) []string {
	types := make([]string, width)
	for index := range types {
		types[index] = "Unknown"
	}
	if record == nil {
		return types
	}
	for index := 0; index < width && index < len(record.Values); index++ {
		types[index] = neo4jTypeName(record.Values[index])
	}
	return types
}

func refineColumnTypes(types []string, record *neo4j.Record) {
	if record == nil {
		return
	}
	for index := 0; index < len(types) && index < len(record.Values); index++ {
		if types[index] == "Unknown" || types[index] == "Null" {
			if discovered := neo4jTypeName(record.Values[index]); discovered != "Null" {
				types[index] = discovered
			}
		}
	}
}

func neo4jTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "Null"
	case bool:
		return "Boolean"
	case int, int8, int16, int32, int64:
		return "Integer"
	case float32, float64:
		return "Float"
	case string:
		return "String"
	case []byte, []any:
		return "List"
	case map[string]any:
		return "Map"
	case neo4j.Node:
		return "Node"
	case neo4j.Relationship:
		return "Relationship"
	case neo4j.Path:
		return "Path"
	case neo4j.Point2D, neo4j.Point3D:
		return "Point"
	case neo4j.Date:
		return "Date"
	case neo4j.LocalDateTime:
		return "LocalDateTime"
	case neo4j.LocalTime:
		return "LocalTime"
	case neo4j.Time:
		return "Time"
	case neo4j.Duration:
		return "Duration"
	case time.Time:
		return "DateTime"
	default:
		return "Any"
	}
}

func effectiveMaxRows(configured int) int {
	if configured > 0 {
		return configured
	}
	return defaultMaxRows
}

func effectiveFetchSize(options queryOptions) int {
	if options.FetchSize > 0 {
		return options.FetchSize
	}
	maxRows := effectiveMaxRows(options.MaxRows)
	if maxRows >= 1000 && queryHasBoundedLimit(options.SQL, min(maxRows, defaultMaxRows)) {
		return neo4j.FetchAll
	}
	switch {
	case maxRows <= 100:
		return 100
	case maxRows <= 1000:
		return 1000
	default:
		return 4096
	}
}

var numericLimitPattern = regexp.MustCompile(`(?i)\bLIMIT\s+([0-9]+)\b`)

func queryHasBoundedLimit(cypher string, maxRows int) bool {
	matches := numericLimitPattern.FindAllStringSubmatch(cypher, -1)
	if len(matches) == 0 {
		return false
	}
	limit, err := strconv.Atoi(matches[len(matches)-1][1])
	return err == nil && limit > 0 && limit <= maxRows
}

func effectivePageFetchSize(options queryOptions, pageSize int) int {
	if options.FetchSize > 0 {
		return options.FetchSize
	}
	if pageSize <= 100 {
		return 100
	}
	if pageSize <= 1000 {
		return 1000
	}
	return 4096
}

func emptyQueryResult(duration time.Duration) queryResult {
	return queryResult{
		Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, ExecutionTimeMS: duration.Milliseconds(),
	}
}

func emptyQueryPage(duration time.Duration) queryPageResult {
	return queryPageResult{
		Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, ExecutionTimeMS: duration.Milliseconds(),
	}
}

func trimCypher(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "; \t\r\n")
}
