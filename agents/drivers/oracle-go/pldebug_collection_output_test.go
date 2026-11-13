package main

import "testing"

func TestPLDebugCollectionOutputRetainsNestedDeclaredIdentity(t *testing.T) {
	graph, record := plDebugRecordInputFixture()
	text := func(value string) *string { return &value }
	collection := plDebugNativeTypeRef{Owner: record.Owner, PackageName: record.PackageName, TypeName: "ROWS"}
	graph.Nodes = append(graph.Nodes, plDebugNativeTypeNode{Reference: collection, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{{"COLL_TYPE": text("TABLE"), "ELEM_TYPE_OWNER": &record.Owner, "ELEM_TYPE_PACKAGE": record.PackageName, "ELEM_TYPE_NAME": &record.TypeName}}})
	nodes, err := plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{collection})
	if err != nil || len(nodes) != 3 || nodes[0].Reference.key() != collection.key() || nodes[1].Reference.key() != record.key() {
		t.Fatalf("nested collection/record graph was not retained: %v", err)
	}
	graph.Nodes = graph.Nodes[1:]
	if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{collection}); err == nil {
		t.Fatal("collection element with missing declared identity was accepted")
	}
}

func TestPLDebugCollectionOutputValidatesIndexIdentity(t *testing.T) {
	text := func(value string) *string { return &value }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "ITEMS"}
	for _, test := range []struct {
		kind, index string
		valid       bool
	}{
		{"TABLE", "", true}, {"VARYING ARRAY", "", true},
		{"PL/SQL INDEX TABLE", "BINARY_INTEGER", true}, {"PL/SQL INDEX TABLE", "VARCHAR2", true},
		{"TABLE", "VARCHAR2", false}, {"PL/SQL INDEX TABLE", "", false}, {"PL/SQL INDEX TABLE", "NUMBER", false},
	} {
		t.Run(test.kind+"/"+test.index, func(t *testing.T) {
			row := plDebugNativeMetadataRow{"COLL_TYPE": text(test.kind), "ELEM_TYPE_NAME": text("NUMBER")}
			if test.index != "" {
				row["INDEX_BY"] = text(test.index)
			}
			graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("COLLECTION")}, Collections: []plDebugNativeMetadataRow{row}}}}
			nodes, err := plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{ref})
			if (err == nil) != test.valid {
				t.Fatalf("index identity validation mismatch: %v", err)
			}
			if err != nil {
				return
			}
			if plDebugCompositeStringIndices(nodes) != (test.index == "VARCHAR2") {
				t.Fatal("NLS context requirement did not follow actual index type")
			}
			if test.index == "VARCHAR2" {
				names := map[string]bool{}
				for _, name := range newPLDebugCompositeEncoder(nodes, "DBX_C_", "LEFT_BYTES").privateNames() {
					names[name] = true
				}
				for _, suffix := range []string{"SORT0", "SORT1", "COMP0", "COMP1", "KEY_EQ"} {
					if !names["DBX_C_"+suffix] {
						t.Fatal("NLS encoder state exposed as a user variable")
					}
				}
			}
		})
	}
}
