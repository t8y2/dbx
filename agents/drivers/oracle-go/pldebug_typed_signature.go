package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"
)

func plDebugDecodeNativeTypedSignature(request plDebugNativeStart) (*plDebugNativeTypedSignature, error) {
	if request.TargetSignature == nil {
		return nil, nil
	}
	_, versioned := request.TargetSignature["signatureVersion"]
	if !versioned {
		return nil, nil
	}
	if request.MetadataPreparation != "type_only" {
		return nil, errors.New("a versioned Oracle signature requires type_only metadata preparation")
	}
	for _, key := range []string{"signatureVersion", "metadataPreparation", "argumentDetails", "typeGraph", "targetVersion"} {
		if request.TargetSignature[key] == nil {
			return nil, errors.New("the versioned Oracle signature is incomplete: " + key)
		}
	}
	raw, err := json.Marshal(request.TargetSignature)
	if err != nil {
		return nil, err
	}
	var signature plDebugNativeTypedSignature
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&signature); err != nil {
		return nil, err
	}
	if signature.SignatureVersion != 2 || signature.MetadataPreparation != "type_only" {
		return nil, errors.New("unsupported Oracle typed signature version or preparation policy")
	}
	for _, argument := range signature.Arguments {
		if argument.Level == 0 && argument.national() && signature.NationalCharacterSet == "" {
			return nil, errors.New("refresh Oracle national character set metadata before starting")
		}
	}
	return &signature, nil
}

func plDebugRevalidateNativeTypedSignature(ctx context.Context, conn *sql.Conn, plan *plDebugNativePlan, prepare, oci bool) error {
	if plan.typedSignature == nil {
		return nil
	}
	if !prepare && !plan.typesPrepared {
		return errors.New("the original debuggee has not confirmed typed reference preparation")
	}
	loader := plDebugNativeTypeLoader{ctx: ctx, conn: conn, oci: oci}
	current, err := plDebugBuildNativeTypedSignaturePrepared(&loader, plan.target, prepare)
	if err != nil {
		return err
	}
	if !prepare {
		for i := range current.TypeGraph.Nodes {
			node := &current.TypeGraph.Nodes[i]
			for _, original := range plan.typedSignature.TypeGraph.Nodes {
				if node.Reference.key() == original.Reference.key() {
					node.ObjectAccess = original.ObjectAccess
					break
				}
			}
		}
		for i := range current.TypeGraph.Nodes {
			node := &current.TypeGraph.Nodes[i]
			if node.Definition.text("TYPECODE") == "OBJECT" {
				calls := plDebugNativeObjectCallables(current.TypeGraph, *node)
				node.ConstructorCalls = &calls
			}
		}
	}
	if !reflect.DeepEqual(*plan.typedSignature, current) {
		return errors.New("the selected Oracle type graph or source changed; refresh metadata and confirm again")
	}
	if prepare {
		plan.typesPrepared = true
	}
	return nil
}

type plDebugNativeTypeBinding struct {
	Sequence  int64                `json:"sequence"`
	Reference plDebugNativeTypeRef `json:"reference"`
}
type plDebugNativeTypedSignature struct {
	plDebugNativeCandidate
	LegacyDictionary     *plDebugLegacyDictionaryLayout `json:"legacyDictionary,omitempty"`
	SignatureVersion     int                            `json:"signatureVersion"`
	MetadataPreparation  string                         `json:"metadataPreparation"`
	ArgumentDetails      []plDebugNativeMetadataRow     `json:"argumentDetails"`
	TypeBindings         []plDebugNativeTypeBinding     `json:"typeBindings,omitempty"`
	TypeGraph            plDebugNativeTypeGraph         `json:"typeGraph"`
	TargetVersion        plDebugNativeTypeVersion       `json:"targetVersion"`
	NationalCharacterSet string                         `json:"nationalCharacterSet,omitempty"`
}

func plDebugNativeArgumentDetailsMatch(candidate plDebugNativeCandidate, details []plDebugNativeMetadataRow) bool {
	if len(candidate.Arguments) != len(details) {
		return false
	}
	for index, argument := range candidate.Arguments {
		row := details[index]
		for _, field := range []struct {
			key   string
			value int64
		}{{"POSITION", argument.Position}, {"SEQUENCE", argument.Sequence}, {"DATA_LEVEL", argument.Level}} {
			number, err := strconv.ParseInt(row.text(field.key), 10, 64)
			if err != nil || number != field.value {
				return false
			}
		}
		if plDebugNativeMode(row.text("IN_OUT")) != argument.Mode || row.text("DATA_TYPE") != argument.Type {
			return false
		}
		for _, field := range []struct {
			key   string
			value *string
		}{{"ARGUMENT_NAME", argument.Name}, {"TYPE_OWNER", argument.TypeOwner}, {"TYPE_NAME", argument.TypeName}, {"TYPE_SUBNAME", argument.TypeSubname}, {"DEFAULTED", argument.Defaulted}} {
			if !reflect.DeepEqual(row[field.key], field.value) {
				return false
			}
		}
	}
	return true
}

func plDebugBuildNativeTypedSignature(ctx context.Context, conn *sql.Conn, candidate plDebugNativeCandidate) (plDebugNativeTypedSignature, error) {
	loader := plDebugNativeTypeLoader{ctx: ctx, conn: conn}
	return plDebugBuildNativeTypedSignatureOnLoader(&loader, candidate)
}

func plDebugBuildNativeTypedSignatureOnLoader(l *plDebugNativeTypeLoader, candidate plDebugNativeCandidate) (plDebugNativeTypedSignature, error) {
	return plDebugBuildNativeTypedSignaturePrepared(l, candidate, true)
}

func plDebugBuildNativeTypedSignaturePrepared(l *plDebugNativeTypeLoader, candidate plDebugNativeCandidate, prepare bool) (plDebugNativeTypedSignature, error) {
	signature := plDebugNativeTypedSignature{plDebugNativeCandidate: candidate, SignatureVersion: 2, MetadataPreparation: "type_only"}
	l.legacyTrees, l.legacySources = nil, nil
	if candidate.Status == nil || *candidate.Status != "VALID" {
		return signature, errors.New("selected debug object is not confirmed VALID")
	}
	name, kind := candidate.ObjectName, candidate.ObjectType
	if candidate.PackageName != nil {
		name, kind = *candidate.PackageName, "PACKAGE"
	}
	before, err := l.containerVersion(candidate.Schema, name, kind)
	if err != nil {
		return signature, err
	}
	identity := false
	for _, row := range before.Objects {
		if row.text("OBJECT_TYPE") == kind && row.text("OBJECT_ID") == candidate.ObjectID {
			identity = true
		}
	}
	if !identity {
		return signature, errors.New("selected debug object identity changed before type inspection")
	}
	query := "SELECT * FROM SYS.ALL_ARGUMENTS WHERE OWNER=:1 AND OBJECT_ID=:2 AND SUBPROGRAM_ID=:3 ORDER BY SEQUENCE"
	details, err := l.query(query, candidate.Schema, candidate.ObjectID, candidate.SubprogramID)
	if err != nil {
		return signature, err
	}
	if !plDebugNativeArgumentDetailsMatch(candidate, details) {
		return signature, errors.New("selected debug argument metadata changed before type inspection")
	}
	for _, argument := range candidate.Arguments {
		if argument.Level != 0 {
			trees, err := plDebugLegacyArgumentTree(candidate, details)
			if err != nil {
				return signature, err
			}
			layout, err := l.legacyDictionaryLayout()
			if err != nil {
				return signature, err
			}
			if layout != nil {
				signature.LegacyDictionary = layout
				l.legacyTrees = map[string]*plDebugLegacyArgumentNode{}
				var collect func(*plDebugLegacyArgumentNode) error
				collect = func(node *plDebugLegacyArgumentNode) error {
					ref, err := plDebugLegacyArgumentTypeRef(node.argument)
					if err != nil {
						return err
					}
					if ref != nil && ref.PackageName != nil {
						l.legacyTrees[ref.key()] = node
					}
					for _, child := range node.children {
						if err := collect(child); err != nil {
							return err
						}
					}
					return nil
				}
				for _, tree := range trees {
					if err := collect(tree); err != nil {
						return signature, err
					}
				}
			}
			break
		}
	}
	for _, row := range details {
		if row["TYPE_LINK"] != nil {
			return signature, errors.New("remote declared types require a verified Oracle type identity adapter")
		}
	}
	roots := []plDebugNativeTypeRef{}
	var bindings []plDebugNativeTypeBinding
	for _, argument := range candidate.Arguments {
		if argument.Level != 0 {
			continue
		}
		if argument.national() && signature.NationalCharacterSet == "" {
			rows, charsetErr := l.query("SELECT VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER='NLS_NCHAR_CHARACTERSET'")
			if charsetErr != nil {
				return signature, charsetErr
			}
			if len(rows) != 1 || rows[0].text("VALUE") == "" {
				return signature, errors.New("Oracle national character set metadata is unavailable")
			}
			signature.NationalCharacterSet = rows[0].text("VALUE")
		}
		ref, e := plDebugNativeArgumentTypeRef(argument)
		if e != nil {
			return signature, e
		}
		if ref != nil {
			roots = append(roots, *ref)
			bindings = append(bindings, plDebugNativeTypeBinding{argument.Sequence, *ref})
		}
	}
	graph, err := plDebugLoadNativeTypeGraphOnLoader(l, roots, prepare)
	if err != nil {
		return signature, err
	}
	afterDetails, err := l.query(query, candidate.Schema, candidate.ObjectID, candidate.SubprogramID)
	if err != nil {
		return signature, err
	}
	after, err := l.containerVersion(candidate.Schema, name, kind)
	if err != nil {
		return signature, err
	}
	if !reflect.DeepEqual(details, afterDetails) || !reflect.DeepEqual(before, after) {
		return signature, errors.New("selected debug signature or source changed during type inspection")
	}
	signature.ArgumentDetails = details
	signature.TypeBindings = bindings
	signature.TypeGraph = graph
	signature.TargetVersion = before
	return signature, nil
}
