package main

import (
	"errors"
	"strings"
	"testing"
)

func TestPLDebugRootCharUsesRetainedTextWithoutNationalHelpers(t *testing.T) {
	name := "V"
	a := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN OUT", Type: "CHAR"}
	if !plDebugNativeTypedRootAdapter(a) || a.adapted() {
		t.Fatal("CHAR must be typed-only without changing legacy admission")
	}
	plan := plDebugNativePlan{target: plDebugNativeCandidate{Schema: "S", ObjectName: "P", ObjectType: "PROCEDURE"}, typedSignature: &plDebugNativeTypedSignature{}, arguments: []plDebugNativeInput{{argument: a, state: "value", value: "ab "}}}
	call, err := plan.bind(false)
	if err != nil || len(call.lobs) != 1 || len(call.arguments) != plan.prefixCount() {
		t.Fatalf("CHAR lost retained carrier or physical slot count: %v", err)
	}
	body := plan.render("DBX_CHAR_")
	if !strings.Contains(body.After, "DBX_CHAR_TXT(DBX_CHAR_ARG_0)") || !strings.Contains(body.ScopedDeclarations, "DBX_CHAR_LOB_0 CLOB") || strings.Contains(body.ScopedDeclarations, "PROCEDURE DBX_CHAR_NTV") {
		t.Fatal("CHAR-only output did not use ordinary text JSON encoder")
	}
	for _, typ := range []string{"VARCHAR2", "NCHAR", "NVARCHAR2", "RAW"} {
		other := a
		other.Type = typ
		match, err := plDebugNativeCallMatches(plDebugNativeCandidate{Arguments: []plDebugNativeArgument{other}}, plan.arguments, nil)
		if err != nil || !match {
			t.Fatalf("character-family ambiguity hidden for %s: %v", typ, err)
		}
	}
}

func TestPLDebugRootBinaryIntegerPreservesExactNumericCarrier(t *testing.T) {
	name := "V"
	a := plDebugNativeArgument{Name: &name, Position: 1, Sequence: 1, Mode: "IN OUT", Type: "BINARY_INTEGER"}
	if !plDebugNativeTypedRootAdapter(a) || a.adapted() || a.retainedOutput() {
		t.Fatal("BINARY_INTEGER must use typed-only scalar transport")
	}
	plan := plDebugNativePlan{target: plDebugNativeCandidate{Schema: "S", ObjectName: "P", ObjectType: "PROCEDURE"}, typedSignature: &plDebugNativeTypedSignature{}, arguments: []plDebugNativeInput{{argument: a, state: "value", value: "-2147483648"}}}
	call, err := plan.bind(false)
	if err != nil || len(call.lobs) != 0 || len(call.arguments) != plan.prefixCount() {
		t.Fatalf("integer scalar binding failed: %v", err)
	}
	body := plan.render("DBX_INT_")
	if !strings.Contains(body.ScopedDeclarations, "DBX_INT_ARG_0 BINARY_INTEGER") || !strings.Contains(body.Source, "DBX_INT_ARG_0 := -:1") || !strings.Contains(body.After, "TO_CHAR(DBX_INT_ARG_0, 'TM9'") {
		t.Fatal("integer local, negative magnitude, or exact export was lost")
	}
}

func TestPLDebugExpandedArgumentRowsCannotOverwriteRootDeclarations(t *testing.T) {
	graph, ref := plDebugRecordInputFixture()
	text := func(value string) *string { return &value }
	root := plDebugNativeArgument{Name: text("V"), Position: 1, Sequence: 1, Mode: "OUT", Type: "PL/SQL RECORD", TypeOwner: text(ref.Owner), TypeName: ref.PackageName, TypeSubname: text(ref.TypeName)}
	nested := root
	nested.Level, nested.Sequence, nested.TypeSubname = 1, 2, text("OTHER")
	target := plDebugNativeCandidate{Schema: "S", ObjectName: "P", ObjectType: "PROCEDURE", Arguments: []plDebugNativeArgument{root, nested}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: target, TypeBindings: []plDebugNativeTypeBinding{{Sequence: 1, Reference: ref}}, TypeGraph: graph}
	nodes, err := plDebugNativeTypedTransport(signature)
	if err != nil {
		t.Fatal("root adapter incorrectly consumed an expanded row", err)
	}
	plan := plDebugNativePlan{target: target, arguments: []plDebugNativeInput{{argument: root, state: "null"}}, typedSignature: &signature, compositeOutputNodes: nodes}
	body := plan.render("DBX_TREE_")
	if !strings.Contains(body.ScopedDeclarations, "DBX_TREE_ARG_0 "+ref.declaration()+";") || strings.Contains(body.ScopedDeclarations, `"OTHER"`) {
		t.Fatal("nested POSITION overwrote the root type declaration")
	}
	if len(target.Arguments) != 2 || target.Arguments[1].Level != 1 {
		t.Fatal("root consumption deleted frozen expanded evidence")
	}
}

func TestPLDebugCompositeOverloadUsesDeclaredIdentityWithoutPayload(t *testing.T) {
	text := func(s string) *string { return &s }
	for _, kind := range []string{"PL/SQL RECORD", "TABLE", "OBJECT"} {
		a := plDebugNativeArgument{Name: text("V"), Position: 1, Sequence: 1, Mode: "OUT", Type: kind, TypeOwner: text("S"), TypeName: text("A")}
		input := plDebugNativeInput{argument: a, state: "out"}
		candidate := plDebugNativeCandidate{Arguments: []plDebugNativeArgument{a}}
		if match, err := plDebugNativeCallMatches(candidate, []plDebugNativeInput{input}, nil); err != nil || !match {
			t.Fatalf("%s OUT-only or typed NULL lost exact declaration: %v", kind, err)
		}
		candidate.Arguments[0].TypeName = text("B")
		match, err := plDebugNativeCallMatches(candidate, []plDebugNativeInput{input}, nil)
		if match || (kind == "OBJECT") != (err != nil) {
			t.Fatalf("%s distinct or unknown declaration was treated as exact: %v", kind, err)
		}
	}
}

func TestPLDebugObjectOverloadStaticPreferenceRequiresCompleteSameShapeVector(t *testing.T) {
	text := func(s string) *string { return &s }
	base := plDebugNativeTypeRef{Owner: "S", TypeName: "BASE"}
	sub := plDebugNativeTypeRef{Owner: "S", TypeName: "SUB"}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{{Reference: base, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT")}}, {Reference: sub, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "SUPERTYPE_OWNER": text("S"), "SUPERTYPE_NAME": text("BASE")}}}}
	a := plDebugNativeArgument{Name: text("V"), Position: 1, Sequence: 1, Mode: "IN", Type: "OBJECT", TypeOwner: text("S"), TypeName: text("SUB")}
	n := plDebugNativeArgument{Name: text("N"), Position: 2, Sequence: 2, Mode: "IN", Type: "NUMBER"}
	inputs := []plDebugNativeInput{{argument: a, state: "null"}, {argument: n, state: "value"}}
	a.TypeName = text("BASE")
	other := plDebugNativeCandidate{Arguments: []plDebugNativeArgument{a, n}}
	if match, err := plDebugNativeCallMatches(other, inputs, &graph); err != nil || match {
		t.Fatal("known ancestor displaced exact static declaration", err)
	}
	other.Arguments[1].Type = "VARCHAR2"
	if _, err := plDebugNativeCallMatches(other, inputs, &graph); err == nil {
		t.Fatal("later scalar conversion was hidden by first ancestor parameter")
	}
	other.Arguments[1] = n
	other.Arguments = append(other.Arguments, plDebugNativeArgument{Name: text("EXTRA"), Position: 3, Sequence: 3, Mode: "IN", Type: "NUMBER", Defaulted: text("Y")})
	if _, err := plDebugNativeCallMatches(other, inputs, &graph); err == nil {
		t.Fatal("different omitted-formal shape was given an unproved preference")
	}
	other.Arguments[0].TypeName = text("SUB")
	if match, err := plDebugNativeCallMatches(other, inputs, &graph); err != nil || !match {
		t.Fatal("same declared types plus default must remain ambiguous", err)
	}
}

func TestPLDebugTypedTransportChecksReachableInputMetadata(t *testing.T) {
	graph, ref := plDebugRecordInputFixture()
	text := func(s string) *string { return &s }
	a := plDebugNativeArgument{Name: text("V"), Position: 1, Sequence: 1, Mode: "IN", Type: "PL/SQL RECORD", TypeOwner: text(ref.Owner), TypeName: ref.PackageName, TypeSubname: text(ref.TypeName)}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: plDebugNativeCandidate{Arguments: []plDebugNativeArgument{a}}, TypeBindings: []plDebugNativeTypeBinding{{Sequence: 1, Reference: ref}}, TypeGraph: graph}
	if _, err := plDebugNativeTypedTransport(signature); err != nil {
		t.Fatal(err)
	}
	graph.Nodes[1].Attributes[1]["ATTR_TYPE_NAME"] = text("BFILE")
	var missing plDebugNativeMissingAdapter
	if _, err := plDebugNativeTypedTransport(signature); err == nil || !errors.As(err, &missing) || !strings.Contains(err.Error(), "BFILE") || !strings.Contains(err.Error(), "Child") {
		t.Fatal("deep missing input adapter was hidden by an empty record")
	}
	signature.TypeBindings = nil
	if _, err := plDebugNativeTypedTransport(signature); err == nil || errors.As(err, &missing) {
		t.Fatal("missing frozen root binding accepted")
	}
}

func TestPLDebugTypedTransportSeparatesObjectInputNullFromOutputClosure(t *testing.T) {
	text := func(s string) *string { return &s }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	a := plDebugNativeArgument{Name: text("V"), Position: 1, Sequence: 1, Mode: "IN", Type: "OBJECT", TypeOwner: text("S"), TypeName: text("T")}
	node := plDebugNativeTypeNode{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "FINAL": text("YES")}, ObjectAccess: &plDebugNativeTypeAccess{State: "type_only_verified"}, Attributes: []plDebugNativeMetadataRow{{"ATTR_NAME": text("X"), "ATTR_TYPE_NAME": text("BFILE")}}}
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: plDebugNativeCandidate{Arguments: []plDebugNativeArgument{a}}, TypeBindings: []plDebugNativeTypeBinding{{Sequence: 1, Reference: ref}}, TypeGraph: plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{node}}}
	if _, err := plDebugNativeTypedTransport(signature); err != nil {
		t.Fatal("atomic NULL object incorrectly required a constructor or attribute input adapter", err)
	}
	signature.Arguments[0].Mode = "OUT"
	if _, err := plDebugNativeTypedTransport(signature); err == nil || !strings.Contains(err.Error(), "BFILE") {
		t.Fatal("output closure skipped an unsupported attribute")
	}
	signature.TypeGraph.Nodes[0].Attributes[0]["ATTR_TYPE_NAME"] = text("NUMBER")
	if nodes, err := plDebugNativeTypedTransport(signature); err != nil || len(nodes) != 1 {
		t.Fatal("OUT-only object incorrectly required constructor metadata", err)
	}
}
