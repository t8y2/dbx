package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	nebula "github.com/vesoft-inc/nebula-go/v3"
)

const (
	defaultMaxRows = 10000
	maxQueryRows   = 100000
	defaultPage    = 1000
)

type queryOptions struct {
	SQL         string `json:"sql"`
	Database    string `json:"database"`
	MaxRows     int    `json:"maxRows"`
	TimeoutSecs int    `json:"timeoutSecs"`
}

type queryResult struct {
	Columns         []string `json:"columns"`
	ColumnTypes     []string `json:"column_types"`
	Rows            [][]any  `json:"rows"`
	AffectedRows    int64    `json:"affected_rows"`
	ExecutionTimeMS int64    `json:"execution_time_ms"`
	Truncated       bool     `json:"truncated"`
}

type queryPageResult struct {
	queryResult
	SessionID *string `json:"session_id"`
	HasMore   bool    `json:"has_more"`
}

type queryCursor struct {
	result queryResult
	offset int
}

type graphVID struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type graphProperty struct {
	Owner string `json:"owner,omitempty"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value any    `json:"value"`
}

type graphNode struct {
	ID         string          `json:"id"`
	VID        graphVID        `json:"vid"`
	Labels     []string        `json:"labels"`
	Properties []graphProperty `json:"properties"`
}

type graphEdge struct {
	ID         string          `json:"id"`
	Source     string          `json:"source"`
	Target     string          `json:"target"`
	SourceVID  graphVID        `json:"sourceVid"`
	TargetVID  graphVID        `json:"targetVid"`
	Type       string          `json:"type"`
	Rank       string          `json:"rank"`
	Properties []graphProperty `json:"properties"`
}

type graphCell struct {
	Marker       string      `json:"__dbx_graph_cell"`
	Kind         string      `json:"kind"`
	Display      string      `json:"display"`
	Nodes        []graphNode `json:"nodes"`
	Edges        []graphEdge `json:"edges"`
	DisplayParts []any       `json:"displayParts,omitempty"`
}

func (s *agentSession) dispatch(method string, params map[string]json.RawMessage) (any, error) {
	switch method {
	case "connection_info":
		return map[string]any{
			"database": s.params.Database, "schema": "", "username": s.params.Username,
			"identifierQuote": "`", "compatibilityMode": "ngql",
			"databaseInfo": map[string]string{
				"productName": "NebulaGraph", "driverName": "NebulaGraph Go Client", "driverVersion": "3.8.0",
				"unquotedIdentifierCase": "mixed", "quotedIdentifierCase": "mixed",
			},
		}, nil
	case "list_databases":
		return s.listDatabases()
	case "list_schemas":
		return []string{}, nil
	case "list_tables":
		return s.listTables(params)
	case "list_objects":
		return s.listObjects(params)
	case "list_data_types":
		return []string{"bool", "int8", "int16", "int32", "int64", "float", "double", "string", "fixed_string", "date", "time", "datetime", "timestamp", "duration", "geography"}, nil
	case "get_columns":
		return s.getColumns(stringParam(params, "database"), stringParam(params, "table"))
	case "get_table_ddl":
		return s.getTableDDL(stringParam(params, "database"), stringParam(params, "table"), "")
	case "get_object_source":
		return s.getObjectSource(params)
	case "get_table_comment":
		return nil, nil
	case "list_indexes", "list_foreign_keys", "list_triggers", "list_constraints", "list_partitions", "list_subpartitions":
		return []any{}, nil
	case "get_explain_info":
		return map[string]any{"plan": "", "has_actual_stats": false}, nil
	case "execute_query":
		var options queryOptions
		if err := decodeParams(params, &options); err != nil {
			return nil, err
		}
		return s.executeQuery(options)
	case "execute_query_page", "start_table_read":
		var options queryOptions
		if err := decodeParams(params, &options); err != nil {
			return nil, err
		}
		return s.executeQueryPage(options, intParam(params, "pageSize"))
	case "fetch_query_page", "fetch_table_read_page":
		return s.fetchQueryPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
	case "close_query_session", "close_table_read_session":
		delete(s.cursors, stringParam(params, "sessionId"))
		return map[string]bool{"ok": true}, nil
	case "execute_batch":
		started := time.Now()
		for _, statement := range stringSliceParam(params, "statements") {
			_, err := s.executeQuery(queryOptions{SQL: statement, Database: stringParam(params, "database")})
			if err != nil {
				return nil, err
			}
		}
		return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, ExecutionTimeMS: time.Since(started).Milliseconds()}, nil
	default:
		return nil, fmt.Errorf("unsupported NebulaGraph agent method: %s", method)
	}
}

func (s *agentSession) execute(statement, space string) (*nebula.ResultSet, error) {
	if s.canceled.Load() {
		return nil, errors.New("agent session was canceled")
	}
	if space = strings.TrimSpace(space); space != "" {
		quoted, err := quoteNebulaIdentifier(space)
		if err != nil {
			return nil, err
		}
		selected, err := s.conn.Execute("USE " + quoted)
		if err != nil {
			return nil, err
		}
		if err := resultError(selected); err != nil {
			return nil, err
		}
	}
	result, err := s.conn.Execute(statement)
	if err != nil {
		return nil, err
	}
	if err := resultError(result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *agentSession) executeQuery(options queryOptions) (queryResult, error) {
	started := time.Now()
	statement := strings.TrimSpace(options.SQL)
	if statement == "" {
		return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}}, nil
	}
	space := options.Database
	if space == "" {
		space = s.params.Database
	}
	result, err := s.execute(statement, space)
	if err != nil {
		return queryResult{}, err
	}
	rows, types, err := readRows(result, effectiveMaxRows(options.MaxRows))
	if err != nil {
		return queryResult{}, err
	}
	return queryResult{
		Columns: result.GetColNames(), ColumnTypes: types, Rows: rows,
		ExecutionTimeMS: time.Since(started).Milliseconds(), Truncated: len(result.GetRows()) > len(rows),
	}, nil
}

func (s *agentSession) executeQueryPage(options queryOptions, pageSize int) (queryPageResult, error) {
	result, err := s.executeQuery(options)
	if err != nil {
		return queryPageResult{}, err
	}
	if pageSize <= 0 {
		pageSize = defaultPage
	}
	if pageSize >= len(result.Rows) {
		return queryPageResult{queryResult: result}, nil
	}
	s.nextCursorID++
	id := fmt.Sprintf("nebula-query-%d", s.nextCursorID)
	s.cursors[id] = &queryCursor{result: result, offset: pageSize}
	result.Rows = result.Rows[:pageSize]
	return queryPageResult{queryResult: result, SessionID: &id, HasMore: true}, nil
}

func (s *agentSession) fetchQueryPage(id string, pageSize int) (queryPageResult, error) {
	cursor := s.cursors[id]
	if cursor == nil {
		return queryPageResult{}, fmt.Errorf("query session not found: %s", id)
	}
	if pageSize <= 0 {
		pageSize = defaultPage
	}
	end := min(cursor.offset+pageSize, len(cursor.result.Rows))
	result := cursor.result
	result.Rows = result.Rows[cursor.offset:end]
	cursor.offset = end
	if end == len(cursor.result.Rows) {
		delete(s.cursors, id)
		return queryPageResult{queryResult: result}, nil
	}
	return queryPageResult{queryResult: result, SessionID: &id, HasMore: true}, nil
}

func effectiveMaxRows(requested int) int {
	if requested <= 0 {
		return defaultMaxRows
	}
	return min(requested, maxQueryRows)
}

func readRows(result *nebula.ResultSet, limit int) ([][]any, []string, error) {
	columns := result.GetColNames()
	rows := make([][]any, 0, min(len(result.GetRows()), limit))
	types := make([]string, len(columns))
	for i := range types {
		types[i] = "Unknown"
	}
	for index := 0; index < len(result.GetRows()) && index < limit; index++ {
		record, err := result.GetRowValuesByIndex(index)
		if err != nil {
			return nil, nil, err
		}
		row := make([]any, len(columns))
		for column := range columns {
			value, err := record.GetValueByIndex(column)
			if err != nil {
				return nil, nil, err
			}
			if types[column] == "Unknown" && value.GetType() != "null" {
				types[column] = value.GetType()
			}
			row[column] = normalizeValue(value)
		}
		rows = append(rows, row)
	}
	return rows, types, nil
}

func normalizeValue(value *nebula.ValueWrapper) any {
	if value == nil || value.GetType() == "null" {
		return nil
	}
	if value.GetType() == "string" {
		if text, err := value.AsString(); err == nil {
			return text
		}
	}
	if value.IsFloat() {
		if number, err := value.AsFloat(); err == nil {
			return strconv.FormatFloat(number, 'g', -1, 64)
		}
	}
	if graph := graphCellForValue(value); graph != nil {
		return graph
	}
	return value.String()
}

func graphCellForValue(value *nebula.ValueWrapper) *graphCell {
	if !value.IsVertex() && !value.IsEdge() && !value.IsPath() && !value.IsList() && !value.IsSet() && !value.IsMap() {
		return nil
	}
	cell := &graphCell{Marker: "nebula-v1", Kind: value.GetType(), Display: value.String(), Nodes: []graphNode{}, Edges: []graphEdge{}}
	appendGraphValue(value, cell)
	if len(cell.Nodes) == 0 && len(cell.Edges) == 0 {
		return nil
	}
	appendGraphDisplay(value, &cell.DisplayParts)
	return cell
}

func appendGraphValue(value *nebula.ValueWrapper, cell *graphCell) {
	if value == nil {
		return
	}
	switch {
	case value.IsVertex():
		node, err := value.AsNode()
		if err == nil {
			cell.Nodes = append(cell.Nodes, graphNodeFromNebula(node))
		}
	case value.IsEdge():
		edge, err := value.AsRelationship()
		if err == nil {
			cell.Edges = append(cell.Edges, graphEdgeFromNebula(edge))
			cell.Nodes = append(cell.Nodes, graphPlaceholder(edge.GetSrcVertexID()), graphPlaceholder(edge.GetDstVertexID()))
		}
	case value.IsPath():
		path, err := value.AsPath()
		if err == nil {
			for _, node := range path.GetNodes() {
				cell.Nodes = append(cell.Nodes, graphNodeFromNebula(node))
			}
			for _, edge := range path.GetRelationships() {
				cell.Edges = append(cell.Edges, graphEdgeFromNebula(edge))
			}
		}
	case value.IsList():
		items, err := value.AsList()
		if err == nil {
			for i := range items {
				appendGraphValue(&items[i], cell)
			}
		}
	case value.IsSet():
		items, err := value.AsDedupList()
		if err == nil {
			for i := range items {
				appendGraphValue(&items[i], cell)
			}
		}
	case value.IsMap():
		items, err := value.AsMap()
		if err == nil {
			for _, item := range items {
				appendGraphValue(&item, cell)
			}
		}
	}
}

func graphIdentity(parts ...string) string {
	encoded, _ := json.Marshal(parts)
	return string(encoded)
}

func graphVIDFromNebula(value nebula.ValueWrapper) graphVID {
	if value.IsString() {
		text, _ := value.AsString()
		return graphVID{Type: "string", Value: text}
	}
	if value.IsInt() {
		number, _ := value.AsInt()
		return graphVID{Type: "int", Value: strconv.FormatInt(number, 10)}
	}
	return graphVID{Type: value.GetType(), Value: value.String()}
}

func graphPlaceholder(value nebula.ValueWrapper) graphNode {
	vid := graphVIDFromNebula(value)
	return graphNode{ID: graphIdentity("vertex", vid.Type, vid.Value), VID: vid, Labels: []string{}, Properties: []graphProperty{}}
}

func graphPropertyFromNebula(owner, name string, value *nebula.ValueWrapper) graphProperty {
	property := graphProperty{Owner: owner, Name: name, Type: "null"}
	if value == nil || value.IsNull() {
		return property
	}
	property.Type = value.GetType()
	switch {
	case value.IsString():
		property.Value, _ = value.AsString()
	case value.IsBool():
		property.Value, _ = value.AsBool()
	case value.IsInt():
		number, _ := value.AsInt()
		property.Value = strconv.FormatInt(number, 10)
	case value.IsFloat():
		number, _ := value.AsFloat()
		property.Value = strconv.FormatFloat(number, 'g', -1, 64)
	default:
		property.Value = value.String()
	}
	return property
}

func graphNodeFromNebula(node *nebula.Node) graphNode {
	result := graphPlaceholder(node.GetID())
	result.Labels = append([]string{}, node.GetTags()...)
	for _, tag := range result.Labels {
		props, err := node.Properties(tag)
		if err != nil {
			continue
		}
		for name, value := range props {
			result.Properties = append(result.Properties, graphPropertyFromNebula(tag, name, value))
		}
	}
	sort.Slice(result.Properties, func(i, j int) bool {
		if result.Properties[i].Owner == result.Properties[j].Owner {
			return result.Properties[i].Name < result.Properties[j].Name
		}
		return result.Properties[i].Owner < result.Properties[j].Owner
	})
	return result
}

func graphEdgeFromNebula(edge *nebula.Relationship) graphEdge {
	src := graphPlaceholder(edge.GetSrcVertexID())
	dst := graphPlaceholder(edge.GetDstVertexID())
	rank := strconv.FormatInt(edge.GetRanking(), 10)
	result := graphEdge{
		ID:     graphIdentity("edge", edge.GetEdgeName(), src.ID, dst.ID, rank),
		Source: src.ID, Target: dst.ID, SourceVID: src.VID, TargetVID: dst.VID,
		Type: edge.GetEdgeName(), Rank: rank, Properties: []graphProperty{},
	}
	for name, value := range edge.Properties() {
		result.Properties = append(result.Properties, graphPropertyFromNebula("", name, value))
	}
	sort.Slice(result.Properties, func(i, j int) bool { return result.Properties[i].Name < result.Properties[j].Name })
	return result
}

type nebulaQueryError struct {
	code    string
	message string
}

func (err *nebulaQueryError) Error() string {
	return fmt.Sprintf("NebulaGraph error %s: %s", err.code, err.message)
}

func resultError(result *nebula.ResultSet) error {
	if result == nil {
		return errors.New("NebulaGraph returned no result")
	}
	if !result.IsSucceed() {
		return &nebulaQueryError{code: fmt.Sprint(result.GetErrorCode()), message: result.GetErrorMsg()}
	}
	return nil
}
