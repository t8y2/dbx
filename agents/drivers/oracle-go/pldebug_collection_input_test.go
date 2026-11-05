package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPLDebugCollectionInputNormalizesRecursiveElementsWithSharedBudgets(t *testing.T) {
	text := func(s string) *string { return &s }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "NUMBERS"}
	outer := plDebugNativeTypeRef{Owner: "S", TypeName: "ROWS"}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{
		{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_NAME": text("NUMBER")}}},
		{Reference: outer, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_NAME": &ref.TypeName, "ELEM_TYPE_OWNER": &ref.Owner}}},
	}}
	payload := json.RawMessage(`{"kind":"collection","value":[{"index":"2","value":{"kind":"collection","value":[{"index":"3","value":{"kind":"number","value":"12345678901234567890123456789012345678"}}]}},{"index":"4","value":{"kind":"collection","value":null}}]}`)
	input, err := plDebugDecodeCollectionInput(graph, outer, payload, 4, 41)
	if err != nil {
		t.Fatal(err)
	}
	if input.nodes != 4 || input.bytes != 41 || input.entries[0].collection.entries[0].scalar.value != "12345678901234567890123456789012345678" || !input.entries[1].collection.null {
		t.Fatal("recursive collection normalization changed numeric precision/NULL or lost shared accounting")
	}
	if _, err = plDebugDecodeCollectionInput(graph, outer, payload, 3, 41); err == nil {
		t.Fatal("nested collection bypassed node budget")
	}
	if _, err = plDebugDecodeCollectionInput(graph, outer, payload, 4, 40); err == nil {
		t.Fatal("nested collection bypassed cumulative index/value byte budget")
	}
	deep := `{"kind":"collection","value":[]}`
	graph.Nodes[1].Collections[0]["ELEM_TYPE_NAME"] = &outer.TypeName
	for depth := 0; depth < 18; depth++ {
		deep = `{"kind":"collection","value":[{"index":"1","value":` + deep + `}]}`
	}
	if _, err = plDebugDecodeCollectionInput(graph, outer, json.RawMessage(deep), 100, 100); err == nil || !strings.Contains(err.Error(), "depth") {
		t.Fatal("recursive declared collection bypassed depth limit")
	}
}

func TestPLDebugCollectionRecordElementsPreserveOmittedDefaults(t *testing.T) {
	graph, record := plDebugRecordInputFixture()
	text := func(s string) *string { return &s }
	root := plDebugNativeTypeRef{Owner: record.Owner, PackageName: record.PackageName, TypeName: "RECORDS"}
	graph.Nodes = append(graph.Nodes, plDebugNativeTypeNode{Reference: root, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_OWNER": &record.Owner, "ELEM_TYPE_PACKAGE": record.PackageName, "ELEM_TYPE_NAME": &record.TypeName}}})
	payload := json.RawMessage(`{"kind":"collection","value":[{"index":"1","value":{"kind":"record","value":[]}},{"index":"3","value":{"kind":"record","value":[{"name":"N","value":{"kind":"number","value":"7"}}]}}]}`)
	input, err := plDebugDecodeCollectionInput(graph, root, payload, 4, 3)
	if err != nil {
		t.Fatal(err)
	}
	if input.nodes != 4 || input.bytes != 3 || len(input.entries[0].record.leaves) != 0 || len(input.entries[1].record.leaves) != 1 || input.entries[1].record.leaves[0].input.value != "7" {
		t.Fatal("record elements invented omitted fields or lost shared budgets")
	}
	if input.entries[0].record.reference.key() != record.key() || input.entries[1].record.reference.key() != record.key() {
		t.Fatal("record element lost its actual declared type")
	}
	graph.Nodes[2].Collections[0]["ELEM_TYPE_NAME"] = text("MISSING")
	if _, err = plDebugDecodeCollectionInput(graph, root, payload, 100, 100); err == nil {
		t.Fatal("missing element type was accepted")
	}
}

func TestPLDebugRecordCollectionFieldsStayWithTheirActualElement(t *testing.T) {
	graph, record := plDebugRecordInputFixture()
	text := func(s string) *string { return &s }
	items := plDebugNativeTypeRef{Owner: record.Owner, PackageName: record.PackageName, TypeName: "ITEMS"}
	root := plDebugNativeTypeRef{Owner: record.Owner, PackageName: record.PackageName, TypeName: "ROWS"}
	graph.Nodes[0].Attributes = append(graph.Nodes[0].Attributes, plDebugNativeMetadataRow{"ATTR_NAME": text("Items"), "ATTR_TYPE_OWNER": &items.Owner, "ATTR_TYPE_PACKAGE": items.PackageName, "ATTR_TYPE_NAME": &items.TypeName})
	graph.Nodes = append(graph.Nodes,
		plDebugNativeTypeNode{Reference: items, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_NAME": text("NUMBER")}}},
		plDebugNativeTypeNode{Reference: root, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_OWNER": &record.Owner, "ELEM_TYPE_PACKAGE": record.PackageName, "ELEM_TYPE_NAME": &record.TypeName}}})
	payload := json.RawMessage(`{"kind":"collection","value":[{"index":"1","value":{"kind":"record","value":[{"name":"Items","value":{"kind":"collection","value":[]}}]}},{"index":"3","value":{"kind":"record","value":[{"name":"Items","value":{"kind":"collection","value":null}}]}}]}`)
	input, err := plDebugDecodeCollectionInput(graph, root, payload, 5, 2)
	if err != nil {
		t.Fatal(err)
	}
	first, second := input.entries[0].record, input.entries[1].record
	if input.nodes != 5 || len(first.collections) != 1 || len(second.collections) != 1 || first.collections[0].input.null || !second.collections[0].input.null || first.collections[0].path[0] != "Items" {
		t.Fatal("nested record collection values leaked across element ownership")
	}
	builder := plDebugCollectionInitializer{prefix: "DBX_TEST_"}
	if err = builder.collection(input, "ROOT"); err != nil {
		t.Fatal(err)
	}
	if len(builder.names) != 2 {
		t.Fatal("collection construction added extra record default initializers")
	}
}

func TestPLDebugMultipleDefaultOnlyCollectionsHaveDistinctInitializationLocals(t *testing.T) {
	graph, record := plDebugRecordInputFixture()
	text := func(s string) *string { return &s }
	root := plDebugNativeTypeRef{Owner: record.Owner, PackageName: record.PackageName, TypeName: "ROWS"}
	graph.Nodes = append(graph.Nodes, plDebugNativeTypeNode{Reference: root, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_OWNER": &record.Owner, "ELEM_TYPE_PACKAGE": record.PackageName, "ELEM_TYPE_NAME": &record.TypeName}}})
	input, err := plDebugDecodeCollectionInput(graph, root, json.RawMessage(`{"kind":"collection","value":[{"index":"1","value":{"kind":"record","value":[]}}]}`), 10, 10)
	if err != nil {
		t.Fatal(err)
	}
	plan := plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{}, target: plDebugNativeCandidate{Schema: "S", ObjectName: "RUN"}}
	for index, name := range []string{"A", "B"} {
		argument := plDebugNativeArgument{Name: text(name), Position: int64(index + 1), Mode: "IN", Type: "TABLE", TypeOwner: &root.Owner, TypeName: root.PackageName, TypeSubname: &root.TypeName}
		plan.target.Arguments = append(plan.target.Arguments, argument)
		plan.arguments = append(plan.arguments, plDebugNativeInput{argument: argument, state: "value", collection: input})
	}
	if plan.inputCount() != 0 {
		t.Fatal("omitted record fields acquired invented input bindings")
	}
	seen := map[string]bool{}
	for _, name := range plan.render("DBX_TEST_").PrivateNames {
		if seen[name] {
			t.Fatalf("zero-bind composite inputs collided on local identity: %s", name)
		}
		seen[name] = true
	}
}

func TestPLDebugCollectionInputIndexDomains(t *testing.T) {
	text := func(s string) *string { return &s }
	for _, test := range []struct {
		kind, index, payload string
		valid                bool
	}{
		{"TABLE", "", `null`, true}, {"TABLE", "", `[]`, true},
		{"TABLE", "", `[{"index":"3","value":{"kind":"number","value":"8"}}]`, true},
		{"TABLE", "", `[{"index":"0","value":null}]`, false},
		{"VARYING ARRAY", "", `[{"index":"2","value":null}]`, false},
		{"PL/SQL INDEX TABLE", "BINARY_INTEGER", `[{"index":"-2147483648","value":null},{"index":"2147483647","value":null}]`, true},
		{"PL/SQL INDEX TABLE", "BINARY_INTEGER", `[{"index":"2147483648","value":null}]`, false},
		{"PL/SQL INDEX TABLE", "BINARY_INTEGER", `[{"index":"01","value":null}]`, false},
		{"PL/SQL INDEX TABLE", "VARCHAR2", `null`, false},
		{"PL/SQL INDEX TABLE", "VARCHAR2", `[{"index":"","value":null}]`, false},
		{"PL/SQL INDEX TABLE", "VARCHAR2", `[{"index":"A","value":null},{"index":"a","value":null}]`, true},
		{"PL/SQL INDEX TABLE", "VARCHAR2", `[{"index":"A","value":null},{"index":"A","value":null}]`, false},
	} {
		node := plDebugNativeTypeNode{Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text(test.kind), "INDEX_BY": text(test.index)}}}
		if test.kind == "VARYING ARRAY" {
			node.Collections[0]["UPPER_BOUND"] = text("8")
		}
		input, err := plDebugDecodeCollectionEnvelope(node, json.RawMessage(`{"kind":"collection","value":`+test.payload+`}`), 32, 1024)
		if (err == nil) != test.valid {
			t.Fatalf("%s/%s %s: %v", test.kind, test.index, test.payload, err)
		}
		if err == nil && test.payload == "null" && !input.null {
			t.Fatal("NULL collection became empty")
		}
	}
}

func TestPLDebugCollectionInputDeclaredCapacityAndBudgets(t *testing.T) {
	text := func(s string) *string { return &s }
	node := plDebugNativeTypeNode{Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("VARYING ARRAY"), "UPPER_BOUND": text("1")}}}
	for _, test := range []struct {
		payload      string
		nodes, bytes int
		valid        bool
	}{
		{`null`, 0, 100, false}, {`[]`, 1, 100, true},
		{`[{"index":"1","value":null}]`, 2, 1, true},
		{`[{"index":"1","value":null}]`, 2, 0, false},
		{`[{"index":"1","value":null}]`, 1, 100, false},
		{`[{"index":"1","value":null},{"index":"2","value":null}]`, 3, 100, false},
	} {
		_, err := plDebugDecodeCollectionEnvelope(node, json.RawMessage(`{"kind":"collection","value":`+test.payload+`}`), test.nodes, test.bytes)
		if (err == nil) != test.valid {
			t.Fatalf("capacity/budget mismatch for %s: %v", test.payload, err)
		}
	}
	delete(node.Collections[0], "UPPER_BOUND")
	if _, err := plDebugDecodeCollectionEnvelope(node, json.RawMessage(`{"kind":"collection","value":[]}`), 10, 100); err == nil {
		t.Fatal("missing varray capacity was silently invented")
	}
}
