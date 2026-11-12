package main

import (
	"reflect"
	"testing"
)

func TestPLDebugOracleIntervalConstructorSourceAndNativeDistinctSelection(t *testing.T) {
	text := func(s string) *string { return &s }
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	source := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(LABEL VARCHAR2(20),CONSTRUCTOR FUNCTION T(V INTERVAL YEAR TO MONTH DEFAULT NULL) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(V INTERVAL DAY TO SECOND DEFAULT NULL) RETURN SELF AS RESULT)")
	if source.State != "syntax_parsed" || len(source.Constructors) != 2 {
		t.Fatalf("interval source not parsed: %+v", source)
	}
	node := plDebugNativeTypeNode{Reference: ref, Definition: plDebugNativeMetadataRow{"TYPECODE": text("OBJECT"), "INSTANTIABLE": text("YES"), "FINAL": text("YES")}, Attributes: []plDebugNativeMetadataRow{{"ATTR_NAME": text("LABEL"), "ATTR_TYPE_NAME": text("VARCHAR2")}}, ConstructorSource: &source, ObjectAccess: &plDebugNativeTypeAccess{State: "type_only_verified"}}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{node}}
	for i, kind := range []string{"INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND"} {
		p := source.Constructors[i].Parameters[0]
		if len(plDebugNativeConstructorReferenceCandidates(ref, p)) != 0 || plDebugNativeConstructorParameterType(graph, ref, p).text("ATTR_TYPE_NAME") != kind {
			t.Fatal("interval builtin identity lost")
		}
		id := []string{"user-1", "user-2"}[i]
		if selected, err := plDebugNativeSelectConstructor(graph, node, id, map[string]bool{"V": true}); err != nil || selected.ID != id {
			t.Fatalf("Oracle native distinct interval selection rejected: %v", err)
		}
	}
	if _, err := plDebugNativeSelectConstructor(graph, node, "user-1", map[string]bool{}); err == nil {
		t.Fatal("all-default ambiguity accepted")
	}
	for _, kind := range []string{"INTERVAL DAY TO MONTH", "INTERVAL YEAR(9) TO MONTH", "INTERVAL DAY TO \"SECOND\""} {
		if v := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(V "+kind+") RETURN SELF AS RESULT)"); v.State == "syntax_parsed" {
			t.Fatalf("unproven interval syntax accepted: %s", kind)
		}
	}
}

func TestPLDebugOracleConstructorSourcePreservesNamedDefaultsAndExactReferences(t *testing.T) {
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	source := `CREATE OR REPLACE TYPE S.T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(SELF IN OUT NOCOPY S.T,N IN NUMBER,T VARCHAR2 DEFAULT f(1,q'[),CONSTRUCTOR FUNCTION fake()]')) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(X "Other Owner"."Pack"."Child",Y "NUMBER" := nq'{a,b(''c'')}' ) RETURN SELF AS RESULT) NOT FINAL; /`
	value := plDebugReadNativeConstructors(ref, source)
	if value.State != "syntax_parsed" || len(value.Constructors) != 2 {
		t.Fatalf("unexpected description: %+v", value)
	}
	params := value.Constructors[0].Parameters
	if len(params) != 2 || params[0].Name != "N" || params[0].Defaulted || !params[1].Defaulted || params[1].Name != "T" {
		t.Fatalf("SELF/default handling failed: %+v", params)
	}
	second := value.Constructors[1]
	if second.ID != "user-2" || !reflect.DeepEqual(second.Parameters[0].Type, []string{"Other Owner", "Pack", "Child"}) || !second.Parameters[1].QuotedType || !second.Parameters[1].Defaulted {
		t.Fatalf("quoted identity lost: %+v", second)
	}
}

func TestPLDebugOracleConstructorTimezoneFormalsRetainExactBuiltinIdentity(t *testing.T) {
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	for _, kind := range []string{"TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE"} {
		value := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(V "+kind+",EXTRA NUMBER DEFAULT 7) RETURN SELF AS RESULT)")
		if value.State != "syntax_parsed" || len(value.Constructors) != 1 || !reflect.DeepEqual(value.Constructors[0].Parameters[0].Type, []string{kind}) || !value.Constructors[0].Parameters[1].Defaulted {
			t.Fatalf("timezone formal identity lost: %+v", value)
		}
		if refs := plDebugNativeConstructorReferenceCandidates(ref, value.Constructors[0].Parameters[0]); len(refs) != 0 {
			t.Fatal("timezone builtin was resolved as user type")
		}
	}
	for _, kind := range []string{`"TIMESTAMP" WITH TIME ZONE`, `TIMESTAMP WITH "TIME" ZONE`, `TIMESTAMP WITH LOCAL "TIME" ZONE`, `S.TIMESTAMP WITH TIME ZONE`, `TIMESTAMP WITH TZ`} {
		if value := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(V "+kind+") RETURN SELF AS RESULT)"); value.State == "syntax_parsed" {
			t.Fatalf("nonbuiltin timezone spelling accepted: %s", kind)
		}
	}
}

func TestPLDebugOracleTimezoneMetadataAliasesAreConsumedWithoutRewritingEvidence(t *testing.T) {
	for _, pair := range [][2]string{{"TIMESTAMP WITH TZ", "TIMESTAMP WITH TIME ZONE"}, {"TIMESTAMP WITH LOCAL TZ", "TIMESTAMP WITH LOCAL TIME ZONE"}} {
		short, long := pair[0], pair[1]
		left, right := plDebugNativeMetadataRow{"ATTR_TYPE_NAME": &short}, plDebugNativeMetadataRow{"ATTR_TYPE_NAME": &long}
		if !plDebugNativeConstructorTypeEqual(left, right) || left.text("ATTR_TYPE_NAME") != pair[0] {
			t.Fatal("timezone alias equality changed raw metadata")
		}
		owner := "S"
		left["ATTR_TYPE_OWNER"], right["ATTR_TYPE_OWNER"] = &owner, &owner
		if plDebugNativeConstructorTypeEqual(left, right) {
			t.Fatal("user type names were normalized as builtin aliases")
		}
	}
	left, right := "TIMESTAMP WITH TZ", "TIMESTAMP WITH LOCAL TZ"
	if plDebugNativeConstructorTypeEqual(plDebugNativeMetadataRow{"ATTR_TYPE_NAME": &left}, plDebugNativeMetadataRow{"ATTR_TYPE_NAME": &right}) {
		t.Fatal("TZ and LTZ type identity collapsed")
	}
}

func TestPLDebugOracleConstructorReferenceDiscoveryDoesNotGuessPackageOrBuiltinAliases(t *testing.T) {
	declaring := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	if refs := plDebugNativeConstructorReferenceCandidates(declaring, plDebugNativeConstructorParameter{Type: []string{"NUMBER"}}); len(refs) != 0 {
		t.Fatal("builtin was resolved as a schema type")
	}
	refs := plDebugNativeConstructorReferenceCandidates(declaring, plDebugNativeConstructorParameter{Type: []string{"NUMBER"}, QuotedType: true})
	if len(refs) != 1 || refs[0].Owner != "S" || refs[0].TypeName != "NUMBER" {
		t.Fatal("quoted alias was guessed as builtin")
	}
	refs = plDebugNativeConstructorReferenceCandidates(declaring, plDebugNativeConstructorParameter{Type: []string{"OTHER", "CHILD"}})
	if len(refs) != 2 || refs[0].Owner != "OTHER" || refs[0].PackageName != nil || refs[1].Owner != "S" || refs[1].PackageName == nil || *refs[1].PackageName != "OTHER" {
		t.Fatal("two-part type reference did not retain both dictionary interpretations")
	}
}

func TestPLDebugOracleCallableConstructorsRequireAccessAndHideOnlyExactSystemSignature(t *testing.T) {
	row := func(values map[string]string) plDebugNativeMetadataRow {
		result := plDebugNativeMetadataRow{}
		for key, value := range values {
			v := value
			result[key] = &v
		}
		return result
	}
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	description := plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N NUMBER) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(LABEL VARCHAR2,EXTRA NUMBER DEFAULT 7) RETURN SELF AS RESULT)")
	node := plDebugNativeTypeNode{Reference: ref, Definition: row(map[string]string{"TYPECODE": "OBJECT", "FINAL": "YES", "INSTANTIABLE": "YES"}), Attributes: []plDebugNativeMetadataRow{row(map[string]string{"ATTR_NAME": "N", "ATTR_TYPE_NAME": "NUMBER"})}, ConstructorSource: &description}
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{node}}
	if calls := plDebugNativeObjectCallables(graph, node); calls.State != "constructor_metadata_unresolved" {
		t.Fatal("syntax alone falsely proved type access")
	}
	node.ObjectAccess = &plDebugNativeTypeAccess{State: "type_only_verified"}
	calls := plDebugNativeObjectCallables(graph, node)
	if calls.State != "resolved" || len(calls.Constructors) != 2 || calls.Constructors[0].ID != "user-1" || calls.Constructors[1].ID != "user-2" || !calls.Constructors[1].Parameters[1].Defaulted {
		t.Fatalf("hidden constructor or defaults lost: %+v", calls)
	}
	description = plDebugReadNativeConstructors(ref, "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(V NUMBER) RETURN SELF AS RESULT)")
	calls = plDebugNativeObjectCallables(graph, node)
	if calls.State != "resolved" || len(calls.Constructors) != 2 || calls.Constructors[0].ID != "attribute-value" {
		t.Fatal("renamed user constructor falsely hid the system constructor")
	}
	node.Definition["INSTANTIABLE"] = func() *string { value := "NO"; return &value }()
	if calls = plDebugNativeObjectCallables(graph, node); calls.State != "not_instantiable" || len(calls.Constructors) != 0 {
		t.Fatal("abstract object was made constructible")
	}
	node.ObjectAccess.State = "type_only_failed"
	if calls = plDebugNativeObjectCallables(graph, node); calls.State != "constructor_metadata_unresolved" {
		t.Fatal("failed access was bypassed")
	}
}

func TestPLDebugOracleConstructorSourceNeverPublishesPartialOrGuessedDeclarations(t *testing.T) {
	ref := plDebugNativeTypeRef{Owner: "S", TypeName: "T"}
	prefix := "TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N NUMBER) RETURN SELF AS RESULT"
	for _, source := range []string{prefix, prefix + ",CONSTRUCTOR FUNCTION T(X VARCHAR2) RETURN SELF AS RESULT", prefix + ") GARBAGE", "TYPE OTHER AS OBJECT(N NUMBER)", "TYPE T WRAPPED xyz", "TYPE T AS OBJECT(N NUMBER /*", "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(N NUMBER DEFAULT) RETURN SELF AS RESULT)", "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(N NUMBER :=) RETURN SELF AS RESULT)", "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(N OUT NUMBER) RETURN SELF AS RESULT)", "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(SELF IN T) RETURN SELF AS RESULT)", "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(N NUMBER,SELF IN OUT T) RETURN SELF AS RESULT)", "TYPE T AS OBJECT(CONSTRUCTOR FUNCTION T(N NUMBER DEFAULT q'[unterminated) RETURN SELF AS RESULT)"} {
		value := plDebugReadNativeConstructors(ref, source)
		if value.State != "constructor_metadata_unresolved" || len(value.Constructors) != 0 {
			t.Fatalf("invalid source published constructors: %q %+v", source, value)
		}
	}
}

func TestPLDebugOracleConstructorSourceHandlesNoArgumentsUnderAndQuotedNames(t *testing.T) {
	ref := plDebugNativeTypeRef{Owner: "Owner Name", TypeName: "Mixed.Type"}
	for _, params := range []string{"()", ""} {
		value := plDebugReadNativeConstructors(ref, `TYPE "Owner Name"."Mixed.Type" UNDER S.BASE(CONSTRUCTOR FUNCTION "Mixed.Type"`+params+` RETURN SELF AS RESULT) FINAL`)
		if value.State != "syntax_parsed" || len(value.Constructors) != 1 || len(value.Constructors[0].Parameters) != 0 {
			t.Fatalf("zero argument constructor lost: %+v", value)
		}
	}
	value := plDebugReadNativeConstructors(plDebugNativeTypeRef{Owner: "S", TypeName: "T"}, "TYPE T AS OBJECT(N NUMBER /* CONSTRUCTOR FUNCTION FAKE */)")
	if value.State != "syntax_parsed" || len(value.Constructors) != 0 {
		t.Fatal("comment created a fake constructor")
	}
}
