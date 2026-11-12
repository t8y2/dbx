package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

type plDebugCollectionEntry struct {
	index      string
	value      json.RawMessage
	scalar     *plDebugNativeInput
	record     *plDebugRecordInput
	collection *plDebugCollectionInput
	object     *plDebugObjectInput
}

type plDebugCollectionInput struct {
	reference  plDebugNativeTypeRef
	definition plDebugNativeMetadataRow
	null       bool
	entries    []plDebugCollectionEntry
	nodes      int
	bytes      int
}

func plDebugDecodeCollectionInput(graph plDebugNativeTypeGraph, reference plDebugNativeTypeRef, payload json.RawMessage, maxNodes, maxBytes int) (*plDebugCollectionInput, error) {
	decoder := plDebugRecordDecoder{types: map[string]plDebugNativeTypeNode{}, maxNodes: maxNodes, maxBytes: maxBytes}
	for _, node := range graph.Nodes {
		if _, exists := decoder.types[node.Reference.key()]; exists {
			return nil, errors.New("duplicate declared collection type identity")
		}
		decoder.types[node.Reference.key()] = node
	}
	return decoder.collection(reference, payload, 0)
}

func (decoder *plDebugRecordDecoder) collection(reference plDebugNativeTypeRef, payload json.RawMessage, depth int) (*plDebugCollectionInput, error) {
	startNodes, startBytes := decoder.input.nodes, decoder.input.bytes
	if err := decoder.guard(depth); err != nil {
		return nil, err
	}
	node, exists := decoder.types[reference.key()]
	if !exists {
		return nil, errors.New("collection input type identity is missing")
	}
	input, err := plDebugDecodeCollectionEnvelope(node, payload, decoder.maxNodes-startNodes, decoder.maxBytes-startBytes)
	if err != nil {
		return nil, err
	}
	input.reference, input.definition = reference, node.Collections[0]
	definition := node.Collections[0]
	if definition["ELEM_TYPE_MOD"] != nil {
		return nil, errors.New("collection element requires a reference adapter")
	}
	for index := range input.entries {
		entry := &input.entries[index]
		decoder.input.bytes += len(entry.index)
		if decoder.input.bytes > decoder.maxBytes {
			return nil, errors.New("collection input byte budget exceeded")
		}
		owner, pack, kind := definition["ELEM_TYPE_OWNER"], definition["ELEM_TYPE_PACKAGE"], definition.text("ELEM_TYPE_NAME")
		if owner != nil || pack != nil {
			if owner == nil || kind == "" {
				return nil, errors.New("collection element declared identity is incomplete")
			}
			ref := plDebugNativeTypeRef{Owner: *owner, PackageName: pack, TypeName: kind}
			child, ok := decoder.types[ref.key()]
			if !ok {
				return nil, errors.New("collection element type definition is missing")
			}
			if child.Definition.text("TYPECODE") == "OBJECT" {
				entry.object, err = decoder.object(ref, entry.value, depth+1)
			} else if child.Definition.text("TYPECODE") == "COLLECTION" {
				entry.collection, err = decoder.collection(ref, entry.value, depth+1)
			} else {
				before := len(decoder.input.leaves)
				beforeCollections := len(decoder.input.collections)
				beforeObjects := len(decoder.input.objects)
				n, b := decoder.input.nodes, decoder.input.bytes
				err = decoder.record(ref, entry.value, nil, depth+1)
				if err == nil {
					entry.record = &plDebugRecordInput{reference: ref, leaves: append([]plDebugRecordLeaf{}, decoder.input.leaves[before:]...), collections: append([]plDebugRecordCollection{}, decoder.input.collections[beforeCollections:]...), objects: append([]plDebugRecordObject{}, decoder.input.objects[beforeObjects:]...), nodes: decoder.input.nodes - n, bytes: decoder.input.bytes - b}
					decoder.input.leaves = decoder.input.leaves[:before]
					decoder.input.collections = decoder.input.collections[:beforeCollections]
					decoder.input.objects = decoder.input.objects[:beforeObjects]
				}
			}
		} else {
			before := len(decoder.input.leaves)
			err = decoder.leaf(kind, entry.value, nil, depth+1)
			if err == nil {
				value := decoder.input.leaves[before].input
				entry.scalar = &value
				decoder.input.leaves = decoder.input.leaves[:before]
			}
		}
		if err != nil {
			return nil, err
		}
	}
	input.nodes, input.bytes = decoder.input.nodes-startNodes, decoder.input.bytes-startBytes
	return &input, nil
}

func plDebugCollectionInputShape(node plDebugNativeTypeNode) (int64, error) {
	if node.Definition.text("TYPECODE") != "COLLECTION" || len(node.Collections) != 1 {
		return 0, errors.New("collection input declared identity is incomplete")
	}
	definition := node.Collections[0]
	indexType, collectionType := definition.text("INDEX_BY"), definition.text("COLL_TYPE")
	if indexType != "" && indexType != "BINARY_INTEGER" && indexType != "PLS_INTEGER" && indexType != "VARCHAR2" {
		return 0, plDebugNativeMissingAdapter{errors.New("collection input index identity has no adapter")}
	}
	if indexType != "" && collectionType != "PL/SQL INDEX TABLE" || indexType == "" && collectionType != "TABLE" && collectionType != "VARYING ARRAY" {
		return 0, errors.New("collection input kind contradicts its index identity")
	}
	upper := int64(0)
	if collectionType == "VARYING ARRAY" {
		var err error
		upper, err = strconv.ParseInt(definition.text("UPPER_BOUND"), 10, 32)
		if err != nil || upper < 1 {
			return 0, errors.New("varray input capacity is not confirmed")
		}
	}
	return upper, nil
}

func plDebugDecodeCollectionEnvelope(node plDebugNativeTypeNode, payload json.RawMessage, maxNodes, maxBytes int) (plDebugCollectionInput, error) {
	result := plDebugCollectionInput{}
	if maxNodes < 1 || maxBytes < 0 {
		return result, errors.New("collection input budget exceeded")
	}
	upper, err := plDebugCollectionInputShape(node)
	if err != nil {
		return result, err
	}
	definition := node.Collections[0]
	indexType, collectionType := definition.text("INDEX_BY"), definition.text("COLL_TYPE")
	kind, value, err := plDebugRecordEnvelope(payload)
	if err != nil {
		return result, err
	}
	if kind != "collection" {
		return result, errors.New("collection input kind does not match declared type")
	}
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		if indexType != "" {
			return result, errors.New("associative arrays have no atomic NULL")
		}
		result.null = true
		return result, nil
	}
	var entries []json.RawMessage
	if err = json.Unmarshal(value, &entries); err != nil {
		return result, err
	}
	if maxNodes < 1 || len(entries) > maxNodes-1 {
		return result, errors.New("collection input node budget exceeded")
	}
	if collectionType == "VARYING ARRAY" && int64(len(entries)) > upper {
		return result, errors.New("varray input exceeds declared capacity")
	}
	seen := map[string]bool{}
	for position, encoded := range entries {
		var entry map[string]json.RawMessage
		if err = json.Unmarshal(encoded, &entry); err != nil {
			return result, err
		}
		if len(entry) != 2 || entry["index"] == nil || entry["value"] == nil {
			return result, errors.New("collection entries require exact index and value fields")
		}
		var index string
		if err = json.Unmarshal(entry["index"], &index); err != nil {
			return result, err
		}
		if indexType == "VARCHAR2" {
			if index == "" {
				return result, errors.New("collection string index cannot be SQL NULL")
			}
		} else {
			number, parseErr := strconv.ParseInt(index, 10, 32)
			if parseErr != nil || strconv.FormatInt(number, 10) != index || indexType == "" && number < 1 {
				return result, errors.New("collection index must be a canonical integer in its declared domain")
			}
			if collectionType == "VARYING ARRAY" && number != int64(position+1) {
				return result, errors.New("varray input indices must be dense and ordered from one")
			}
		}
		if seen[index] {
			return result, errors.New("duplicate collection input index")
		}
		seen[index] = true
		if len(index) > maxBytes {
			return result, errors.New("collection index byte budget exceeded")
		}
		maxBytes -= len(index)
		result.entries = append(result.entries, plDebugCollectionEntry{index: index, value: entry["value"]})
	}
	return result, nil
}
