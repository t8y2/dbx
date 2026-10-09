package main

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"

	nebula "github.com/vesoft-inc/nebula-go/v3"
	wire "github.com/vesoft-inc/nebula-go/v3/nebula"
	"github.com/vesoft-inc/nebula-go/v3/nebula/graph"
)

func resultSet(t *testing.T, names []string, rows [][]*wire.Value) *nebula.ResultSet {
	t.Helper()
	columns := make([][]byte, len(names))
	for index, name := range names {
		columns[index] = []byte(name)
	}
	data := &wire.DataSet{ColumnNames: columns}
	for _, row := range rows {
		data.Rows = append(data.Rows, &wire.Row{Values: row})
	}
	result, err := nebula.GenResultSet(&graph.ExecutionResponse{ErrorCode: wire.ErrorCode_SUCCEEDED, Data: data})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestHandshakeMatchesAgentProtocol(t *testing.T) {
	runtime := &runtimeServer{sessions: make(map[string]*agentSession)}
	response := runtime.handleLine(`{"jsonrpc":"2.0","id":7,"method":"handshake","params":{}}`)
	if response.Error != nil {
		t.Fatalf("unexpected handshake error: %#v", response.Error)
	}
	result := response.Result.(map[string]any)
	if result["protocolVersion"] != 2 {
		t.Fatalf("unexpected protocol: %#v", result)
	}
	capabilities := result["capabilities"].([]string)
	if !strings.Contains(strings.Join(capabilities, ","), "multi_session") {
		t.Fatalf("missing multi-session capability: %#v", capabilities)
	}
}

func TestDriverProfileSupportsV3AndLegacyConnections(t *testing.T) {
	for _, profile := range []string{"", "nebula", "nebula-v3"} {
		_, err := newAgentSession(connectParams{DriverProfile: profile})
		if err == nil || !strings.Contains(err.Error(), "graphd host is required") {
			t.Fatalf("profile %q unexpectedly rejected: %v", profile, err)
		}
	}
	_, err := newAgentSession(connectParams{DriverProfile: "nebula-v5"})
	if err == nil || !strings.Contains(err.Error(), "only NebulaGraph 3.x is supported") {
		t.Fatalf("unsupported profile was not rejected: %v", err)
	}
}

func TestMissingSessionReturnsValidErrorContract(t *testing.T) {
	runtime := &runtimeServer{sessions: make(map[string]*agentSession)}
	response := runtime.handleLine(`{"jsonrpc":"2.0","id":7,"method":"execute_query","params":{"agentSessionId":"missing","sql":"SHOW SPACES"}}`)
	if response.Error == nil || response.Error.Data == nil {
		t.Fatalf("missing structured error: %#v", response)
	}
	data := response.Error.Data
	if data.ContractVersion != 1 || data.Stage != "execute" || data.OperationOutcome != "unknown" || data.AgentSessionID != "missing" || data.Category != "protocol" {
		t.Fatalf("invalid error contract: %#v", data)
	}
	if _, err := json.Marshal(response); err != nil {
		t.Fatal(err)
	}
}

func TestQueryErrorClassifiesAsSQLWithoutSQLState(t *testing.T) {
	response := errorResponse(json.RawMessage("1"), "execute_query", "session-1", &nebulaQueryError{code: "-1004", message: "syntax error"})
	if response.Error.Data.Category != "sql" || response.Error.Data.SessionDisposition != "keep" {
		t.Fatalf("unexpected SQL error: %#v", response.Error)
	}
	if !strings.Contains(response.Error.Message, "-1004") {
		t.Fatalf("NebulaGraph error code missing: %q", response.Error.Message)
	}
}

func TestQuoteNebulaIdentifier(t *testing.T) {
	quoted, err := quoteNebulaIdentifier("edge`name\\part")
	if err != nil || quoted != "`edge\\`name\\\\part`" {
		t.Fatalf("quoted = %q, err = %v", quoted, err)
	}
	if _, err := quoteNebulaIdentifier("a\nb"); err == nil {
		t.Fatal("control characters must not be accepted")
	}
}

func TestReadRowsPreservesScalarAndGraphValues(t *testing.T) {
	count := int64(42)
	nullValue := wire.NullType___NULL__
	value := resultSet(t, []string{"name", "count", "missing"}, [][]*wire.Value{{
		{SVal: []byte("Ada")}, {IVal: &count}, {NVal: &nullValue},
	}})
	rows, types, err := readRows(value, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rows, [][]any{{"Ada", "42", nil}}) || !reflect.DeepEqual(types, []string{"string", "int", "Unknown"}) {
		t.Fatalf("rows=%#v types=%#v", rows, types)
	}
	metadata, err := metadataRows(value)
	if err != nil || metadata[0]["name"] != "Ada" || metadata[0]["count"] != "42" {
		t.Fatalf("metadata=%#v err=%v", metadata, err)
	}
}

func TestReadRowsFloatRoundTripDoesNotUseSDKDisplay(t *testing.T) {
	for _, number := range []float64{0.000001, -0.000001, 1e20, 1.25e-7, math.SmallestNonzeroFloat64, math.MaxFloat64} {
		t.Run(strconv.FormatFloat(number, 'g', -1, 64), func(t *testing.T) {
			result := resultSet(t, []string{"dbx_value"}, [][]*wire.Value{{{FVal: &number}}})
			rows, types, err := readRows(result, 1)
			if err != nil {
				t.Fatal(err)
			}
			text := rows[0][0].(string)
			got, err := strconv.ParseFloat(text, 64)
			if err != nil || got != number || types[0] != "float" {
				t.Fatalf("float round-trip lost: value=%q parsed=%v error=%v types=%v", text, got, err, types)
			}
		})
	}
}

func TestReadRowsPreservesGraphIdentityAndProperties(t *testing.T) {
	large := int64(9007199254740993)
	rank := wire.EdgeRanking(7)
	src := &wire.Value{SVal: []byte("person:1")}
	dst := &wire.Value{SVal: []byte("company:1")}
	person := &wire.Vertex{Vid: src, Tags: []*wire.Tag{{Name: []byte("Person"), Props: map[string]*wire.Value{
		"name": {SVal: []byte("Ada")}, "visits": {IVal: &large},
	}}}}
	company := &wire.Vertex{Vid: dst, Tags: []*wire.Tag{{Name: []byte("Company")}}}
	edge := &wire.Edge{Src: src, Dst: dst, Type: 1, Name: []byte("WORK_IN"), Ranking: rank, Props: map[string]*wire.Value{"since": {IVal: &large}}}
	path := &wire.Path{Src: person, Steps: []*wire.Step{{Dst: company, Type: 1, Name: []byte("WORK_IN"), Ranking: rank, Props: edge.Props}}}
	reversed := &wire.Edge{Src: src, Dst: dst, Type: -1, Name: []byte("WORK_IN"), Ranking: rank}
	result := resultSet(t, []string{"vertex", "edge", "path", "items", "reverse_edge"}, [][]*wire.Value{{
		{VVal: person}, {EVal: edge}, {PVal: path}, {LVal: &wire.NList{Values: []*wire.Value{{VVal: person}, {EVal: edge}}}}, {EVal: reversed},
	}})
	rows, _, err := readRows(result, 10)
	if err != nil {
		t.Fatal(err)
	}
	vertex := rows[0][0].(*graphCell)
	if vertex.Kind != "vertex" || vertex.Nodes[0].VID.Value != "person:1" || vertex.Nodes[0].Properties[1].Value != "9007199254740993" {
		t.Fatalf("vertex lost identity or large integer: %#v", vertex)
	}
	relationship := rows[0][1].(*graphCell)
	if relationship.Kind != "edge" || relationship.Edges[0].SourceVID.Value != "person:1" || relationship.Edges[0].TargetVID.Value != "company:1" || relationship.Edges[0].Rank != "7" {
		t.Fatalf("edge lost direction or rank: %#v", relationship)
	}
	if pathCell := rows[0][2].(*graphCell); pathCell.Kind != "path" || len(pathCell.Nodes) != 2 || len(pathCell.Edges) != 1 {
		t.Fatalf("path was not preserved: %#v", pathCell)
	}
	if items := rows[0][3].(*graphCell); len(items.Nodes) < 1 || len(items.Edges) != 1 {
		t.Fatalf("nested graph values were not preserved: %#v", items)
	}
	if reverse := rows[0][4].(*graphCell); reverse.Edges[0].SourceVID.Value != "company:1" || reverse.Edges[0].TargetVID.Value != "person:1" {
		t.Fatalf("reverse edge direction was lost: %#v", reverse)
	}
	data, err := json.Marshal(rows)
	if err != nil || !strings.Contains(string(data), `"__dbx_graph_cell":"nebula-v1"`) {
		t.Fatalf("graph envelope cannot cross the agent protocol: %s, %v", data, err)
	}
}

func TestFetchQueryPageAdvancesWithoutReexecuting(t *testing.T) {
	session := &agentSession{cursors: map[string]*queryCursor{
		"page-1": {result: queryResult{Columns: []string{"n"}, ColumnTypes: []string{"int"}, Rows: [][]any{{"1"}, {"2"}, {"3"}}}, offset: 1},
	}}
	page, err := session.fetchQueryPage("page-1", 1)
	if err != nil || !page.HasMore || !reflect.DeepEqual(page.Rows, [][]any{{"2"}}) {
		t.Fatalf("page=%#v err=%v", page, err)
	}
	last, err := session.fetchQueryPage("page-1", 1)
	if err != nil || last.HasMore || !reflect.DeepEqual(last.Rows, [][]any{{"3"}}) || len(session.cursors) != 0 {
		t.Fatalf("last=%#v err=%v cursors=%d", last, err, len(session.cursors))
	}
}

func TestMetadataKindsRemainSeparate(t *testing.T) {
	if !acceptsObjectType([]string{"TABLE"}, "TABLE") || acceptsObjectType([]string{"TABLE"}, "VIEW") {
		t.Fatal("tag and edge types were mixed")
	}
	if !acceptsObjectType([]string{"EDGE"}, "VIEW") || !acceptsObjectType(nil, "TABLE") {
		t.Fatal("edge alias or unrestricted metadata lookup failed")
	}
}
