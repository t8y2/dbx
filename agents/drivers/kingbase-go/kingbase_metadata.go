package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"gitea.com/kingbase/gokb"
)

const metadataTimeout = 15 * time.Second

// Escape '_' so only Kingbase internal SYS_/XLOG_ prefixes are hidden; names
// such as SYSTEMS and SYSLOG may be user-created schemas in MySQL mode.
const kingbaseMySQLCompatListSchemasSQL = `SELECT schema_name FROM information_schema.schemata WHERE UPPER(schema_name) <> 'INFORMATION_SCHEMA' AND UPPER(schema_name) NOT LIKE 'SYS\_%' ESCAPE '\' AND UPPER(schema_name) NOT LIKE 'XLOG\_%' ESCAPE '\' ORDER BY schema_name`

var kingbaseDataTypes = []string{
	"bigint", "bigserial", "bit", "bit varying", "boolean", "bytea", "char", "character",
	"character varying", "date", "decimal", "double precision", "integer", "interval", "json",
	"jsonb", "money", "numeric", "real", "smallint", "smallserial", "serial", "text", "time",
	"time with time zone", "timestamp", "timestamp with time zone", "uuid", "varchar", "xml",
}

type kingbaseMode struct {
	postgresCatalog   bool
	mysqlCompat       bool
	sqlServerIdentity bool
}

type databaseInfo struct {
	Name string `json:"name"`
}

type tableInfo struct {
	Name      string  `json:"name"`
	TableType string  `json:"table_type"`
	Comment   *string `json:"comment"`
}

type objectInfo struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     string  `json:"schema"`
	Comment    *string `json:"comment"`
	Valid      *bool   `json:"valid,omitempty"`
}

type metadataListConstraints struct {
	Filter      string
	Limit       int
	Offset      int
	ObjectTypes []string
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

func (i indexInfo) MarshalJSON() ([]byte, error) {
	type alias indexInfo
	value := alias(i)
	if value.Columns == nil {
		value.Columns = []string{}
	}
	if value.IncludedColumns == nil {
		value.IncludedColumns = []string{}
	}
	return json.Marshal(value)
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

func detectKingbaseMode(db *sql.DB, configuredMySQL bool) kingbaseMode {
	mode := kingbaseMode{mysqlCompat: configuredMySQL}
	if configuredMySQL {
		return mode
	}
	mode.postgresCatalog = !catalogExists(db, "sys_catalog.sys_namespace") && catalogExists(db, "pg_catalog.pg_namespace")
	if !mode.postgresCatalog {
		mode.mysqlCompat = detectMySQLCompatMode(db)
		mode.sqlServerIdentity = !mode.mysqlCompat && catalogExists(db, "sys.identity_columns")
	}
	return mode
}

func catalogExists(db *sql.DB, catalog string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, "SELECT 1 FROM "+catalog+" WHERE 1 = 0")
	if err != nil {
		return false
	}
	return rows.Close() == nil
}

func detectMySQLCompatMode(db *sql.DB) bool {
	var databaseMode string
	switch err := db.QueryRow("SELECT setting FROM sys_catalog.sys_settings WHERE LOWER(name) = 'database_mode'").Scan(&databaseMode); {
	case err == nil:
		// Treat database_mode as authoritative when the server exposes it. This
		// avoids misclassifying Oracle-compatible servers that also publish
		// sql_mode for MySQL syntax toggles such as ANSI_QUOTES.
		return strings.EqualFold(strings.TrimSpace(databaseMode), "mysql")
	case errors.Is(err, sql.ErrNoRows):
		// Older Kingbase versions may not expose database_mode. Fall back to the
		// legacy sql_mode existence probe in that case.
	default:
		// Ignore metadata errors and fall back to the legacy probe below.
	}
	return mysqlSQLModeExists(db)
}

func mysqlSQLModeExists(db *sql.DB) bool {
	var value int
	return db.QueryRow("SELECT 1 FROM sys_catalog.sys_settings WHERE LOWER(name) = 'sql_mode'").Scan(&value) == nil
}

func (s *server) identifierQuote() string {
	// Kingbase MySQL compatibility mode follows MySQL identifier quoting;
	// other modes retain the PostgreSQL-compatible double quote.
	if s.mode.mysqlCompat {
		return "`"
	}
	return `"`
}

func (s *server) connectionInfo() (map[string]any, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	var database, username, version, schema string
	err = db.QueryRow("SELECT current_database(), current_user, version(), current_schema()").Scan(&database, &username, &version, &schema)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"database": database, "username": username, "version": version, "schema": schema,
		"mysql_compat_mode": s.mode.mysqlCompat, "identifierQuote": s.identifierQuote(),
	}, nil
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	queries := []string{
		"SELECT datname FROM sys_catalog.sys_database WHERE NOT datistemplate AND datallowconn ORDER BY datname",
		"SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname",
		"SELECT current_database()",
	}
	for _, query := range queries {
		rows, err := s.metadataQuery(query)
		if err != nil {
			continue
		}
		result := []databaseInfo{}
		for rows.Next() {
			var name string
			if rows.Scan(&name) == nil {
				result = append(result, databaseInfo{Name: name})
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err == nil && len(result) > 0 {
			return result, nil
		}
	}
	return []databaseInfo{{Name: s.params.Database}}, nil
}

func (s *server) listSchemas(visible []string) ([]string, error) {
	query := "SELECT nspname FROM sys_catalog.sys_namespace WHERE nspname NOT LIKE 'sys_temp_%' AND nspname NOT LIKE 'sys_toast_temp_%' ORDER BY nspname"
	if s.mode.postgresCatalog {
		query = "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%' ORDER BY nspname"
	} else if s.mode.mysqlCompat {
		query = kingbaseMySQLCompatListSchemasSQL
	}
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	allowed := stringSet(visible)
	result := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		if len(allowed) == 0 || allowed[strings.ToLower(name)] {
			result = append(result, name)
		}
	}
	return result, rows.Err()
}

func (s *server) listTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	if !constraintsAllowsTableLike(constraints) {
		return []tableInfo{}, nil
	}
	catalog := "sys_catalog"
	if s.mode.postgresCatalog {
		catalog = "pg_catalog"
	}
	query := fmt.Sprintf(`SELECT c.relname,
CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'f' THEN 'FOREIGN_TABLE' ELSE 'TABLE' END,
obj_description(c.oid)
FROM %s.%s_class c
JOIN %s.%s_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, catalog, catalogPrefix(catalog), catalog, catalogPrefix(catalog), quoteLiteral(effective))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []tableInfo{}
	for rows.Next() {
		var name, kind string
		var comment sql.NullString
		if err := rows.Scan(&name, &kind, &comment); err != nil {
			return nil, err
		}
		item := tableInfo{Name: name, TableType: normalizeTableType(kind), Comment: nullStringPtr(comment)}
		if constraintsMatch(constraints, item.Name, item.TableType) {
			result = append(result, item)
		}
	}
	return pageTables(result, constraints), rows.Err()
}

func (s *server) getTableComment(schema, table string) (*string, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	catalog := "sys_catalog"
	if s.mode.postgresCatalog {
		catalog = "pg_catalog"
	}
	prefix := catalogPrefix(catalog)
	query := fmt.Sprintf(`SELECT obj_description(c.oid)
FROM %s.%s_class c
JOIN %s.%s_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relname = %s AND c.relkind IN ('r','p','v','m','f')
LIMIT 1`, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(table))
	var comment sql.NullString
	if err := s.requireDBQueryRow(query, &comment); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return nullStringPtr(comment), nil
}

func (s *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	tables, err := s.listTables(effective, metadataListConstraints{})
	if err != nil {
		return nil, err
	}
	result := make([]objectInfo, 0, len(tables))
	for _, table := range tables {
		result = append(result, objectInfo{Name: table.Name, ObjectType: table.TableType, Schema: effective, Comment: table.Comment})
	}
	if !s.mode.mysqlCompat {
		catalog := "sys_catalog"
		function := "sys"
		if s.mode.postgresCatalog {
			catalog, function = "pg_catalog", "pg"
		}
		query := fmt.Sprintf(`SELECT p.proname, CASE WHEN p.prorettype = 2278 THEN 'PROCEDURE' ELSE 'FUNCTION' END, d.description
FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid = p.pronamespace
LEFT JOIN %s.%s_description d ON d.objoid = p.oid AND d.objsubid = 0
WHERE n.nspname = %s ORDER BY p.proname`, catalog, function, catalog, function, catalog, function, quoteLiteral(effective))
		rows, queryErr := s.metadataQuery(query)
		if queryErr == nil {
			for rows.Next() {
				var name, kind string
				var comment sql.NullString
				if rows.Scan(&name, &kind, &comment) == nil {
					result = append(result, objectInfo{Name: name, ObjectType: kind, Schema: effective, Comment: nullStringPtr(comment)})
				}
			}
			_ = rows.Close()
		}
	}
	filtered := result[:0]
	for _, item := range result {
		if constraintsMatch(constraints, item.Name, item.ObjectType) {
			filtered = append(filtered, item)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		if objectOrder(filtered[i].ObjectType) != objectOrder(filtered[j].ObjectType) {
			return objectOrder(filtered[i].ObjectType) < objectOrder(filtered[j].ObjectType)
		}
		return filtered[i].Name < filtered[j].Name
	})
	return pageObjects(filtered, constraints), nil
}

func (s *server) completionAssistantSearch(request completionAssistantRequest) (completionAssistantResponse, error) {
	limit := request.MaxResults
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	kinds := stringSet(request.ObjectKinds)
	candidates := make([]completionAssistantCandidate, 0, limit+1)
	if kinds["column"] && request.ParentName != "" {
		schema := request.ParentSchema
		if schema == "" {
			schema = request.Schema
		}
		columns, err := s.getColumns(schema, request.ParentName)
		if err != nil {
			return completionAssistantResponse{}, err
		}
		for _, column := range columns {
			if !completionNameMatches(column.Name, request) {
				continue
			}
			dataType := column.DataType
			candidates = append(candidates, completionAssistantCandidate{
				Name: column.Name, Kind: "COLUMN", Schema: stringPtr(schema), ParentSchema: stringPtr(schema),
				ParentName: stringPtr(request.ParentName), Comment: column.Comment, DataType: &dataType,
			})
		}
	} else {
		schemas := []string{request.Schema}
		if request.GlobalSearch {
			visible, err := s.listSchemas(nil)
			if err != nil {
				return completionAssistantResponse{}, err
			}
			schemas = visible
		}
		objectTypes := request.ObjectKinds
		for _, schema := range schemas {
			objects, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: objectTypes})
			if err != nil {
				return completionAssistantResponse{}, err
			}
			for _, object := range objects {
				if !completionNameMatches(object.Name, request) {
					continue
				}
				candidates = append(candidates, completionAssistantCandidate{Name: object.Name, Kind: object.ObjectType, Schema: stringPtr(object.Schema), Comment: object.Comment})
				if len(candidates) > limit {
					return completionAssistantResponse{Candidates: candidates[:limit], Incomplete: true}, nil
				}
			}
		}
	}
	incomplete := len(candidates) > limit
	if incomplete {
		candidates = candidates[:limit]
	}
	if candidates == nil {
		candidates = []completionAssistantCandidate{}
	}
	return completionAssistantResponse{Candidates: candidates, Incomplete: incomplete}, nil
}

func completionNameMatches(name string, request completionAssistantRequest) bool {
	mask := request.Mask
	if mask == "" {
		return true
	}
	if !request.CaseSensitive {
		name = strings.ToLower(name)
		mask = strings.ToLower(mask)
	}
	if strings.EqualFold(request.MatchMode, "contains") {
		return strings.Contains(name, mask)
	}
	return strings.HasPrefix(name, mask)
}

func (s *server) getColumns(schema, table string) ([]columnInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	primary, _ := s.primaryKeys(effective, table)
	if s.mode.mysqlCompat {
		return s.informationSchemaColumns(effective, table, primary)
	}
	catalog, prefix := "sys_catalog", "sys"
	if s.mode.postgresCatalog {
		catalog, prefix = "pg_catalog", "pg"
		return s.queryCatalogColumns(effective, table, primary, catalog, prefix, "pg_get_expr")
	}
	expression := "sys_get_expr"
	if s.usePgDefaultExpression {
		expression = "pg_get_expr"
	}
	result, err := s.queryCatalogColumns(effective, table, primary, catalog, prefix, expression)
	if err != nil && expression == "sys_get_expr" && isUndefinedFunction(err, expression) {
		// Some V8R6 PostgreSQL-mode databases keep sys_catalog while adbin is
		// pg_node_tree. Cache the compatible function after the exact failure.
		s.usePgDefaultExpression = true
		return s.queryCatalogColumns(effective, table, primary, catalog, prefix, "pg_get_expr")
	}
	return result, err
}

func (s *server) queryCatalogColumns(
	schema, table string,
	primary map[string]bool,
	catalog, prefix, expression string,
) ([]columnInfo, error) {
	query := fmt.Sprintf(`SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
	%s(ad.adbin, ad.adrelid), col_description(a.attrelid, a.attnum),
	CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 THEN ((a.atttypmod - 4) >> 16) & 65535 END,
	CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 THEN (a.atttypmod - 4) & 65535 END,
	CASE WHEN t.typname IN ('varchar','bpchar') AND a.atttypmod > 0 THEN a.atttypmod - 4 END,
	a.attidentity
	FROM %s.%s_attribute a JOIN %s.%s_type t ON t.oid = a.atttypid
	JOIN %s.%s_class c ON c.oid = a.attrelid JOIN %s.%s_namespace n ON n.oid = c.relnamespace
	LEFT JOIN %s.%s_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = %s AND c.relname = %s AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, expression, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(schema), quoteLiteral(table))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []columnInfo{}
	for rows.Next() {
		var name, dataType string
		var nullable bool
		var defaultValue, comment, identity sql.NullString
		var precision, scale, length sql.NullInt64
		if err := rows.Scan(&name, &dataType, &nullable, &defaultValue, &comment, &precision, &scale, &length, &identity); err != nil {
			return nil, err
		}
		result = append(result, columnInfo{Name: name, DataType: dataType, IsNullable: nullable, ColumnDefault: nullStringPtr(defaultValue), IsPrimaryKey: primary[strings.ToLower(name)], Extra: kingbaseIdentityClause(identity.String), Comment: nullStringPtr(comment), NumericPrecision: nullIntPtr(precision), NumericScale: nullIntPtr(scale), CharacterMaximumLength: nullIntPtr(length)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if s.mode.sqlServerIdentity {
		s.applyIdentityMetadata(schema, table, result)
	}
	return result, nil
}

func isUndefinedFunction(err error, functionName string) bool {
	var driverError *gokb.Error
	undefined := errors.As(err, &driverError) && string(driverError.Code) == "42883"
	normalized := strings.ToLower(err.Error())
	undefined = undefined || strings.Contains(normalized, "does not exist") || strings.Contains(normalized, "不存在")
	return undefined && strings.Contains(normalized, strings.ToLower(functionName))
}

func (s *server) informationSchemaColumns(schema, table string, primary map[string]bool) ([]columnInfo, error) {
	query := `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
	col_description(a.attrelid, a.attnum), c.numeric_precision, c.numeric_scale, c.character_maximum_length
	FROM information_schema.columns c
	LEFT JOIN sys_catalog.sys_namespace n ON n.nspname = c.table_schema
	LEFT JOIN sys_catalog.sys_class rel ON rel.relnamespace = n.oid AND rel.relname = c.table_name
	LEFT JOIN sys_catalog.sys_attribute a ON a.attrelid = rel.oid AND a.attname = c.column_name AND a.attnum > 0 AND NOT a.attisdropped
	WHERE c.table_schema = ` + quoteLiteral(schema) + ` AND c.table_name = ` + quoteLiteral(table) + ` ORDER BY c.ordinal_position`
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []columnInfo{}
	for rows.Next() {
		var name, dataType, nullable string
		var defaultValue, comment sql.NullString
		var precision, scale, length sql.NullInt64
		if err := rows.Scan(&name, &dataType, &nullable, &defaultValue, &comment, &precision, &scale, &length); err != nil {
			return nil, err
		}
		if parsed := boundedVarcharLength(dataType); parsed != nil && !length.Valid {
			length = sql.NullInt64{Int64: int64(*parsed), Valid: true}
		}
		result = append(result, columnInfo{Name: name, DataType: dataType, IsNullable: strings.EqualFold(nullable, "YES"), ColumnDefault: nullStringPtr(defaultValue), IsPrimaryKey: primary[strings.ToLower(name)], Comment: nullStringPtr(comment), NumericPrecision: nullIntPtr(precision), NumericScale: nullIntPtr(scale), CharacterMaximumLength: nullIntPtr(length)})
	}
	return result, rows.Err()
}

func (s *server) listIndexes(schema, table string) ([]indexInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	catalog, prefix := "sys_catalog", "sys"
	if s.mode.postgresCatalog {
		catalog, prefix = "pg_catalog", "pg"
	}
	query := kingbaseListIndexesQuery(catalog, prefix, effective, table)
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byName := map[string]*indexInfo{}
	order := []string{}
	for rows.Next() {
		var name, kind, column string
		var unique, primary bool
		var ordinal int
		if err := rows.Scan(&name, &kind, &unique, &primary, &column, &ordinal); err != nil {
			return nil, err
		}
		item := byName[name]
		if item == nil {
			item = &indexInfo{Name: name, IsUnique: unique, IsPrimary: primary, IndexType: stringPtr(kind), Columns: []string{}, IncludedColumns: []string{}}
			byName[name] = item
			order = append(order, name)
		}
		item.Columns = append(item.Columns, column)
	}
	result := make([]indexInfo, 0, len(order))
	for _, name := range order {
		result = append(result, *byName[name])
	}
	return result, rows.Err()
}

func kingbaseListIndexesQuery(catalog, prefix, schema, table string) string {
	return fmt.Sprintf(`SELECT i.relname, am.amname, ix.indisunique, ix.indisprimary, a.attname, pos.n
FROM %s.%s_index ix JOIN %s.%s_class t ON t.oid = ix.indrelid
JOIN %s.%s_class i ON i.oid = ix.indexrelid JOIN %s.%s_namespace n ON n.oid = t.relnamespace
JOIN %s.%s_am am ON am.oid = i.relam
JOIN unnest(ix.indkey) WITH ORDINALITY AS pos(attnum,n) ON true
JOIN %s.%s_attribute a ON a.attrelid = t.oid AND a.attnum = pos.attnum
WHERE n.nspname = %s AND t.relname = %s ORDER BY i.relname, pos.n`, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(schema), quoteLiteral(table))
}

func (s *server) listForeignKeys(schema, table string) ([]foreignKeyInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	query := `SELECT fk.constraint_name, fk.column_name, pk.table_name, pk.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage fk ON fk.constraint_schema = tc.constraint_schema AND fk.constraint_name = tc.constraint_name AND fk.table_schema = tc.table_schema AND fk.table_name = tc.table_name
JOIN information_schema.referential_constraints rc ON rc.constraint_schema = tc.constraint_schema AND rc.constraint_name = tc.constraint_name
JOIN information_schema.key_column_usage pk ON pk.constraint_schema = rc.unique_constraint_schema AND pk.constraint_name = rc.unique_constraint_name AND pk.ordinal_position = fk.position_in_unique_constraint
WHERE tc.table_schema = ` + quoteLiteral(effective) + ` AND tc.table_name = ` + quoteLiteral(table) + ` AND tc.constraint_type = 'FOREIGN KEY' ORDER BY fk.constraint_name, fk.ordinal_position`
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []foreignKeyInfo{}
	for rows.Next() {
		var item foreignKeyInfo
		if err := rows.Scan(&item.Name, &item.Column, &item.RefTable, &item.RefColumn); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *server) listTriggers(schema, table string) ([]triggerInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	catalog, prefix := "sys_catalog", "sys"
	if s.mode.postgresCatalog {
		catalog, prefix = "pg_catalog", "pg"
	}
	query := fmt.Sprintf(`SELECT tg.tgname,
trim(trailing ',' FROM (CASE WHEN (tg.tgtype & 4) <> 0 THEN 'INSERT,' ELSE '' END || CASE WHEN (tg.tgtype & 8) <> 0 THEN 'DELETE,' ELSE '' END || CASE WHEN (tg.tgtype & 16) <> 0 THEN 'UPDATE,' ELSE '' END || CASE WHEN (tg.tgtype & 32) <> 0 THEN 'TRUNCATE,' ELSE '' END)), tg.tgtype
FROM %s.%s_trigger tg JOIN %s.%s_class c ON c.oid = tg.tgrelid JOIN %s.%s_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relname = %s AND NOT tg.tgisinternal ORDER BY tg.tgname`, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(table))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []triggerInfo{}
	for rows.Next() {
		var name, event string
		var triggerType int
		if err := rows.Scan(&name, &event, &triggerType); err != nil {
			return nil, err
		}
		result = append(result, triggerInfo{Name: name, Event: event, Timing: decodeTriggerTiming(triggerType)})
	}
	return result, rows.Err()
}

func (s *server) getObjectSource(schema, name, objectType string) (map[string]any, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	source := ""
	kind := strings.ToUpper(objectType)
	if kind == "VIEW" || kind == "MATERIALIZED_VIEW" {
		if s.mode.mysqlCompat {
			err = s.requireDBQueryRow("SELECT view_definition FROM information_schema.views WHERE table_schema = "+quoteLiteral(effective)+" AND table_name = "+quoteLiteral(name), &source)
		} else {
			catalog, prefix, function := "sys_catalog", "sys", "sys_get_viewdef"
			if s.mode.postgresCatalog {
				catalog, prefix, function = "pg_catalog", "pg", "pg_get_viewdef"
			}
			query := fmt.Sprintf("SELECT %s(c.oid) FROM %s.%s_class c JOIN %s.%s_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relname=%s LIMIT 1", function, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(name))
			err = s.requireDBQueryRow(query, &source)
		}
	} else if kind == "FUNCTION" || kind == "PROCEDURE" {
		catalog, prefix, function := "sys_catalog", "sys", "sys_get_functiondef"
		if s.mode.postgresCatalog {
			catalog, prefix, function = "pg_catalog", "pg", "pg_get_functiondef"
		}
		query := fmt.Sprintf("SELECT %s(p.oid) FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid=p.pronamespace WHERE n.nspname=%s AND p.proname=%s ORDER BY CASE WHEN p.prorettype=2278 THEN 0 ELSE 1 END LIMIT 1", function, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(name))
		err = s.requireDBQueryRow(query, &source)
	}
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	return map[string]any{"name": name, "object_type": objectType, "schema": effective, "source": source}, nil
}

func (s *server) getTableDDL(schema, table string) (string, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return "", err
	}
	columns, err := s.getColumns(effective, table)
	if err != nil {
		return "", err
	}
	tableComment, _ := s.getTableComment(effective, table)
	return renderTableDDL(effective, table, columns, tableComment), nil
}

func renderTableDDL(schema, table string, columns []columnInfo, tableComment *string) string {
	definitions := make([]string, 0, len(columns)+1)
	primary := []string{}
	for _, column := range columns {
		definitions = append(definitions, columnDDLDefinition(column))
		if column.IsPrimaryKey {
			primary = append(primary, quoteIdentifier(column.Name))
		}
	}
	if len(primary) > 0 {
		definitions = append(definitions, "PRIMARY KEY ("+strings.Join(primary, ", ")+")")
	}
	qualifiedTable := quoteIdentifier(schema) + "." + quoteIdentifier(table)
	ddl := "CREATE TABLE " + qualifiedTable + " (\n  " + strings.Join(definitions, ",\n  ") + "\n);"
	if tableComment != nil && strings.TrimSpace(*tableComment) != "" {
		ddl += "\nCOMMENT ON TABLE " + qualifiedTable + " IS " + quoteLiteral(*tableComment) + ";"
	}
	for _, column := range columns {
		if column.Comment == nil || strings.TrimSpace(*column.Comment) == "" {
			continue
		}
		ddl += "\nCOMMENT ON COLUMN " + qualifiedTable + "." + quoteIdentifier(column.Name) + " IS " + quoteLiteral(*column.Comment) + ";"
	}
	return ddl
}

func columnDDLDefinition(column columnInfo) string {
	definition := quoteIdentifier(column.Name) + " " + column.DataType
	if column.Extra != nil && *column.Extra != "" {
		// Identity clauses belong immediately after the data type in both
		// PostgreSQL-compatible and SQL Server-compatible Kingbase modes.
		definition += " " + *column.Extra
	}
	if !column.IsNullable {
		definition += " NOT NULL"
	}
	if column.ColumnDefault != nil && *column.ColumnDefault != "" {
		definition += " DEFAULT " + *column.ColumnDefault
	}
	return definition
}

func kingbaseIdentityClause(code string) *string {
	var clause string
	switch strings.ToLower(strings.TrimSpace(code)) {
	case "a":
		clause = "GENERATED ALWAYS AS IDENTITY"
	case "d":
		clause = "GENERATED BY DEFAULT AS IDENTITY"
	default:
		return nil
	}
	return &clause
}

func (s *server) getExplainInfo(sqlText string) (string, error) {
	rows, err := s.metadataQuery("EXPLAIN " + trimStatementSQL(sqlText))
	if err != nil {
		return "", err
	}
	defer rows.Close()
	lines := []string{}
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return "", err
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n"), rows.Err()
}

func (s *server) metadataQuery(query string) (*sql.Rows, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	// These are bounded, internally generated statements. Calling Query without
	// arguments keeps gokb on its single-round-trip simple-query path.
	return db.Query(query)
}

func (s *server) requireDBQueryRow(query string, destination ...any) error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), metadataTimeout)
	defer cancel()
	return db.QueryRowContext(ctx, query).Scan(destination...)
}

func (s *server) effectiveSchema(schema string) (string, error) {
	if strings.TrimSpace(schema) != "" {
		return strings.TrimSpace(schema), nil
	}
	var current sql.NullString
	if err := s.requireDBQueryRow("SELECT current_schema()", &current); err == nil && current.Valid && current.String != "" {
		return current.String, nil
	}
	if s.params.Username != "" {
		return s.params.Username, nil
	}
	return "public", nil
}

func (s *server) primaryKeys(schema, table string) (map[string]bool, error) {
	query := `SELECT kcu.column_name FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema AND kcu.table_name=tc.table_name
WHERE tc.table_schema=` + quoteLiteral(schema) + ` AND tc.table_name=` + quoteLiteral(table) + ` AND tc.constraint_type='PRIMARY KEY' ORDER BY kcu.ordinal_position`
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		result[strings.ToLower(name)] = true
	}
	return result, rows.Err()
}

func (s *server) applyIdentityMetadata(schema, table string, columns []columnInfo) {
	query := `SELECT a.attname, ic.seed_value, ic.increment_value FROM sys.identity_columns ic
JOIN sys_catalog.sys_class c ON c.oid=ic.object_id JOIN sys_catalog.sys_namespace n ON n.oid=c.relnamespace
JOIN sys_catalog.sys_attribute a ON a.attrelid=c.oid AND a.attnum=ic.column_id
WHERE n.nspname=` + quoteLiteral(schema) + ` AND c.relname=` + quoteLiteral(table)
	rows, err := s.metadataQuery(query)
	if err != nil {
		s.mode.sqlServerIdentity = false
		return
	}
	defer rows.Close()
	byName := map[string]*columnInfo{}
	for i := range columns {
		byName[strings.ToLower(columns[i].Name)] = &columns[i]
	}
	for rows.Next() {
		var name string
		var seed, increment sql.NullString
		if rows.Scan(&name, &seed, &increment) == nil {
			if column := byName[strings.ToLower(name)]; column != nil {
				extra := "IDENTITY"
				if seed.Valid && increment.Valid {
					extra = "IDENTITY(" + seed.String + "," + increment.String + ")"
				}
				column.Extra = &extra
			}
		}
	}
}

func catalogPrefix(catalog string) string {
	if catalog == "pg_catalog" {
		return "pg"
	}
	return "sys"
}

func normalizeTableType(value string) string {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), " ", "_"))
	switch normalized {
	case "BASE_TABLE", "PARTITIONED_TABLE":
		return "TABLE"
	case "MATERIALIZED_VIEW", "FOREIGN_TABLE", "VIEW", "TABLE":
		return normalized
	default:
		return "TABLE"
	}
}

func decodeTriggerTiming(triggerType int) string {
	if triggerType&(1<<6) != 0 {
		return "INSTEAD OF"
	}
	if triggerType&(1<<1) != 0 {
		return "BEFORE"
	}
	return "AFTER"
}

func boundedVarcharLength(dataType string) *int {
	lower := strings.ToLower(strings.TrimSpace(dataType))
	for _, prefix := range []string{"varchar", "character varying"} {
		if strings.HasPrefix(lower, prefix) {
			value := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(lower, prefix), ")"))
			value = strings.TrimPrefix(value, "(")
			if number, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && number >= 0 {
				return &number
			}
		}
	}
	return nil
}

func constraintsAllowsTableLike(constraints metadataListConstraints) bool {
	if len(constraints.ObjectTypes) == 0 {
		return true
	}
	for _, kind := range constraints.ObjectTypes {
		switch normalizeTableType(kind) {
		case "TABLE", "VIEW", "MATERIALIZED_VIEW", "FOREIGN_TABLE":
			return true
		}
	}
	return false
}

func constraintsMatch(constraints metadataListConstraints, name, kind string) bool {
	if filter := strings.TrimSpace(constraints.Filter); filter != "" && !strings.Contains(strings.ToLower(name), strings.ToLower(filter)) {
		return false
	}
	if len(constraints.ObjectTypes) == 0 {
		return true
	}
	for _, allowed := range constraints.ObjectTypes {
		if strings.EqualFold(normalizeTableType(allowed), normalizeTableType(kind)) || strings.EqualFold(allowed, kind) {
			return true
		}
	}
	return false
}

func pageTables(items []tableInfo, constraints metadataListConstraints) []tableInfo {
	start, end := pageBounds(len(items), constraints.Offset, constraints.Limit)
	return items[start:end]
}

func pageObjects(items []objectInfo, constraints metadataListConstraints) []objectInfo {
	start, end := pageBounds(len(items), constraints.Offset, constraints.Limit)
	return items[start:end]
}

func pageBounds(length, offset, limit int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if offset > length {
		offset = length
	}
	end := length
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	return offset, end
}

func objectOrder(kind string) int {
	switch strings.ToUpper(kind) {
	case "TABLE":
		return 0
	case "VIEW":
		return 1
	case "MATERIALIZED_VIEW":
		return 2
	case "FOREIGN_TABLE":
		return 3
	case "PROCEDURE":
		return 4
	case "FUNCTION":
		return 5
	default:
		return 9
	}
}

func stringSet(values []string) map[string]bool {
	result := map[string]bool{}
	for _, value := range values {
		result[strings.ToLower(value)] = true
	}
	return result
}

func nullStringPtr(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullIntPtr(value sql.NullInt64) *int {
	if !value.Valid {
		return nil
	}
	converted := int(value.Int64)
	return &converted
}
