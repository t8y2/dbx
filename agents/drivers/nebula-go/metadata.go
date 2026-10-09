package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"

	nebula "github.com/vesoft-inc/nebula-go/v3"
)

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

type objectSource struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     *string `json:"schema"`
	Source     string  `json:"source"`
}

func (s *agentSession) listDatabases() ([]databaseInfo, error) {
	result, err := s.execute("SHOW SPACES", "")
	if err != nil {
		return nil, err
	}
	rows, err := metadataRows(result)
	if err != nil {
		return nil, err
	}
	spaces := make([]databaseInfo, 0, len(rows))
	for _, row := range rows {
		name := firstMetadataValue(row, "Name")
		if name != "" {
			spaces = append(spaces, databaseInfo{Name: name})
		}
	}
	sort.Slice(spaces, func(i, j int) bool { return spaces[i].Name < spaces[j].Name })
	return spaces, nil
}

func (s *agentSession) listTables(params map[string]json.RawMessage) ([]tableInfo, error) {
	space := selectedSpace(stringParam(params, "database"), s.params.Database)
	if space == "" {
		return []tableInfo{}, nil
	}
	filter := strings.ToLower(strings.TrimSpace(stringParam(params, "filter")))
	requestedTypes := stringSliceParam(params, "object_types")
	if len(requestedTypes) == 0 {
		requestedTypes = stringSliceParam(params, "objectTypes")
	}
	tables := make([]tableInfo, 0)
	for _, kind := range []struct{ typeName, statement string }{{"TABLE", "SHOW TAGS"}, {"VIEW", "SHOW EDGES"}} {
		if !acceptsObjectType(requestedTypes, kind.typeName) {
			continue
		}
		result, err := s.execute(kind.statement, space)
		if err != nil {
			return nil, err
		}
		rows, err := metadataRows(result)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			name := firstMetadataValue(row, "Name")
			if name != "" && strings.Contains(strings.ToLower(name), filter) {
				tables = append(tables, tableInfo{Name: name, TableType: kind.typeName})
			}
		}
	}
	sort.Slice(tables, func(i, j int) bool {
		if tables[i].TableType != tables[j].TableType {
			return tables[i].TableType < tables[j].TableType
		}
		return tables[i].Name < tables[j].Name
	})
	offset, limit := intParam(params, "offset"), intParam(params, "limit")
	if offset < 0 {
		offset = 0
	}
	if offset >= len(tables) {
		return []tableInfo{}, nil
	}
	tables = tables[offset:]
	if limit > 0 && limit < len(tables) {
		tables = tables[:limit]
	}
	return tables, nil
}

func (s *agentSession) listObjects(params map[string]json.RawMessage) ([]objectInfo, error) {
	tables, err := s.listTables(params)
	if err != nil {
		return nil, err
	}
	objects := make([]objectInfo, 0, len(tables))
	for _, table := range tables {
		objects = append(objects, objectInfo{Name: table.Name, ObjectType: table.TableType, Schema: ""})
	}
	return objects, nil
}

func (s *agentSession) getColumns(database, name string) ([]columnInfo, error) {
	space := selectedSpace(database, s.params.Database)
	if space == "" {
		return nil, errors.New("select a NebulaGraph space before reading object columns")
	}
	quoted, err := quoteNebulaIdentifier(name)
	if err != nil {
		return nil, err
	}
	result, err := s.execute("DESCRIBE TAG "+quoted, space)
	if err != nil {
		result, err = s.execute("DESCRIBE EDGE "+quoted, space)
		if err != nil {
			return nil, err
		}
	}
	rows, err := metadataRows(result)
	if err != nil {
		return nil, err
	}
	columns := make([]columnInfo, 0, len(rows))
	for _, row := range rows {
		field := firstMetadataValue(row, "Field")
		if field == "" {
			continue
		}
		columns = append(columns, columnInfo{
			Name: field, DataType: firstMetadataValue(row, "Type"),
			IsNullable:    !strings.EqualFold(firstMetadataValue(row, "Null"), "NO"),
			ColumnDefault: optionalMetadataValue(row, "Default"), Comment: optionalMetadataValue(row, "Comment"),
		})
	}
	return columns, nil
}

func (s *agentSession) getTableDDL(database, name, objectType string) (string, error) {
	space := selectedSpace(database, s.params.Database)
	if space == "" {
		return "", errors.New("select a NebulaGraph space before reading object DDL")
	}
	quoted, err := quoteNebulaIdentifier(name)
	if err != nil {
		return "", err
	}
	kinds := []string{"TAG", "EDGE"}
	if strings.EqualFold(objectType, "VIEW") || strings.EqualFold(objectType, "EDGE") {
		kinds = []string{"EDGE"}
	}
	for _, kind := range kinds {
		result, queryErr := s.execute("SHOW CREATE "+kind+" "+quoted, space)
		if queryErr != nil {
			if kind == kinds[len(kinds)-1] {
				return "", queryErr
			}
			continue
		}
		rows, readErr := metadataRows(result)
		if readErr != nil {
			return "", readErr
		}
		if len(rows) > 0 {
			for key, value := range rows[0] {
				if strings.HasPrefix(strings.ToLower(key), "create ") {
					return value, nil
				}
			}
		}
	}
	return "", nil
}

func (s *agentSession) getObjectSource(params map[string]json.RawMessage) (objectSource, error) {
	name := stringParam(params, "name")
	objectType := strings.ToUpper(stringParam(params, "object_type"))
	if objectType == "" {
		objectType = strings.ToUpper(stringParam(params, "objectType"))
	}
	source, err := s.getTableDDL(stringParam(params, "database"), name, objectType)
	if err != nil {
		return objectSource{}, err
	}
	return objectSource{Name: name, ObjectType: objectType, Source: source}, nil
}

func selectedSpace(requested, configured string) string {
	if strings.TrimSpace(requested) != "" {
		return strings.TrimSpace(requested)
	}
	return strings.TrimSpace(configured)
}

func quoteNebulaIdentifier(name string) (string, error) {
	if name == "" || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", fmt.Errorf("invalid NebulaGraph identifier: %q", name)
	}
	escaped := strings.ReplaceAll(strings.ReplaceAll(name, `\`, `\\`), "`", "\\`")
	return "`" + escaped + "`", nil
}

func acceptsObjectType(requested []string, kind string) bool {
	if len(requested) == 0 {
		return true
	}
	for _, candidate := range requested {
		if strings.EqualFold(candidate, kind) || (kind == "TABLE" && strings.EqualFold(candidate, "TAG")) || (kind == "VIEW" && strings.EqualFold(candidate, "EDGE")) {
			return true
		}
	}
	return false
}

func metadataRows(result *nebula.ResultSet) ([]map[string]string, error) {
	columns := result.GetColNames()
	rows := make([]map[string]string, 0, len(result.GetRows()))
	for index := range result.GetRows() {
		record, err := result.GetRowValuesByIndex(index)
		if err != nil {
			return nil, err
		}
		row := make(map[string]string, len(columns))
		for column, name := range columns {
			value, err := record.GetValueByIndex(column)
			if err != nil {
				return nil, err
			}
			if normalized := normalizeValue(value); normalized != nil {
				row[name] = fmt.Sprint(normalized)
			}
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func firstMetadataValue(row map[string]string, name string) string {
	for key, value := range row {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

func optionalMetadataValue(row map[string]string, name string) *string {
	value := firstMetadataValue(row, name)
	if value == "" || strings.EqualFold(value, "NULL") {
		return nil
	}
	return &value
}
