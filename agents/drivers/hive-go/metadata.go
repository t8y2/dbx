package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/t8y2/dbx/agents/go-common/gohive"
)

const metadataQueryLimit = 100000

var hiveTypes = []string{
	"tinyint", "smallint", "int", "bigint", "boolean", "float", "double", "decimal", "string", "varchar",
	"char", "binary", "date", "timestamp", "timestamp with local time zone", "interval_year_month",
	"interval_day_time", "array", "map", "struct", "uniontype", "void",
}

type databaseInfo struct {
	Name string `json:"name"`
}

type tableInfo struct {
	Name         string  `json:"name"`
	TableType    string  `json:"table_type"`
	Comment      *string `json:"comment"`
	ParentSchema *string `json:"parent_schema,omitempty"`
	ParentName   *string `json:"parent_name,omitempty"`
}

type objectInfo struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     string  `json:"schema"`
	Comment    *string `json:"comment"`
	Valid      *bool   `json:"valid,omitempty"`
}

type objectSource struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     *string `json:"schema"`
	Source     string  `json:"source"`
}

type columnInfo struct {
	Name                   string  `json:"name"`
	DataType               string  `json:"data_type"`
	IsNullable             bool    `json:"is_nullable"`
	ColumnDefault          *string `json:"column_default"`
	IsPrimaryKey           bool    `json:"is_primary_key"`
	Extra                  *string `json:"extra"`
	Comment                *string `json:"comment"`
	NumericPrecision       *int    `json:"numeric_precision"`
	NumericScale           *int    `json:"numeric_scale"`
	CharacterMaximumLength *int    `json:"character_maximum_length"`
}

type indexInfo struct {
	Name            string   `json:"name"`
	Columns         []string `json:"columns"`
	IsUnique        bool     `json:"is_unique"`
	IsPrimary       bool     `json:"is_primary"`
	Filter          *string  `json:"filter"`
	IndexType       *string  `json:"index_type"`
	IncludedColumns []string `json:"included_columns"`
	Comment         *string  `json:"comment"`
}

func (value indexInfo) MarshalJSON() ([]byte, error) {
	type alias indexInfo
	copy := alias(value)
	if copy.Columns == nil {
		copy.Columns = []string{}
	}
	if copy.IncludedColumns == nil {
		copy.IncludedColumns = []string{}
	}
	return json.Marshal(copy)
}

type foreignKeyInfo struct {
	Name      string `json:"name"`
	Column    string `json:"column"`
	RefTable  string `json:"ref_table"`
	RefColumn string `json:"ref_column"`
}

type triggerInfo struct {
	Name   string `json:"name"`
	Event  string `json:"event"`
	Timing string `json:"timing"`
}

type metadataListConstraints struct {
	Filter      string
	Limit       int
	Offset      int
	ObjectTypes []string
}

type completionAssistantRequest struct {
	ConnectionID  string   `json:"connection_id"`
	Database      string   `json:"database"`
	Schema        string   `json:"schema"`
	ObjectKinds   []string `json:"object_kinds"`
	Mask          string   `json:"mask"`
	CaseSensitive bool     `json:"case_sensitive"`
	GlobalSearch  bool     `json:"global_search"`
	MaxResults    int      `json:"max_results"`
	ParentSchema  string   `json:"parent_schema"`
	ParentName    string   `json:"parent_name"`
	MatchMode     string   `json:"match_mode"`
}

type completionAssistantCandidate struct {
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	Database     *string `json:"database"`
	Schema       *string `json:"schema"`
	ParentSchema *string `json:"parent_schema"`
	ParentName   *string `json:"parent_name"`
	Comment      *string `json:"comment"`
	DataType     *string `json:"data_type"`
}

type completionAssistantResponse struct {
	Candidates   []completionAssistantCandidate `json:"candidates"`
	Incomplete   bool                           `json:"incomplete"`
	FallbackUsed bool                           `json:"fallback_used"`
}

func hiveDataTypes() []string {
	return append([]string(nil), hiveTypes...)
}

type hiveMetadataRows struct {
	indexes map[string]int
	rows    [][]any
}

func newHiveMetadataRows(result gohive.MetadataResult) hiveMetadataRows {
	indexes := make(map[string]int, len(result.Columns))
	for index, column := range result.Columns {
		indexes[normalizeMetadataColumn(column)] = index
	}
	rows := make([][]any, 0, len(result.Rows))
	for _, row := range result.Rows {
		values := make([]any, len(row))
		for index, value := range row {
			values[index] = value
		}
		rows = append(rows, values)
	}
	return hiveMetadataRows{indexes: indexes, rows: rows}
}

func (rows hiveMetadataRows) value(row []any, names ...string) any {
	for _, name := range names {
		if index, ok := rows.indexes[normalizeMetadataColumn(name)]; ok && index >= 0 && index < len(row) {
			return row[index]
		}
	}
	return nil
}

func normalizeMetadataColumn(value string) string {
	return strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.ToUpper(strings.TrimSpace(value)))
}

func (server *server) hiveMetadata(operation func(context.Context, gohive.MetadataProvider) (gohive.MetadataResult, error)) (gohive.MetadataResult, error) {
	connection, err := server.requireConnection()
	if err != nil {
		return gohive.MetadataResult{}, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	server.setActiveOperation(cancel)
	defer server.clearActiveOperation(cancel)
	var result gohive.MetadataResult
	err = connection.Raw(func(rawConnection any) error {
		provider, ok := rawConnection.(gohive.MetadataProvider)
		if !ok {
			return errors.New("Hive driver does not expose HiveServer2 metadata RPCs")
		}
		var operationErr error
		result, operationErr = operation(ctx, provider)
		return operationErr
	})
	return result, err
}

func (server *server) connectionInfo() (map[string]any, error) {
	version := ""
	if result, err := server.executeQuery(queryOptions{SQL: "SELECT VERSION()", MaxRows: 1, TimeoutSecs: 5}); err == nil && len(result.Rows) > 0 && len(result.Rows[0]) > 0 {
		version = stringValue(result.Rows[0][0])
	}
	username := server.config.Username
	if result, err := server.executeQuery(queryOptions{SQL: "SELECT CURRENT_USER()", MaxRows: 1, TimeoutSecs: 5}); err == nil && len(result.Rows) > 0 && len(result.Rows[0]) > 0 {
		if current := stringValue(result.Rows[0][0]); current != "" {
			username = current
		}
	}
	productName := "Apache Hive"
	compatibilityMode := "hive"
	driverName := "DBX Hive Go Agent"
	if strings.EqualFold(server.params.DatabaseType, "kyuubi") {
		productName = "Apache Kyuubi"
		compatibilityMode = "kyuubi"
		driverName = "DBX Kyuubi Go Agent"
	} else if strings.EqualFold(server.params.DatabaseType, "impala") || strings.Contains(strings.ToLower(version), "impalad version") {
		productName = "Apache Impala"
		compatibilityMode = "impala"
		driverName = "DBX Impala Go Agent"
	}
	return map[string]any{
		"database":          server.config.Database,
		"schema":            server.config.Database,
		"username":          username,
		"version":           version,
		"sqlDialect":        "HIVE",
		"identifierQuote":   "`",
		"compatibilityMode": compatibilityMode,
		"databaseInfo": map[string]string{
			"productName":            productName,
			"productVersion":         version,
			"unquotedIdentifierCase": "mixed",
			"quotedIdentifierCase":   "mixed",
			"driverName":             driverName,
			"driverVersion":          "gohive-v2.1.0",
		},
	}, nil
}

func (server *server) listDatabases() ([]databaseInfo, error) {
	result, err := server.executeQuery(queryOptions{SQL: "SHOW DATABASES", MaxRows: metadataQueryLimit})
	if err == nil {
		return databaseInfoFromQueryRows(result.Rows), nil
	}
	metadataResult, metadataErr := server.hiveMetadata(func(ctx context.Context, provider gohive.MetadataProvider) (gohive.MetadataResult, error) {
		return provider.GetHiveSchemas(ctx, "%")
	})
	if metadataErr != nil {
		return nil, fmt.Errorf("SHOW DATABASES failed (%v); HiveServer2 metadata fallback failed: %w", err, metadataErr)
	}
	rows := newHiveMetadataRows(metadataResult)
	values := make([]databaseInfo, 0, len(rows.rows))
	seen := map[string]bool{}
	for _, row := range rows.rows {
		name := metadataString(rows.value(row, "TABLE_SCHEM", "SCHEMA_NAME"))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		values = append(values, databaseInfo{Name: name})
	}
	sort.Slice(values, func(first, second int) bool { return values[first].Name < values[second].Name })
	return values, nil
}

func databaseInfoFromQueryRows(rows [][]any) []databaseInfo {
	values := make([]databaseInfo, 0, len(rows))
	seen := map[string]bool{}
	for _, row := range rows {
		name := firstRowValue(row)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		values = append(values, databaseInfo{Name: name})
	}
	sort.Slice(values, func(first, second int) bool { return values[first].Name < values[second].Name })
	return values
}

func (server *server) listSchemas(visibleSchemas []string) ([]string, error) {
	if visibleSchemas != nil && len(visibleSchemas) == 0 {
		return []string{}, nil
	}
	databases, err := server.listDatabases()
	if err != nil {
		return nil, err
	}
	visible := map[string]bool{}
	for _, schema := range visibleSchemas {
		visible[schema] = true
	}
	values := make([]string, 0, len(databases))
	for _, database := range databases {
		if visibleSchemas != nil && !visible[database.Name] {
			continue
		}
		values = append(values, database.Name)
	}
	return values, nil
}

func (server *server) listTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	schema = firstNonEmpty(schema, server.config.Database)
	requestedTypes := hiveTableTypes(constraints.ObjectTypes)
	if len(constraints.ObjectTypes) > 0 && len(requestedTypes) == 0 {
		return []tableInfo{}, nil
	}
	metadataResult, metadataErr := server.hiveMetadata(func(ctx context.Context, provider gohive.MetadataProvider) (gohive.MetadataResult, error) {
		return provider.GetHiveTables(ctx, schema, "%", requestedTypes)
	})
	if metadataErr == nil {
		rows := newHiveMetadataRows(metadataResult)
		values := make([]tableInfo, 0, len(rows.rows))
		for _, row := range rows.rows {
			name := metadataString(rows.value(row, "TABLE_NAME"))
			if name == "" || !metadataNameMatches(name, constraints.Filter) {
				continue
			}
			values = append(values, tableInfo{
				Name:      name,
				TableType: normalizeHiveTableType(metadataString(rows.value(row, "TABLE_TYPE"))),
				Comment:   optionalString(metadataString(rows.value(row, "REMARKS", "COMMENT"))),
			})
		}
		sort.Slice(values, func(first, second int) bool { return values[first].Name < values[second].Name })
		return applyMetadataWindow(values, constraints.Offset, constraints.Limit), nil
	}
	type fallbackQuery struct {
		operation  string
		statement  string
		objectType string
	}
	fallbackQueries := make([]fallbackQuery, 0, 2)
	if containsString(requestedTypes, "TABLE") {
		fallbackQueries = append(fallbackQueries, fallbackQuery{
			operation:  "SHOW TABLES",
			statement:  "SHOW TABLES IN " + quoteHiveIdentifier(schema),
			objectType: "TABLE",
		})
	}
	if containsString(requestedTypes, "VIEW") || containsString(requestedTypes, "MATERIALIZED VIEW") {
		fallbackQueries = append(fallbackQueries, fallbackQuery{
			operation:  "SHOW VIEWS",
			statement:  "SHOW VIEWS IN " + quoteHiveIdentifier(schema),
			objectType: "VIEW",
		})
	}
	objectsByName := make(map[string]tableInfo)
	tableFallbackSucceeded := false
	for _, fallback := range fallbackQueries {
		result, err := server.executeQuery(queryOptions{SQL: fallback.statement, MaxRows: metadataQueryLimit})
		if err != nil {
			// Older Hive and Impala versions can list tables but do not support SHOW VIEWS.
			// Keep the usable table result for mixed requests; explicit view requests still fail.
			if fallback.objectType == "VIEW" && tableFallbackSucceeded && showViewsUnsupported(err) {
				continue
			}
			return nil, fmt.Errorf("HiveServer2 metadata failed (%v); %s fallback failed: %w", metadataErr, fallback.operation, err)
		}
		if fallback.objectType == "TABLE" {
			tableFallbackSucceeded = true
		}
		for _, row := range result.Rows {
			name := showTablesRowName(result.Columns, row)
			if name == "" || !metadataNameMatches(name, constraints.Filter) {
				continue
			}
			candidate := tableInfo{Name: name, TableType: fallback.objectType, Comment: nil}
			if existing, ok := objectsByName[name]; ok && existing.TableType == "VIEW" && candidate.TableType != "VIEW" {
				continue
			}
			objectsByName[name] = candidate
		}
	}
	values := make([]tableInfo, 0, len(objectsByName))
	for _, value := range objectsByName {
		values = append(values, value)
	}
	sort.Slice(values, func(first, second int) bool { return values[first].Name < values[second].Name })
	return applyMetadataWindow(values, constraints.Offset, constraints.Limit), nil
}

func showViewsUnsupported(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	message := strings.ToLower(err.Error())
	operationalMarkers := []string{
		"permission",
		"access denied",
		"not authorized",
		"unauthorized",
		"authentication",
		"authorization",
		"timeout",
		"timed out",
		"deadline exceeded",
		"cancelled",
		"canceled",
		"transport",
		"connection",
		"broken pipe",
		"network",
	}
	for _, marker := range operationalMarkers {
		if strings.Contains(message, marker) {
			return false
		}
	}
	explicitMarkers := []string{
		"unsupported",
		"not supported",
		"not implemented",
		"unknown statement",
		"unrecognized statement",
	}
	for _, marker := range explicitMarkers {
		if strings.Contains(message, marker) {
			return true
		}
	}
	parseMarkers := []string{
		"parseexception",
		"parse error",
		"syntax error",
		"mismatched input",
		"cannot recognize input",
		"no viable alternative",
	}
	for _, marker := range parseMarkers {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

func (server *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	if !acceptsHiveTable(constraints.ObjectTypes) && !(server.supportsRoutines() && acceptsHiveRoutine(constraints.ObjectTypes)) {
		return []objectInfo{}, nil
	}
	schema = firstNonEmpty(schema, server.config.Database)
	values := make([]objectInfo, 0)
	if acceptsHiveTable(constraints.ObjectTypes) {
		tables, err := server.listTables(schema, constraints)
		if err != nil {
			return nil, err
		}
		for _, table := range tables {
			values = append(values, objectInfo{Name: table.Name, ObjectType: table.TableType, Schema: schema, Comment: table.Comment})
		}
	}
	if server.supportsRoutines() && acceptsRoutineType(constraints.ObjectTypes, "PROCEDURE") {
		procedures, err := server.listRoutines(schema, constraints, "PROCEDURE")
		if err != nil {
			return nil, err
		}
		values = append(values, procedures...)
	}
	if server.supportsRoutines() && acceptsRoutineType(constraints.ObjectTypes, "FUNCTION") {
		functions, err := server.listRoutines(schema, constraints, "FUNCTION")
		if err != nil {
			return nil, err
		}
		values = append(values, functions...)
	}
	sort.Slice(values, func(first, second int) bool { return values[first].Name < values[second].Name })
	return applyMetadataWindow(values, constraints.Offset, constraints.Limit), nil
}

// supportsRoutines reports whether the connected server is known to expose the
// Hive procedure / function catalog views (system.procedures_v /
// system.functions_v). ArgoDB / Inceptor / Transwarp forks ship these views;
// vanilla Apache Hive does not, so routine listing is gated on the connection's
// database_type to avoid firing unsupported queries against plain Hive.
func (server *server) supportsRoutines() bool {
	switch strings.ToLower(strings.TrimSpace(server.params.DatabaseType)) {
	case "argo", "inceptor", "inceptor2", "transwarp":
		return true
	default:
		return false
	}
}

// listRoutines queries the server's procedure / function catalog views when the
// driver supports them. Hive and most forks (ArgoDB, Inceptor, Transwarp) expose
// stored procedures / functions through the system.procedures_v / system.functions_v
// views, with columns (procedure_name | function_name, database_name, full_text, ...).
// The full_text column carries the routine source used by getObjectSource.
//
// The query is best-effort: when the view is missing or the server rejects it
// (older Hive without procedure support), the call returns an empty slice and
// nil error so the caller can fall back to listing tables.
func (server *server) listRoutines(schema string, constraints metadataListConstraints, routineType string) ([]objectInfo, error) {
	nameColumn := "procedure_name"
	viewName := "system.procedures_v"
	if strings.EqualFold(routineType, "FUNCTION") {
		nameColumn = "function_name"
		viewName = "system.functions_v"
	}
	// Routine listings are pinned to the active schema (or the connection's default
	// database when the caller passes an empty schema). system.procedures_v /
	// system.functions_v only contain rows for one specific database per query;
	// there is no wildcard form. Falling back to the connection default keeps
	// callers like the sidebar schema tree happy when they pass "" as the schema.
	targetSchema := firstNonEmpty(schema, server.config.Database)
	likePattern := buildRoutineLikePattern(constraints.Filter)
	// database_name is a string column, so the schema filter must be a single-quoted
	// literal — not a backtick-quoted identifier. ArgoDB/Inceptor reject lower(`ods`)
	// against system.procedures_v with an ERROR_STATUS, while lower('ods') works.
	schemaLiteral := "'" + strings.ReplaceAll(targetSchema, "'", "''") + "'"
	sql := "SELECT " + nameColumn + " FROM " + viewName +
		" WHERE lower(database_name) = lower(" + schemaLiteral + ")" +
		" AND lower(" + nameColumn + ") LIKE " + likePattern +
		" ORDER BY " + nameColumn
	result, err := server.executeQuery(queryOptions{SQL: sql, MaxRows: metadataQueryLimit})
	if err != nil {
		// View missing or not supported — silently return empty list.
		return []objectInfo{}, nil
	}
	values := make([]objectInfo, 0, len(result.Rows))
	for _, row := range result.Rows {
		name := rowString(row, 0)
		if name == "" {
			continue
		}
		values = append(values, objectInfo{Name: name, ObjectType: strings.ToUpper(routineType), Schema: schema, Comment: nil})
	}
	return values, nil
}

// buildRoutineLikePattern turns a user-supplied filter into a Hive-safe LIKE
// literal: wraps with %, escapes \, %, _ (the LIKE metacharacters), and quotes
// the whole literal so it can be concatenated directly into SQL.
func buildRoutineLikePattern(filter string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(filter)
	return "'%" + escaped + "%'"
}

// acceptsHiveRoutine reports whether the requested object types include any
// routine (PROCEDURE / FUNCTION) that hive-go needs to surface through listObjects.
func acceptsHiveRoutine(objectTypes []string) bool {
	for _, objectType := range objectTypes {
		if strings.EqualFold(objectType, "PROCEDURE") || strings.EqualFold(objectType, "FUNCTION") {
			return true
		}
	}
	return false
}

// acceptsRoutineType reports whether the requested object types include the
// given routine kind (case-insensitive).
func acceptsRoutineType(objectTypes []string, routineType string) bool {
	for _, objectType := range objectTypes {
		if strings.EqualFold(objectType, routineType) {
			return true
		}
	}
	return false
}

func (server *server) getColumns(schema, table string) ([]columnInfo, error) {
	if strings.TrimSpace(table) == "" {
		return nil, errors.New("table is required")
	}
	schema = firstNonEmpty(schema, server.config.Database)
	metadataResult, metadataErr := server.hiveMetadata(func(ctx context.Context, provider gohive.MetadataProvider) (gohive.MetadataResult, error) {
		return provider.GetHiveColumns(ctx, schema, table, "%")
	})
	if metadataErr == nil {
		rows := newHiveMetadataRows(metadataResult)
		values := make([]columnInfo, 0, len(rows.rows))
		for _, row := range rows.rows {
			name := metadataString(rows.value(row, "COLUMN_NAME"))
			if name == "" {
				continue
			}
			dataType := metadataString(rows.value(row, "TYPE_NAME"))
			columnSize := metadataIntPointer(rows.value(row, "COLUMN_SIZE"))
			values = append(values, columnInfo{
				Name:                   name,
				DataType:               dataType,
				IsNullable:             metadataNullable(rows.value(row, "NULLABLE", "IS_NULLABLE")),
				ColumnDefault:          optionalString(metadataString(rows.value(row, "COLUMN_DEF"))),
				Comment:                optionalString(metadataString(rows.value(row, "REMARKS", "COMMENT"))),
				NumericPrecision:       columnSize,
				NumericScale:           metadataIntPointer(rows.value(row, "DECIMAL_DIGITS")),
				CharacterMaximumLength: characterLengthForType(dataType, columnSize),
			})
		}
		return values, nil
	}
	qualified := qualifiedHiveName(schema, table)
	result, err := server.executeQuery(queryOptions{SQL: "DESCRIBE " + qualified, MaxRows: metadataQueryLimit})
	if err != nil {
		return nil, fmt.Errorf("HiveServer2 metadata failed (%v); DESCRIBE fallback failed: %w", metadataErr, err)
	}
	values := make([]columnInfo, 0, len(result.Rows))
	for _, row := range result.Rows {
		name := rowString(row, 0)
		if name == "" || strings.HasPrefix(name, "#") {
			continue
		}
		dataType := rowString(row, 1)
		comment := optionalString(rowString(row, 2))
		values = append(values, columnInfo{
			Name:       name,
			DataType:   dataType,
			IsNullable: true,
			Comment:    comment,
		})
	}
	return values, nil
}

func (server *server) getTableComment(schema, table string) (*string, error) {
	if strings.TrimSpace(table) == "" {
		return nil, errors.New("table is required")
	}
	schema = firstNonEmpty(schema, server.config.Database)
	metadataResult, err := server.hiveMetadata(func(ctx context.Context, provider gohive.MetadataProvider) (gohive.MetadataResult, error) {
		return provider.GetHiveTables(ctx, schema, table, nil)
	})
	if err != nil {
		tables, listErr := server.listTables(schema, metadataListConstraints{Filter: table})
		if listErr != nil {
			return nil, fmt.Errorf("HiveServer2 table comment metadata failed (%v); table listing fallback failed: %w", err, listErr)
		}
		for _, candidate := range tables {
			if strings.EqualFold(candidate.Name, table) {
				return candidate.Comment, nil
			}
		}
		return nil, nil
	}
	rows := newHiveMetadataRows(metadataResult)
	for _, row := range rows.rows {
		if strings.EqualFold(metadataString(rows.value(row, "TABLE_NAME")), table) {
			return optionalString(metadataString(rows.value(row, "REMARKS", "COMMENT"))), nil
		}
	}
	return nil, nil
}

func (server *server) listDataTypes() ([]string, error) {
	metadataResult, err := server.hiveMetadata(func(ctx context.Context, provider gohive.MetadataProvider) (gohive.MetadataResult, error) {
		return provider.GetHiveTypeInfo(ctx)
	})
	if err != nil {
		return hiveDataTypes(), nil
	}
	rows := newHiveMetadataRows(metadataResult)
	values := make([]string, 0, len(rows.rows))
	seen := map[string]bool{}
	for _, row := range rows.rows {
		name := strings.ToLower(metadataString(rows.value(row, "TYPE_NAME")))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		values = append(values, name)
	}
	if len(values) == 0 {
		return hiveDataTypes(), nil
	}
	sort.Strings(values)
	return values, nil
}

func (server *server) getTableDDL(schema, table string) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", errors.New("table is required")
	}
	result, err := server.executeQuery(queryOptions{
		SQL:     "SHOW CREATE TABLE " + qualifiedHiveName(schema, table),
		MaxRows: metadataQueryLimit,
	})
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(result.Rows))
	for _, row := range result.Rows {
		if line := firstRowValue(row); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return "", nil
	}
	return strings.Join(lines, "\n") + "\n", nil
}

func (server *server) getObjectSource(schema, name, objectType string) (objectSource, error) {
	schema = firstNonEmpty(schema, server.config.Database)
	var source string
	var err error
	switch strings.ToUpper(objectType) {
	case "PROCEDURE", "FUNCTION":
		if !server.supportsRoutines() {
			return objectSource{}, fmt.Errorf("routine source is not supported for %s connections", server.params.DatabaseType)
		}
		source, err = server.getRoutineSource(schema, name, strings.ToUpper(objectType))
	default:
		source, err = server.getTableDDL(schema, name)
	}
	if err != nil {
		return objectSource{}, err
	}
	return objectSource{
		Name:       name,
		ObjectType: strings.ToUpper(objectType),
		Schema:     optionalString(schema),
		Source:     source,
	}, nil
}

// getRoutineSource fetches a procedure or function's full source from the
// server's system.procedures_v / system.functions_v view. Returns an empty
// string when the view is missing or the routine is not found, so callers can
// fall back to other sources. full_text may span multiple rows (the underlying
// query driver splits long strings), so we join them like getTableDDL does.
func (server *server) getRoutineSource(schema, name, routineType string) (string, error) {
	nameColumn := "procedure_name"
	viewName := "system.procedures_v"
	if strings.EqualFold(routineType, "FUNCTION") {
		nameColumn = "function_name"
		viewName = "system.functions_v"
	}
	sql := "SELECT full_text FROM " + viewName +
		" WHERE lower(database_name) = lower('" + strings.ReplaceAll(schema, "'", "''") + "')" +
		" AND " + nameColumn + " = '" + strings.ReplaceAll(name, "'", "''") + "'"
	result, err := server.executeQuery(queryOptions{SQL: sql, MaxRows: metadataQueryLimit})
	if err != nil {
		return "", nil
	}
	lines := make([]string, 0, len(result.Rows))
	for _, row := range result.Rows {
		if line := firstRowValue(row); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return "", nil
	}
	return strings.Join(lines, "\n") + "\n", nil
}

func (server *server) getExplainInfo(sqlText string) (string, error) {
	sqlText = trimStatementSQL(sqlText)
	if sqlText == "" {
		return "", errors.New("SQL is required")
	}
	result, err := server.executeQuery(queryOptions{SQL: "EXPLAIN " + sqlText, MaxRows: metadataQueryLimit})
	if err != nil {
		return "", err
	}
	lines := make([]string, 0, len(result.Rows))
	for _, row := range result.Rows {
		lines = append(lines, firstRowValue(row))
	}
	return strings.Join(lines, "\n"), nil
}

func (server *server) completionAssistantSearch(input completionAssistantRequest) (completionAssistantResponse, error) {
	maxResults := input.MaxResults
	if maxResults <= 0 {
		maxResults = 200
	}
	schemas := []string{firstNonEmpty(input.Schema, input.Database, server.config.Database)}
	if input.GlobalSearch {
		listed, err := server.listSchemas(nil)
		if err != nil {
			return completionAssistantResponse{}, err
		}
		schemas = listed
	}
	values := make([]completionAssistantCandidate, 0, maxResults)
	incomplete := false
	for _, schema := range schemas {
		tables, err := server.listTables(schema, metadataListConstraints{Limit: maxResults})
		if err != nil {
			return completionAssistantResponse{}, err
		}
		for _, table := range tables {
			if !completionNameMatches(table.Name, input) {
				continue
			}
			schemaCopy := schema
			values = append(values, completionAssistantCandidate{
				Name: table.Name, Kind: "table", Database: &schemaCopy, Schema: &schemaCopy, Comment: table.Comment,
			})
			if len(values) >= maxResults {
				incomplete = true
				break
			}
		}
		if len(values) >= maxResults {
			break
		}
	}
	return completionAssistantResponse{Candidates: values, Incomplete: incomplete, FallbackUsed: false}, nil
}

func metadataListConstraintsFromParams(params map[string]json.RawMessage) metadataListConstraints {
	return metadataListConstraints{
		Filter:      stringParam(params, "filter"),
		Limit:       intParam(params, "limit"),
		Offset:      intParam(params, "offset"),
		ObjectTypes: stringSliceParam(params, "objectTypes"),
	}
}

func qualifiedHiveName(schema, table string) string {
	if strings.TrimSpace(schema) == "" {
		return quoteHiveIdentifier(table)
	}
	return quoteHiveIdentifier(schema) + "." + quoteHiveIdentifier(table)
}

func metadataNameMatches(name, filter string) bool {
	return filter == "" || strings.Contains(strings.ToLower(name), strings.ToLower(filter))
}

func acceptsHiveTable(objectTypes []string) bool {
	if len(objectTypes) == 0 {
		return true
	}
	for _, objectType := range objectTypes {
		if strings.EqualFold(objectType, "table") || strings.EqualFold(objectType, "view") || strings.EqualFold(objectType, "materialized view") {
			return true
		}
	}
	return false
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func hiveTableTypes(objectTypes []string) []string {
	if len(objectTypes) == 0 {
		return []string{"TABLE", "VIEW", "MATERIALIZED VIEW"}
	}
	values := make([]string, 0, len(objectTypes))
	seen := map[string]bool{}
	for _, objectType := range objectTypes {
		normalized := strings.ToUpper(strings.TrimSpace(objectType))
		switch normalized {
		case "TABLE", "EXTERNAL TABLE", "MANAGED TABLE":
			normalized = "TABLE"
		case "VIEW":
			normalized = "VIEW"
		case "MATERIALIZED VIEW", "MATERIALIZED_VIEW":
			normalized = "MATERIALIZED VIEW"
		default:
			continue
		}
		if !seen[normalized] {
			seen[normalized] = true
			values = append(values, normalized)
		}
	}
	return values
}

func normalizeHiveTableType(value string) string {
	if strings.Contains(strings.ToUpper(value), "VIEW") {
		return "VIEW"
	}
	return "TABLE"
}

func metadataString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case []byte:
		return strings.TrimSpace(string(typed))
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func metadataIntPointer(value any) *int {
	var parsed int64
	switch typed := value.(type) {
	case nil:
		return nil
	case int:
		parsed = int64(typed)
	case int8:
		parsed = int64(typed)
	case int16:
		parsed = int64(typed)
	case int32:
		parsed = int64(typed)
	case int64:
		parsed = typed
	case float32:
		parsed = int64(typed)
	case float64:
		parsed = int64(typed)
	default:
		value, err := strconv.ParseInt(metadataString(value), 10, 64)
		if err != nil {
			return nil
		}
		parsed = value
	}
	if parsed < 0 || parsed > int64(^uint(0)>>1) {
		return nil
	}
	converted := int(parsed)
	return &converted
}

func metadataNullable(value any) bool {
	if parsed := metadataIntPointer(value); parsed != nil {
		return *parsed != 0
	}
	switch strings.ToUpper(metadataString(value)) {
	case "NO", "FALSE", "NOT NULL":
		return false
	default:
		return true
	}
}

func characterLengthForType(dataType string, size *int) *int {
	normalized := strings.ToLower(dataType)
	if strings.Contains(normalized, "char") || strings.Contains(normalized, "text") || strings.Contains(normalized, "string") {
		return size
	}
	return nil
}

func applyMetadataWindow[T any](values []T, offset, limit int) []T {
	if offset < 0 {
		offset = 0
	}
	if offset >= len(values) {
		return []T{}
	}
	end := len(values)
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return values[offset:end]
}

func completionNameMatches(name string, input completionAssistantRequest) bool {
	mask := input.Mask
	if mask == "" {
		return true
	}
	if !input.CaseSensitive {
		name = strings.ToLower(name)
		mask = strings.ToLower(mask)
	}
	switch strings.ToLower(input.MatchMode) {
	case "exact":
		return name == mask
	case "prefix":
		return strings.HasPrefix(name, mask)
	default:
		return strings.Contains(name, mask)
	}
}

func firstRowValue(row []any) string {
	for _, value := range row {
		if text := stringValue(value); text != "" {
			return text
		}
	}
	return ""
}

func showTablesRowName(columns []string, row []any) string {
	for index, column := range columns {
		normalized := strings.NewReplacer("_", "", "-", "", " ", "").Replace(strings.ToLower(column))
		if normalized == "tablename" || normalized == "tabname" {
			if value := rowString(row, index); value != "" {
				return value
			}
		}
	}
	if len(row) > 1 {
		if value := rowString(row, 1); value != "" {
			return value
		}
	}
	return firstRowValue(row)
}

func rowString(row []any, index int) string {
	if index < 0 || index >= len(row) {
		return ""
	}
	return strings.TrimSpace(stringValue(row[index]))
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
