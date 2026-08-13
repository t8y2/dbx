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

const (
	kingbaseListDatabasesSQL         = "SELECT datname FROM sys_catalog.sys_database WHERE datallowconn AND LOWER(datname) NOT IN ('template0', 'template1') ORDER BY datname"
	kingbaseListDatabasesPostgresSQL = "SELECT datname FROM pg_catalog.pg_database WHERE datallowconn AND LOWER(datname) NOT IN ('template0', 'template1') ORDER BY datname"
)

// Escape '_' so only Kingbase internal SYS_/XLOG_ prefixes are hidden; use a
// non-backslash escape because MySQL mode treats backslash as a string escape.
const kingbaseMySQLCompatListSchemasSQL = `SELECT schema_name FROM information_schema.schemata WHERE UPPER(schema_name) <> 'INFORMATION_SCHEMA' AND UPPER(schema_name) NOT LIKE 'SYS#_%' ESCAPE '#' AND UPPER(schema_name) NOT LIKE 'XLOG#_%' ESCAPE '#' ORDER BY schema_name`

var kingbaseDataTypes = []string{
	"bigint", "bigserial", "bit", "bit varying", "boolean", "bytea", "char", "character",
	"character varying", "date", "decimal", "double precision", "integer", "interval", "json",
	"jsonb", "money", "numeric", "real", "smallint", "smallserial", "serial", "text", "time",
	"time with time zone", "timestamp", "timestamp with time zone", "uuid", "varchar", "xml",
}

type kingbaseMode struct {
	compatibilityMode string
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
	Name           string  `json:"name"`
	ObjectType     string  `json:"object_type"`
	Schema         string  `json:"schema"`
	Comment        *string `json:"comment"`
	Valid          *bool   `json:"valid,omitempty"`
	CustomTypeKind *string `json:"custom_type_kind,omitempty"`
	HasMembers     *bool   `json:"has_members,omitempty"`
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
	FullDataType           string  `json:"-"`
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
	if configuredMySQL {
		return kingbaseMode{compatibilityMode: "mysql", mysqlCompat: true}
	}
	mode := kingbaseMode{compatibilityMode: detectDatabaseMode(db)}
	mode.postgresCatalog = !catalogExists(db, "sys_catalog.sys_namespace") && catalogExists(db, "pg_catalog.pg_namespace")
	if !mode.postgresCatalog {
		if mode.compatibilityMode != "" {
			mode.mysqlCompat = mode.compatibilityMode == "mysql"
		} else {
			mode.mysqlCompat = supportsBacktickIdentifiers(db)
		}
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
	if databaseMode := detectDatabaseMode(db); databaseMode != "" {
		return databaseMode == "mysql"
	}
	return supportsBacktickIdentifiers(db)
}

func detectDatabaseMode(db *sql.DB) string {
	var databaseMode string
	switch err := db.QueryRow("SELECT setting FROM sys_catalog.sys_settings WHERE LOWER(name) = 'database_mode'").Scan(&databaseMode); {
	case err == nil:
		// Treat database_mode as authoritative when the server exposes it. This
		// avoids misclassifying Oracle-compatible servers that also publish
		// sql_mode for MySQL syntax toggles such as ANSI_QUOTES.
		return strings.ToLower(strings.TrimSpace(databaseMode))
	case errors.Is(err, sql.ErrNoRows):
		return ""
	default:
		return ""
	}
}

func supportsBacktickIdentifiers(db *sql.DB) bool {
	var value int
	return db.QueryRow("SELECT 1 AS `dbx_identifier_probe`").Scan(&value) == nil
}

func (s *server) identifierQuote() string {
	// Kingbase MySQL compatibility mode follows MySQL identifier quoting;
	// other modes retain the PostgreSQL-compatible double quote.
	if s.mode.mysqlCompat {
		return "`"
	}
	return `"`
}

// quoteDDLIdentifier quotes an identifier inside generated DDL using the mode's
// identifier quote. MySQL compatibility mode uses backticks (and backtick
// escaping); everything else keeps the PostgreSQL-compatible double quote, so
// schema/table names containing hyphens or other special characters render as
// valid SQL instead of being parsed as operators or bare tokens.
func (s *server) quoteDDLIdentifier(value string) string {
	if s.mode.mysqlCompat {
		return "`" + strings.ReplaceAll(value, "`", "``") + "`"
	}
	return quoteIdentifier(value)
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
		"compatibilityMode": s.mode.compatibilityMode, "mysql_compat_mode": s.mode.mysqlCompat,
		"identifierQuote": s.identifierQuote(),
	}, nil
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	queries := []string{
		kingbaseListDatabasesSQL,
		kingbaseListDatabasesPostgresSQL,
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

func kingbaseListSchemasSQL(mode kingbaseMode, showSystemSchemas bool) string {
	if mode.mysqlCompat {
		if showSystemSchemas {
			return "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"
		}
		return kingbaseMySQLCompatListSchemasSQL
	}
	if mode.postgresCatalog {
		if showSystemSchemas {
			return "SELECT nspname FROM pg_catalog.pg_namespace ORDER BY nspname"
		}
		return "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%' ORDER BY nspname"
	}
	if showSystemSchemas {
		return "SELECT nspname FROM sys_catalog.sys_namespace ORDER BY nspname"
	}
	return "SELECT nspname FROM sys_catalog.sys_namespace WHERE nspname NOT LIKE 'sys_temp_%' AND nspname NOT LIKE 'sys_toast_temp_%' ORDER BY nspname"
}

func (s *server) listSchemas(visible []string, showSystemSchemas bool) ([]string, error) {
	query := kingbaseListSchemasSQL(s.mode, showSystemSchemas)
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
	includeComment := !s.catalogOIDUnsupported
	rows, err := s.queryTables(effective, catalog, includeComment)
	if err != nil && includeComment && isUndefinedColumn(err, "c.oid") {
		s.catalogOIDUnsupported = true
		rows, err = s.queryTables(effective, catalog, false)
	}
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

func (s *server) queryTables(schema, catalog string, includeComment bool) (*sql.Rows, error) {
	commentExpression := "NULL AS table_comment"
	if includeComment {
		commentExpression = "obj_description(c.oid) AS table_comment"
	}
	query := fmt.Sprintf(`SELECT c.relname,
CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'f' THEN 'FOREIGN_TABLE' ELSE 'TABLE' END,
%s
FROM %s.%s_class c
JOIN %s.%s_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, commentExpression, catalog, catalogPrefix(catalog), catalog, catalogPrefix(catalog), quoteLiteral(schema))
	return s.metadataQuery(query)
}

func (s *server) getTableComment(schema, table string) (*string, error) {
	if s.catalogOIDUnsupported {
		return nil, nil
	}
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
		if isUndefinedColumn(err, "c.oid") {
			s.catalogOIDUnsupported = true
			return nil, nil
		}
		return nil, err
	}
	return nullStringPtr(comment), nil
}

// listCustomTypes lists user-defined types visible in the given schema.
//
// Only explicitly created types are returned: base types (b), standalone
// composite types (c), domains (d), enums (e), ranges (r) and multiranges (m).
// Relation auto-generated row types (table/view/materialized view/foreign
// table/partitioned table) are excluded via `typrelid = 0 OR relkind = 'c'`,
// and array companion types are excluded via `typelem = 0`. MySQL
// compatibility mode has no pg_type catalog contract and returns nothing.
//
// The comment join scopes description entries to the type catalog itself via
// a regclass cast. `t.tableoid` cannot be used because Kingbase's native
// sys_type catalog has no tableoid system column. Kingbase and Vastbase both
// key COMMENT ON TYPE entries with the pg_type identity (oid 1247) even when
// the server is in sys_catalog compatibility mode, so the filter always
// references pg_catalog.pg_type.
func (s *server) listCustomTypes(schema string) ([]objectInfo, error) {
	if s.mode.mysqlCompat {
		return []objectInfo{}, nil
	}
	catalog := "sys_catalog"
	if s.mode.postgresCatalog {
		catalog = "pg_catalog"
	}
	prefix := catalogPrefix(catalog)
	query := fmt.Sprintf(`SELECT t.typname, d.description, t.typtype::text,
CASE
  WHEN t.typtype = 'c' THEN EXISTS (
    SELECT 1 FROM %s.%s_attribute a
    WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
  )
  WHEN t.typtype = 'e' THEN EXISTS (
    SELECT 1 FROM %s.%s_enum e WHERE e.enumtypid = t.oid
  )
  ELSE false
END AS has_members
FROM %s.%s_type t
JOIN %s.%s_namespace n ON n.oid = t.typnamespace
LEFT JOIN %s.%s_class c ON c.oid = t.typrelid
LEFT JOIN %s.%s_description d ON d.objoid = t.oid AND d.classoid = 'pg_catalog.pg_type'::regclass AND d.objsubid = 0
WHERE n.nspname = %s
  AND t.typtype IN ('b','c','d','e','r','m')
  AND t.typisdefined
  AND t.typelem = 0
  AND (t.typrelid = 0 OR c.relkind = 'c')
  AND n.nspname <> 'pg_catalog'
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_toast%%'
  AND n.nspname NOT LIKE 'pg_temp%%'
ORDER BY t.typname`, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(schema))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []objectInfo{}
	for rows.Next() {
		var name, kindCode string
		var comment sql.NullString
		var hasMembers bool
		if err := rows.Scan(&name, &comment, &kindCode, &hasMembers); err != nil {
			return nil, err
		}
		kind, ok := customTypeKindFromCode(kindCode)
		if !ok {
			continue
		}
		kindValue := string(kind)
		result = append(result, objectInfo{Name: name, ObjectType: "TYPE", Schema: schema, Comment: nullStringPtr(comment), CustomTypeKind: &kindValue, HasMembers: &hasMembers})
	}
	return result, rows.Err()
}

func isSystemSchema(schema string) bool {
	return schema == "pg_catalog" || schema == "information_schema" || strings.HasPrefix(schema, "pg_toast") || strings.HasPrefix(schema, "pg_temp")
}

type customTypeKind string

const (
	customTypeKindBase       customTypeKind = "base"
	customTypeKindComposite  customTypeKind = "composite"
	customTypeKindDomain     customTypeKind = "domain"
	customTypeKindEnum       customTypeKind = "enum"
	customTypeKindRange      customTypeKind = "range"
	customTypeKindMultirange customTypeKind = "multirange"
)

type customTypeMember struct {
	Name      string  `json:"name"`
	DataType  string  `json:"dataType"`
	Ordinal   int32   `json:"ordinal"`
	Nullable  *bool   `json:"nullable,omitempty"`
	Default   *string `json:"default,omitempty"`
	Comment   *string `json:"comment,omitempty"`
	EnumValue *string `json:"enumValue,omitempty"`
}

type customTypeDomainConstraint struct {
	Name       string `json:"name"`
	Definition string `json:"definition"`
}

type customTypeProperties struct {
	BaseType                 *string                      `json:"baseType,omitempty"`
	NotNull                  *bool                        `json:"notNull,omitempty"`
	Default                  *string                      `json:"default,omitempty"`
	Collation                *string                      `json:"collation,omitempty"`
	DomainConstraints        []customTypeDomainConstraint `json:"domainConstraints"`
	RangeSubtype             *string                      `json:"rangeSubtype,omitempty"`
	RangeMultirangeName      *string                      `json:"rangeMultirangeName,omitempty"`
	RangeCanonicalFunction   *string                      `json:"rangeCanonicalFunction,omitempty"`
	RangeSubtypeDiffFunction *string                      `json:"rangeSubtypeDiffFunction,omitempty"`
	RangeSubtypeOpclass      *string                      `json:"rangeSubtypeOpclass,omitempty"`
	InputFunction            *string                      `json:"inputFunction,omitempty"`
	OutputFunction           *string                      `json:"outputFunction,omitempty"`
	ReceiveFunction          *string                      `json:"receiveFunction,omitempty"`
	SendFunction             *string                      `json:"sendFunction,omitempty"`
	AnalyzeFunction          *string                      `json:"analyzeFunction,omitempty"`
	Internallength           *int32                       `json:"internallength,omitempty"`
	PassedByValue            *bool                        `json:"passedByValue,omitempty"`
	Alignment                *string                      `json:"alignment,omitempty"`
	Storage                  *string                      `json:"storage,omitempty"`
}

type customTypeDdl struct {
	SQL      string   `json:"sql"`
	Complete bool     `json:"complete"`
	Warnings []string `json:"warnings,omitempty"`
}

type customTypeDetails struct {
	Name       string               `json:"name"`
	Schema     string               `json:"schema"`
	Kind       customTypeKind       `json:"kind"`
	Comment    *string              `json:"comment,omitempty"`
	Members    []customTypeMember   `json:"members"`
	Properties customTypeProperties `json:"properties"`
	DDL        *customTypeDdl       `json:"ddl,omitempty"`
}

// customTypeCatalogQueries carries catalog-aware SQL fragments for type
// details. Kingbase exposes pg_get_expr/pg_get_constraintdef under the sys_
// prefix in system-catalog mode, so the function names follow the catalog.
type customTypeCatalogQueries struct {
	general                      string
	enumMembers                  string
	compositeMembers             string
	domainBaseType               string
	domainRenderedDefault        string
	domainConstraints            string
	rangeAttributes              string
	rangeAttributesForMultirange string
	rangeMultirange              string
	collationName                string
}

// qualifiedCatalogTypeExpression keeps user-defined type references usable
// outside the current search_path while retaining format_type's typmod output
// for built-in pg_catalog types.
func qualifiedCatalogTypeExpression(typeAlias, namespaceAlias, elementAlias, elementNamespaceAlias, oidExpression, typmodExpression string) string {
	return fmt.Sprintf(`CASE
  WHEN %s.typelem <> 0 AND %s.nspname <> 'pg_catalog'
    THEN quote_ident(%s.nspname) || '.' || quote_ident(%s.typname) || '[]'
  WHEN %s.nspname <> 'pg_catalog'
    THEN quote_ident(%s.nspname) || '.' || quote_ident(%s.typname)
  ELSE format_type(%s, %s)
END`, typeAlias, elementNamespaceAlias, elementNamespaceAlias, elementAlias, namespaceAlias, namespaceAlias, typeAlias, oidExpression, typmodExpression)
}

func customTypeCatalogQueriesFor(catalog, prefix, schema, name string) customTypeCatalogQueries {
	getExpr := prefix + "_get_expr"
	getConstraintDef := prefix + "_get_constraintdef"
	typeTable := catalog + "." + prefix + "_type"
	namespaceTable := catalog + "." + prefix + "_namespace"
	classTable := catalog + "." + prefix + "_class"
	descriptionTable := catalog + "." + prefix + "_description"
	procTable := catalog + "." + prefix + "_proc"
	collationTable := catalog + "." + prefix + "_collation"
	enumTable := catalog + "." + prefix + "_enum"
	attributeTable := catalog + "." + prefix + "_attribute"
	attrdefTable := catalog + "." + prefix + "_attrdef"
	constraintTable := catalog + "." + prefix + "_constraint"
	rangeTable := catalog + "." + prefix + "_range"
	opclassTable := catalog + "." + prefix + "_opclass"
	quotedSchema := quoteLiteral(schema)
	quotedName := quoteLiteral(name)
	compositeMemberType := qualifiedCatalogTypeExpression("at", "atn", "elem", "elem_n", "a.atttypid", "a.atttypmod")
	domainBaseType := qualifiedCatalogTypeExpression("t", "n", "elem", "elem_n", "t.oid", "%[2]d::int4")
	rangeSubtype := qualifiedCatalogTypeExpression("st", "stn", "elem", "elem_n", "r.rngsubtype", "NULL::integer")
	return customTypeCatalogQueries{
		general: fmt.Sprintf(`SELECT t.oid, t.typtype::text, t.typisdefined,
t.typbasetype, t.typnotnull, t.typrelid, t.typelem, t.typcollation,
t.typdefaultbin, t.typdefault, t.typlen, t.typbyval,
t.typalign::text, t.typstorage::text, t.typtypmod,
pi.proname, po.proname, pr.proname, ps.proname, pa.proname,
d.description,
CASE WHEN t.typrelid != 0 THEN (SELECT c.relkind::text FROM %s c WHERE c.oid = t.typrelid) END,
CASE WHEN cl.oid IS NULL THEN NULL ELSE quote_ident(ncl.nspname) || '.' || quote_ident(cl.collname) END
FROM %s t
JOIN %s n ON n.oid = t.typnamespace
LEFT JOIN %s d ON d.objoid = t.oid AND d.classoid = 'pg_catalog.pg_type'::regclass AND d.objsubid = 0
LEFT JOIN %s pi ON pi.oid = t.typinput
LEFT JOIN %s po ON po.oid = t.typoutput
LEFT JOIN %s pr ON pr.oid = t.typreceive
LEFT JOIN %s ps ON ps.oid = t.typsend
LEFT JOIN %s pa ON pa.oid = t.typanalyze
LEFT JOIN %s cl ON cl.oid = t.typcollation
LEFT JOIN %s ncl ON ncl.oid = cl.collnamespace
WHERE n.nspname = %s AND t.typname = %s`, classTable, typeTable, namespaceTable, descriptionTable, procTable, procTable, procTable, procTable, procTable, collationTable, namespaceTable, quotedSchema, quotedName),
		enumMembers: fmt.Sprintf(`SELECT e.enumlabel, e.enumsortorder
FROM %s e
WHERE e.enumtypid = %%d ORDER BY e.enumsortorder`, enumTable),
		compositeMembers: fmt.Sprintf(`SELECT a.attname, %s, a.attnum,
NOT a.attnotnull, a.atthasdef, %s(ad.adbin, ad.adrelid), col_description(%%d, a.attnum)
FROM %s a
JOIN %s at ON at.oid = a.atttypid
JOIN %s atn ON atn.oid = at.typnamespace
LEFT JOIN %s elem ON elem.oid = at.typelem
LEFT JOIN %s elem_n ON elem_n.oid = elem.typnamespace
LEFT JOIN %s ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE a.attrelid = %%d AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, compositeMemberType, getExpr, attributeTable, typeTable, namespaceTable, typeTable, namespaceTable, attrdefTable),
		domainBaseType: fmt.Sprintf(`SELECT %s
FROM %s t
JOIN %s n ON n.oid = t.typnamespace
LEFT JOIN %s elem ON elem.oid = t.typelem
LEFT JOIN %s elem_n ON elem_n.oid = elem.typnamespace
WHERE t.oid = %%[1]d`, domainBaseType, typeTable, namespaceTable, typeTable, namespaceTable),
		domainRenderedDefault: fmt.Sprintf(`SELECT %s(t.typdefaultbin, 0)
FROM %s t WHERE t.oid = %%d`, getExpr, typeTable),
		domainConstraints: fmt.Sprintf(`SELECT c.conname, %s(c.oid, true) FROM %s c WHERE c.contypid = %%d ORDER BY c.conname`, getConstraintDef, constraintTable),
		rangeAttributes: fmt.Sprintf(`SELECT %s, quote_ident(ncan.nspname) || '.' || quote_ident(pcan.proname), quote_ident(ndiff.nspname) || '.' || quote_ident(pdiff.proname), quote_ident(nopc.nspname) || '.' || quote_ident(opc.opcname)
FROM %s r
JOIN %s st ON st.oid = r.rngsubtype
JOIN %s stn ON stn.oid = st.typnamespace
LEFT JOIN %s elem ON elem.oid = st.typelem
LEFT JOIN %s elem_n ON elem_n.oid = elem.typnamespace
LEFT JOIN %s pcan ON pcan.oid = r.rngcanonical
LEFT JOIN %s pdiff ON pdiff.oid = r.rngsubdiff
LEFT JOIN %s opc ON opc.oid = r.rngsubopc
LEFT JOIN %s ncan ON ncan.oid = pcan.pronamespace
LEFT JOIN %s ndiff ON ndiff.oid = pdiff.pronamespace
LEFT JOIN %s nopc ON nopc.oid = opc.opcnamespace
WHERE r.rngtypid = %%d`, rangeSubtype, rangeTable, typeTable, namespaceTable, typeTable, namespaceTable, procTable, procTable, opclassTable, namespaceTable, namespaceTable, namespaceTable),
		rangeAttributesForMultirange: fmt.Sprintf(`SELECT %s, quote_ident(ncan.nspname) || '.' || quote_ident(pcan.proname), quote_ident(ndiff.nspname) || '.' || quote_ident(pdiff.proname), quote_ident(nopc.nspname) || '.' || quote_ident(opc.opcname)
FROM %s r
JOIN %s st ON st.oid = r.rngsubtype
JOIN %s stn ON stn.oid = st.typnamespace
LEFT JOIN %s elem ON elem.oid = st.typelem
LEFT JOIN %s elem_n ON elem_n.oid = elem.typnamespace
LEFT JOIN %s pcan ON pcan.oid = r.rngcanonical
LEFT JOIN %s pdiff ON pdiff.oid = r.rngsubdiff
LEFT JOIN %s opc ON opc.oid = r.rngsubopc
LEFT JOIN %s ncan ON ncan.oid = pcan.pronamespace
LEFT JOIN %s ndiff ON ndiff.oid = pdiff.pronamespace
LEFT JOIN %s nopc ON nopc.oid = opc.opcnamespace
WHERE r.rngmultitypid = %%d`, rangeSubtype, rangeTable, typeTable, namespaceTable, typeTable, namespaceTable, procTable, procTable, opclassTable, namespaceTable, namespaceTable, namespaceTable),
		rangeMultirange: fmt.Sprintf(`SELECT mt.typname
FROM %s r
JOIN %s mt ON mt.oid = r.rngmultitypid
WHERE r.rngtypid = %%d`, rangeTable, typeTable),
		collationName: fmt.Sprintf(`SELECT quote_ident(ncl.nspname) || '.' || quote_ident(cl.collname) FROM %s cl JOIN %s ncl ON ncl.oid = cl.collnamespace WHERE cl.oid = %%d`, collationTable, namespaceTable),
	}
}

// getTypeDetails returns read-only details of a user-defined type. MySQL
// compatibility mode is explicitly unsupported instead of running PostgreSQL
// catalog SQL against a MySQL-mode server.
func (s *server) getTypeDetails(schema, name string) (*customTypeDetails, error) {
	if s.mode.mysqlCompat {
		return nil, errors.New("type details are not supported in MySQL compatibility mode")
	}
	schema = strings.TrimSpace(schema)
	name = strings.TrimSpace(name)
	if schema == "" || name == "" {
		return nil, errors.New("schema and type name are required")
	}
	if isSystemSchema(schema) {
		return nil, fmt.Errorf("system schema %s is not supported for custom type details", schema)
	}
	catalog := "sys_catalog"
	if s.mode.postgresCatalog {
		catalog = "pg_catalog"
	}
	prefix := catalogPrefix(catalog)
	queries := customTypeCatalogQueriesFor(catalog, prefix, schema, name)

	rows, err := s.metadataQuery(queries.general)
	if err != nil {
		return nil, fmt.Errorf("failed to locate custom type %s.%s: %w", schema, name, err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("failed to read type %s.%s: %w", schema, name, err)
		}
		return nil, fmt.Errorf("custom type %s.%s does not exist", schema, name)
	}
	var oid, typbasetype, typrelid, typelem, typcollation int64
	var typtype, typalign, typstorage string
	var typisdefined, typnotnull, typbyval bool
	var typdefaultbin, typdefault, inputFn, outputFn, receiveFn, sendFn, analyzeFn, comment, collname, relkind sql.NullString
	var typlen sql.NullInt64
	var typtypmod int64
	if err := rows.Scan(&oid, &typtype, &typisdefined, &typbasetype, &typnotnull, &typrelid, &typelem, &typcollation, &typdefaultbin, &typdefault, &typlen, &typbyval, &typalign, &typstorage, &typtypmod, &inputFn, &outputFn, &receiveFn, &sendFn, &analyzeFn, &comment, &relkind, &collname); err != nil {
		return nil, fmt.Errorf("failed to read type %s.%s: %w", schema, name, err)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if !typisdefined {
		return nil, fmt.Errorf("custom type %s.%s is not fully defined", schema, name)
	}
	if typelem != 0 {
		return nil, fmt.Errorf("custom type %s.%s is an array companion type", schema, name)
	}
	kind, ok := customTypeKindFromCode(typtype)
	if !ok {
		return nil, fmt.Errorf("custom type %s.%s is a pseudo type (typtype=%s)", schema, name, typtype)
	}
	if relkind.Valid && relkind.String != "" && relkind.String != "c" {
		return nil, fmt.Errorf("%s.%s is the auto-generated row type of a relation, not an independent custom type", schema, name)
	}

	properties := customTypeCommonProperties(inputFn, outputFn, receiveFn, sendFn, analyzeFn, typlen, typbyval, typalign, typstorage)
	properties.DomainConstraints = []customTypeDomainConstraint{}
	details := &customTypeDetails{
		Name:       name,
		Schema:     schema,
		Kind:       kind,
		Comment:    nullStringPtr(comment),
		Members:    []customTypeMember{},
		Properties: properties,
	}

	var warnings []string
	switch kind {
	case customTypeKindEnum:
		details.Members, err = s.customTypeEnumMembers(queries.enumMembers, oid)
		if err != nil {
			return nil, err
		}
	case customTypeKindComposite:
		details.Members, err = s.customTypeCompositeMembers(queries.compositeMembers, typrelid)
		if err != nil {
			return nil, err
		}
	case customTypeKindDomain:
		warnings = append(warnings, s.customTypeDomainAttributes(queries, &details.Properties, oid, typbasetype, typtypmod, typnotnull, typdefaultbin, typdefault, typcollation, collname)...)
	case customTypeKindRange:
		warnings = append(warnings, s.customTypeRangeAttributes(queries, &details.Properties, oid, false)...)
	case customTypeKindMultirange:
		warnings = append(warnings, s.customTypeRangeAttributes(queries, &details.Properties, oid, true)...)
	case customTypeKindBase:
	}
	details.DDL = s.buildCustomTypeDDL(schema, name, kind, inputFn, &details.Members, &details.Properties, warnings)
	return details, nil
}

func customTypeKindFromCode(code string) (customTypeKind, bool) {
	switch code {
	case "b":
		return customTypeKindBase, true
	case "c":
		return customTypeKindComposite, true
	case "d":
		return customTypeKindDomain, true
	case "e":
		return customTypeKindEnum, true
	case "r":
		return customTypeKindRange, true
	case "m":
		return customTypeKindMultirange, true
	default:
		return "", false
	}
}

func customTypeCommonProperties(inputFn, outputFn, receiveFn, sendFn, analyzeFn sql.NullString, typlen sql.NullInt64, typbyval bool, typalign, typstorage string) customTypeProperties {
	properties := customTypeProperties{}
	properties.InputFunction = nullStringPtr(inputFn)
	properties.OutputFunction = nullStringPtr(outputFn)
	properties.ReceiveFunction = nullStringPtr(receiveFn)
	properties.SendFunction = nullStringPtr(sendFn)
	properties.AnalyzeFunction = nullStringPtr(analyzeFn)
	if typlen.Valid && typlen.Int64 > 0 {
		value := int32(typlen.Int64)
		properties.Internallength = &value
	}
	properties.PassedByValue = &typbyval
	if typalign != "" {
		properties.Alignment = &typalign
	}
	if typstorage != "" {
		properties.Storage = &typstorage
	}
	return properties
}

func (s *server) customTypeEnumMembers(sqlTemplate string, oid int64) ([]customTypeMember, error) {
	rows, err := s.metadataQuery(fmt.Sprintf(sqlTemplate, oid))
	if err != nil {
		return nil, fmt.Errorf("failed to read enum values: %w", err)
	}
	defer rows.Close()
	var members []customTypeMember
	index := 0
	for rows.Next() {
		var label string
		var sortOrder float64
		if err := rows.Scan(&label, &sortOrder); err != nil {
			return nil, err
		}
		// enumsortorder is float4; ALTER TYPE ... ADD VALUE BEFORE/AFTER can
		// yield fractional values. Use the ORDER BY position for a unique key.
		index++
		members = append(members, customTypeMember{Ordinal: int32(index), EnumValue: &label})
	}
	return members, rows.Err()
}

func (s *server) customTypeCompositeMembers(sqlTemplate string, typrelid int64) ([]customTypeMember, error) {
	rows, err := s.metadataQuery(fmt.Sprintf(sqlTemplate, typrelid, typrelid))
	if err != nil {
		return nil, fmt.Errorf("failed to read composite fields: %w", err)
	}
	defer rows.Close()
	var members []customTypeMember
	for rows.Next() {
		var member customTypeMember
		var hasDefault bool
		var comment sql.NullString
		if err := rows.Scan(&member.Name, &member.DataType, &member.Ordinal, &member.Nullable, &hasDefault, &member.Default, &comment); err != nil {
			return nil, err
		}
		if !hasDefault {
			member.Default = nil
		}
		member.Comment = nullStringPtr(comment)
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *server) customTypeDomainAttributes(queries customTypeCatalogQueries, properties *customTypeProperties, oid, typbasetype, typtypmod int64, typnotnull bool, typdefaultbin, typdefault sql.NullString, typcollation int64, collname sql.NullString) []string {
	var warnings []string
	if base := s.singleStringQuery(fmt.Sprintf(queries.domainBaseType, typbasetype, typtypmod)); base != "" {
		properties.BaseType = &base
	}
	properties.NotNull = &typnotnull
	defaultValue, defaultWarnings := resolveCustomTypeDomainDefault(typdefaultbin, typdefault, func() (string, error) {
		return s.singleStringQueryResult(fmt.Sprintf(queries.domainRenderedDefault, oid))
	})
	properties.Default = defaultValue
	warnings = append(warnings, defaultWarnings...)
	if typcollation != 0 {
		if collname.Valid && collname.String != "" {
			properties.Collation = &collname.String
		} else if value := s.singleStringQuery(fmt.Sprintf(queries.collationName, typcollation)); value != "" {
			properties.Collation = &value
		}
	}
	rows, err := s.metadataQuery(fmt.Sprintf(queries.domainConstraints, oid))
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("domain constraints could not be read: %v", err))
		return warnings
	}
	for rows.Next() {
		var constraint customTypeDomainConstraint
		if err := rows.Scan(&constraint.Name, &constraint.Definition); err != nil {
			warnings = append(warnings, fmt.Sprintf("domain constraints could not be decoded: %v", err))
			break
		}
		if constraint.Definition != "" {
			properties.DomainConstraints = append(properties.DomainConstraints, constraint)
		}
	}
	if err := rows.Err(); err != nil {
		warnings = append(warnings, fmt.Sprintf("domain constraints could not be read: %v", err))
	}
	if err := rows.Close(); err != nil {
		warnings = append(warnings, fmt.Sprintf("domain constraints could not be closed: %v", err))
	}
	return warnings
}

func (s *server) customTypeRangeAttributes(queries customTypeCatalogQueries, properties *customTypeProperties, oid int64, isMultirange bool) []string {
	var warnings []string
	// pg_range.rngtypid stores the RANGE oid; a multirange view resolves its
	// owning range through rngmultitypid instead.
	rangeTemplate := queries.rangeAttributes
	if isMultirange {
		rangeTemplate = queries.rangeAttributesForMultirange
	}
	rows, err := s.metadataQuery(fmt.Sprintf(rangeTemplate, oid))
	if err != nil {
		return []string{fmt.Sprintf("range attributes could not be read: %v", err)}
	}
	if rows.Next() {
		var subtype, canonical, subdiff, opclass sql.NullString
		if err := rows.Scan(&subtype, &canonical, &subdiff, &opclass); err != nil {
			warnings = append(warnings, fmt.Sprintf("range attributes could not be decoded: %v", err))
		} else {
			properties.RangeSubtype = nullStringPtr(subtype)
			properties.RangeCanonicalFunction = nullStringPtr(canonical)
			properties.RangeSubtypeDiffFunction = nullStringPtr(subdiff)
			properties.RangeSubtypeOpclass = nullStringPtr(opclass)
		}
	} else if err := rows.Err(); err != nil {
		warnings = append(warnings, fmt.Sprintf("range attributes could not be read: %v", err))
	} else {
		warnings = append(warnings, "range attributes returned no rows")
	}
	if err := rows.Close(); err != nil {
		warnings = append(warnings, fmt.Sprintf("range attributes could not be closed: %v", err))
	}
	// Optional PG 13+ multirange companion; older kernels have no column.
	if multirangeRows, err := s.metadataQuery(fmt.Sprintf(queries.rangeMultirange, oid)); err == nil {
		if multirangeRows.Next() {
			var name string
			if scanErr := multirangeRows.Scan(&name); scanErr != nil {
				warnings = append(warnings, fmt.Sprintf("multirange companion could not be decoded: %v", scanErr))
			} else if name != "" {
				properties.RangeMultirangeName = &name
			}
		} else if rowsErr := multirangeRows.Err(); rowsErr != nil {
			warnings = append(warnings, fmt.Sprintf("multirange companion could not be read: %v", rowsErr))
		}
		if closeErr := multirangeRows.Close(); closeErr != nil {
			warnings = append(warnings, fmt.Sprintf("multirange companion could not be closed: %v", closeErr))
		}
	} else {
		warnings = append(warnings, fmt.Sprintf("multirange companion could not be read: %v", err))
	}
	return warnings
}

func (s *server) singleStringQuery(query string) string {
	value, _ := s.singleStringQueryResult(query)
	return value
}

func (s *server) singleStringQueryResult(query string) (string, error) {
	rows, err := s.metadataQuery(query)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if !rows.Next() {
		return "", rows.Err()
	}
	var value sql.NullString
	if err := rows.Scan(&value); err != nil {
		return "", err
	}
	if !value.Valid {
		return "", nil
	}
	return value.String, nil
}

func resolveCustomTypeDomainDefault(typdefaultbin, typdefault sql.NullString, render func() (string, error)) (*string, []string) {
	if typdefault.Valid && typdefault.String != "" {
		value := typdefault.String
		return &value, nil
	}
	if !typdefaultbin.Valid || typdefaultbin.String == "" {
		return nil, nil
	}
	value, err := render()
	if err != nil {
		return nil, []string{fmt.Sprintf("default value could not be rendered; the generated DDL is incomplete: %v", err)}
	}
	if value == "" {
		return nil, []string{"default value could not be rendered; the generated DDL is incomplete"}
	}
	return &value, nil
}

func (s *server) quoteCatalogIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) && strings.Contains(value, `"."`) {
		return value
	}
	if separator := strings.LastIndexByte(value, '.'); separator >= 0 {
		return s.quoteDDLIdentifier(value[:separator]) + "." + s.quoteDDLIdentifier(value[separator+1:])
	}
	return s.quoteDDLIdentifier(value)
}

// buildCustomTypeDDL generates normalized CREATE TYPE text. complete is only
// true when the text can be executed standalone; multiranges and base types
// are marked incomplete with visible warnings.
func (s *server) buildCustomTypeDDL(schema, name string, kind customTypeKind, inputFn sql.NullString, members *[]customTypeMember, properties *customTypeProperties, warnings []string) *customTypeDdl {
	qualified := s.quoteDDLIdentifier(schema) + "." + s.quoteDDLIdentifier(name)
	switch kind {
	case customTypeKindEnum:
		values := make([]string, 0, len(*members))
		for _, member := range *members {
			if member.EnumValue != nil {
				values = append(values, quoteLiteral(*member.EnumValue))
			}
		}
		return &customTypeDdl{
			SQL:      fmt.Sprintf("CREATE TYPE %s AS ENUM (%s);", qualified, strings.Join(values, ", ")),
			Complete: true,
			Warnings: warnings,
		}
	case customTypeKindComposite:
		fields := make([]string, 0, len(*members))
		comments := make([]string, 0, len(*members))
		for _, member := range *members {
			fields = append(fields, s.quoteDDLIdentifier(member.Name)+" "+member.DataType)
			if member.Comment != nil {
				comments = append(comments, fmt.Sprintf("COMMENT ON COLUMN %s.%s IS %s;", qualified, s.quoteDDLIdentifier(member.Name), quoteLiteral(*member.Comment)))
			}
		}
		sql := fmt.Sprintf("CREATE TYPE %s AS (\n  %s\n);", qualified, strings.Join(fields, ",\n  "))
		if len(comments) > 0 {
			sql = sql + "\n" + strings.Join(comments, "\n")
		}
		return &customTypeDdl{SQL: sql, Complete: true, Warnings: warnings}
	case customTypeKindDomain:
		complete := true
		base := "unknown"
		if properties.BaseType != nil && *properties.BaseType != "" {
			base = *properties.BaseType
		} else {
			complete = false
			warnings = append(warnings, "base type could not be resolved; the generated DDL is incomplete")
		}
		parts := []string{fmt.Sprintf("CREATE DOMAIN %s AS %s", qualified, base)}
		if properties.Collation != nil && *properties.Collation != "" {
			parts = append(parts, "COLLATE "+s.quoteCatalogIdentifier(*properties.Collation))
		}
		if properties.Default != nil && *properties.Default != "" {
			parts = append(parts, "DEFAULT "+*properties.Default)
		}
		if properties.NotNull != nil && *properties.NotNull {
			parts = append(parts, "NOT NULL")
		}
		for _, constraint := range properties.DomainConstraints {
			body := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(constraint.Definition), "CHECK"))
			constraintName := constraint.Name
			if constraintName == "" {
				constraintName = name + "_check"
			}
			parts = append(parts, fmt.Sprintf("CONSTRAINT %s CHECK %s", s.quoteDDLIdentifier(constraintName), body))
		}
		for _, warning := range warnings {
			if strings.Contains(warning, "domain constraints") || strings.Contains(warning, "default value could not be rendered") {
				complete = false
			}
		}
		return &customTypeDdl{SQL: strings.Join(parts, "\n  ") + ";", Complete: complete, Warnings: warnings}
	case customTypeKindRange:
		var args []string
		if properties.RangeSubtype != nil && *properties.RangeSubtype != "" {
			args = append(args, "subtype = "+*properties.RangeSubtype)
		}
		if properties.RangeSubtypeOpclass != nil && *properties.RangeSubtypeOpclass != "" {
			args = append(args, "subtype_opclass = "+s.quoteCatalogIdentifier(*properties.RangeSubtypeOpclass))
		}
		if properties.RangeCanonicalFunction != nil && *properties.RangeCanonicalFunction != "" {
			args = append(args, "canonical = "+s.quoteCatalogIdentifier(*properties.RangeCanonicalFunction))
		}
		if properties.RangeSubtypeDiffFunction != nil && *properties.RangeSubtypeDiffFunction != "" {
			args = append(args, "subtype_diff = "+s.quoteCatalogIdentifier(*properties.RangeSubtypeDiffFunction))
		}
		if properties.RangeMultirangeName != nil && *properties.RangeMultirangeName != "" {
			args = append(args, "multirange_type_name = "+s.quoteCatalogIdentifier(*properties.RangeMultirangeName))
		}
		if properties.RangeSubtype == nil || *properties.RangeSubtype == "" {
			result := &customTypeDdl{
				SQL:      fmt.Sprintf("CREATE TYPE %s AS RANGE (subtype = unknown);", qualified),
				Complete: false,
				Warnings: append(warnings, "range attributes could not be resolved"),
			}
			return result
		}
		return &customTypeDdl{
			SQL:      fmt.Sprintf("CREATE TYPE %s AS RANGE (\n  %s\n);", qualified, strings.Join(args, ",\n  ")),
			Complete: true,
			Warnings: warnings,
		}
	case customTypeKindMultirange:
		return &customTypeDdl{
			SQL:      "",
			Complete: false,
			Warnings: append(append([]string{}, warnings...), fmt.Sprintf("%s is the auto-generated multirange companion of a range type; it has no standalone CREATE statement", qualified)),
		}
	default: // customTypeKindBase
		inputName := "unknown"
		if inputFn.Valid && inputFn.String != "" {
			inputName = inputFn.String
		}
		return &customTypeDdl{
			SQL:      fmt.Sprintf("CREATE TYPE %s;  -- base type attributes require manual reconstruction", qualified),
			Complete: false,
			Warnings: append(append([]string{}, warnings...), fmt.Sprintf("%s is a base type; its input/output functions (%s) cannot be rebuilt from catalogs", qualified, inputName)),
		}
	}
}

func (s *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	result := []objectInfo{}
	if constraintsAllowsTableLike(constraints) {
		tables, err := s.listTables(effective, metadataListConstraints{})
		if err != nil {
			return nil, err
		}
		for _, table := range tables {
			result = append(result, objectInfo{Name: table.Name, ObjectType: table.TableType, Schema: effective, Comment: table.Comment})
		}
	}
	if constraintsAllowRoutines(constraints) {
		var query string
		if s.mode.mysqlCompat {
			query = fmt.Sprintf(`SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT
FROM information_schema.routines
WHERE ROUTINE_SCHEMA = %s
ORDER BY ROUTINE_NAME`, quoteLiteral(effective))
		} else {
			catalog := "sys_catalog"
			function := "sys"
			if s.mode.postgresCatalog {
				catalog, function = "pg_catalog", "pg"
			}
			query = fmt.Sprintf(`SELECT p.proname, CASE WHEN p.prorettype = 2278 THEN 'PROCEDURE' ELSE 'FUNCTION' END, d.description
FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid = p.pronamespace
LEFT JOIN %s.%s_description d ON d.objoid = p.oid AND d.objsubid = 0
WHERE n.nspname = %s ORDER BY p.proname`, catalog, function, catalog, function, catalog, function, quoteLiteral(effective))
		}
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
	if constraintsAllowTypes(constraints) {
		types, typesErr := s.listCustomTypes(effective)
		if typesErr != nil {
			// A type catalog failure is a real fault: surfacing it lets the user
			// distinguish an incomplete “all objects” view from an actually
			// empty schema, instead of silently dropping the type group.
			return nil, fmt.Errorf("list custom types in schema %q: %w", effective, typesErr)
		}
		result = append(result, types...)
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
			visible, err := s.listSchemas(nil, false)
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
	identityExpression := "a.attidentity"
	if s.catalogIdentityUnsupported {
		identityExpression = "CAST(NULL AS varchar(1)) AS attidentity"
	}
	query := fmt.Sprintf(`SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
	%s(ad.adbin, ad.adrelid), col_description(a.attrelid, a.attnum),
	CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 THEN ((a.atttypmod - 4) >> 16) & 65535 END,
	CASE WHEN t.typname = 'numeric' AND a.atttypmod > 0 THEN (a.atttypmod - 4) & 65535 END,
	CASE WHEN t.typname IN ('varchar','bpchar') AND a.atttypmod > 0 THEN a.atttypmod - 4 END,
	%s
	FROM %s.%s_attribute a JOIN %s.%s_type t ON t.oid = a.atttypid
	JOIN %s.%s_class c ON c.oid = a.attrelid JOIN %s.%s_namespace n ON n.oid = c.relnamespace
	LEFT JOIN %s.%s_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = %s AND c.relname = %s AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, expression, identityExpression, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(schema), quoteLiteral(table))
	rows, err := s.metadataQuery(query)
	if err != nil && !s.catalogIdentityUnsupported && isUndefinedColumn(err, "attidentity") {
		s.catalogIdentityUnsupported = true
		return s.queryCatalogColumns(schema, table, primary, catalog, prefix, expression)
	}
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

func isUndefinedColumn(err error, columnName string) bool {
	var driverError *gokb.Error
	undefined := errors.As(err, &driverError) && string(driverError.Code) == "42703"
	normalized := strings.ToLower(err.Error())
	undefined = undefined || strings.Contains(normalized, "does not exist") || strings.Contains(normalized, "不存在")
	return undefined && strings.Contains(normalized, strings.ToLower(columnName))
}

func (s *server) informationSchemaColumns(schema, table string, primary map[string]bool) ([]columnInfo, error) {
	// Cache the optional information_schema capabilities for this connection so
	// subsequent table metadata requests do not repeat known failing probes.
	includeColumnType := !s.infoColumnTypeUnsupported
	includeUdtName := !s.infoUdtNameUnsupported
	for {
		result, err := s.queryInformationSchemaColumns(schema, table, primary, includeColumnType, includeUdtName)
		if err == nil {
			return result, nil
		}
		switch {
		case includeColumnType && isUndefinedColumn(err, "column_type"):
			includeColumnType = false
			s.infoColumnTypeUnsupported = true
		case includeUdtName && isUndefinedColumn(err, "udt_name"):
			includeUdtName = false
			s.infoUdtNameUnsupported = true
		default:
			return nil, err
		}
	}
}

func (s *server) queryInformationSchemaColumns(schema, table string, primary map[string]bool, includeColumnType, includeUdtName bool) ([]columnInfo, error) {
	var fullDataTypeExpression string
	switch {
	case includeColumnType && includeUdtName:
		fullDataTypeExpression = `CASE
	WHEN UPPER(TRIM(c.data_type)) IN ('USER-DEFINED', 'USER_DEFINED')
		AND UPPER(COALESCE(NULLIF(TRIM(c.column_type), ''), 'USER-DEFINED')) IN ('USER-DEFINED', 'USER_DEFINED')
	THEN c.udt_name
	ELSE c.column_type
	END`
	case includeColumnType:
		fullDataTypeExpression = "c.column_type"
	case includeUdtName:
		fullDataTypeExpression = `CASE
		WHEN UPPER(TRIM(c.data_type)) IN ('USER-DEFINED', 'USER_DEFINED') THEN c.udt_name
		END AS column_type`
	default:
		fullDataTypeExpression = "NULL AS column_type"
	}
	query := fmt.Sprintf(`SELECT c.column_name, c.data_type, %s, c.is_nullable, c.column_default,
	col_description(a.attrelid, a.attnum), c.numeric_precision, c.numeric_scale, c.character_maximum_length
	FROM information_schema.columns c
	LEFT JOIN sys_catalog.sys_namespace n ON n.nspname = c.table_schema
	LEFT JOIN sys_catalog.sys_class rel ON rel.relnamespace = n.oid AND rel.relname = c.table_name
	LEFT JOIN sys_catalog.sys_attribute a ON a.attrelid = rel.oid AND a.attname = c.column_name AND a.attnum > 0 AND NOT a.attisdropped
	WHERE c.table_schema = %s AND c.table_name = %s ORDER BY c.ordinal_position`, fullDataTypeExpression, quoteLiteral(schema), quoteLiteral(table))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []columnInfo{}
	for rows.Next() {
		var name, dataType, nullable string
		var fullDataType, defaultValue, comment sql.NullString
		var precision, scale, length sql.NullInt64
		if err := rows.Scan(&name, &dataType, &fullDataType, &nullable, &defaultValue, &comment, &precision, &scale, &length); err != nil {
			return nil, err
		}
		if parsed := boundedVarcharLength(dataType); parsed != nil && !length.Valid {
			length = sql.NullInt64{Int64: int64(*parsed), Valid: true}
		}
		result = append(result, columnInfo{Name: name, DataType: resolvedInformationSchemaDataType(dataType, fullDataType.String), FullDataType: fullDataType.String, IsNullable: strings.EqualFold(nullable, "YES"), ColumnDefault: nullStringPtr(defaultValue), IsPrimaryKey: primary[strings.ToLower(name)], Comment: nullStringPtr(comment), NumericPrecision: nullIntPtr(precision), NumericScale: nullIntPtr(scale), CharacterMaximumLength: nullIntPtr(length)})
	}
	return result, rows.Err()
}

func resolvedInformationSchemaDataType(dataType, fullDataType string) string {
	if !isUserDefinedDataTypeMarker(dataType) {
		return dataType
	}
	resolved := strings.TrimSpace(fullDataType)
	if resolved == "" || isUserDefinedDataTypeMarker(resolved) {
		return dataType
	}
	return resolved
}

func isUserDefinedDataTypeMarker(dataType string) bool {
	switch strings.ToUpper(strings.TrimSpace(dataType)) {
	case "USER-DEFINED", "USER_DEFINED":
		return true
	default:
		return false
	}
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

func kingbaseCatalogFunction(catalog, sysFunction, postgresFunction string) string {
	// Kingbase compatibility modes expose different catalog-qualified deparser names.
	if catalog == "pg_catalog" {
		return "pg_catalog." + postgresFunction
	}
	return "sys_catalog." + sysFunction
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
			} else if s.usePgViewDefinition {
				function = "pg_get_viewdef"
			}
			querySource := func(definitionFunction string) error {
				query := fmt.Sprintf("SELECT %s(c.oid) FROM %s.%s_class c JOIN %s.%s_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relname=%s LIMIT 1", definitionFunction, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(name))
				return s.requireDBQueryRow(query, &source)
			}
			err = querySource(function)
			if err != nil && function == "sys_get_viewdef" && isUndefinedFunction(err, function) {
				s.usePgViewDefinition = true
				err = querySource("pg_get_viewdef")
			}
		}
	} else if kind == "FUNCTION" || kind == "PROCEDURE" {
		catalog, prefix, function := "sys_catalog", "sys", "sys_get_functiondef"
		if s.mode.postgresCatalog {
			catalog, prefix, function = "pg_catalog", "pg", "pg_get_functiondef"
		} else if s.usePgFunctionDefinition {
			function = "pg_get_functiondef"
		}
		querySource := func(definitionFunction string) error {
			query := fmt.Sprintf("SELECT %s(p.oid) FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid=p.pronamespace WHERE n.nspname=%s AND p.proname=%s ORDER BY CASE WHEN p.prorettype=2278 THEN 0 ELSE 1 END LIMIT 1", definitionFunction, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(name))
			return s.requireDBQueryRow(query, &source)
		}
		err = querySource(function)
		if err != nil && function == "sys_get_functiondef" && isUndefinedFunction(err, function) {
			s.usePgFunctionDefinition = true
			err = querySource("pg_get_functiondef")
		}
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
	ddl := s.renderTableDDL(effective, table, columns, tableComment)
	ddl, err = s.appendTableIndexDDL(effective, table, ddl)
	if err != nil {
		return "", err
	}
	ddl, err = s.appendTableTriggerDDL(effective, table, ddl)
	if err != nil {
		return "", err
	}
	return ddl, nil
}

func (s *server) renderTableDDL(schema, table string, columns []columnInfo, tableComment *string) string {
	definitions := make([]string, 0, len(columns)+1)
	primary := []string{}
	for _, column := range columns {
		definitions = append(definitions, s.columnDDLDefinition(column))
		if column.IsPrimaryKey {
			primary = append(primary, s.quoteDDLIdentifier(column.Name))
		}
	}
	if len(primary) > 0 {
		definitions = append(definitions, "PRIMARY KEY ("+strings.Join(primary, ", ")+")")
	}
	qualifiedTable := s.quoteDDLIdentifier(schema) + "." + s.quoteDDLIdentifier(table)
	ddl := "CREATE TABLE " + qualifiedTable + " (\n  " + strings.Join(definitions, ",\n  ") + "\n);"
	if tableComment != nil && strings.TrimSpace(*tableComment) != "" {
		ddl += "\nCOMMENT ON TABLE " + qualifiedTable + " IS " + quoteLiteral(*tableComment) + ";"
	}
	for _, column := range columns {
		if column.Comment == nil || strings.TrimSpace(*column.Comment) == "" {
			continue
		}
		ddl += "\nCOMMENT ON COLUMN " + qualifiedTable + "." + s.quoteDDLIdentifier(column.Name) + " IS " + quoteLiteral(*column.Comment) + ";"
	}
	return ddl
}

func (s *server) appendTableIndexDDL(schema, table, ddl string) (string, error) {
	definitions, err := s.listIndexDefinitions(schema, table)
	if err != nil {
		return "", err
	}
	return appendDDLStatements(ddl, definitions), nil
}

func (s *server) appendTableTriggerDDL(schema, table, ddl string) (string, error) {
	definitions, err := s.listTriggerDefinitions(schema, table)
	if err != nil {
		return "", err
	}
	return appendDDLStatements(ddl, definitions), nil
}

func (s *server) listIndexDefinitions(schema, table string) ([]string, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	catalog, prefix := "sys_catalog", "sys"
	if s.mode.postgresCatalog {
		catalog, prefix = "pg_catalog", "pg"
	}
	indexDefinitionFunction := kingbaseCatalogFunction(catalog, "sys_get_indexdef", "pg_get_indexdef")
	query := fmt.Sprintf(`SELECT i.relname, %s(ix.indexrelid, 0, true), obj_description(i.oid)
FROM %s.%s_index ix JOIN %s.%s_class t ON t.oid = ix.indrelid
JOIN %s.%s_class i ON i.oid = ix.indexrelid JOIN %s.%s_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = %s AND t.relname = %s AND NOT ix.indisprimary ORDER BY i.relname`, indexDefinitionFunction, catalog, prefix, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(table))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var name string
		var definition string
		var comment sql.NullString
		if err := rows.Scan(&name, &definition, &comment); err != nil {
			return nil, err
		}
		if strings.TrimSpace(definition) != "" {
			result = append(result, definition)
		}
		if comment.Valid && strings.TrimSpace(comment.String) != "" {
			result = append(result, "COMMENT ON INDEX "+s.quoteDDLIdentifier(effective)+"."+s.quoteDDLIdentifier(name)+" IS "+quoteLiteral(comment.String))
		}
	}
	return result, rows.Err()
}

func (s *server) listTriggerDefinitions(schema, table string) ([]string, error) {
	effective, err := s.effectiveSchema(schema)
	if err != nil {
		return nil, err
	}
	catalog, prefix := "sys_catalog", "sys"
	if s.mode.postgresCatalog {
		catalog, prefix = "pg_catalog", "pg"
	}
	triggerDefinitionFunction := kingbaseCatalogFunction(catalog, "sys_get_triggerdef", "pg_get_triggerdef")
	query := fmt.Sprintf(`SELECT %s(tg.oid, true)
FROM %s.%s_trigger tg JOIN %s.%s_class c ON c.oid = tg.tgrelid JOIN %s.%s_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = %s AND c.relname = %s AND NOT tg.tgisinternal ORDER BY tg.tgname`, triggerDefinitionFunction, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(effective), quoteLiteral(table))
	rows, err := s.metadataQuery(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var definition string
		if err := rows.Scan(&definition); err != nil {
			return nil, err
		}
		if strings.TrimSpace(definition) != "" {
			result = append(result, definition)
		}
	}
	return result, rows.Err()
}

func appendDDLStatements(ddl string, statements []string) string {
	for _, statement := range statements {
		ddl = appendDDLStatement(ddl, statement)
	}
	return ddl
}

func appendDDLStatement(ddl, statement string) string {
	ddl = strings.TrimRight(ddl, "\r\n\t ")
	statement = ensureStatementTerminator(statement)
	if statement == "" {
		return ddl
	}
	if ddl == "" {
		return statement
	}
	if !strings.HasSuffix(ddl, ";") {
		ddl += ";"
	}
	return ddl + "\n\n" + statement
}

func ensureStatementTerminator(statement string) string {
	trimmed := strings.TrimSpace(statement)
	if trimmed == "" || strings.HasSuffix(trimmed, ";") {
		return trimmed
	}
	return trimmed + ";"
}

func (s *server) columnDDLDefinition(column columnInfo) string {
	definition := s.quoteDDLIdentifier(column.Name) + " " + columnDDLDataType(column)
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

func columnDDLDataType(column columnInfo) string {
	if fullDataType := strings.TrimSpace(column.FullDataType); fullDataType != "" {
		return fullDataType
	}
	dataType := strings.TrimSpace(column.DataType)
	if strings.Contains(dataType, "(") {
		return dataType
	}
	normalized := strings.Join(strings.Fields(strings.ToLower(dataType)), " ")
	switch normalized {
	case "varchar", "character varying", "char", "character":
		if column.CharacterMaximumLength != nil && *column.CharacterMaximumLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, *column.CharacterMaximumLength)
		}
	case "numeric", "decimal":
		if column.NumericPrecision != nil && *column.NumericPrecision > 0 {
			if column.NumericScale != nil {
				return fmt.Sprintf("%s(%d,%d)", dataType, *column.NumericPrecision, *column.NumericScale)
			}
			return fmt.Sprintf("%s(%d)", dataType, *column.NumericPrecision)
		}
	}
	return dataType
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
	case "MATERIALIZED_VIEW", "FOREIGN_TABLE", "VIEW", "TABLE", "TYPE", "TYPE_BODY":
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
		if routineObjectType(kind) != "" {
			continue
		}
		switch normalizeTableType(kind) {
		case "TABLE", "VIEW", "MATERIALIZED_VIEW", "FOREIGN_TABLE":
			return true
		}
	}
	return false
}

// constraintsAllowTypes reports whether the object-type filter asks for
// user-defined types (or leaves the filter open). normalizeTableType treats
// "TYPE" and "TYPE_BODY" as first-class kinds, so table-like constraints never
// match them and a dedicated type request does not scan relations.
func constraintsAllowTypes(constraints metadataListConstraints) bool {
	if len(constraints.ObjectTypes) == 0 {
		return true
	}
	for _, kind := range constraints.ObjectTypes {
		switch normalizeTableType(kind) {
		case "TYPE", "TYPE_BODY":
			return true
		}
	}
	return false
}

// constraintsAllowRoutines reports whether the object-type filter asks for
// procedures or functions (or leaves the filter open).
func constraintsAllowRoutines(constraints metadataListConstraints) bool {
	if len(constraints.ObjectTypes) == 0 {
		return true
	}
	for _, kind := range constraints.ObjectTypes {
		if routineObjectType(kind) != "" {
			return true
		}
	}
	return false
}

func routineObjectType(value string) string {
	upper := strings.ToUpper(strings.TrimSpace(value))
	switch {
	case strings.Contains(upper, "PROCEDURE"):
		return "PROCEDURE"
	case strings.Contains(upper, "FUNCTION"):
		return "FUNCTION"
	default:
		return ""
	}
}

func constraintsMatch(constraints metadataListConstraints, name, kind string) bool {
	if filter := strings.TrimSpace(constraints.Filter); filter != "" && !strings.Contains(strings.ToLower(name), strings.ToLower(filter)) {
		return false
	}
	if len(constraints.ObjectTypes) == 0 {
		return true
	}
	if routineKind := routineObjectType(kind); routineKind != "" {
		for _, allowed := range constraints.ObjectTypes {
			if routineObjectType(allowed) == routineKind {
				return true
			}
		}
		return false
	}
	for _, allowed := range constraints.ObjectTypes {
		if routineObjectType(allowed) != "" {
			continue
		}
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
	case "TYPE":
		return 6
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
