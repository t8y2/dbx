package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
)

var neo4jTypes = []string{
	"Any", "Boolean", "Date", "DateTime", "Duration", "Float", "Integer", "List", "LocalDateTime",
	"LocalTime", "Map", "Node", "Null", "Path", "Point", "Relationship", "String", "Time", "Vector",
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

func neo4jDataTypes() []string {
	return append([]string(nil), neo4jTypes...)
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	records, err := s.runMetadataQuery(
		"SHOW DATABASES YIELD name RETURN name ORDER BY name",
		nil,
	)
	if err != nil {
		return []databaseInfo{{Name: s.databaseName("")}}, nil
	}
	seen := map[string]struct{}{}
	result := make([]databaseInfo, 0, len(records))
	for _, record := range records {
		name := recordString(record, "name")
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, databaseInfo{Name: name})
	}
	if len(result) == 0 {
		result = append(result, databaseInfo{Name: s.databaseName("")})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return result, nil
}

func (s *server) listTables(constraints metadataListConstraints) ([]tableInfo, error) {
	records, err := s.runMetadataQuery(
		"CALL db.labels() YIELD label RETURN label ORDER BY label",
		nil,
	)
	if err != nil {
		return nil, err
	}
	result := make([]tableInfo, 0, len(records))
	for _, record := range records {
		name := recordString(record, "label")
		if name == "" || !metadataNameMatches(name, constraints.Filter) || !acceptsNodeType(constraints.ObjectTypes) {
			continue
		}
		result = append(result, tableInfo{Name: name, TableType: "TABLE"})
	}
	return applyMetadataWindow(result, constraints.Offset, constraints.Limit), nil
}

func (s *server) listObjects(constraints metadataListConstraints) ([]objectInfo, error) {
	tables, err := s.listTables(constraints)
	if err != nil {
		return nil, err
	}
	result := make([]objectInfo, 0, len(tables))
	for _, table := range tables {
		result = append(result, objectInfo{Name: table.Name, ObjectType: "TABLE", Schema: ""})
	}
	return result, nil
}

func (s *server) getColumns(label string) ([]columnInfo, error) {
	if strings.TrimSpace(label) == "" {
		return []columnInfo{}, nil
	}
	records, err := s.runMetadataQuery(
		"CALL db.schema.nodeTypeProperties() "+
			"YIELD nodeLabels, propertyName, propertyTypes, mandatory "+
			"WHERE $label IN nodeLabels "+
			"RETURN propertyName, propertyTypes, mandatory ORDER BY propertyName",
		map[string]any{"label": label},
	)
	if err != nil {
		records, err = s.runMetadataQuery(
			fmt.Sprintf(
				"MATCH (n:%s) UNWIND keys(n) AS propertyName "+
					"WITH DISTINCT propertyName RETURN propertyName, ['Unknown'] AS propertyTypes, false AS mandatory "+
					"ORDER BY propertyName LIMIT 10000",
				quoteCypherIdentifier(label),
			),
			nil,
		)
		if err != nil {
			return nil, err
		}
	}
	result := make([]columnInfo, 0, len(records))
	seen := map[string]struct{}{}
	for _, record := range records {
		name := recordString(record, "propertyName")
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		types := recordStringSlice(record, "propertyTypes")
		dataType := "Unknown"
		if len(types) > 0 {
			dataType = strings.Join(types, " | ")
		}
		result = append(result, columnInfo{
			Name:       name,
			DataType:   dataType,
			IsNullable: !recordBool(record, "mandatory"),
		})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].Name < result[right].Name })
	return result, nil
}

func (s *server) listIndexes(label string) ([]indexInfo, error) {
	if strings.TrimSpace(label) == "" {
		return []indexInfo{}, nil
	}
	records, err := s.runMetadataQuery(
		"SHOW INDEXES YIELD name, type, labelsOrTypes, properties, owningConstraint "+
			"WHERE $label IN labelsOrTypes "+
			"RETURN name, type, properties, owningConstraint ORDER BY name",
		map[string]any{"label": label},
	)
	if err != nil {
		return nil, err
	}
	result := make([]indexInfo, 0, len(records))
	for _, record := range records {
		indexType := recordString(record, "type")
		result = append(result, indexInfo{
			Name:            recordString(record, "name"),
			Columns:         recordStringSlice(record, "properties"),
			IsUnique:        recordString(record, "owningConstraint") != "",
			IndexType:       stringPtr(indexType),
			IncludedColumns: []string{},
		})
	}
	return result, nil
}

func (s *server) completionAssistantSearch(params map[string]json.RawMessage) (completionAssistantResponse, error) {
	var request completionAssistantRequest
	if err := decodeParams(params, &request); err != nil {
		return completionAssistantResponse{}, err
	}
	limit := request.MaxResults
	if limit <= 0 {
		limit = 100
	}
	kinds := map[string]bool{}
	for _, kind := range request.ObjectKinds {
		kinds[strings.ToLower(kind)] = true
	}
	includeTables := len(kinds) == 0 || kinds["table"] || kinds["node"]
	includeColumns := len(kinds) == 0 || kinds["column"] || kinds["property"]
	constraints := metadataListConstraints{Filter: request.Mask}
	tables, err := s.listTables(constraints)
	if err != nil {
		return completionAssistantResponse{}, err
	}
	database := s.databaseName(request.Database)
	candidates := make([]completionAssistantCandidate, 0, min(limit+1, len(tables)))
	for _, table := range tables {
		if includeTables && completionNameMatches(table.Name, request) {
			candidates = append(candidates, completionAssistantCandidate{
				Name: table.Name, Kind: "table", Database: stringPtr(database),
			})
		}
		if includeColumns && (request.ParentName == "" || request.ParentName == table.Name) {
			columns, columnErr := s.getColumns(table.Name)
			if columnErr != nil {
				continue
			}
			for _, column := range columns {
				if !completionNameMatches(column.Name, request) {
					continue
				}
				parent := table.Name
				dataType := column.DataType
				candidates = append(candidates, completionAssistantCandidate{
					Name: column.Name, Kind: "column", Database: stringPtr(database), ParentName: &parent, DataType: &dataType,
				})
				if len(candidates) > limit {
					return completionAssistantResponse{Candidates: candidates[:limit], Incomplete: true}, nil
				}
			}
		}
		if len(candidates) > limit {
			return completionAssistantResponse{Candidates: candidates[:limit], Incomplete: true}, nil
		}
	}
	return completionAssistantResponse{Candidates: candidates, Incomplete: false}, nil
}

func (s *server) runMetadataQuery(cypher string, params map[string]any) ([]*neo4j.Record, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := s.newSession(ctx, "", neo4j.AccessModeRead, 256)
	defer session.Close(ctx)
	result, err := session.Run(ctx, cypher, params)
	if err != nil {
		return nil, err
	}
	records, err := result.Collect(ctx)
	if err != nil {
		return nil, err
	}
	return records, nil
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

func acceptsNodeType(objectTypes []string) bool {
	if len(objectTypes) == 0 {
		return true
	}
	for _, objectType := range objectTypes {
		switch strings.ToLower(objectType) {
		case "table", "node", "label":
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

func completionNameMatches(name string, request completionAssistantRequest) bool {
	mask := request.Mask
	if mask == "" {
		return true
	}
	left, right := name, mask
	if !request.CaseSensitive {
		left, right = strings.ToLower(left), strings.ToLower(right)
	}
	switch strings.ToLower(request.MatchMode) {
	case "exact":
		return left == right
	case "prefix":
		return strings.HasPrefix(left, right)
	default:
		return strings.Contains(left, right)
	}
}

func recordValue(record *neo4j.Record, key string) any {
	if record == nil {
		return nil
	}
	value, found := record.Get(key)
	if !found {
		return nil
	}
	return value
}

func recordString(record *neo4j.Record, key string) string {
	value := recordValue(record, key)
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func recordStringSlice(record *neo4j.Record, key string) []string {
	value := recordValue(record, key)
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if item != nil {
				result = append(result, fmt.Sprint(item))
			}
		}
		return result
	case nil:
		return []string{}
	default:
		return []string{fmt.Sprint(typed)}
	}
}

func recordBool(record *neo4j.Record, key string) bool {
	value, _ := recordValue(record, key).(bool)
	return value
}

func quoteCypherIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
