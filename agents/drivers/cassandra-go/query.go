package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

func (s *server) executeQuery(options queryOptions) (queryResult, error) {
	start := time.Now()
	maxRows := options.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	session, err := s.runtime.sessionFor(s.keyspaceForOptions(options))
	if err != nil {
		return queryResult{}, err
	}
	ctx, cancel := s.beginOperation(options.TimeoutSecs)
	defer s.endOperation(cancel)
	query := session.Query(trimStatementSQL(options.SQL)).WithContext(ctx)
	if options.FetchSize > 0 {
		query = query.PageSize(options.FetchSize)
	}
	iter := query.Iter()
	columns := iter.Columns()
	result := queryResult{
		Columns:     columnNames(columns),
		ColumnTypes: columnTypeNames(columns),
		Rows:        make([][]any, 0, min(maxRows, 1024)),
	}
	if len(columns) == 0 {
		err := iter.Close()
		if err == nil && isSchemaChangingCQL(options.SQL) {
			s.runtime.invalidateMetadataSession()
		}
		result.ExecutionTimeMS = time.Since(start).Milliseconds()
		return result, err
	}
	for len(result.Rows) < maxRows {
		row, ok, scanErr := scanCQLRow(iter, columns)
		if scanErr != nil {
			_ = iter.Close()
			return queryResult{}, scanErr
		}
		if !ok {
			break
		}
		result.Rows = append(result.Rows, row)
	}
	if len(result.Rows) == maxRows {
		_, hasExtra, scanErr := scanCQLRow(iter, columns)
		if scanErr != nil {
			_ = iter.Close()
			return queryResult{}, scanErr
		}
		result.Truncated = hasExtra
	}
	if err := iter.Close(); err != nil {
		return queryResult{}, err
	}
	result.ExecutionTimeMS = time.Since(start).Milliseconds()
	return result, nil
}

func (s *server) executeQueryPage(options queryOptions, pageSize int) (queryPageResult, error) {
	if pageSize <= 0 {
		pageSize = options.FetchSize
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	remaining := options.MaxRows
	if remaining <= 0 {
		remaining = defaultMaxRows
	}
	result, nextState, err := s.fetchCQLPage(options.SQL, s.keyspaceForOptions(options), nil, pageSize, remaining, options.TimeoutSecs)
	if err != nil {
		return queryPageResult{}, err
	}
	remaining -= len(result.Rows)
	if len(nextState) == 0 || remaining <= 0 {
		result.HasMore = false
		result.Truncated = len(nextState) > 0 && remaining <= 0
		return result, nil
	}
	s.nextSessionID++
	id := fmt.Sprintf("cassandra-query-%d", s.nextSessionID)
	s.querySessions[id] = &querySession{
		sql:       trimStatementSQL(options.SQL),
		keyspace:  s.keyspaceForOptions(options),
		pageState: append([]byte(nil), nextState...),
		remaining: remaining,
	}
	result.SessionID = &id
	result.HasMore = true
	return result, nil
}

func (s *server) fetchQueryPage(id string, pageSize int) (queryPageResult, error) {
	state := s.querySessions[id]
	if state == nil {
		return queryPageResult{}, fmt.Errorf("query session not found: %s", id)
	}
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	result, nextState, err := s.fetchCQLPage(state.sql, state.keyspace, state.pageState, pageSize, state.remaining, 0)
	if err != nil {
		return queryPageResult{}, err
	}
	state.remaining -= len(result.Rows)
	if len(nextState) == 0 || state.remaining <= 0 {
		delete(s.querySessions, id)
		result.HasMore = false
		result.Truncated = len(nextState) > 0 && state.remaining <= 0
		return result, nil
	}
	state.pageState = append(state.pageState[:0], nextState...)
	result.SessionID = &id
	result.HasMore = true
	return result, nil
}

func (s *server) fetchCQLPage(sql, keyspace string, pageState []byte, pageSize, remaining, timeoutSecs int) (queryPageResult, []byte, error) {
	start := time.Now()
	if remaining < pageSize {
		pageSize = remaining
	}
	if pageSize <= 0 {
		return queryPageResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}}, nil, nil
	}
	session, err := s.runtime.sessionFor(keyspace)
	if err != nil {
		return queryPageResult{}, nil, err
	}
	ctx, cancel := s.beginOperation(timeoutSecs)
	defer s.endOperation(cancel)
	iter := session.Query(trimStatementSQL(sql)).WithContext(ctx).PageSize(pageSize).PageState(pageState).Iter()
	columns := iter.Columns()
	result := queryPageResult{
		Columns:     columnNames(columns),
		ColumnTypes: columnTypeNames(columns),
		Rows:        make([][]any, 0, pageSize),
	}
	if len(columns) == 0 {
		err := iter.Close()
		result.ExecutionTimeMS = time.Since(start).Milliseconds()
		return result, nil, err
	}
	for len(result.Rows) < pageSize {
		row, ok, scanErr := scanCQLRow(iter, columns)
		if scanErr != nil {
			_ = iter.Close()
			return queryPageResult{}, nil, scanErr
		}
		if !ok {
			break
		}
		result.Rows = append(result.Rows, row)
	}
	nextState := append([]byte(nil), iter.PageState()...)
	if err := iter.Close(); err != nil {
		return queryPageResult{}, nil, err
	}
	result.ExecutionTimeMS = time.Since(start).Milliseconds()
	return result, nextState, nil
}

func (s *server) closeQuerySession(id string) bool {
	if _, exists := s.querySessions[id]; !exists {
		return false
	}
	delete(s.querySessions, id)
	return true
}

func (s *server) executeStatements(params map[string]json.RawMessage, transactional bool) (queryResult, error) {
	statements := stringSliceParam(params, "statements")
	if len(statements) == 0 {
		return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}}, nil
	}
	keyspace := strings.TrimSpace(stringParam(params, "schema"))
	if keyspace == "" {
		keyspace = strings.TrimSpace(stringParam(params, "database"))
	}
	if keyspace == "" {
		keyspace = strings.TrimSpace(s.params.Database)
	}
	session, err := s.runtime.sessionFor(keyspace)
	if err != nil {
		return queryResult{}, err
	}
	batchType := gocql.UnloggedBatch
	if transactional {
		batchType = gocql.LoggedBatch
	}
	batch := session.NewBatch(batchType)
	for _, statement := range statements {
		statement = trimStatementSQL(statement)
		if statement != "" {
			batch.Query(statement)
		}
	}
	ctx, cancel := s.beginOperation(intParam(params, "timeoutSecs"))
	defer s.endOperation(cancel)
	start := time.Now()
	if err := session.ExecuteBatch(batch.WithContext(ctx)); err != nil {
		return queryResult{}, err
	}
	return queryResult{
		Columns:         []string{},
		ColumnTypes:     []string{},
		Rows:            [][]any{},
		AffectedRows:    0,
		ExecutionTimeMS: time.Since(start).Milliseconds(),
	}, nil
}

func (s *server) keyspaceForOptions(options queryOptions) string {
	if schema := strings.TrimSpace(options.Schema); schema != "" {
		return schema
	}
	if database := strings.TrimSpace(options.Database); database != "" {
		return database
	}
	return s.defaultKeyspace()
}

func scanCQLRow(iter *gocql.Iter, columns []gocql.ColumnInfo) ([]any, bool, error) {
	destinations := make([]any, 0, len(columns))
	extractors := make([]func() any, 0, len(columns))
	for _, column := range columns {
		if tuple, ok := column.TypeInfo.(gocql.TupleTypeInfo); ok {
			tupleDestinations := make([]*cqlDestination, 0, len(tuple.Elems))
			for _, element := range tuple.Elems {
				destination := newCQLDestination(element)
				tupleDestinations = append(tupleDestinations, destination)
				destinations = append(destinations, destination.destination)
			}
			extractors = append(extractors, func() any {
				values := make([]any, len(tupleDestinations))
				allNull := true
				for index, destination := range tupleDestinations {
					value, present := destination.value()
					if present {
						allNull = false
						values[index] = value
					}
				}
				if allNull {
					return nil
				}
				return normalizeCQLValue(values)
			})
			continue
		}
		destination := newCQLDestination(column.TypeInfo)
		destinations = append(destinations, destination.destination)
		extractors = append(extractors, func() any {
			value, present := destination.value()
			if !present {
				return nil
			}
			return normalizeCQLValue(value)
		})
	}
	if !iter.Scan(destinations...) {
		return nil, false, nil
	}
	row := make([]any, len(columns))
	for index, extract := range extractors {
		row[index] = extract()
	}
	return row, true, nil
}

type cqlDestination struct {
	destination any
	holder      reflect.Value
	fallback    *any
}

func newCQLDestination(typeInfo gocql.TypeInfo) *cqlDestination {
	zero := typeInfo.Zero()
	valueType := reflect.TypeOf(zero)
	if valueType == nil {
		var fallback any
		return &cqlDestination{destination: &fallback, fallback: &fallback}
	}
	holder := reflect.New(reflect.PointerTo(valueType))
	return &cqlDestination{destination: holder.Interface(), holder: holder}
}

func (destination *cqlDestination) value() (any, bool) {
	if destination.fallback != nil {
		return *destination.fallback, *destination.fallback != nil
	}
	pointer := destination.holder.Elem()
	if pointer.IsNil() {
		return nil, false
	}
	return pointer.Elem().Interface(), true
}

func columnNames(columns []gocql.ColumnInfo) []string {
	result := make([]string, len(columns))
	for index, column := range columns {
		result[index] = column.Name
	}
	return result
}

func columnTypeNames(columns []gocql.ColumnInfo) []string {
	result := make([]string, len(columns))
	for index, column := range columns {
		result[index] = cqlTypeName(column.TypeInfo)
	}
	return result
}

func trimStatementSQL(sql string) string {
	trimmed := strings.TrimSpace(sql)
	for strings.HasSuffix(trimmed, ";") {
		trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, ";"))
	}
	return trimmed
}

func isSchemaChangingCQL(sql string) bool {
	fields := strings.Fields(trimStatementSQL(sql))
	if len(fields) == 0 {
		return false
	}
	switch strings.ToUpper(fields[0]) {
	case "CREATE", "ALTER", "DROP":
		return true
	default:
		return false
	}
}
