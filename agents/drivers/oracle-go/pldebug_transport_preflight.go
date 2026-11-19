package main

import (
	"errors"
	"fmt"
)

type plDebugNativeMissingAdapter struct{ error }

func plDebugNativeObjectHierarchyKnown(graph plDebugNativeTypeGraph, ref plDebugNativeTypeRef) bool {
	seen := map[string]bool{}
	for {
		if seen[ref.key()] {
			return false
		}
		seen[ref.key()] = true
		var found *plDebugNativeTypeNode
		for i := range graph.Nodes {
			if graph.Nodes[i].Reference.key() == ref.key() {
				found = &graph.Nodes[i]
				break
			}
		}
		if found == nil || found.Definition.text("TYPECODE") != "OBJECT" {
			return false
		}
		owner, name := found.Definition.text("SUPERTYPE_OWNER"), found.Definition.text("SUPERTYPE_NAME")
		if owner == "" && name == "" {
			return true
		}
		if owner == "" || name == "" {
			return false
		}
		ref = plDebugNativeTypeRef{Owner: owner, TypeName: name}
	}
}

func plDebugNativeTypedRootAdapter(a plDebugNativeArgument) bool {
	return a.adapted() || a.composite() || a.scalar() && (a.Type == "CHAR" || a.Type == "BINARY_INTEGER" || a.Type == "PL/SQL BOOLEAN" || a.Type == "DATE" || a.Type == "TIMESTAMP" || a.lobCarrier() || a.interval() || a.national() || a.binaryFloat() || a.timezone())
}

func plDebugNativeTypedTransport(signature plDebugNativeTypedSignature) ([]plDebugNativeTypeNode, error) {
	available := map[string]plDebugNativeTypeNode{}
	for _, node := range signature.TypeGraph.Nodes {
		if _, exists := available[node.Reference.key()]; exists {
			return nil, errors.New("duplicate typed transport type identity")
		}
		available[node.Reference.key()] = node
	}
	outputRoots := []plDebugNativeTypeRef{}
	for _, a := range signature.Arguments {
		if a.Level != 0 || signature.NoArgumentPlaceholder != nil {
			continue
		}
		path := fmt.Sprintf("position %d (%s, %s)", a.Position, a.Type, a.Mode)
		if !plDebugNativeTypedRootAdapter(a) {
			return nil, plDebugNativeMissingAdapter{fmt.Errorf("%s: debugger parameter transport is not yet implemented", path)}
		}
		if !a.composite() {
			continue
		}
		ref, err := plDebugNativeArgumentTypeRef(a)
		if err != nil || ref == nil {
			return nil, fmt.Errorf("%s: declared type identity is incomplete", path)
		}
		bindings := 0
		for _, binding := range signature.TypeBindings {
			if binding.Sequence == a.Sequence {
				bindings++
				if binding.Reference.key() != ref.key() {
					return nil, fmt.Errorf("%s: declared type binding changed", path)
				}
			}
		}
		if bindings != 1 {
			return nil, fmt.Errorf("%s: declared type binding is incomplete or duplicated", path)
		}
		if a.input() {
			if err := plDebugNativeInputTransport(available, *ref, map[string]bool{}); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
		}
		if a.output() {
			outputRoots = append(outputRoots, *ref)
		}
	}
	return plDebugCompositeOutputTypes(signature.TypeGraph, outputRoots)
}

func plDebugNativeInputTransport(available map[string]plDebugNativeTypeNode, ref plDebugNativeTypeRef, seen map[string]bool) error {
	if seen[ref.key()] {
		return nil
	}
	seen[ref.key()] = true
	node, exists := available[ref.key()]
	if !exists {
		return fmt.Errorf("%s: input type metadata is incomplete", ref.declaration())
	}
	rows, prefix := node.Attributes, "ATTR_TYPE_"
	switch node.Definition.text("TYPECODE") {
	case "OBJECT":
		if ref.PackageName != nil || node.ObjectAccess == nil || node.ObjectAccess.State != "type_only_verified" {
			return fmt.Errorf("%s: object input type access is not verified", ref.declaration())
		}
		// Atomic NULL needs type access only. Non-NULL constructor arguments are
		// validated by the original decoder after the user selects a constructor.
		return nil
	case "PL/SQL RECORD":
	case "COLLECTION":
		if _, err := plDebugCollectionInputShape(node); err != nil {
			return fmt.Errorf("%s: %w", ref.declaration(), err)
		}
		rows, prefix = node.Collections, "ELEM_TYPE_"
	default:
		return plDebugNativeMissingAdapter{fmt.Errorf("%s: input type adapter is not implemented", ref.declaration())}
	}
	names := map[string]bool{}
	for _, row := range rows {
		name := row.text("ATTR_NAME")
		if prefix == "ATTR_TYPE_" && (name == "" || names[name]) {
			return fmt.Errorf("%s: input field identity is incomplete or duplicated", ref.declaration())
		}
		names[name] = true
		path := ref.declaration() + "." + name
		if row[prefix+"MOD"] != nil {
			return plDebugNativeMissingAdapter{fmt.Errorf("%s: reference input adapter is not implemented", path)}
		}
		owner, pack, kind := row[prefix+"OWNER"], row[prefix+"PACKAGE"], row.text(prefix+"NAME")
		if owner != nil || pack != nil {
			if owner == nil || kind == "" {
				return fmt.Errorf("%s: nested input identity is incomplete", path)
			}
			if err := plDebugNativeInputTransport(available, plDebugNativeTypeRef{Owner: *owner, PackageName: pack, TypeName: kind}, seen); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
		} else if _, _, err := plDebugNativeInputLeafAdapter(kind); err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
	}
	return nil
}
