package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/t8y2/dbx/agents/go-common/gohive"
)

func (server *server) validateConnection() error {
	connection, err := server.requireConnection()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), server.config.ConnectTimeout)
	defer cancel()
	return connection.PingContext(ctx)
}

func (server *server) executeQuery(options queryOptions) (queryResult, error) {
	started := time.Now()
	if options.FetchSize <= 0 {
		options.FetchSize = server.effectiveFetchSize()
	}
	sqlText := trimStatementSQL(options.SQL)
	if sqlText == "" {
		return queryResult{}, errors.New("SQL is required")
	}
	maxRows := options.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	connection, err := server.requireConnection()
	if err != nil {
		return queryResult{}, err
	}

	ctx, cancel := queryContext(options.TimeoutSecs)
	server.setActiveOperation(cancel)
	defer server.clearActiveOperation(cancel)
	if err := server.applySchemaContext(ctx, connection, effectiveSchema(options)); err != nil {
		return queryResult{}, err
	}
	rows, affected, hasResultSet, err := executeHiveStatement(ctx, connection, sqlText, options.FetchSize)
	if err != nil {
		return queryResult{}, err
	}
	if !hasResultSet {
		return queryResult{
			Columns:         []string{},
			ColumnTypes:     []string{},
			Rows:            [][]any{},
			AffectedRows:    affected,
			ExecutionTimeMS: time.Since(started).Milliseconds(),
			Truncated:       false,
		}, nil
	}
	defer rows.Close()
	columns, columnTypes, err := queryColumnMetadata(rows)
	if err != nil {
		return queryResult{}, err
	}
	values, truncated, err := readSQLRows(rows, columnTypes, maxRows)
	if err != nil {
		return queryResult{}, err
	}
	return queryResult{
		Columns:         columns,
		ColumnTypes:     columnTypes,
		Rows:            values,
		AffectedRows:    0,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       truncated,
	}, nil
}

func (server *server) executeQueryPage(options queryOptions, requestedPageSize int) (queryPageResult, error) {
	started := time.Now()
	if options.FetchSize <= 0 {
		options.FetchSize = server.effectiveFetchSize()
	}
	server.expireIdleQuerySessions(started)
	sqlText := trimStatementSQL(options.SQL)
	if sqlText == "" {
		return queryPageResult{}, errors.New("SQL is required")
	}
	pageSize := requestedPageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	maxRows := options.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	connection, err := server.requireConnection()
	if err != nil {
		return queryPageResult{}, err
	}
	ctx, cancel := queryContext(options.TimeoutSecs)
	server.setActiveOperation(cancel)
	if err := server.applySchemaContext(ctx, connection, effectiveSchema(options)); err != nil {
		server.clearActiveOperation(cancel)
		return queryPageResult{}, err
	}
	rows, affected, hasResultSet, err := executeHiveStatement(ctx, connection, sqlText, options.FetchSize)
	if err != nil {
		server.clearActiveOperation(cancel)
		return queryPageResult{}, err
	}
	if !hasResultSet {
		server.clearActiveOperation(cancel)
		return queryPageResult{
			Columns:         []string{},
			ColumnTypes:     []string{},
			Rows:            [][]any{},
			AffectedRows:    affected,
			ExecutionTimeMS: time.Since(started).Milliseconds(),
			Truncated:       false,
			SessionID:       nil,
			HasMore:         false,
		}, nil
	}

	columns, columnTypes, err := queryColumnMetadata(rows)
	if err != nil {
		_ = rows.Close()
		server.clearActiveOperation(cancel)
		return queryPageResult{}, err
	}
	server.nextSessionID++
	sessionID := fmt.Sprintf("hive-%d", server.nextSessionID)
	state := &querySession{
		rows:         rows,
		columns:      columns,
		columnTypes:  columnTypes,
		remaining:    maxRows,
		cancel:       cancel,
		lastAccessed: started,
	}
	server.querySessions[sessionID] = state
	page, hasMore, truncated, err := server.readQuerySessionPage(ctx, state, pageSize)
	server.activeMu.Lock()
	if server.activeCancel != nil {
		server.activeCancel = nil
	}
	server.activeMu.Unlock()
	if err != nil {
		server.closeQuerySession(sessionID)
		return queryPageResult{}, err
	}
	if !hasMore {
		server.closeQuerySession(sessionID)
		return queryPageResult{
			Columns:         columns,
			ColumnTypes:     columnTypes,
			Rows:            page,
			ExecutionTimeMS: time.Since(started).Milliseconds(),
			Truncated:       truncated,
			SessionID:       nil,
			HasMore:         false,
		}, nil
	}
	return queryPageResult{
		Columns:         columns,
		ColumnTypes:     columnTypes,
		Rows:            page,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       false,
		SessionID:       &sessionID,
		HasMore:         true,
	}, nil
}

func (server *server) fetchQueryPage(sessionID string, requestedPageSize int) (queryPageResult, error) {
	server.expireIdleQuerySessions(time.Now())
	state := server.querySessions[sessionID]
	if state == nil {
		return queryPageResult{}, errors.New("query session not found")
	}
	pageSize := requestedPageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	ctx := context.Background()
	server.setActiveOperation(state.cancel)
	page, hasMore, truncated, err := server.readQuerySessionPage(ctx, state, pageSize)
	server.activeMu.Lock()
	server.activeCancel = nil
	server.activeMu.Unlock()
	if err != nil {
		server.closeQuerySession(sessionID)
		return queryPageResult{}, err
	}
	var resultSessionID *string
	if hasMore {
		resultSessionID = &sessionID
	} else {
		server.closeQuerySession(sessionID)
	}
	return queryPageResult{
		Columns:     state.columns,
		ColumnTypes: state.columnTypes,
		Rows:        page,
		Truncated:   truncated,
		SessionID:   resultSessionID,
		HasMore:     hasMore,
	}, nil
}

func (server *server) readQuerySessionPage(ctx context.Context, state *querySession, pageSize int) ([][]any, bool, bool, error) {
	state.lastAccessed = time.Now()
	values := make([][]any, 0, min(pageSize, state.remaining))
	if state.pending != nil && state.remaining > 0 {
		values = append(values, state.pending)
		state.pending = nil
		state.remaining--
	}
	for len(values) < pageSize && state.remaining > 0 {
		row, ok, err := nextSQLRow(state.rows, state.columnTypes)
		if err != nil {
			return nil, false, false, err
		}
		if !ok {
			return values, false, false, nil
		}
		values = append(values, row)
		state.remaining--
		select {
		case <-ctx.Done():
			return nil, false, false, ctx.Err()
		default:
		}
	}
	if state.remaining == 0 {
		_, ok, err := nextSQLRow(state.rows, state.columnTypes)
		if err != nil {
			return nil, false, false, err
		}
		return values, false, ok, nil
	}
	row, ok, err := nextSQLRow(state.rows, state.columnTypes)
	if err != nil {
		return nil, false, false, err
	}
	if !ok {
		return values, false, false, nil
	}
	state.pending = row
	return values, true, false, nil
}

func (server *server) closeQuerySession(sessionID string) bool {
	state := server.querySessions[sessionID]
	if state == nil {
		return false
	}
	delete(server.querySessions, sessionID)
	state.cancel()
	_ = state.rows.Close()
	return true
}

func (server *server) closeAllQuerySessions() error {
	var failures []string
	for sessionID, state := range server.querySessions {
		delete(server.querySessions, sessionID)
		state.cancel()
		if err := state.rows.Close(); err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", sessionID, err))
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func (server *server) expireIdleQuerySessions(now time.Time) int {
	expired := make([]string, 0)
	for sessionID, state := range server.querySessions {
		if !state.lastAccessed.IsZero() && now.Sub(state.lastAccessed) >= querySessionIdleTime {
			expired = append(expired, sessionID)
		}
	}
	for _, sessionID := range expired {
		server.closeQuerySession(sessionID)
	}
	return len(expired)
}

func (server *server) executeStatements(params map[string]json.RawMessage, transaction bool) (queryResult, error) {
	started := time.Now()
	statements := stringSliceParam(params, "statements")
	if len(statements) == 0 {
		return queryResult{}, errors.New("statements are required")
	}
	connection, err := server.requireConnection()
	if err != nil {
		return queryResult{}, err
	}
	ctx, cancel := queryContext(intParam(params, "timeoutSecs"))
	server.setActiveOperation(cancel)
	defer server.clearActiveOperation(cancel)
	if err := server.applySchemaContext(ctx, connection, firstNonEmpty(stringParam(params, "schema"), stringParam(params, "database"))); err != nil {
		return queryResult{}, err
	}

	var affected int64
	if transaction {
		tx, beginErr := connection.BeginTx(ctx, nil)
		if beginErr == nil {
			for _, statement := range statements {
				trimmed := trimStatementSQL(statement)
				if trimmed == "" {
					continue
				}
				result, execErr := tx.ExecContext(ctx, trimmed)
				if execErr != nil {
					_ = tx.Rollback()
					return queryResult{}, execErr
				}
				count, _ := result.RowsAffected()
				affected += max(count, 0)
			}
			if err := tx.Commit(); err != nil {
				return queryResult{}, err
			}
			return emptyQueryResult(affected, started), nil
		}
		if !transactionUnsupported(beginErr) {
			return queryResult{}, beginErr
		}
	}
	for _, statement := range statements {
		trimmed := trimStatementSQL(statement)
		if trimmed == "" {
			continue
		}
		result, err := connection.ExecContext(ctx, trimmed)
		if err != nil {
			return queryResult{}, err
		}
		count, _ := result.RowsAffected()
		affected += max(count, 0)
	}
	return emptyQueryResult(affected, started), nil
}

func transactionUnsupported(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, sql.ErrTxDone) {
		return false
	}
	message := strings.ToLower(err.Error())
	return errors.Is(err, driver.ErrSkip) ||
		strings.Contains(message, "transactions are not supported") ||
		strings.Contains(message, "transaction is not supported") ||
		strings.Contains(message, "unsupported transaction") ||
		strings.Contains(message, "driver: skip fast-path")
}

func emptyQueryResult(affected int64, started time.Time) queryResult {
	return queryResult{
		Columns:         []string{},
		ColumnTypes:     []string{},
		Rows:            [][]any{},
		AffectedRows:    affected,
		ExecutionTimeMS: time.Since(started).Milliseconds(),
		Truncated:       false,
	}
}

func (server *server) applySchemaContext(ctx context.Context, connection *sql.Conn, schema string) error {
	schema = strings.TrimSpace(schema)
	if schema == "" || strings.EqualFold(schema, server.config.Database) {
		return nil
	}
	_, err := connection.ExecContext(ctx, "USE "+quoteHiveIdentifier(schema))
	return err
}

func queryColumnMetadata(rows *sql.Rows) ([]string, []string, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, nil, err
	}
	columnTypes := make([]string, len(columns))
	for index := range columns {
		if index < len(types) {
			columnTypes[index] = strings.ToLower(strings.TrimSpace(types[index].DatabaseTypeName()))
		}
	}
	return columns, columnTypes, nil
}

func readSQLRows(rows *sql.Rows, columnTypes []string, limit int) ([][]any, bool, error) {
	values := make([][]any, 0, min(limit, defaultFetchSize))
	for len(values) < limit {
		row, ok, err := nextSQLRow(rows, columnTypes)
		if err != nil {
			return nil, false, err
		}
		if !ok {
			return values, false, nil
		}
		values = append(values, row)
	}
	_, ok, err := nextSQLRow(rows, columnTypes)
	return values, ok, err
}

func nextSQLRow(rows *sql.Rows, columnTypes []string) ([]any, bool, error) {
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}
	values := make([]any, len(columnTypes))
	targets := make([]any, len(values))
	for index := range values {
		targets[index] = &values[index]
	}
	if err := rows.Scan(targets...); err != nil {
		return nil, false, err
	}
	for index, value := range values {
		values[index] = normalizeHiveValue(value, columnTypes[index])
	}
	return values, true, nil
}

func normalizeHiveValue(value any, columnType string) any {
	if value == nil {
		return nil
	}
	switch typed := value.(type) {
	case []byte:
		return bytesToHex(typed)
	case time.Time:
		return formatHiveJDBCDateTime(typed, columnType)
	case fmt.Stringer:
		return typed.String()
	case string:
		return typed
	default:
		return fmt.Sprint(value)
	}
}

func formatHiveJDBCDateTime(value time.Time, columnType string) string {
	if strings.EqualFold(strings.TrimSpace(columnType), "DATE") {
		return value.Format("2006-01-02")
	}
	base := value.Format("2006-01-02 15:04:05")
	if value.Nanosecond() == 0 {
		return base + ".0"
	}
	fraction := strings.TrimRight(fmt.Sprintf("%09d", value.Nanosecond()), "0")
	return base + "." + fraction
}

func executeHiveStatement(
	ctx context.Context,
	connection *sql.Conn,
	sqlText string,
	fetchSize int,
) (*sql.Rows, int64, bool, error) {
	ctx = gohive.WithFetchSize(ctx, fetchSize)
	rows, err := connection.QueryContext(ctx, sqlText)
	if err == nil {
		return rows, 0, true, nil
	}
	var nonQuery *gohive.NonQueryResult
	if errors.As(err, &nonQuery) {
		return nil, max(nonQuery.AffectedRows, 0), false, nil
	}
	return nil, 0, false, err
}

func bytesToHex(value []byte) string {
	const digits = "0123456789abcdef"
	result := make([]byte, 2+len(value)*2)
	result[0] = '0'
	result[1] = 'x'
	for index, current := range value {
		result[2+index*2] = digits[current>>4]
		result[3+index*2] = digits[current&0x0f]
	}
	return string(result)
}

func queryContext(timeoutSecs int) (context.Context, context.CancelFunc) {
	if timeoutSecs > 0 {
		return context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	}
	return context.WithCancel(context.Background())
}

func (server *server) effectiveFetchSize() int {
	if server.config.FetchSize > 0 {
		return server.config.FetchSize
	}
	return defaultFetchSize
}

func effectiveSchema(options queryOptions) string {
	return firstNonEmpty(options.Schema, options.Database)
}

func trimStatementSQL(sqlText string) string {
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(sqlText), ";"))
}

func quoteHiveIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}
