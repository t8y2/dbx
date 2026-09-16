package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/apache/iotdb-client-go/v2/client"
)

const metadataQueryLimit = 100000

var (
	iotdbTypes = []string{
		"BOOLEAN", "INT32", "INT64", "FLOAT", "DOUBLE", "TEXT", "STRING", "BLOB", "TIMESTAMP", "DATE",
	}
	simpleTreeNodePattern = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
)

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

func iotdbDataTypes() []string {
	return append([]string(nil), iotdbTypes...)
}

func (s *server) connectionInfo() (map[string]any, error) {
	version := ""
	if values, err := s.queryValues("SHOW VERSION", "", 1, 5); err == nil && len(values.Rows) > 0 {
		version = metadataRowString(values, values.Rows[0], "Version")
	} else if err != nil {
		return nil, err
	}
	username := s.params.Username
	if values, err := s.queryValues("SHOW CURRENT_USER", "", 1, 5); err == nil && len(values.Rows) > 0 {
		if current := metadataRowString(values, values.Rows[0], "CurrentUser"); current != "" {
			username = current
		}
	}
	dialect := strings.ToUpper(s.config.Dialect)
	if values, err := s.queryValues("SHOW CURRENT_SQL_DIALECT", "", 1, 5); err == nil && len(values.Rows) > 0 {
		if current := metadataRowString(values, values.Rows[0], "CurrentSqlDialect"); current != "" {
			dialect = strings.ToUpper(current)
		}
	}
	quote := "`"
	identifierCase := "mixed"
	if s.config.Dialect == client.TableSqlDialect {
		quote = `"`
		identifierCase = "lower"
	}
	return map[string]any{
		"database":          s.config.Database,
		"schema":            s.config.Database,
		"username":          username,
		"version":           version,
		"sqlDialect":        dialect,
		"identifierQuote":   quote,
		"compatibilityMode": "iotdb-" + strings.ToLower(dialect),
		"databaseInfo": map[string]string{
			"productName":            "Apache IoTDB",
			"productVersion":         version,
			"unquotedIdentifierCase": identifierCase,
			"quotedIdentifierCase":   "mixed",
			"driverName":             "Apache IoTDB Go Client",
			"driverVersion":          "v" + iotdbGoClientVersion,
		},
	}, nil
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	values, err := s.queryValues("SHOW DATABASES", "", metadataQueryLimit, 0)
	if err != nil {
		return nil, err
	}
	result := make([]databaseInfo, 0, len(values.Rows))
	seen := map[string]bool{}
	for _, row := range values.Rows {
		name := metadataRowString(values, row, "Database")
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		result = append(result, databaseInfo{Name: name})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return result, nil
}

func (s *server) listSchemas() ([]string, error) {
	databases, err := s.listDatabases()
	if err != nil {
		return nil, err
	}
	result := make([]string, len(databases))
	for index, database := range databases {
		result[index] = database.Name
	}
	return result, nil
}

func (s *server) listTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	if !acceptsIoTDBTable(constraints.ObjectTypes) {
		return []tableInfo{}, nil
	}
	if s.config.Dialect == client.TableSqlDialect {
		return s.listTableDialectTables(schema, constraints)
	}
	return s.listTreeDialectDevices(schema, constraints)
}

func (s *server) listTreeDialectDevices(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	schema = s.effectiveMetadataSchema(schema)
	pattern := "root.**"
	if schema != "" {
		pattern = quoteTreePath(schema) + ".**"
	}
	values, err := s.queryValues("SHOW DEVICES "+pattern, "", metadataQueryLimit, 0)
	if err != nil {
		return nil, err
	}
	prefix := strings.TrimSuffix(schema, ".")
	if prefix != "" {
		prefix += "."
	}
	result := make([]tableInfo, 0, len(values.Rows))
	for _, row := range values.Rows {
		device := metadataRowString(values, row, "Device")
		name := strings.TrimPrefix(device, prefix)
		if name == "" || name == device && prefix != "" || !metadataNameMatches(name, constraints.Filter) {
			continue
		}
		result = append(result, tableInfo{Name: name, TableType: "TABLE"})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return applyMetadataWindow(result, constraints.Offset, constraints.Limit), nil
}

func (s *server) listTableDialectTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	schema = s.effectiveMetadataSchema(schema)
	if schema == "" {
		return []tableInfo{}, nil
	}
	values, err := s.queryValues("SHOW TABLES DETAILS FROM "+quoteTableIdentifier(schema), schema, metadataQueryLimit, 0)
	if err != nil {
		values, err = s.queryValues("SHOW TABLES FROM "+quoteTableIdentifier(schema), schema, metadataQueryLimit, 0)
		if err != nil {
			return nil, err
		}
	}
	result := make([]tableInfo, 0, len(values.Rows))
	for _, row := range values.Rows {
		name := firstMetadataRowString(values, row, "TableName", "table_name")
		if name == "" || !metadataNameMatches(name, constraints.Filter) {
			continue
		}
		tableType := firstMetadataRowString(values, row, "TableType", "table_type")
		if tableType == "" || strings.EqualFold(tableType, "BASE TABLE") {
			tableType = "TABLE"
		}
		result = append(result, tableInfo{
			Name:      name,
			TableType: tableType,
			Comment:   optionalMetadataString(firstMetadataRowString(values, row, "Comment", "comment")),
		})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return applyMetadataWindow(result, constraints.Offset, constraints.Limit), nil
}

func (s *server) getTableComment(schema, table string) (*string, error) {
	if s.config.Dialect != client.TableSqlDialect {
		return nil, nil
	}
	tables, err := s.listTableDialectTables(schema, metadataListConstraints{})
	if err != nil {
		return nil, err
	}
	for _, item := range tables {
		if item.Name == table {
			return item.Comment, nil
		}
	}
	return nil, nil
}

func (s *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	tables, err := s.listTables(schema, constraints)
	if err != nil {
		return nil, err
	}
	result := make([]objectInfo, 0, len(tables))
	for _, table := range tables {
		result = append(result, objectInfo{
			Name:       table.Name,
			ObjectType: "TABLE",
			Schema:     schema,
			Comment:    table.Comment,
		})
	}
	return result, nil
}

func (s *server) getColumns(schema, table string) ([]columnInfo, error) {
	if strings.TrimSpace(table) == "" {
		return []columnInfo{}, nil
	}
	if s.config.Dialect == client.TableSqlDialect {
		return s.getTableDialectColumns(schema, table)
	}
	return s.getTreeDialectColumns(schema, table)
}

func (s *server) getTreeDialectColumns(schema, table string) ([]columnInfo, error) {
	device := treeDevicePath(s.effectiveMetadataSchema(schema), table)
	if device == "" {
		return []columnInfo{}, nil
	}
	values, err := s.queryValues("SHOW TIMESERIES "+quoteTreePath(device)+".**", "", metadataQueryLimit, 0)
	if err != nil {
		return nil, err
	}
	prefix := device + "."
	result := make([]columnInfo, 0, len(values.Rows))
	for _, row := range values.Rows {
		path := metadataRowString(values, row, "Timeseries")
		name := strings.TrimPrefix(path, prefix)
		if name == "" || name == path || strings.Contains(name, ".") {
			continue
		}
		encoding := metadataRowString(values, row, "Encoding")
		compression := metadataRowString(values, row, "Compression")
		extra := make([]string, 0, 2)
		if encoding != "" {
			extra = append(extra, "encoding="+encoding)
		}
		if compression != "" {
			extra = append(extra, "compressor="+compression)
		}
		result = append(result, columnInfo{
			Name:       name,
			DataType:   metadataRowString(values, row, "DataType"),
			IsNullable: true,
			Extra:      optionalMetadataString(strings.Join(extra, ", ")),
		})
	}
	return result, nil
}

func (s *server) getTableDialectColumns(schema, table string) ([]columnInfo, error) {
	schema = s.effectiveMetadataSchema(schema)
	qualified := quoteTableIdentifier(schema) + "." + quoteTableIdentifier(table)
	values, err := s.queryValues("DESC "+qualified+" DETAILS", schema, metadataQueryLimit, 0)
	if err != nil {
		values, err = s.queryValues("DESC "+qualified, schema, metadataQueryLimit, 0)
		if err != nil {
			return nil, err
		}
	}
	result := make([]columnInfo, 0, len(values.Rows))
	for _, row := range values.Rows {
		name := firstMetadataRowString(values, row, "ColumnName", "column_name")
		if name == "" {
			continue
		}
		category := strings.ToUpper(firstMetadataRowString(values, row, "Category", "category"))
		isPrimary := category == "TIME" || category == "TAG"
		result = append(result, columnInfo{
			Name:         name,
			DataType:     strings.ToUpper(firstMetadataRowString(values, row, "DataType", "datatype")),
			IsNullable:   !isPrimary,
			IsPrimaryKey: isPrimary,
			Extra:        optionalMetadataString(category),
			Comment:      optionalMetadataString(firstMetadataRowString(values, row, "Comment", "comment")),
		})
	}
	return result, nil
}

func (s *server) listIndexes(_, _ string) ([]indexInfo, error) {
	return []indexInfo{}, nil
}

func (s *server) getTableDDL(schema, table string) (string, error) {
	if strings.TrimSpace(table) == "" {
		return "", nil
	}
	if s.config.Dialect == client.TableSqlDialect {
		return s.getTableDialectDDL(schema, table)
	}
	return s.getTreeDialectDDL(schema, table)
}

func (s *server) getTreeDialectDDL(schema, table string) (string, error) {
	device := treeDevicePath(s.effectiveMetadataSchema(schema), table)
	columns, err := s.getTreeDialectColumns(schema, table)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", nil
	}
	aligned := false
	if values, queryErr := s.queryValues("SHOW DEVICES "+quoteTreePath(device), "", 1, 0); queryErr == nil && len(values.Rows) > 0 {
		aligned = metadataRowBool(values, values.Rows[0], "IsAligned")
	}
	var ddl strings.Builder
	for _, column := range columns {
		ddl.WriteString("DELETE TIMESERIES ")
		ddl.WriteString(quoteTreePath(device + "." + column.Name))
		ddl.WriteString(";\n")
	}
	ddl.WriteString("\n")
	if aligned {
		definitions := make([]string, 0, len(columns))
		for _, column := range columns {
			definition := quoteTreeNode(column.Name) + " " + column.DataType
			if column.Extra != nil && *column.Extra != "" {
				definition += " " + strings.ReplaceAll(*column.Extra, ", ", " ")
			}
			definitions = append(definitions, definition)
		}
		ddl.WriteString("CREATE ALIGNED TIMESERIES ")
		ddl.WriteString(quoteTreePath(device))
		ddl.WriteString("(")
		ddl.WriteString(strings.Join(definitions, ", "))
		ddl.WriteString(");")
		return ddl.String(), nil
	}
	for _, column := range columns {
		ddl.WriteString("CREATE TIMESERIES ")
		ddl.WriteString(quoteTreePath(device + "." + column.Name))
		ddl.WriteString(" WITH DATATYPE=")
		ddl.WriteString(column.DataType)
		if column.Extra != nil && *column.Extra != "" {
			ddl.WriteString(", ")
			ddl.WriteString(*column.Extra)
		}
		ddl.WriteString(";\n")
	}
	return strings.TrimSuffix(ddl.String(), "\n"), nil
}

func (s *server) getTableDialectDDL(schema, table string) (string, error) {
	schema = s.effectiveMetadataSchema(schema)
	columns, err := s.getTableDialectColumns(schema, table)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", nil
	}
	comment, err := s.getTableComment(schema, table)
	if err != nil {
		return "", err
	}
	ttl := "INF"
	if values, queryErr := s.queryValues("SHOW TABLES DETAILS FROM "+quoteTableIdentifier(schema), schema, metadataQueryLimit, 0); queryErr == nil {
		for _, row := range values.Rows {
			if firstMetadataRowString(values, row, "TableName", "table_name") == table {
				if value := firstMetadataRowString(values, row, "TTL(ms)", "ttl(ms)"); value != "" {
					ttl = value
				}
				break
			}
		}
	}
	definitions := make([]string, 0, len(columns))
	for _, column := range columns {
		definition := "  " + quoteTableIdentifier(column.Name) + " " + column.DataType
		if column.Extra != nil && *column.Extra != "" {
			definition += " " + *column.Extra
		}
		if column.Comment != nil && *column.Comment != "" {
			definition += " COMMENT " + quoteSQLString(*column.Comment)
		}
		definitions = append(definitions, definition)
	}
	qualified := quoteTableIdentifier(schema) + "." + quoteTableIdentifier(table)
	ddl := "DROP TABLE IF EXISTS " + qualified + ";\n\nCREATE TABLE " + qualified + " (\n" + strings.Join(definitions, ",\n") + "\n)"
	if comment != nil && *comment != "" {
		ddl += " COMMENT " + quoteSQLString(*comment)
	}
	if strings.EqualFold(ttl, "INF") {
		ddl += " WITH (TTL='INF')"
	} else if _, parseErr := strconv.ParseInt(ttl, 10, 64); parseErr == nil {
		ddl += " WITH (TTL=" + ttl + ")"
	}
	return ddl + ";", nil
}

func (s *server) completionAssistantSearch(input completionAssistantRequest) (completionAssistantResponse, error) {
	limit := input.MaxResults
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	candidates := make([]completionAssistantCandidate, 0, limit+1)
	kinds := metadataStringSet(input.ObjectKinds)
	if (kinds["column"] || kinds["property"] || len(kinds) == 0 && input.ParentName != "") && input.ParentName != "" {
		schema := input.ParentSchema
		if schema == "" {
			schema = input.Schema
		}
		columns, err := s.getColumns(schema, input.ParentName)
		if err != nil {
			return completionAssistantResponse{}, err
		}
		for _, column := range columns {
			if !completionNameMatches(column.Name, input) {
				continue
			}
			dataType := column.DataType
			candidates = append(candidates, completionAssistantCandidate{
				Name: column.Name, Kind: "COLUMN", Database: stringPtr(input.Database), Schema: stringPtr(schema),
				ParentSchema: stringPtr(schema), ParentName: stringPtr(input.ParentName), DataType: &dataType,
			})
			if len(candidates) > limit {
				return completionAssistantResponse{Candidates: candidates[:limit], Incomplete: true}, nil
			}
		}
		return completionAssistantResponse{Candidates: candidates}, nil
	}
	schemas := []string{input.Schema}
	if input.GlobalSearch || input.Schema == "" {
		var err error
		schemas, err = s.listSchemas()
		if err != nil {
			return completionAssistantResponse{}, err
		}
	}
	for _, schema := range schemas {
		objects, err := s.listObjects(schema, metadataListConstraints{ObjectTypes: input.ObjectKinds})
		if err != nil {
			return completionAssistantResponse{}, err
		}
		for _, object := range objects {
			if !completionNameMatches(object.Name, input) {
				continue
			}
			candidates = append(candidates, completionAssistantCandidate{
				Name: object.Name, Kind: object.ObjectType, Database: stringPtr(input.Database),
				Schema: stringPtr(schema), Comment: object.Comment,
			})
			if len(candidates) > limit {
				return completionAssistantResponse{Candidates: candidates[:limit], Incomplete: true}, nil
			}
		}
	}
	return completionAssistantResponse{Candidates: candidates}, nil
}

func (s *server) effectiveMetadataSchema(schema string) string {
	if value := strings.TrimSpace(schema); value != "" {
		return value
	}
	return strings.TrimSpace(s.config.Database)
}

func metadataListConstraintsFromParams(params map[string]json.RawMessage) metadataListConstraints {
	return metadataListConstraints{
		Filter:      stringParam(params, "filter"),
		Limit:       intParam(params, "limit"),
		Offset:      intParam(params, "offset"),
		ObjectTypes: stringSliceParam(params, "object_types"),
	}
}

func metadataNameMatches(name, filter string) bool {
	return filter == "" || strings.Contains(strings.ToLower(name), strings.ToLower(filter))
}

func acceptsIoTDBTable(objectTypes []string) bool {
	if len(objectTypes) == 0 {
		return true
	}
	for _, objectType := range objectTypes {
		switch strings.ToLower(strings.TrimSpace(objectType)) {
		case "table", "base table", "device", "timeseries":
			return true
		}
	}
	return false
}

func applyMetadataWindow[T any](values []T, offset, limit int) []T {
	if offset < 0 {
		offset = 0
	}
	if offset >= len(values) {
		return []T{}
	}
	values = values[offset:]
	if limit > 0 && limit < len(values) {
		values = values[:limit]
	}
	return values
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
	case "contains":
		return strings.Contains(name, mask)
	default:
		return strings.HasPrefix(name, mask)
	}
}

func metadataStringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[strings.ToLower(strings.TrimSpace(value))] = true
	}
	return result
}

func metadataRowString(values queryResult, row []any, column string) string {
	index := metadataColumnIndex(values.Columns, column)
	if index < 0 || index >= len(row) || row[index] == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(row[index]))
}

func firstMetadataRowString(values queryResult, row []any, columns ...string) string {
	for _, column := range columns {
		if value := metadataRowString(values, row, column); value != "" {
			return value
		}
	}
	return ""
}

func metadataRowBool(values queryResult, row []any, column string) bool {
	index := metadataColumnIndex(values.Columns, column)
	if index < 0 || index >= len(row) || row[index] == nil {
		return false
	}
	switch value := row[index].(type) {
	case bool:
		return value
	case string:
		parsed, _ := strconv.ParseBool(value)
		return parsed
	default:
		parsed, _ := strconv.ParseBool(fmt.Sprint(value))
		return parsed
	}
}

func metadataColumnIndex(columns []string, target string) int {
	for index, column := range columns {
		if strings.EqualFold(strings.TrimSpace(column), strings.TrimSpace(target)) {
			return index
		}
	}
	return -1
}

func treeDevicePath(schema, table string) string {
	schema = strings.TrimSuffix(strings.TrimSpace(schema), ".")
	table = strings.TrimPrefix(strings.TrimSpace(table), ".")
	if table == "" {
		return ""
	}
	if schema == "" || table == schema || strings.HasPrefix(table, schema+".") {
		return table
	}
	return schema + "." + table
}

func quoteTreePath(value string) string {
	nodes := strings.Split(strings.TrimSpace(value), ".")
	for index, node := range nodes {
		nodes[index] = quoteTreeNode(node)
	}
	return strings.Join(nodes, ".")
}

func quoteTreeNode(value string) string {
	if simpleTreeNodePattern.MatchString(value) {
		return value
	}
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func quoteSQLString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func optionalMetadataString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func stringPtr(value string) *string {
	return &value
}
