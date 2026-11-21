package main

import (
	"bytes"
	"encoding/json"
	"errors"
)

type plDebugObjectArgument struct {
	formal     plDebugNativeConstructorFormal
	defaulted  bool
	scalar     *plDebugNativeInput
	record     *plDebugRecordInput
	collection *plDebugCollectionInput
	object     *plDebugObjectInput
}

type plDebugObjectInput struct {
	reference    plDebugNativeTypeRef
	null         bool
	constructor  plDebugNativeConstructorCallable
	arguments    []plDebugObjectArgument
	nodes, bytes int
}

func plDebugDecodeObjectInput(graph plDebugNativeTypeGraph, reference plDebugNativeTypeRef, payload json.RawMessage, maxNodes, maxBytes int) (*plDebugObjectInput, error) {
	decoder := plDebugRecordDecoder{types: map[string]plDebugNativeTypeNode{}, maxNodes: maxNodes, maxBytes: maxBytes}
	for _, node := range graph.Nodes {
		if _, exists := decoder.types[node.Reference.key()]; exists {
			return nil, errors.New("duplicate declared object type identity")
		}
		decoder.types[node.Reference.key()] = node
	}
	return decoder.object(reference, payload, 0)
}

func (decoder *plDebugRecordDecoder) object(reference plDebugNativeTypeRef, payload json.RawMessage, depth int) (*plDebugObjectInput, error) {
	n, b := decoder.input.nodes, decoder.input.bytes
	if err := decoder.guard(depth); err != nil {
		return nil, err
	}
	node, exists := decoder.types[reference.key()]
	if !exists || node.Definition.text("TYPECODE") != "OBJECT" || reference.PackageName != nil || node.ObjectAccess == nil || node.ObjectAccess.State != "type_only_verified" {
		return nil, errors.New("object input declared type access is not verified")
	}
	kind, value, err := plDebugRecordEnvelope(payload)
	if err != nil {
		return nil, err
	}
	if kind != "object" {
		return nil, errors.New("object input kind does not match declared type")
	}
	input := &plDebugObjectInput{reference: reference}
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		input.null = true
		input.nodes = 1
		return input, nil
	}
	var object map[string]json.RawMessage
	if err = json.Unmarshal(value, &object); err != nil {
		return nil, err
	}
	if len(object) != 3 || object["type"] == nil || object["constructorId"] == nil || object["arguments"] == nil {
		return nil, errors.New("object construction requires exact type, constructorId and arguments")
	}
	var identity map[string]json.RawMessage
	if err = json.Unmarshal(object["type"], &identity); err != nil {
		return nil, err
	}
	if len(identity) != 2 && len(identity) != 3 || identity["owner"] == nil || identity["typeName"] == nil || len(identity) == 3 && identity["packageName"] == nil {
		return nil, errors.New("object construction requires an exact SQL type identity")
	}
	actual := plDebugNativeTypeRef{}
	if err = json.Unmarshal(identity["owner"], &actual.Owner); err != nil {
		return nil, err
	}
	if err = json.Unmarshal(identity["typeName"], &actual.TypeName); err != nil {
		return nil, err
	}
	if identity["packageName"] != nil && !bytes.Equal(bytes.TrimSpace(identity["packageName"]), []byte("null")) {
		return nil, errors.New("object construction requires a SQL type, not a package type")
	}
	graph := plDebugNativeTypeGraph{}
	for _, available := range decoder.types {
		graph.Nodes = append(graph.Nodes, available)
	}
	if !plDebugNativeObjectAssignable(graph, actual, reference) {
		return nil, errors.New("object construction type cannot be assigned to its declared type")
	}
	node = decoder.types[actual.key()]
	var id string
	if err = json.Unmarshal(object["constructorId"], &id); err != nil {
		return nil, err
	}
	metadata := plDebugNativeObjectCallables(graph, node)
	var constructor *plDebugNativeConstructorCallable
	if metadata.State == "resolved" {
		for index := range metadata.Constructors {
			if metadata.Constructors[index].ID == id {
				constructor = &metadata.Constructors[index]
			}
		}
	}
	if constructor == nil {
		return nil, errors.New("unknown, inaccessible or unresolved object constructor")
	}
	var arguments []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(object["arguments"]), []byte("null")) {
		return nil, errors.New("object constructor arguments must be an array")
	}
	if err = json.Unmarshal(object["arguments"], &arguments); err != nil {
		return nil, err
	}
	if len(arguments) != len(constructor.Parameters) || len(arguments) > decoder.maxNodes-decoder.input.nodes {
		return nil, errors.New("object constructor requires every exact formal within the input node budget")
	}
	formals := map[string]plDebugNativeConstructorFormal{}
	for _, formal := range constructor.Parameters {
		formals[formal.Name] = formal
	}
	seen, supplied := map[string]bool{}, map[string]bool{}
	for _, encoded := range arguments {
		var argument map[string]json.RawMessage
		if err = json.Unmarshal(encoded, &argument); err != nil {
			return nil, err
		}
		var name, state string
		if err = json.Unmarshal(argument["name"], &name); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(argument["state"], &state); err != nil {
			return nil, err
		}
		formal, found := formals[name]
		if !found || seen[name] {
			return nil, errors.New("unknown or duplicate exact object constructor formal")
		}
		seen[name] = true
		parsed := plDebugObjectArgument{formal: formal}
		if state == "default" && len(argument) == 2 && formal.Defaulted {
			if err = decoder.guard(depth + 1); err != nil {
				return nil, err
			}
			parsed.defaulted = true
		} else if state == "value" && len(argument) == 3 && argument["value"] != nil {
			parsed, err = decoder.objectArgument(formal, argument["value"], depth+1)
			if err != nil {
				return nil, err
			}
			supplied[name] = true
		} else {
			return nil, errors.New("object constructor formal requires an explicit value or confirmed default")
		}
		input.arguments = append(input.arguments, parsed)
	}
	input.constructor, err = plDebugNativeSelectConstructor(graph, node, id, supplied)
	if err != nil {
		return nil, err
	}
	input.reference = actual
	input.nodes, input.bytes = decoder.input.nodes-n, decoder.input.bytes-b
	return input, nil
}

func (decoder *plDebugRecordDecoder) objectArgument(formal plDebugNativeConstructorFormal, payload json.RawMessage, depth int) (plDebugObjectArgument, error) {
	result := plDebugObjectArgument{formal: formal}
	row := formal.Type
	if row["ATTR_TYPE_MOD"] != nil {
		return result, errors.New("object constructor formal requires a reference adapter")
	}
	owner, pack, kind := row["ATTR_TYPE_OWNER"], row["ATTR_TYPE_PACKAGE"], row.text("ATTR_TYPE_NAME")
	if owner == nil && pack == nil {
		if plDebugNativeConstructorNumericCarrier(row) != "" {
			kind = "NUMBER"
		}
		before := len(decoder.input.leaves)
		err := decoder.leaf(kind, payload, nil, depth)
		if err != nil {
			return result, err
		}
		value := decoder.input.leaves[before].input
		result.scalar = &value
		decoder.input.leaves = decoder.input.leaves[:before]
		return result, nil
	}
	if owner == nil || kind == "" {
		return result, errors.New("object constructor child type identity is incomplete")
	}
	ref := plDebugNativeTypeRef{Owner: *owner, PackageName: pack, TypeName: kind}
	node, exists := decoder.types[ref.key()]
	if !exists {
		return result, errors.New("object constructor child type definition is missing")
	}
	var err error
	switch node.Definition.text("TYPECODE") {
	case "OBJECT":
		result.object, err = decoder.object(ref, payload, depth)
	case "COLLECTION":
		result.collection, err = decoder.collection(ref, payload, depth)
	default:
		before, beforeCollections := len(decoder.input.leaves), len(decoder.input.collections)
		beforeObjects := len(decoder.input.objects)
		n, b := decoder.input.nodes, decoder.input.bytes
		err = decoder.record(ref, payload, nil, depth)
		if err == nil {
			result.record = &plDebugRecordInput{reference: ref, leaves: append([]plDebugRecordLeaf{}, decoder.input.leaves[before:]...), collections: append([]plDebugRecordCollection{}, decoder.input.collections[beforeCollections:]...), objects: append([]plDebugRecordObject{}, decoder.input.objects[beforeObjects:]...), nodes: decoder.input.nodes - n, bytes: decoder.input.bytes - b}
			decoder.input.leaves = decoder.input.leaves[:before]
			decoder.input.collections = decoder.input.collections[:beforeCollections]
			decoder.input.objects = decoder.input.objects[:beforeObjects]
		}
	}
	return result, err
}
