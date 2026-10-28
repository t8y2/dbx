package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

type plDebugRecordLeaf struct {
	path  []string
	input plDebugNativeInput
}

type plDebugRecordInput struct {
	reference   plDebugNativeTypeRef
	leaves      []plDebugRecordLeaf
	collections []plDebugRecordCollection
	objects     []plDebugRecordObject
	nodes       int
	bytes       int
}

type plDebugRecordObject struct {
	path  []string
	input *plDebugObjectInput
}

type plDebugRecordCollection struct {
	path  []string
	input *plDebugCollectionInput
}

type plDebugRecordDecoder struct {
	types              map[string]plDebugNativeTypeNode
	input              plDebugRecordInput
	maxNodes, maxBytes int
}

func plDebugDecodeRecordInput(graph plDebugNativeTypeGraph, reference plDebugNativeTypeRef, payload json.RawMessage, maxNodes, maxBytes int) (*plDebugRecordInput, error) {
	decoder := plDebugRecordDecoder{types: map[string]plDebugNativeTypeNode{}, input: plDebugRecordInput{reference: reference}, maxNodes: maxNodes, maxBytes: maxBytes}
	for _, node := range graph.Nodes {
		if _, exists := decoder.types[node.Reference.key()]; exists {
			return nil, errors.New("duplicate declared record type identity")
		}
		decoder.types[node.Reference.key()] = node
	}
	if err := decoder.record(reference, payload, nil, 0); err != nil {
		return nil, err
	}
	return &decoder.input, nil
}

func plDebugRecordEnvelope(payload json.RawMessage) (string, json.RawMessage, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return "", nil, err
	}
	if len(envelope) != 2 || envelope["kind"] == nil || envelope["value"] == nil {
		return "", nil, errors.New("typed record input requires exact kind and value fields")
	}
	var kind string
	if err := json.Unmarshal(envelope["kind"], &kind); err != nil {
		return "", nil, err
	}
	return kind, envelope["value"], nil
}

func (decoder *plDebugRecordDecoder) guard(depth int) error {
	if depth > 16 || decoder.input.nodes >= decoder.maxNodes {
		return errors.New("record input node or depth budget exceeded")
	}
	decoder.input.nodes++
	return nil
}

func (decoder *plDebugRecordDecoder) record(reference plDebugNativeTypeRef, payload json.RawMessage, path []string, depth int) error {
	if err := decoder.guard(depth); err != nil {
		return err
	}
	node, exists := decoder.types[reference.key()]
	if !exists || node.Definition.text("TYPECODE") != "PL/SQL RECORD" {
		return errors.New("record input type identity is incomplete or has no record adapter")
	}
	kind, value, err := plDebugRecordEnvelope(payload)
	if err != nil {
		return err
	}
	if kind != "record" || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return errors.New("record input requires a field array; records have no atomic NULL")
	}
	var fields []json.RawMessage
	if err = json.Unmarshal(value, &fields); err != nil {
		return err
	}
	if len(fields) > decoder.maxNodes-decoder.input.nodes {
		return errors.New("record input node budget exceeded")
	}
	attributes := map[string]plDebugNativeMetadataRow{}
	for _, attribute := range node.Attributes {
		name := attribute.text("ATTR_NAME")
		if name == "" || attributes[name] != nil {
			return errors.New("record attribute identity is incomplete or duplicated")
		}
		attributes[name] = attribute
	}
	seen := map[string]bool{}
	for _, field := range fields {
		var object map[string]json.RawMessage
		if err = json.Unmarshal(field, &object); err != nil {
			return err
		}
		if len(object) != 2 || object["name"] == nil || object["value"] == nil {
			return errors.New("record fields require exact name and value fields")
		}
		var name string
		if err = json.Unmarshal(object["name"], &name); err != nil {
			return err
		}
		attribute, exists := attributes[name]
		if !exists || seen[name] {
			return fmt.Errorf("unknown or duplicate exact record field %q", name)
		}
		seen[name] = true
		childPath := append(append([]string{}, path...), name)
		if attribute["ATTR_TYPE_MOD"] != nil {
			return fmt.Errorf("record field %q requires a reference adapter", name)
		}
		owner, pack, typeName := attribute["ATTR_TYPE_OWNER"], attribute["ATTR_TYPE_PACKAGE"], attribute.text("ATTR_TYPE_NAME")
		if owner != nil || pack != nil {
			if owner == nil || typeName == "" {
				return errors.New("nested record type identity is incomplete")
			}
			ref := plDebugNativeTypeRef{Owner: *owner, PackageName: pack, TypeName: typeName}
			if child, ok := decoder.types[ref.key()]; ok && child.Definition.text("TYPECODE") == "OBJECT" {
				var parsedObject *plDebugObjectInput
				parsedObject, err = decoder.object(ref, object["value"], depth+1)
				if err == nil {
					decoder.input.objects = append(decoder.input.objects, plDebugRecordObject{path: childPath, input: parsedObject})
				}
			} else if child, ok := decoder.types[ref.key()]; ok && child.Definition.text("TYPECODE") == "COLLECTION" {
				var collection *plDebugCollectionInput
				collection, err = decoder.collection(ref, object["value"], depth+1)
				if err == nil {
					decoder.input.collections = append(decoder.input.collections, plDebugRecordCollection{path: childPath, input: collection})
				}
			} else {
				err = decoder.record(ref, object["value"], childPath, depth+1)
			}
			if err != nil {
				return fmt.Errorf("record field %q: %w", name, err)
			}
		} else if err = decoder.leaf(typeName, object["value"], childPath, depth+1); err != nil {
			return fmt.Errorf("record field %q: %w", name, err)
		}
	}
	return nil
}

func plDebugNativeInputLeafAdapter(dataType string) (plDebugNativeArgument, string, error) {
	dataType = plDebugNativeScalarTypeName(dataType)
	argument := plDebugNativeArgument{Mode: "IN", Type: dataType}
	want := ""
	switch dataType {
	case "NUMBER", "INTEGER", "PL/SQL PLS INTEGER", "PL/SQL BINARY INTEGER":
		want = "number"
		argument.Type = "NUMBER"
	case "BOOLEAN", "PL/SQL BOOLEAN":
		want = "boolean"
		argument.Type = "PL/SQL BOOLEAN"
	case "NCHAR", "NVARCHAR2":
		want = "text"
	case "BINARY_FLOAT":
		want = "binary_float"
	case "BINARY_DOUBLE":
		want = "binary_double"
	case "VARCHAR2", "CHAR":
		want = "text"
		argument.Type = "VARCHAR2"
	case "DATE":
		want = "date"
	case "TIMESTAMP":
		want = "timestamp"
	case plDebugTimestampTZ:
		want = "timestamp_tz"
	case plDebugTimestampLTZ:
		want = "timestamp_ltz"
	case "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND":
		want = "text"
	case "CLOB":
		want = "clob"
	case "NCLOB":
		want = "nclob"
	case "BLOB":
		want = "blob"
	case "RAW":
		want = "raw"
	default:
		return argument, "", plDebugNativeMissingAdapter{fmt.Errorf("record leaf adapter is not yet implemented for %s", dataType)}
	}
	return argument, want, nil
}

func (decoder *plDebugRecordDecoder) leaf(dataType string, payload json.RawMessage, path []string, depth int) error {
	dataType = plDebugNativeScalarTypeName(dataType)
	if err := decoder.guard(depth); err != nil {
		return err
	}
	kind, value, err := plDebugRecordEnvelope(payload)
	if err != nil {
		return err
	}
	argument, want, err := plDebugNativeInputLeafAdapter(dataType)
	if err != nil {
		return err
	}
	if kind != want {
		return errors.New("record leaf kind does not match its declared type")
	}
	input := plDebugNativeInput{argument: argument, state: "null"}
	cost := 0
	if !bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		input.state = "value"
		if argument.timezone() {
			value, err := plDebugDecodeTimezoneInput(value, want == "timestamp_ltz", decoder.maxBytes-decoder.input.bytes)
			if err != nil {
				return err
			}
			input.value, cost = value, value.bytes
		} else if argument.lobCarrier() {
			lob, err := plDebugDecodeBinaryOrLobInput(payload, want, decoder.maxBytes-decoder.input.bytes)
			if err != nil {
				return err
			}
			input.value, cost = lob, lob.bytes
		} else if want == "boolean" {
			var boolean bool
			if err = json.Unmarshal(value, &boolean); err != nil {
				return err
			}
			input.value, cost = boolean, 5
			if boolean {
				cost = 4
			}
		} else {
			var text string
			if err = json.Unmarshal(value, &text); err != nil {
				return err
			}
			cost = len(text)
			if cost > decoder.maxBytes-decoder.input.bytes {
				return errors.New("record input byte budget exceeded")
			}
			switch want {
			case "binary_float", "binary_double":
				input.value, err = plDebugNativeBinaryFloatHex(text, want == "binary_double")
			case "number":
				input.value, err = plDebugNativeDecimal(text)
			case "date", "timestamp":
				input.value, err = plDebugNativeTemporalComponents(text, want == "timestamp")
			default:
				if argument.national() {
					input.value = plDebugEncodeNationalInput(text)
				} else if dataType == "INTERVAL YEAR TO MONTH" || dataType == "INTERVAL DAY TO SECOND" {
					input.value, err = plDebugNativeIntervalText(text, dataType == "INTERVAL DAY TO SECOND")
				} else {
					input.value = text
				}
			}
			if err != nil {
				return err
			}
		}
	}
	if cost > decoder.maxBytes-decoder.input.bytes {
		return errors.New("record input byte budget exceeded")
	}
	decoder.input.bytes += cost
	decoder.input.leaves = append(decoder.input.leaves, plDebugRecordLeaf{path: path, input: input})
	return nil
}
