package main

import "errors"

// Keep constructor selection aligned with the existing OceanBase adapter.
func plDebugNativeObjectAssignable(graph plDebugNativeTypeGraph, actual, declared plDebugNativeTypeRef) bool {
	if actual.PackageName != nil || declared.PackageName != nil {
		return false
	}
	nodes := map[string]plDebugNativeTypeNode{}
	for _, node := range graph.Nodes {
		if _, duplicate := nodes[node.Reference.key()]; duplicate {
			return false
		}
		nodes[node.Reference.key()] = node
	}
	seen := map[string]bool{}
	for {
		node, exists := nodes[actual.key()]
		if !exists || node.Definition.text("TYPECODE") != "OBJECT" || seen[actual.key()] {
			return false
		}
		seen[actual.key()] = true
		if actual.key() == declared.key() {
			return true
		}
		owner, name := node.Definition.text("SUPERTYPE_OWNER"), node.Definition.text("SUPERTYPE_NAME")
		if owner == "" || name == "" {
			return false
		}
		actual = plDebugNativeTypeRef{Owner: owner, TypeName: name}
	}
}

func plDebugNativeConstructorMatchesShape(call plDebugNativeConstructorCallable, supplied map[string]bool) bool {
	names := map[string]bool{}
	for _, formal := range call.Parameters {
		if names[formal.Name] || !formal.Defaulted && !supplied[formal.Name] {
			return false
		}
		names[formal.Name] = true
	}
	for name, present := range supplied {
		if present && !names[name] {
			return false
		}
	}
	return true
}

func plDebugNativeSelectConstructor(graph plDebugNativeTypeGraph, node plDebugNativeTypeNode, id string, supplied map[string]bool) (plDebugNativeConstructorCallable, error) {
	metadata := plDebugNativeObjectCallables(graph, node)
	if metadata.State != "resolved" {
		return plDebugNativeConstructorCallable{}, errors.New("object constructor metadata is unresolved; refresh its preview")
	}
	var selected *plDebugNativeConstructorCallable
	for index := range metadata.Constructors {
		if metadata.Constructors[index].ID == id {
			if selected != nil {
				return plDebugNativeConstructorCallable{}, errors.New("duplicate object constructor identity")
			}
			selected = &metadata.Constructors[index]
		}
	}
	if selected == nil || !plDebugNativeConstructorMatchesShape(*selected, supplied) {
		return plDebugNativeConstructorCallable{}, errors.New("object constructor arguments do not match its required or defaulted parameters")
	}
	actual := map[string]plDebugNativeMetadataRow{}
	for _, formal := range selected.Parameters {
		if supplied[formal.Name] {
			actual[formal.Name] = formal.Type
		}
	}
	family := func(row plDebugNativeMetadataRow) string {
		if carrier := plDebugNativeConstructorNumericCarrier(row); carrier != "" {
			return carrier
		}
		kind := plDebugNativeConstructorScalarType(row)
		if kind == "CHAR" || kind == "VARCHAR2" {
			return "text"
		}
		return kind
	}
	matches := 0
	for _, candidate := range metadata.Constructors {
		if !plDebugNativeConstructorMatchesShape(candidate, supplied) {
			continue
		}
		compatible, upcast, scalarConversion := true, false, false
		for _, formal := range candidate.Parameters {
			if !supplied[formal.Name] {
				continue
			}
			kind := actual[formal.Name]
			if plDebugNativeConstructorTypeEqual(kind, formal.Type) {
				continue
			}
			if kind["ATTR_TYPE_OWNER"] != nil || formal.Type["ATTR_TYPE_OWNER"] != nil {
				if kind["ATTR_TYPE_OWNER"] == nil || formal.Type["ATTR_TYPE_OWNER"] == nil || !plDebugNativeObjectAssignable(graph, plDebugNativeTypeRef{Owner: kind.text("ATTR_TYPE_OWNER"), PackageName: kind["ATTR_TYPE_PACKAGE"], TypeName: kind.text("ATTR_TYPE_NAME")}, plDebugNativeTypeRef{Owner: formal.Type.text("ATTR_TYPE_OWNER"), PackageName: formal.Type["ATTR_TYPE_PACKAGE"], TypeName: formal.Type.text("ATTR_TYPE_NAME")}) {
					compatible = false
					break
				}
				upcast = true
			} else {
				if family(kind) != family(formal.Type) {
					compatible = false
					break
				}
				scalarConversion = true
			}
		}
		if compatible && !(upcast && !scalarConversion) {
			matches++
		}
	}
	if matches != 1 {
		return plDebugNativeConstructorCallable{}, errors.New("selected constructor and omitted defaults leave an ambiguous object construction")
	}
	return *selected, nil
}
