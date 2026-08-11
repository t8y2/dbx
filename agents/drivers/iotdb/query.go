package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/apache/iotdb-client-go/v2/client"
)

type querySession struct {
	dataset     *client.SessionDataSet
	client      *sessionClient
	columns     []string
	columnTypes []string
	prefetched  []any
	remaining   int
}

type queryPageRead struct {
	state     *querySession
	rows      [][]any
	hasMore   bool
	truncated bool
}

func (s *server) validateConnection() error {
	values, err := s.queryValues("SHOW VERSION", "", 1, 0)
	if err != nil {
		return err
	}
	if len(values.Rows) == 0 {
		return errors.New("IoTDB SHOW VERSION returned no rows")
	}
	return nil
}

func (s *server) executeQuery(options queryOptions) (queryResult, error) {
	started := time.Now()
	sql := trimStatementSQL(options.SQL)
	if sql == "" {
		return queryResult{}, errors.New("sql is required")
	}
	if !isQueryStatement(sql) {
		if err := s.executeNonQuery(sql, effectiveDatabase(options), options.TimeoutSecs); err != nil {
			return queryResult{}, err
		}
		return queryResult{
			Columns:         []string{},
			ColumnTypes:     []string{},
			Rows:            [][]any{},
			AffectedRows:    0,
			ExecutionTimeMS: time.Since(started).Milliseconds(),
		}, nil
	}

	limit := options.MaxRows
	if limit <= 0 {
		limit = defaultMaxRows
	}
	values, err := s.queryValues(sql, effectiveDatabase(options), limit, options.TimeoutSecs)
	if err != nil {
		return queryResult{}, err
	}
	values.ExecutionTimeMS = time.Since(started).Milliseconds()
	return values, nil
}

func (s *server) queryValues(sql, database string, limit, timeoutSecs int) (queryResult, error) {
	connected, err := s.ensureClient()
	if err != nil {
		return queryResult{}, err
	}
	timeout := timeoutMilliseconds(timeoutSecs)
	return runCancelable(s, timeoutSecs, connected, func(ctx context.Context) (queryResult, error) {
		if err := s.applyDatabaseContext(ctx, connected, database); err != nil {
			return queryResult{}, err
		}
		dataset, err := connected.session.ExecuteQueryStatement(ctx, sql, timeout)
		if err != nil {
			return queryResult{}, err
		}
		defer dataset.Close()
		columns := append([]string(nil), dataset.GetColumnNames()...)
		columnTypes := normalizedColumnTypes(dataset.GetColumnTypes(), len(columns))
		rows, truncated, err := readDataset(ctx, dataset, connected.dialect, columns, columnTypes, limit)
		if err != nil {
			return queryResult{}, err
		}
		return queryResult{
			Columns:      columns,
			ColumnTypes:  columnTypes,
			Rows:         rows,
			AffectedRows: 0,
			Truncated:    truncated,
		}, nil
	})
}

func (s *server) executeNonQuery(sql, database string, timeoutSecs int) error {
	connected, err := s.ensureClient()
	if err != nil {
		return err
	}
	_, err = runCancelable(s, timeoutSecs, connected, func(ctx context.Context) (struct{}, error) {
		if err := s.applyDatabaseContext(ctx, connected, database); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, connected.session.ExecuteNonQueryStatement(ctx, sql)
	})
	return err
}

func (s *server) executeQueryPage(options queryOptions, requestedPageSize int) (queryPageResult, error) {
	started := time.Now()
	sql := trimStatementSQL(options.SQL)
	if sql == "" {
		return queryPageResult{}, errors.New("sql is required")
	}
	if !isQueryStatement(sql) {
		if err := s.executeNonQuery(sql, effectiveDatabase(options), options.TimeoutSecs); err != nil {
			return queryPageResult{}, err
		}
		return queryPageResult{
			Columns:         []string{},
			ColumnTypes:     []string{},
			Rows:            [][]any{},
			ExecutionTimeMS: time.Since(started).Milliseconds(),
		}, nil
	}

	connected, err := s.ensureClient()
	if err != nil {
		return queryPageResult{}, err
	}
	timeout := timeoutMilliseconds(options.TimeoutSecs)
	limit := options.MaxRows
	if limit <= 0 {
		limit = defaultMaxRows
	}
	pageSize := requestedPageSize
	if pageSize <= 0 {
		pageSize = options.FetchSize
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	var dataset *client.SessionDataSet
	page, err := runCancelable(s, options.TimeoutSecs, connected, func(ctx context.Context) (queryPageRead, error) {
		if err := s.applyDatabaseContext(ctx, connected, effectiveDatabase(options)); err != nil {
			return queryPageRead{}, err
		}
		dataset, err = connected.session.ExecuteQueryStatement(ctx, sql, timeout)
		if err != nil {
			return queryPageRead{}, err
		}
		queryState := &querySession{
			dataset:     dataset,
			client:      connected,
			columns:     append([]string(nil), dataset.GetColumnNames()...),
			columnTypes: normalizedColumnTypes(dataset.GetColumnTypes(), len(dataset.GetColumnNames())),
			remaining:   limit,
		}
		rows, hasMore, truncated, err := s.readQuerySessionPage(ctx, queryState, pageSize)
		return queryPageRead{state: queryState, rows: rows, hasMore: hasMore, truncated: truncated}, err
	})
	if err != nil {
		if dataset != nil {
			_ = dataset.Close()
		}
		return queryPageResult{}, err
	}
	result := queryPageResult{
		Columns:         page.state.columns,
		ColumnTypes:     page.state.columnTypes,
		Rows:            page.rows,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       page.truncated,
		HasMore:         page.hasMore,
	}
	if page.hasMore {
		s.nextSessionID++
		sessionID := fmt.Sprintf("iotdb-go-%d", s.nextSessionID)
		s.querySessions[sessionID] = page.state
		result.SessionID = &sessionID
	} else {
		_ = dataset.Close()
	}
	return result, nil
}

func (s *server) fetchQueryPage(sessionID string, requestedPageSize int) (queryPageResult, error) {
	started := time.Now()
	queryState := s.querySessions[sessionID]
	if queryState == nil {
		return queryPageResult{}, fmt.Errorf("query session not found: %s", sessionID)
	}
	pageSize := requestedPageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	page, err := runCancelable(s, 0, queryState.client, func(ctx context.Context) (queryPageRead, error) {
		rows, hasMore, truncated, err := s.readQuerySessionPage(ctx, queryState, pageSize)
		return queryPageRead{state: queryState, rows: rows, hasMore: hasMore, truncated: truncated}, err
	})
	if err != nil {
		_ = s.closeQuerySession(sessionID)
		return queryPageResult{}, err
	}
	result := queryPageResult{
		Columns:         queryState.columns,
		ColumnTypes:     queryState.columnTypes,
		Rows:            page.rows,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       page.truncated,
		HasMore:         page.hasMore,
	}
	if page.hasMore {
		result.SessionID = &sessionID
	} else {
		_ = s.closeQuerySession(sessionID)
	}
	return result, nil
}

func (s *server) readQuerySessionPage(ctx context.Context, state *querySession, pageSize int) ([][]any, bool, bool, error) {
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	target := min(pageSize, state.remaining)
	rows := make([][]any, 0, target)
	if state.prefetched != nil && target > 0 {
		rows = append(rows, state.prefetched)
		state.prefetched = nil
		state.remaining--
	}
	for len(rows) < target {
		row, hasNext, err := s.nextDatasetRow(ctx, state)
		if err != nil {
			return nil, false, false, err
		}
		if !hasNext {
			return rows, false, false, nil
		}
		rows = append(rows, row)
		state.remaining--
	}
	if state.remaining <= 0 {
		_, hasNext, err := s.nextDatasetRow(ctx, state)
		if err != nil {
			return nil, false, false, err
		}
		return rows, false, hasNext, nil
	}
	next, hasNext, err := s.nextDatasetRow(ctx, state)
	if err != nil {
		return nil, false, false, err
	}
	if !hasNext {
		return rows, false, false, nil
	}
	state.prefetched = next
	return rows, true, false, nil
}

func (s *server) nextDatasetRow(ctx context.Context, state *querySession) ([]any, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	hasNext, err := state.dataset.Next()
	if err != nil || !hasNext {
		return nil, false, err
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	row, err := datasetRow(state.dataset, state.client.dialect, state.columns, state.columnTypes)
	return row, true, err
}

func (s *server) closeQuerySession(sessionID string) bool {
	state := s.querySessions[sessionID]
	delete(s.querySessions, sessionID)
	if state == nil {
		return false
	}
	_ = state.dataset.Close()
	return true
}

func (s *server) closeAllQuerySessions() error {
	var firstErr error
	for sessionID, state := range s.querySessions {
		if err := state.dataset.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(s.querySessions, sessionID)
	}
	return firstErr
}

func (s *server) executeStatements(params map[string]json.RawMessage, transaction bool) (queryResult, error) {
	started := time.Now()
	statements := stringSliceParam(params, "statements")
	if len(statements) == 0 {
		return queryResult{}, errors.New("statements are required")
	}
	database := strings.TrimSpace(stringParam(params, "schema"))
	for _, statement := range statements {
		sql := trimStatementSQL(statement)
		if sql == "" {
			continue
		}
		if isQueryStatement(sql) {
			values, err := s.queryValues(sql, database, defaultMaxRows, 0)
			if err != nil {
				return queryResult{}, err
			}
			_ = values
		} else if err := s.executeNonQuery(sql, database, 0); err != nil {
			return queryResult{}, err
		}
	}
	return queryResult{
		Columns:         []string{},
		ColumnTypes:     []string{},
		Rows:            [][]any{},
		AffectedRows:    0,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       false,
	}, nil
}

func (s *server) applyDatabaseContext(ctx context.Context, connected *sessionClient, database string) error {
	if connected.dialect != client.TableSqlDialect {
		return nil
	}
	database = strings.TrimSpace(database)
	if database == "" {
		database = strings.TrimSpace(s.config.Database)
	}
	if database == "" || strings.EqualFold(database, "information_schema") {
		return nil
	}
	return connected.session.ExecuteNonQueryStatement(ctx, "USE "+quoteTableIdentifier(database))
}

func runCancelable[T any](s *server, timeoutSecs int, connected *sessionClient, operation func(context.Context) (T, error)) (T, error) {
	var zero T
	ctx := context.Background()
	var cancel context.CancelFunc
	if timeoutSecs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutSecs)*time.Second)
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}
	s.setActiveOperation(cancel)
	defer s.clearActiveOperation(cancel)
	value, err := operation(ctx)
	if ctxErr := ctx.Err(); ctxErr != nil {
		s.invalidateClient(connected)
		return zero, ctxErr
	}
	if err != nil && isConnectionError(err) {
		s.invalidateClient(connected)
	}
	return value, err
}

func readDataset(ctx context.Context, dataset *client.SessionDataSet, dialect string, columns, columnTypes []string, limit int) ([][]any, bool, error) {
	if limit <= 0 {
		limit = defaultMaxRows
	}
	rows := make([][]any, 0, min(limit, defaultPageSize))
	for len(rows) < limit {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		hasNext, err := dataset.Next()
		if err != nil {
			return nil, false, err
		}
		if !hasNext {
			return rows, false, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		row, err := datasetRow(dataset, dialect, columns, columnTypes)
		if err != nil {
			return nil, false, err
		}
		rows = append(rows, row)
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	hasNext, err := dataset.Next()
	return rows, hasNext, err
}

func datasetRow(dataset *client.SessionDataSet, dialect string, columns, columnTypes []string) ([]any, error) {
	row := make([]any, len(columns))
	for index := range columns {
		columnIndex := int32(index + 1)
		columnType := ""
		if index < len(columnTypes) {
			columnType = strings.ToUpper(columnTypes[index])
		}
		if dialect == client.TreeSqlDialect && index == 0 && strings.EqualFold(columns[index], "Time") {
			value, err := dataset.GetStringByIndex(columnIndex)
			if err != nil {
				return nil, err
			}
			row[index] = value
			continue
		}
		value, err := dataset.GetObjectByIndex(columnIndex)
		if err != nil {
			return nil, err
		}
		row[index] = normalizeIoTDBValue(value, columnType)
	}
	return row, nil
}

func normalizeIoTDBValue(value any, columnType string) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case time.Time:
		if columnType == "DATE" {
			return typed.Format("2006-01-02")
		}
		return typed.Format(time.RFC3339Nano)
	case []byte:
		return hex.EncodeToString(typed)
	case float32:
		if math.IsNaN(float64(typed)) || math.IsInf(float64(typed), 0) {
			return fmt.Sprint(typed)
		}
		return typed
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return fmt.Sprint(typed)
		}
		return typed
	default:
		return typed
	}
}

func normalizedColumnTypes(values []string, columnCount int) []string {
	result := make([]string, columnCount)
	for index := range result {
		if index < len(values) {
			result[index] = strings.ToUpper(values[index])
		}
	}
	return result
}

func timeoutMilliseconds(timeoutSecs int) *int64 {
	if timeoutSecs <= 0 {
		return nil
	}
	value := int64(timeoutSecs) * 1000
	return &value
}

func effectiveDatabase(options queryOptions) string {
	if value := strings.TrimSpace(options.Schema); value != "" {
		return value
	}
	return strings.TrimSpace(options.Database)
}

func trimStatementSQL(sql string) string {
	trimmed := strings.TrimSpace(sql)
	for strings.HasSuffix(trimmed, ";") {
		trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, ";"))
	}
	return trimmed
}

func isQueryStatement(sql string) bool {
	fields := strings.Fields(strings.TrimSpace(sql))
	if len(fields) == 0 {
		return false
	}
	switch strings.ToUpper(fields[0]) {
	case "SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "WITH":
		return true
	default:
		return false
	}
}

func quoteTableIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func rawParams(values map[string]any) map[string]json.RawMessage {
	result := make(map[string]json.RawMessage, len(values))
	for key, value := range values {
		data, _ := json.Marshal(value)
		result[key] = data
	}
	return result
}
