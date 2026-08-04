package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

var cassandraTypes = []string{
	"ascii", "bigint", "blob", "boolean", "counter", "date", "decimal", "double", "duration",
	"float", "inet", "int", "list", "map", "set", "smallint", "text", "time", "timestamp",
	"timeuuid", "tinyint", "tuple", "uuid", "varchar", "varint", "vector", "frozen",
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

func cassandraDataTypes() []string {
	return append([]string(nil), cassandraTypes...)
}

func (s *server) connectionInfo() (map[string]any, error) {
	session, err := s.runtime.sessionFor("")
	if err != nil {
		return nil, err
	}
	var clusterName, version, cqlVersion, dataCenter string
	err = session.Query("SELECT cluster_name, release_version, cql_version, data_center FROM system.local").Scan(
		&clusterName, &version, &cqlVersion, &dataCenter,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"database":          s.defaultKeyspace(),
		"schema":            s.defaultKeyspace(),
		"username":          s.params.Username,
		"version":           version,
		"clusterName":       clusterName,
		"cqlVersion":        cqlVersion,
		"localDatacenter":   dataCenter,
		"identifierQuote":   `"`,
		"compatibilityMode": "cql",
		"databaseInfo": map[string]string{
			"productName":            "Apache Cassandra",
			"productVersion":         version,
			"unquotedIdentifierCase": "lower",
			"quotedIdentifierCase":   "mixed",
			"driverName":             "Apache cassandra-gocql-driver",
			"driverVersion":          "2.1.2",
		},
	}, nil
}

func (s *server) allKeyspaceMetadata() (map[string]*gocql.KeyspaceMetadata, error) {
	session, err := s.runtime.sessionFor("")
	if err != nil {
		return nil, err
	}
	return session.AllKeyspaceMetadata()
}

func (s *server) keyspaceMetadata(schema string) (*gocql.KeyspaceMetadata, error) {
	session, err := s.runtime.sessionFor("")
	if err != nil {
		return nil, err
	}
	metadata, err := session.KeyspaceMetadata(schema)
	if err != nil {
		return nil, err
	}
	if metadata == nil {
		return nil, fmt.Errorf("Cassandra keyspace not found: %s", schema)
	}
	return metadata, nil
}

func (s *server) tableMetadata(schema, table string) (*gocql.TableMetadata, error) {
	keyspace, err := s.keyspaceMetadata(schema)
	if err != nil {
		return nil, err
	}
	metadata := keyspace.Tables[table]
	if metadata == nil {
		return nil, fmt.Errorf("Cassandra table not found: %s.%s", schema, table)
	}
	return metadata, nil
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	metadata, err := s.allKeyspaceMetadata()
	if err != nil {
		return nil, err
	}
	names := sortedMapKeys(metadata)
	result := make([]databaseInfo, len(names))
	for index, name := range names {
		result[index] = databaseInfo{Name: name}
	}
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
	metadata, err := s.keyspaceMetadata(schema)
	if err != nil {
		return nil, err
	}
	names := sortedMapKeys(metadata.Tables)
	result := make([]tableInfo, 0, len(names))
	for _, name := range names {
		if !metadataNameMatches(name, constraints.Filter) {
			continue
		}
		result = append(result, tableInfo{Name: name, TableType: "TABLE"})
	}
	return applyMetadataWindow(result, constraints.Offset, constraints.Limit), nil
}

func (s *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	tables, err := s.listTables(schema, metadataListConstraints{Filter: constraints.Filter})
	if err != nil {
		return nil, err
	}
	allowed := stringSet(constraints.ObjectTypes)
	result := make([]objectInfo, 0, len(tables))
	for _, table := range tables {
		if len(allowed) > 0 && !allowed["table"] && !allowed["base_table"] {
			continue
		}
		result = append(result, objectInfo{Name: table.Name, ObjectType: "TABLE", Schema: schema})
	}
	return applyMetadataWindow(result, constraints.Offset, constraints.Limit), nil
}

func (s *server) getColumns(schema, table string) ([]columnInfo, error) {
	metadata, err := s.tableMetadata(schema, table)
	if err != nil {
		return nil, err
	}
	return columnsFromMetadata(metadata), nil
}

func columnsFromMetadata(metadata *gocql.TableMetadata) []columnInfo {
	names := orderedColumnNames(metadata)
	result := make([]columnInfo, 0, len(names))
	for _, name := range names {
		column := metadata.Columns[name]
		if column == nil {
			continue
		}
		primary := column.Kind == gocql.ColumnPartitionKey || column.Kind == gocql.ColumnClusteringKey
		extra := column.Kind.String()
		result = append(result, columnInfo{
			Name:         column.Name,
			DataType:     cqlTypeName(column.Type),
			IsNullable:   !primary,
			IsPrimaryKey: primary,
			Extra:        &extra,
		})
	}
	return result
}

func (s *server) listIndexes(schema, table string) ([]indexInfo, error) {
	metadata, err := s.tableMetadata(schema, table)
	if err != nil {
		return nil, err
	}
	result := indexesFromMetadata(metadata)
	queried, queryErr := s.querySystemIndexes(schema, table)
	if queryErr == nil {
		result = mergeIndexes(result, queried)
	}
	return result, nil
}

func (s *server) querySystemIndexes(schema, table string) ([]indexInfo, error) {
	session, err := s.runtime.sessionFor("")
	if err != nil {
		return nil, err
	}
	iter := session.Query(
		"SELECT index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?",
		schema,
		table,
	).Iter()
	result := []indexInfo{}
	var name, kind string
	var options map[string]string
	for iter.Scan(&name, &kind, &options) {
		indexType := strings.TrimSpace(kind)
		result = append(result, indexInfo{
			Name:            name,
			Columns:         targetColumns(options["target"]),
			IndexType:       optionalString(indexType),
			IncludedColumns: []string{},
		})
		options = nil
	}
	if err := iter.Close(); err != nil {
		return nil, err
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return result, nil
}

func mergeIndexes(first, second []indexInfo) []indexInfo {
	byName := make(map[string]indexInfo, len(first)+len(second))
	for _, index := range first {
		byName[index.Name] = index
	}
	for _, index := range second {
		if existing, ok := byName[index.Name]; ok && len(index.Columns) == 0 {
			index.Columns = existing.Columns
		}
		byName[index.Name] = index
	}
	names := sortedMapKeys(byName)
	result := make([]indexInfo, 0, len(names))
	for _, name := range names {
		result = append(result, byName[name])
	}
	return result
}

func targetColumns(target string) []string {
	target = strings.TrimSpace(target)
	for _, wrapper := range []string{"values", "keys", "entries", "full"} {
		prefix := wrapper + "("
		if strings.HasPrefix(strings.ToLower(target), prefix) && strings.HasSuffix(target, ")") {
			target = strings.TrimSpace(target[len(prefix) : len(target)-1])
			break
		}
	}
	target = strings.Trim(target, `"'`)
	if target == "" {
		return []string{}
	}
	return []string{target}
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func indexesFromMetadata(metadata *gocql.TableMetadata) []indexInfo {
	byName := map[string]*indexInfo{}
	for _, columnName := range orderedColumnNames(metadata) {
		column := metadata.Columns[columnName]
		if column == nil || strings.TrimSpace(column.Index.Name) == "" {
			continue
		}
		index := byName[column.Index.Name]
		if index == nil {
			indexType := strings.TrimSpace(column.Index.Type)
			index = &indexInfo{Name: column.Index.Name, Columns: []string{}, IncludedColumns: []string{}}
			if indexType != "" {
				index.IndexType = &indexType
			}
			byName[index.Name] = index
		}
		index.Columns = append(index.Columns, columnName)
	}
	names := sortedMapKeys(byName)
	result := make([]indexInfo, 0, len(names))
	for _, name := range names {
		result = append(result, *byName[name])
	}
	return result
}

func (s *server) getTableDDL(schema, table string) (string, error) {
	metadata, err := s.tableMetadata(schema, table)
	if err != nil {
		return "", err
	}
	return tableDDLFromMetadata(schema, table, metadata)
}

func tableDDLFromMetadata(schema, table string, metadata *gocql.TableMetadata) (string, error) {
	definitions := make([]string, 0, len(metadata.Columns)+1)
	for _, name := range orderedColumnNames(metadata) {
		column := metadata.Columns[name]
		if column != nil {
			definitions = append(definitions, "  "+quoteCQLIdentifier(column.Name)+" "+cqlTypeName(column.Type))
		}
	}
	partitionKeys := metadataColumnNames(metadata.PartitionKey)
	clusteringKeys := metadataColumnNames(metadata.ClusteringColumns)
	if len(partitionKeys) == 0 {
		return "", fmt.Errorf("Cassandra table has no partition key: %s.%s", schema, table)
	}
	primaryParts := make([]string, 0, len(clusteringKeys)+1)
	if len(partitionKeys) == 1 {
		primaryParts = append(primaryParts, quoteCQLIdentifier(partitionKeys[0]))
	} else {
		quoted := make([]string, len(partitionKeys))
		for index, name := range partitionKeys {
			quoted[index] = quoteCQLIdentifier(name)
		}
		primaryParts = append(primaryParts, "("+strings.Join(quoted, ", ")+")")
	}
	for _, name := range clusteringKeys {
		primaryParts = append(primaryParts, quoteCQLIdentifier(name))
	}
	definitions = append(definitions, "  PRIMARY KEY ("+strings.Join(primaryParts, ", ")+")")
	ddl := "CREATE TABLE " + quoteCQLIdentifier(schema) + "." + quoteCQLIdentifier(table) + " (\n" + strings.Join(definitions, ",\n") + "\n)"
	orders := make([]string, 0, len(metadata.ClusteringColumns))
	for _, column := range metadata.ClusteringColumns {
		if column != nil {
			order := "ASC"
			if column.Order == gocql.DESC {
				order = "DESC"
			}
			orders = append(orders, quoteCQLIdentifier(column.Name)+" "+order)
		}
	}
	if len(orders) > 0 {
		ddl += " WITH CLUSTERING ORDER BY (" + strings.Join(orders, ", ") + ")"
	}
	return ddl + ";", nil
}

func (s *server) completionAssistantSearch(input completionAssistantRequest) (completionAssistantResponse, error) {
	limit := input.MaxResults
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	candidates := make([]completionAssistantCandidate, 0, limit+1)
	kinds := stringSet(input.ObjectKinds)
	if kinds["column"] && input.ParentName != "" {
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
				Name: column.Name, Kind: "COLUMN", Schema: stringPtr(schema), ParentSchema: stringPtr(schema),
				ParentName: stringPtr(input.ParentName), DataType: &dataType,
			})
		}
	} else {
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
					Name: object.Name, Kind: object.ObjectType, Schema: stringPtr(schema),
				})
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
	return completionAssistantResponse{Candidates: candidates, Incomplete: incomplete}, nil
}

func metadataListConstraintsFromParams(params map[string]json.RawMessage) metadataListConstraints {
	return metadataListConstraints{
		Filter:      stringParam(params, "filter"),
		Limit:       intParam(params, "limit"),
		Offset:      intParam(params, "offset"),
		ObjectTypes: stringSliceParam(params, "object_types"),
	}
}

func orderedColumnNames(metadata *gocql.TableMetadata) []string {
	if len(metadata.OrderedColumns) > 0 {
		return append([]string(nil), metadata.OrderedColumns...)
	}
	return sortedMapKeys(metadata.Columns)
}

func metadataColumnNames(columns []*gocql.ColumnMetadata) []string {
	result := make([]string, 0, len(columns))
	for _, column := range columns {
		if column != nil {
			result = append(result, column.Name)
		}
	}
	return result
}

func metadataNameMatches(name, filter string) bool {
	return filter == "" || strings.Contains(strings.ToLower(name), strings.ToLower(filter))
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

func sortedMapKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[strings.ToLower(strings.TrimSpace(value))] = true
	}
	return result
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
	if strings.EqualFold(input.MatchMode, "contains") {
		return strings.Contains(name, mask)
	}
	return strings.HasPrefix(name, mask)
}

func quoteCQLIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func stringPtr(value string) *string {
	return &value
}
