package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

const maxLegacyMaterializedViewColumns = 4096

const cassandraMaterializedViewObjectType = "MATERIALIZED_VIEW"

var legacyMaterializedViewOptionNames = []string{
	"additional_write_policy",
	"bloom_filter_fp_chance",
	"caching",
	"cdc",
	"comment",
	"compaction",
	"compression",
	"crc_check_chance",
	"dclocal_read_repair_chance",
	"gc_grace_seconds",
	"max_index_interval",
	"memtable",
	"memtable_flush_period_in_ms",
	"min_index_interval",
	"read_repair",
	"read_repair_chance",
	"speculative_retry",
}

type objectSource struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     *string `json:"schema"`
	Source     string  `json:"source"`
}

type materializedViewColumn struct {
	Name            string
	Kind            string
	Position        int
	ClusteringOrder string
}

type materializedViewCatalog struct {
	BaseTable         string
	IncludeAllColumns bool
	WhereClause       string
	Columns           []materializedViewColumn
	Options           map[string]any
}

func (s *server) getObjectSource(schema, name, objectType string) (objectSource, error) {
	return materializedViewObjectSource(schema, name, objectType, func() (string, error) {
		return s.getMaterializedViewDDL(schema, name)
	})
}

func materializedViewObjectSource(schema, name, objectType string, loadDDL func() (string, error)) (objectSource, error) {
	if normalizeCassandraObjectType(objectType) != cassandraMaterializedViewObjectType {
		return objectSource{}, errors.New("object source is not supported by Cassandra")
	}
	source, err := loadDDL()
	if err != nil {
		return objectSource{}, err
	}
	return objectSource{
		Name:       name,
		ObjectType: cassandraMaterializedViewObjectType,
		Schema:     optionalString(schema),
		Source:     source,
	}, nil
}

func normalizeCassandraObjectType(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "_")
	return strings.ReplaceAll(value, " ", "_")
}

func (s *server) getMaterializedViewDDL(schema, view string) (string, error) {
	session, err := s.runtime.sessionFor("")
	if err != nil {
		return "", err
	}
	return materializedViewDDLWithFallback(
		func() (string, error) {
			return describeMaterializedViewDDL(session, schema, view)
		},
		func() (string, error) {
			catalog, err := legacyMaterializedViewCatalog(session, schema, view)
			if err != nil {
				return "", err
			}
			return materializedViewDDLFromCatalog(schema, view, catalog)
		},
	)
}

func materializedViewDDLWithFallback(describe, legacy func() (string, error)) (string, error) {
	ddl, err := describe()
	if err == nil {
		if strings.TrimSpace(ddl) == "" {
			return "", errors.New("Cassandra returned an empty materialized view definition")
		}
		return ddl, nil
	}
	if !isUnsupportedDescribeSyntax(err) {
		return "", err
	}
	return legacy()
}

func isUnsupportedDescribeSyntax(err error) bool {
	var requestError gocql.RequestError
	return errors.As(err, &requestError) && requestError.Code() == gocql.ErrCodeSyntax
}

func describeMaterializedViewDDL(session *gocql.Session, schema, view string) (string, error) {
	statement := "DESCRIBE MATERIALIZED VIEW " + qualifiedCQLIdentifier(schema, view)
	var describedSchema, objectType, describedName, ddl string
	if err := session.Query(statement).Scan(&describedSchema, &objectType, &describedName, &ddl); err != nil {
		return "", fmt.Errorf("describe Cassandra materialized view %s: %w", qualifiedCQLIdentifier(schema, view), err)
	}
	if normalizeCassandraObjectType(objectType) != cassandraMaterializedViewObjectType {
		return "", fmt.Errorf("Cassandra DESCRIBE returned object type %q for materialized view %s", objectType, qualifiedCQLIdentifier(schema, view))
	}
	if strings.TrimSpace(ddl) == "" {
		return "", fmt.Errorf("Cassandra returned an empty materialized view definition for %s", qualifiedCQLIdentifier(schema, view))
	}
	return ddl, nil
}

func legacyMaterializedViewCatalog(session *gocql.Session, schema, view string) (materializedViewCatalog, error) {
	row := map[string]any{}
	err := session.Query(
		"SELECT * FROM system_schema.views WHERE keyspace_name = ? AND view_name = ?",
		schema,
		view,
	).MapScan(row)
	if errors.Is(err, gocql.ErrNotFound) {
		return materializedViewCatalog{}, fmt.Errorf("Cassandra materialized view not found: %s.%s", schema, view)
	}
	if err != nil {
		return materializedViewCatalog{}, fmt.Errorf("read Cassandra materialized view catalog for %s: %w", qualifiedCQLIdentifier(schema, view), err)
	}

	baseTable, ok := row["base_table_name"].(string)
	if !ok || strings.TrimSpace(baseTable) == "" {
		return materializedViewCatalog{}, fmt.Errorf("Cassandra materialized view catalog has no base table for %s", qualifiedCQLIdentifier(schema, view))
	}
	includeAllColumns, ok := row["include_all_columns"].(bool)
	if !ok {
		return materializedViewCatalog{}, fmt.Errorf("Cassandra materialized view catalog has no projection mode for %s", qualifiedCQLIdentifier(schema, view))
	}
	whereClause, ok := row["where_clause"].(string)
	if !ok || strings.TrimSpace(whereClause) == "" {
		return materializedViewCatalog{}, fmt.Errorf("Cassandra materialized view catalog has no WHERE clause for %s", qualifiedCQLIdentifier(schema, view))
	}

	options, err := legacyMaterializedViewOptions(row)
	if err != nil {
		return materializedViewCatalog{}, fmt.Errorf("read Cassandra materialized view options for %s: %w", qualifiedCQLIdentifier(schema, view), err)
	}
	columns, err := legacyMaterializedViewColumns(session, schema, view)
	if err != nil {
		return materializedViewCatalog{}, err
	}
	return materializedViewCatalog{
		BaseTable:         baseTable,
		IncludeAllColumns: includeAllColumns,
		WhereClause:       whereClause,
		Columns:           columns,
		Options:           options,
	}, nil
}

func legacyMaterializedViewOptions(row map[string]any) (map[string]any, error) {
	metadataColumns := map[string]bool{
		"base_table_id":       true,
		"base_table_name":     true,
		"id":                  true,
		"include_all_columns": true,
		"keyspace_name":       true,
		"view_name":           true,
		"where_clause":        true,
	}
	knownOptions := make(map[string]bool, len(legacyMaterializedViewOptionNames)+1)
	for _, name := range legacyMaterializedViewOptionNames {
		knownOptions[name] = true
	}
	knownOptions["default_time_to_live"] = true
	knownOptions["extensions"] = true

	for name, value := range row {
		if value != nil && !metadataColumns[name] && !knownOptions[name] {
			return nil, fmt.Errorf("unsupported system_schema.views column %q", name)
		}
	}
	if value, exists := row["default_time_to_live"]; exists && value != nil && fmt.Sprint(value) != "0" {
		return nil, fmt.Errorf("unsupported non-zero default_time_to_live %v", value)
	}
	if value, exists := row["extensions"]; exists && value != nil && !isEmptyCQLCollection(value) {
		return nil, errors.New("non-empty materialized view extensions cannot be reproduced safely")
	}

	options := make(map[string]any, len(legacyMaterializedViewOptionNames))
	_, hasModernReadRepair := row["read_repair"]
	for _, name := range legacyMaterializedViewOptionNames {
		if value, exists := row[name]; exists && value != nil {
			if hasModernReadRepair && (name == "dclocal_read_repair_chance" || name == "read_repair_chance") {
				continue
			}
			if name == "memtable" && strings.TrimSpace(fmt.Sprint(value)) == "" {
				continue
			}
			options[name] = value
		}
	}
	return options, nil
}

func legacyMaterializedViewColumns(session *gocql.Session, schema, view string) ([]materializedViewColumn, error) {
	iter := session.Query(
		"SELECT column_name, kind, position, clustering_order FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?",
		schema,
		view,
	).PageSize(512).Iter()
	columns := make([]materializedViewColumn, 0)
	var column materializedViewColumn
	for iter.Scan(&column.Name, &column.Kind, &column.Position, &column.ClusteringOrder) {
		if len(columns) >= maxLegacyMaterializedViewColumns {
			_ = iter.Close()
			return nil, fmt.Errorf("Cassandra materialized view %s has more than %d columns", qualifiedCQLIdentifier(schema, view), maxLegacyMaterializedViewColumns)
		}
		columns = append(columns, column)
		column = materializedViewColumn{}
	}
	if err := iter.Close(); err != nil {
		return nil, fmt.Errorf("read Cassandra materialized view columns for %s: %w", qualifiedCQLIdentifier(schema, view), err)
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("Cassandra materialized view catalog has no columns for %s", qualifiedCQLIdentifier(schema, view))
	}
	return columns, nil
}

func materializedViewDDLFromCatalog(schema, view string, catalog materializedViewCatalog) (string, error) {
	if strings.TrimSpace(catalog.BaseTable) == "" {
		return "", fmt.Errorf("Cassandra materialized view catalog has no base table for %s", qualifiedCQLIdentifier(schema, view))
	}
	if strings.TrimSpace(catalog.WhereClause) == "" {
		return "", fmt.Errorf("Cassandra materialized view catalog has no WHERE clause for %s", qualifiedCQLIdentifier(schema, view))
	}

	partitionKeys, clusteringColumns, selectedColumns, err := classifyMaterializedViewColumns(catalog.Columns)
	if err != nil {
		return "", fmt.Errorf("invalid Cassandra materialized view columns for %s: %w", qualifiedCQLIdentifier(schema, view), err)
	}
	if len(partitionKeys) == 0 {
		return "", fmt.Errorf("Cassandra materialized view has no partition key: %s", qualifiedCQLIdentifier(schema, view))
	}

	projection := "*"
	if !catalog.IncludeAllColumns {
		quoted := make([]string, len(selectedColumns))
		for index, column := range selectedColumns {
			quoted[index] = quoteCQLIdentifier(column.Name)
		}
		projection = strings.Join(quoted, ", ")
	}

	primaryParts := make([]string, 0, len(clusteringColumns)+1)
	if len(partitionKeys) == 1 {
		primaryParts = append(primaryParts, quoteCQLIdentifier(partitionKeys[0].Name))
	} else {
		quoted := make([]string, len(partitionKeys))
		for index, column := range partitionKeys {
			quoted[index] = quoteCQLIdentifier(column.Name)
		}
		primaryParts = append(primaryParts, "("+strings.Join(quoted, ", ")+")")
	}
	for _, column := range clusteringColumns {
		primaryParts = append(primaryParts, quoteCQLIdentifier(column.Name))
	}

	properties := make([]string, 0, len(catalog.Options)+1)
	if len(clusteringColumns) > 0 {
		orders := make([]string, len(clusteringColumns))
		for index, column := range clusteringColumns {
			order := strings.ToUpper(strings.TrimSpace(column.ClusteringOrder))
			if order != "ASC" && order != "DESC" {
				return "", fmt.Errorf("invalid clustering order %q for column %q", column.ClusteringOrder, column.Name)
			}
			orders[index] = quoteCQLIdentifier(column.Name) + " " + order
		}
		properties = append(properties, "CLUSTERING ORDER BY ("+strings.Join(orders, ", ")+")")
	}
	for _, name := range legacyMaterializedViewOptionNames {
		value, exists := catalog.Options[name]
		if !exists || value == nil {
			continue
		}
		properties = append(properties, name+" = "+cqlLiteral(value))
	}
	if len(properties) == 0 {
		return "", fmt.Errorf("Cassandra materialized view has no reproducible table options: %s", qualifiedCQLIdentifier(schema, view))
	}

	return "CREATE MATERIALIZED VIEW " + qualifiedCQLIdentifier(schema, view) + " AS\n" +
		"  SELECT " + projection + "\n" +
		"  FROM " + qualifiedCQLIdentifier(schema, catalog.BaseTable) + "\n" +
		"  WHERE " + strings.TrimSpace(catalog.WhereClause) + "\n" +
		"  PRIMARY KEY (" + strings.Join(primaryParts, ", ") + ")\n" +
		"  WITH " + strings.Join(properties, "\n  AND ") + ";", nil
}

func qualifiedCQLIdentifier(schema, name string) string {
	return quoteCQLIdentifier(schema) + "." + quoteCQLIdentifier(name)
}

func classifyMaterializedViewColumns(columns []materializedViewColumn) ([]materializedViewColumn, []materializedViewColumn, []materializedViewColumn, error) {
	partitionKeys := make([]materializedViewColumn, 0)
	clusteringColumns := make([]materializedViewColumn, 0)
	regularColumns := make([]materializedViewColumn, 0)
	seenNames := make(map[string]bool, len(columns))
	for _, column := range columns {
		if strings.TrimSpace(column.Name) == "" {
			return nil, nil, nil, errors.New("column name is empty")
		}
		if seenNames[column.Name] {
			return nil, nil, nil, fmt.Errorf("duplicate column %q", column.Name)
		}
		seenNames[column.Name] = true
		switch strings.ToLower(strings.TrimSpace(column.Kind)) {
		case "partition_key":
			partitionKeys = append(partitionKeys, column)
		case "clustering", "clustering_key":
			clusteringColumns = append(clusteringColumns, column)
		case "regular", "static":
			regularColumns = append(regularColumns, column)
		default:
			return nil, nil, nil, fmt.Errorf("unsupported kind %q for column %q", column.Kind, column.Name)
		}
	}
	if err := sortMaterializedViewKeyColumns(partitionKeys, "partition"); err != nil {
		return nil, nil, nil, err
	}
	if err := sortMaterializedViewKeyColumns(clusteringColumns, "clustering"); err != nil {
		return nil, nil, nil, err
	}
	sort.Slice(regularColumns, func(left, right int) bool { return regularColumns[left].Name < regularColumns[right].Name })
	selectedColumns := make([]materializedViewColumn, 0, len(columns))
	selectedColumns = append(selectedColumns, partitionKeys...)
	selectedColumns = append(selectedColumns, clusteringColumns...)
	selectedColumns = append(selectedColumns, regularColumns...)
	return partitionKeys, clusteringColumns, selectedColumns, nil
}

func sortMaterializedViewKeyColumns(columns []materializedViewColumn, kind string) error {
	sort.Slice(columns, func(left, right int) bool {
		if columns[left].Position == columns[right].Position {
			return columns[left].Name < columns[right].Name
		}
		return columns[left].Position < columns[right].Position
	})
	for index, column := range columns {
		if column.Position < 0 {
			return fmt.Errorf("invalid %s-key position %d for column %q", kind, column.Position, column.Name)
		}
		if index > 0 && columns[index-1].Position == column.Position {
			return fmt.Errorf("duplicate %s-key position %d", kind, column.Position)
		}
	}
	return nil
}

func isEmptyCQLCollection(value any) bool {
	switch typed := value.(type) {
	case map[string]string:
		return len(typed) == 0
	case map[string][]byte:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}
