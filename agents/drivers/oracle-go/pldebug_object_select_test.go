package main

import "testing"

func TestPLDebugObjectConstructorSelectionRejectsAmbiguousOmittedDefaults(t *testing.T) {
	text := func(s string) *string { return &s }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	source := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(LABEL VARCHAR2,EXTRA NUMBER DEFAULT 7) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(LABEL VARCHAR2,OTHER NUMBER DEFAULT 9) RETURN SELF AS RESULT)")
	node := plDebugNativeTypeNode{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "INSTANTIABLE": text("YES"), "FINAL": text("YES")}, Attributes: []plDebugNativeMetadataRow{{"ATTR_NAME": text("N"), "ATTR_TYPE_NAME": text("NUMBER")}}, ConstructorSource: &source, ObjectAccess: &plDebugNativeTypeAccess{State: "type_only_verified"}}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{node}}
	if _, err := plDebugNativeSelectConstructor(graph, node, "user-1", map[string]bool{"LABEL": true}); err == nil {
		t.Fatal("ambiguous omitted defaults selected a constructor")
	}
	selected, err := plDebugNativeSelectConstructor(graph, node, "user-1", map[string]bool{"LABEL": true, "EXTRA": true})
	if err != nil || selected.ID != "user-1" {
		t.Fatalf("exact named constructor could not be selected: %v", err)
	}
	if _, err = plDebugNativeSelectConstructor(graph, node, "user-1", map[string]bool{"MISSING": true}); err == nil {
		t.Fatal("unknown constructor formal accepted")
	}
	node.ObjectAccess.State = "type_only_failed"
	if _, err = plDebugNativeSelectConstructor(graph, node, "user-1", map[string]bool{"LABEL": true, "EXTRA": true}); err == nil {
		t.Fatal("failed type access bypassed")
	}
}

func TestPLDebugObjectAssignableUsesExactVerifiedSupertypeChain(t *testing.T) {
	text := func(s string) *string { return &s }
	base := plDebugNativeTypeRef{Owner: "S", TypeName: "BASE"}
	sub := plDebugNativeTypeRef{Owner: "S", TypeName: "SUB"}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{{Reference: base, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT")}}, {Reference: sub, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "SUPERTYPE_OWNER": &base.Owner, "SUPERTYPE_NAME": &base.TypeName}}}}
	if !plDebugNativeObjectAssignable(graph, sub, base) || plDebugNativeObjectAssignable(graph, base, sub) {
		t.Fatal("object assignment direction changed")
	}
	graph.Nodes[0].Definition["SUPERTYPE_OWNER"] = &sub.Owner
	graph.Nodes[0].Definition["SUPERTYPE_NAME"] = &sub.TypeName
	if plDebugNativeObjectAssignable(graph, sub, plDebugNativeTypeRef{Owner: "S", TypeName: "MISSING"}) {
		t.Fatal("cyclic chain invented missing subtype identity")
	}
	graph.Nodes = append(graph.Nodes, graph.Nodes[0])
	if plDebugNativeObjectAssignable(graph, sub, base) {
		t.Fatal("duplicate type identities were silently overwritten")
	}
}

func TestPLDebugIntegerConstructorDefaultAmbiguityUsesCarrierFamily(t *testing.T) {
	text := func(s string) *string { return &s }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	for _, pair := range [][2]string{{"INTEGER", "NUMBER"}, {"PLS_INTEGER", "BINARY_INTEGER"}, {"PLS_INTEGER", "SIMPLE_INTEGER"}} {
		source := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(LABEL VARCHAR2(20),CONSTRUCTOR FUNCTION T(V "+pair[0]+",D NUMBER DEFAULT 1) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V "+pair[1]+",K VARCHAR2 DEFAULT 'x') RETURN SELF AS RESULT)")
		node := plDebugNativeTypeNode{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "INSTANTIABLE": text("YES"), "FINAL": text("YES")}, Attributes: []plDebugNativeMetadataRow{{"ATTR_NAME": text("LABEL"), "ATTR_TYPE_NAME": text("VARCHAR2")}}, ConstructorSource: &source, ObjectAccess: &plDebugNativeTypeAccess{State: "type_only_verified"}}
		graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{node}}
		if _, err := plDebugNativeSelectConstructor(graph, node, "user-1", map[string]bool{"V": true}); err == nil {
			t.Fatalf("same-family omitted defaults accepted: %v", pair)
		}
		for _, item := range []struct{ id, extra string }{{"user-1", "D"}, {"user-2", "K"}} {
			selected, err := plDebugNativeSelectConstructor(graph, node, item.id, map[string]bool{"V": true, item.extra: true})
			if err != nil || selected.ID != item.id {
				t.Fatalf("named disambiguation rejected: %v %v", pair, err)
			}
		}
	}
}
