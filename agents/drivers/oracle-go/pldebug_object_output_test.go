package main

import "testing"

func TestPLDebugObjectOutputIncludesVerifiedDynamicSubtypeFields(t *testing.T) {
	graph, base := plDebugObjectInputFixture()
	text := func(s string) *string { return &s }
	graph.Nodes[0].Definition["FINAL"] = text("NO")
	sub := plDebugNativeTypeRef{Owner: base.Owner, TypeName: "CHILD"}
	graph.Nodes = append(graph.Nodes, plDebugNativeTypeNode{Reference: sub, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "FINAL": text("YES"), "SUPERTYPE_OWNER": &base.Owner, "SUPERTYPE_NAME": &base.TypeName}, Attributes: []plDebugNativeMetadataRow{{"ATTR_NAME": text("Extra"), "ATTR_TYPE_NAME": text("NUMBER")}}, ObjectAccess: &plDebugNativeTypeAccess{State: "type_only_verified"}})
	nodes, err := plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{base})
	if err != nil || len(nodes) != 2 || nodes[1].Reference.key() != sub.key() {
		t.Fatalf("dynamic subtype fields absent from output closure: %v", err)
	}
	graph.Nodes[1].Attributes[0]["ATTR_TYPE_NAME"] = text("UNKNOWN")
	if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{base}); err == nil {
		t.Fatal("dynamic subtype field silently used an unverified leaf encoder")
	}
	graph.Nodes[0].ObjectAccess.State = "type_only_failed"
	if _, err = plDebugCompositeOutputTypes(graph, []plDebugNativeTypeRef{base}); err == nil {
		t.Fatal("object output bypassed failed access proof")
	}
}
