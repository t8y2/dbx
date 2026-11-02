package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"regexp"
	"strings"
)

// Signature selection follows the native Java PlDebugTarget adapter: dictionary
// identity and declared types, never the appearance of an input value.
type plDebugNativeArgument struct {
	Name        *string `json:"name"`
	Position    int64   `json:"position"`
	Sequence    int64   `json:"sequence"`
	Level       int64   `json:"dataLevel"`
	Mode        string  `json:"mode"`
	Type        string  `json:"type"`
	TypeOwner   *string `json:"typeOwner"`
	TypeName    *string `json:"typeName"`
	TypeSubname *string `json:"typeSubname"`
	Defaulted   *string `json:"defaulted"`
}

func (a plDebugNativeArgument) input() bool  { return a.Mode != "OUT" }
func (a plDebugNativeArgument) output() bool { return a.Mode != "IN" }
func (a plDebugNativeArgument) lobCarrier() bool {
	return a.Type == "CLOB" || a.Type == "NCLOB" || a.Type == "BLOB" || a.Type == "RAW"
}
func (a plDebugNativeArgument) retainedOutput() bool {
	return a.lobCarrier() || a.composite() || a.national() || a.Type == "CHAR"
}
func (a plDebugNativeArgument) composite() bool {
	return a.Type == "PL/SQL RECORD" || a.Type == "TABLE" || a.Type == "VARRAY" || a.Type == "PL/SQL TABLE" || a.Type == "OBJECT"
}

func (a plDebugNativeArgument) interval() bool {
	return a.Type == "INTERVAL YEAR TO MONTH" || a.Type == "INTERVAL DAY TO SECOND"
}
func (a plDebugNativeArgument) scalar() bool {
	return a.Level == 0 && a.TypeOwner == nil && a.TypeName == nil && a.TypeSubname == nil
}
func (a plDebugNativeArgument) adapted() bool {
	return a.scalar() && (a.Type == "NUMBER" || a.Type == "VARCHAR2")
}

func (a plDebugNativeArgument) decimalCarrier() bool {
	return a.Type == "NUMBER" || a.Type == "BINARY_INTEGER"
}

type plDebugNativeCandidate struct {
	Schema                string                   `json:"schema"`
	ObjectName            string                   `json:"objectName"`
	PackageName           *string                  `json:"packageName"`
	ObjectType            string                   `json:"objectType"`
	ObjectID              string                   `json:"objectId"`
	SubprogramID          int64                    `json:"subprogramId"`
	Status                *string                  `json:"status"`
	Arguments             []plDebugNativeArgument  `json:"arguments"`
	NoArgumentPlaceholder plDebugNativeMetadataRow `json:"noArgumentPlaceholder,omitempty"`
}

func (c plDebugNativeCandidate) parameters() []plDebugNativeArgument {
	result := []plDebugNativeArgument{}
	if c.NoArgumentPlaceholder != nil {
		return result
	}
	for _, a := range c.Arguments {
		if a.Level == 0 && a.Position > 0 {
			result = append(result, a)
		}
	}
	return result
}
func (c plDebugNativeCandidate) returns() *plDebugNativeArgument {
	for _, a := range c.Arguments {
		if a.Level == 0 && a.Position == 0 {
			value := a
			return &value
		}
	}
	return nil
}
func (c plDebugNativeCandidate) routine() string {
	result := quoteIdentifier(c.Schema) + "."
	if c.PackageName != nil {
		result += quoteIdentifier(*c.PackageName) + "."
	}
	return result + quoteIdentifier(c.ObjectName)
}
func (c plDebugNativeCandidate) preview() map[string]interface{} {
	adapted := true
	for _, a := range c.Arguments {
		if a.Level != 0 || c.NoArgumentPlaceholder != nil {
			continue
		}
		adapted = adapted && a.adapted()
	}
	transport := "implemented"
	if !adapted {
		transport = "not_implemented"
	}
	result := map[string]interface{}{"signature": c, "parameters": c.parameters(), "returnValue": c.returns(), "parameterTransport": transport}
	if !adapted {
		result["message"] = "Some declared parameter types do not yet have a debugger transport adapter"
	}
	return result
}

func plDebugNativeToken(value string) string { return strings.ToUpper(strings.TrimSpace(value)) }
func plDebugNativeMode(value string) string {
	value = plDebugNativeToken(value)
	if value == "INOUT" || value == "IN/OUT" {
		return "IN OUT"
	}
	return value
}
func plDebugNativeOptional(value sql.NullString) *string {
	if !value.Valid || value.String == "" {
		return nil
	}
	copy := value.String
	return &copy
}

func plDebugNativeRows(ctx context.Context, conn *sql.Conn, query string, args []interface{}, read func(*sql.Rows) error) error {
	rows, err := conn.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		if err = read(rows); err != nil {
			break
		}
	}
	if err == nil {
		err = rows.Err()
	}
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func plDebugNativeTargetOwner(ctx context.Context, conn *sql.Conn, schema string) (string, error) {
	if schema != "" {
		return schema, nil
	}
	var owner sql.NullString
	if err := conn.QueryRowContext(ctx, `SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL`).Scan(&owner); err != nil {
		return "", err
	}
	if !owner.Valid || owner.String == "" {
		return "", errors.New("current schema could not be determined for the debug target")
	}
	return owner.String, nil
}

func (r *runtimeServer) previewNativeTarget(params map[string]json.RawMessage) (interface{}, error) {
	request, err := plDebugDecodeNativeStart(params)
	if err != nil {
		return nil, err
	}
	return r.nativeTargetMetadata(params, &request, false)
}

func (r *runtimeServer) inspectNativeTarget(params map[string]json.RawMessage) (interface{}, error) {
	var target *plDebugNativeStart
	if raw, ok := params["target"]; ok && strings.TrimSpace(string(raw)) != "null" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, errors.New("target must be an object")
		}
		compilePreview := stringParam(fields, "metadataPreparation") == "debug_compile"
		if compilePreview {
			delete(fields, "metadataPreparation")
		}
		request, err := plDebugDecodeNativeStart(fields)
		if err != nil {
			return nil, err
		}
		if compilePreview {
			request.MetadataPreparation = "debug_compile"
		}
		target = &request
	}
	return r.nativeTargetMetadata(params, target, true)
}

func (r *runtimeServer) nativeTargetMetadata(params map[string]json.RawMessage, request *plDebugNativeStart, inspection bool) (interface{}, error) {
	id := stringParam(params, "agentSessionId")
	if id == "" {
		return nil, errors.New("agentSessionId is required")
	}
	r.mu.Lock()
	session := r.sessions[id]
	if session == nil || len(r.plNativeEntries) != 0 || r.plMetadataBusy || r.nativeCompileUnresolvedLocked() {
		r.mu.Unlock()
		return nil, errors.New("the original debugger connection is not available for target metadata")
	}
	r.plMetadataBusy = true
	r.mu.Unlock()
	defer func() { r.mu.Lock(); r.plMetadataBusy = false; r.mu.Unlock() }()
	if !session.mu.TryLock() {
		return nil, errors.New("the original debugger connection is still being prepared")
	}
	defer session.mu.Unlock()
	if session.server.plConnection == nil {
		return nil, errors.New("the original dedicated session has not finished connecting")
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	if !inspection {
		return plDebugPreviewNativeTarget(ctx, session.server.plConnection, *request, usesOCIProfile(session.server.params))
	}
	result := map[string]interface{}{"capabilities": session.server.plDebugProbeOnConnection(ctx, session.server.plConnection)}
	if request != nil {
		if request.MetadataPreparation == "debug_compile" {
			inspected, err := plDebugInspectNativeCompile(ctx, session.server.plConnection, *request)
			if err != nil {
				return nil, err
			}
			for key, value := range inspected {
				result[key] = value
			}
			return result, nil
		}
		preview, err := plDebugPreviewNativeTarget(ctx, session.server.plConnection, *request, usesOCIProfile(session.server.params))
		if err != nil {
			return nil, err
		}
		result["targetPreview"] = preview
	}
	return result, nil
}

func (s *server) previewNativeTarget(params map[string]json.RawMessage) (interface{}, error) {
	request, err := plDebugDecodeNativeStart(params)
	if err != nil {
		return nil, err
	}
	if request.MetadataPreparation != "" {
		return nil, errors.New("typed Oracle metadata preparation requires its dedicated PL/SQL channel")
	}
	if s.db == nil {
		return nil, errors.New("target metadata requires a connected metadata session")
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return plDebugPreviewNativeTarget(ctx, conn, request, usesOCIProfile(s.params))
}

func plDebugPreviewNativeTarget(ctx context.Context, conn *sql.Conn, request plDebugNativeStart, oci bool) (interface{}, error) {
	owner, candidates, err := plDebugLoadNativeTargets(ctx, conn, request)
	if err != nil {
		return nil, err
	}
	previews := make([]map[string]interface{}, 0, len(candidates))
	loader := plDebugNativeTypeLoader{ctx: ctx, conn: conn, oci: oci}
	for _, candidate := range candidates {
		preview := candidate.preview()
		if request.MetadataPreparation == "type_only" {
			signature, err := plDebugBuildNativeTypedSignatureOnLoader(&loader, candidate)
			if err != nil {
				return nil, err
			}
			preview["signature"] = signature
			preview["parameterTransport"] = "implemented"
			delete(preview, "message")
			if _, err := plDebugNativeTypedTransport(signature); err != nil {
				var missing plDebugNativeMissingAdapter
				if !errors.As(err, &missing) {
					return nil, fmt.Errorf("Oracle typed transport metadata could not be verified: %w", err)
				}
				preview["parameterTransport"] = "not_implemented"
				preview["message"] = err.Error()
			}
		}
		previews = append(previews, preview)
	}
	state := "available"
	if len(candidates) == 0 {
		state = "not_visible"
	}
	result := map[string]interface{}{"schema": owner, "state": state, "candidates": previews}
	if len(candidates) == 0 {
		result["message"] = "The current connection returned no visible matching signature; refresh metadata or check the target"
	}
	return result, nil
}

func plDebugLoadNativeTargets(ctx context.Context, conn *sql.Conn, request plDebugNativeStart) (string, []plDebugNativeCandidate, error) {
	typedRows, typedBytes := 0, 0
	consumeTyped := func(value interface{}) error {
		if request.MetadataPreparation == "" {
			return nil
		}
		typedRows++
		if typedRows > 8192 {
			return errors.New("typed target metadata row budget exceeded")
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		typedBytes += len(raw)
		if typedBytes > 1048576 {
			return errors.New("typed target metadata byte budget exceeded")
		}
		return nil
	}
	objectType := plDebugNativeToken(request.ObjectType)
	if objectType != "PROCEDURE" && objectType != "FUNCTION" {
		return "", nil, errors.New("a named procedure or function is required")
	}
	if request.ObjectName == "" {
		return "", nil, errors.New("an exact routine name is required")
	}
	owner, err := plDebugNativeTargetOwner(ctx, conn, request.Schema)
	if err != nil {
		return "", nil, err
	}
	container, containerType := request.ObjectName, objectType
	var packageName *string
	if request.PackageName != "" {
		value := request.PackageName
		packageName = &value
		container, containerType = value, "PACKAGE"
	}
	type object struct {
		id     string
		status *string
	}
	objects := []object{}
	objectIDs := map[string]bool{}
	err = plDebugNativeRows(ctx, conn, `SELECT TO_CHAR(OBJECT_ID, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), STATUS FROM SYS.ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2 AND OBJECT_TYPE = :3`, []interface{}{owner, container, containerType}, func(rows *sql.Rows) error {
		var id, status sql.NullString
		if err := rows.Scan(&id, &status); err != nil {
			return err
		}
		if !id.Valid || id.String == "" || objectIDs[id.String] {
			return errors.New("incomplete or duplicate debug object identity in metadata")
		}
		objectIDs[id.String] = true
		if err := consumeTyped([]interface{}{id.String, plDebugNativeOptional(status)}); err != nil {
			return err
		}
		objects = append(objects, object{id.String, plDebugNativeOptional(status)})
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	candidates := []plDebugNativeCandidate{}
	for _, object := range objects {
		filter := "PROCEDURE_NAME IS NULL"
		args := []interface{}{owner, object.id, container, containerType}
		if packageName != nil {
			filter = "PROCEDURE_NAME = :5"
			args = append(args, request.ObjectName)
		}
		subprograms := []int64{}
		seen := map[int64]bool{}
		err = plDebugNativeRows(ctx, conn, `SELECT SUBPROGRAM_ID FROM SYS.ALL_PROCEDURES WHERE OWNER = :1 AND OBJECT_ID = :2 AND OBJECT_NAME = :3 AND OBJECT_TYPE = :4 AND `+filter+` ORDER BY SUBPROGRAM_ID`, args, func(rows *sql.Rows) error {
			var id sql.NullInt64
			if err := rows.Scan(&id); err != nil {
				return err
			}
			if !id.Valid || id.Int64 < 0 || seen[id.Int64] {
				return errors.New("incomplete or duplicate debug subprogram identity in metadata")
			}
			seen[id.Int64] = true
			if err := consumeTyped(id.Int64); err != nil {
				return err
			}
			subprograms = append(subprograms, id.Int64)
			return nil
		})
		if err != nil {
			return "", nil, err
		}
		for _, id := range subprograms {
			arguments := []plDebugNativeArgument{}
			positions, sequences, names := map[int64]bool{}, map[int64]bool{}, map[string]bool{}
			err = plDebugNativeRows(ctx, conn, `SELECT ARGUMENT_NAME, POSITION, SEQUENCE, DATA_LEVEL, IN_OUT, DATA_TYPE, TYPE_OWNER, TYPE_NAME, TYPE_SUBNAME, DEFAULTED FROM SYS.ALL_ARGUMENTS WHERE OWNER = :1 AND OBJECT_ID = :2 AND SUBPROGRAM_ID = :3 ORDER BY SEQUENCE`, []interface{}{owner, object.id, id}, func(rows *sql.Rows) error {
				var name, mode, kind, typeOwner, typeName, typeSubname, defaulted sql.NullString
				var position, sequence, level sql.NullInt64
				if err := rows.Scan(&name, &position, &sequence, &level, &mode, &kind, &typeOwner, &typeName, &typeSubname, &defaulted); err != nil {
					return err
				}
				a := plDebugNativeArgument{Name: plDebugNativeOptional(name), Position: position.Int64, Sequence: sequence.Int64, Level: level.Int64, Mode: plDebugNativeMode(mode.String), Type: plDebugNativeToken(kind.String), TypeOwner: plDebugNativeOptional(typeOwner), TypeName: plDebugNativeOptional(typeName), TypeSubname: plDebugNativeOptional(typeSubname), Defaulted: plDebugNativeOptional(defaulted)}
				if position.Valid && sequence.Valid && level.Valid && a.Position == 1 && a.Sequence == 0 && a.Level == 0 && a.Name == nil && a.Type == "" && a.Mode == "IN" && a.TypeOwner == nil && a.TypeName == nil && a.TypeSubname == nil && a.Defaulted != nil && *a.Defaulted == "N" {
					arguments = append(arguments, a)
					return consumeTyped(a)
				}
				if !position.Valid || !sequence.Valid || !level.Valid || a.Position < 0 || a.Sequence < 0 || a.Level < 0 || a.Type == "" || (a.Mode != "IN" && a.Mode != "OUT" && a.Mode != "IN OUT") || sequences[a.Sequence] {
					return errors.New("incomplete or duplicate debug parameter signature in metadata")
				}
				sequences[a.Sequence] = true
				if a.Level == 0 {
					if positions[a.Position] || (a.Position > 0 && (!name.Valid || name.String == "" || names[name.String])) {
						return errors.New("incomplete or duplicate debug parameter identity in metadata")
					}
					positions[a.Position] = true
					if a.Position > 0 {
						names[name.String] = true
					}
				}
				arguments = append(arguments, a)
				if err := consumeTyped(a); err != nil {
					return err
				}
				return nil
			})
			if err != nil {
				return "", nil, err
			}
			candidate := plDebugNativeCandidate{Schema: owner, ObjectName: request.ObjectName, PackageName: packageName, ObjectType: "PROCEDURE", ObjectID: object.id, SubprogramID: id, Status: object.status, Arguments: arguments}
			for _, argument := range arguments {
				if argument.Type != "" {
					continue
				}
				loader := plDebugNativeTypeLoader{ctx: ctx, conn: conn}
				rows, err := loader.query("SELECT * FROM SYS.ALL_ARGUMENTS WHERE OWNER=:1 AND OBJECT_ID=:2 AND SUBPROGRAM_ID=:3 ORDER BY SEQUENCE", owner, object.id, id)
				if err != nil {
					return "", nil, err
				}
				if len(arguments) != 1 || len(rows) != 1 || !plDebugLegacyNoArgumentsRow(rows[0]) {
					return "", nil, errors.New("incomplete no-argument placeholder metadata")
				}
				candidate.NoArgumentPlaceholder = rows[0]
			}
			if candidate.returns() != nil {
				candidate.ObjectType = "FUNCTION"
			}
			if candidate.ObjectType == objectType {
				candidates = append(candidates, candidate)
			}
		}
	}
	return owner, candidates, nil
}

type plDebugNativeParameter struct {
	Name       *string         `json:"name"`
	Mode       string          `json:"mode"`
	Type       string          `json:"type"`
	InputState *string         `json:"inputState"`
	Value      interface{}     `json:"value"`
	TypedValue json.RawMessage `json:"typedValue"`
}
type plDebugNativeInput struct {
	argument   plDebugNativeArgument
	state      string
	value      interface{}
	record     *plDebugRecordInput
	collection *plDebugCollectionInput
	object     *plDebugObjectInput
}
type plDebugNativePlan struct {
	target               plDebugNativeCandidate
	arguments            []plDebugNativeInput
	typedSignature       *plDebugNativeTypedSignature
	typesPrepared        bool
	compositeOutputNodes []plDebugNativeTypeNode
}

func plDebugNativeJSONValue(value interface{}) (interface{}, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var result interface{}
	err = decoder.Decode(&result)
	return result, err
}

func plDebugSelectNativeTarget(candidates []plDebugNativeCandidate, request plDebugNativeStart) (*plDebugNativePlan, error) {
	typedSignature, err := plDebugDecodeNativeTypedSignature(request)
	if err != nil {
		return nil, err
	}
	if typedSignature != nil {
		base, err := plDebugNativeJSONValue(typedSignature.plDebugNativeCandidate)
		if err != nil {
			return nil, err
		}
		request.TargetSignature = base.(map[string]interface{})
	}
	raw, err := json.Marshal(request.Params)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var supplied []*plDebugNativeParameter
	if err = decoder.Decode(&supplied); err != nil {
		return nil, err
	}
	if typedSignature != nil && len(supplied) > 8192 {
		return nil, errors.New("typed debugger value node budget exceeded")
	}
	params := map[string]plDebugNativeParameter{}
	for _, p := range supplied {
		if p == nil || p.Name == nil || *p.Name == "" {
			return nil, errors.New("debug parameters must have unique exact formal names")
		}
		if len(p.TypedValue) != 0 && typedSignature == nil {
			return nil, errors.New("typed Oracle debugger parameter transport is not yet implemented")
		}
		if _, ok := params[*p.Name]; ok {
			return nil, errors.New("debug parameters must have unique exact formal names")
		}
		params[*p.Name] = *p
	}
	matches := []plDebugNativeCandidate{}
	for _, candidate := range candidates {
		matchesRequest := plDebugNativeDescribes(candidate, params)
		if request.TargetSignature != nil {
			signature, err := plDebugNativeJSONValue(candidate)
			if err != nil {
				return nil, err
			}
			matchesRequest = reflect.DeepEqual(signature, request.TargetSignature)
		}
		if matchesRequest {
			matches = append(matches, candidate)
		}
	}
	if len(matches) != 1 {
		if request.TargetSignature != nil {
			return nil, errors.New("the selected debug signature changed or is no longer visible; refresh metadata and confirm again")
		}
		if len(candidates) == 0 {
			return nil, errors.New("no visible matching signature was returned; refresh metadata or check the target")
		}
		return nil, errors.New("debug parameter descriptions do not identify one signature; select a complete signature from refreshed metadata")
	}
	target := matches[0]
	if target.Status == nil || *target.Status != "VALID" {
		return nil, errors.New("the selected debug object is not confirmed VALID; inspect its source and compilation errors")
	}
	if !plDebugNativeDescribes(target, params) {
		return nil, errors.New("parameter names, directions or types do not match the selected signature; refresh metadata")
	}
	for _, a := range target.Arguments {
		if a.Level != 0 || target.NoArgumentPlaceholder != nil {
			continue
		}
		if !a.adapted() && !(typedSignature != nil && plDebugNativeTypedRootAdapter(a)) {
			return nil, fmt.Errorf("debugger parameter transport is not yet implemented for position %d (%s)", a.Position, a.Type)
		}
	}
	plan := &plDebugNativePlan{target: target, arguments: []plDebugNativeInput{}, typedSignature: typedSignature}
	if typedSignature != nil {
		plan.compositeOutputNodes, err = plDebugNativeTypedTransport(*typedSignature)
		if err != nil {
			return nil, err
		}
	}
	lobBytes := 0
	valueNodes := 0
	for _, a := range target.parameters() {
		p := params[*a.Name]
		recordType := a.Type == "PL/SQL RECORD"
		objectType := a.Type == "OBJECT"
		collectionType := a.composite() && !recordType && !objectType
		var record *plDebugRecordInput
		var collection *plDebugCollectionInput
		var object *plDebugObjectInput
		if objectType && len(p.TypedValue) != 0 {
			if p.Value != nil || p.InputState != nil && *p.InputState != "value" || !a.input() {
				return nil, fmt.Errorf("typed object requires one explicit constructor value for parameter %s", *a.Name)
			}
			ref, refErr := plDebugNativeArgumentTypeRef(a)
			if refErr != nil {
				return nil, refErr
			}
			if ref == nil {
				return nil, errors.New("object input has no declared identity")
			}
			object, err = plDebugDecodeObjectInput(typedSignature.TypeGraph, *ref, p.TypedValue, 8192-valueNodes, plDebugTypedInputBytes-lobBytes)
			if err != nil {
				return nil, err
			}
			builder := plDebugCollectionInitializer{prefix: "DBX_CHECK_"}
			if err = builder.object(object, "ROOT"); err != nil {
				return nil, err
			}
			p.Value = object
			lobBytes += object.bytes
			valueNodes += object.nodes
		} else if collectionType && len(p.TypedValue) != 0 {
			if p.Value != nil || p.InputState != nil && *p.InputState != "value" || !a.input() {
				return nil, fmt.Errorf("typed collection requires one explicit entry array for parameter %s", *a.Name)
			}
			ref, refErr := plDebugNativeArgumentTypeRef(a)
			if refErr != nil {
				return nil, refErr
			}
			if ref == nil {
				return nil, errors.New("collection input has no declared identity")
			}
			collection, err = plDebugDecodeCollectionInput(typedSignature.TypeGraph, *ref, p.TypedValue, 8192-valueNodes, plDebugTypedInputBytes-lobBytes)
			if err != nil {
				return nil, fmt.Errorf("parameter %s: %w", *a.Name, err)
			}
			builder := plDebugCollectionInitializer{prefix: "DBX_CHECK_"}
			if err = builder.collection(collection, "ROOT"); err != nil {
				return nil, err
			}
			p.Value = collection
			lobBytes += collection.bytes
			valueNodes += collection.nodes
		} else if recordType && len(p.TypedValue) != 0 {
			if p.Value != nil || p.InputState != nil && *p.InputState != "value" || !a.input() {
				return nil, fmt.Errorf("typed record requires one explicit field array for parameter %s", *a.Name)
			}
			ref, err := plDebugNativeArgumentTypeRef(a)
			if err != nil {
				return nil, err
			}
			if ref == nil {
				return nil, errors.New("record input has no declared identity")
			}
			record, err = plDebugDecodeRecordInput(typedSignature.TypeGraph, *ref, p.TypedValue, 8192-valueNodes, plDebugTypedInputBytes-lobBytes)
			if err != nil {
				return nil, fmt.Errorf("parameter %s: %w", *a.Name, err)
			}
			builder := plDebugCollectionInitializer{prefix: "DBX_CHECK_"}
			if err = builder.record(record, "ROOT"); err != nil {
				return nil, err
			}
			p.Value = record
			lobBytes += record.bytes
			valueNodes += record.nodes
		} else {
			valueNodes++
		}
		if typedSignature != nil && valueNodes > 8192 {
			return nil, errors.New("typed debugger value node budget exceeded")
		}
		lob := a.lobCarrier()
		if lob && len(p.TypedValue) != 0 {
			if p.Value != nil || p.InputState != nil && *p.InputState != "value" || !a.input() {
				return nil, fmt.Errorf("typed input requires one explicit value for parameter %s", *a.Name)
			}
			value, err := plDebugDecodeBinaryOrLobInput(p.TypedValue, strings.ToLower(a.Type), plDebugTypedInputBytes-lobBytes)
			if err != nil {
				return nil, err
			}
			lobBytes += value.bytes
			p.Value = value
		}
		if len(p.TypedValue) != 0 && !lob && !recordType && !collectionType && !objectType {
			if p.Value != nil || p.InputState != nil && *p.InputState != "value" || !a.input() {
				return nil, fmt.Errorf("typed input requires one explicit value for parameter %s", *a.Name)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(p.TypedValue, &payload); err != nil || len(payload) != 2 || payload["kind"] == nil || payload["value"] == nil {
				return nil, fmt.Errorf("invalid typed scalar input for parameter %s", *a.Name)
			}
			var kind string
			if err := json.Unmarshal(payload["kind"], &kind); err != nil {
				return nil, err
			}
			want := "text"
			if a.decimalCarrier() {
				want = "number"
			}
			if a.binaryFloat() {
				want = strings.ToLower(a.Type)
			}
			if a.Type == "PL/SQL BOOLEAN" {
				want = "boolean"
			}
			if a.Type == "DATE" {
				want = "date"
			}
			if a.Type == "TIMESTAMP" {
				want = "timestamp"
			}
			if a.timezone() {
				want = "timestamp_tz"
				if plDebugNativeScalarTypeName(a.Type) == plDebugTimestampLTZ {
					want = "timestamp_ltz"
				}
			}
			if kind != want || bytes.Equal(bytes.TrimSpace(payload["value"]), []byte("null")) {
				return nil, fmt.Errorf("typed scalar input does not match parameter %s", *a.Name)
			}
			if a.timezone() {
				value, err := plDebugDecodeTimezoneInput(payload["value"], want == "timestamp_ltz", plDebugTypedInputBytes-lobBytes)
				if err != nil {
					return nil, err
				}
				p.Value = value
			} else if want == "boolean" {
				var value bool
				if err := json.Unmarshal(payload["value"], &value); err != nil {
					return nil, err
				}
				p.Value = value
			} else {
				var value string
				if err := json.Unmarshal(payload["value"], &value); err != nil {
					return nil, err
				}
				p.Value = value
			}
		}
		state := "value"
		if p.Value == nil {
			state = "null"
		}
		if p.InputState != nil {
			state = *p.InputState
		}
		if state != "value" && state != "null" && state != "default" {
			return nil, fmt.Errorf("invalid input state for parameter %s", *a.Name)
		}
		if !a.input() {
			if p.Value != nil || state == "default" {
				return nil, fmt.Errorf("OUT parameter does not accept input: %s", *a.Name)
			}
			state = "null"
		}
		if state == "default" && (a.Mode != "IN" || a.Defaulted == nil || *a.Defaulted != "Y") {
			return nil, fmt.Errorf("no omittable input default was confirmed for parameter %s", *a.Name)
		}
		if recordType && a.input() && state != "default" && record == nil {
			return nil, fmt.Errorf("record parameter %s requires a typed field array; records have no atomic NULL", *a.Name)
		}
		if collectionType && a.input() && state != "default" && collection == nil {
			return nil, fmt.Errorf("collection parameter %s requires a typed entry array", *a.Name)
		}
		if objectType && a.input() && state != "default" && object == nil {
			return nil, fmt.Errorf("object parameter %s requires a typed constructor value or typed NULL", *a.Name)
		}
		if state == "value" && p.Value == nil {
			return nil, fmt.Errorf("an explicit input value is required for parameter %s", *a.Name)
		}
		value := p.Value
		if state != "value" {
			value = nil
		}
		if value != nil {
			if typedSignature != nil && !lob {
				cost := 0
				switch original := p.Value.(type) {
				case string:
					cost = len(original)
				case json.Number:
					cost = len(original.String())
				case plDebugNativeTimezoneInput:
					cost = original.bytes
				case bool:
					cost = 5
					if original {
						cost = 4
					}
				}
				if cost > plDebugTypedInputBytes-lobBytes {
					return nil, fmt.Errorf("typed input byte budget exceeded at parameter %s", *a.Name)
				}
				lobBytes += cost
			}
			if recordType {
				value = record
			} else if collectionType {
				value = collection
			} else if objectType {
				value = object
			} else if a.timezone() {
				if len(p.TypedValue) == 0 {
					return nil, fmt.Errorf("a structured timezone input is required for parameter %s", *a.Name)
				}
				if _, ok := value.(plDebugNativeTimezoneInput); !ok {
					return nil, errors.New("timezone input was not decoded into exact components")
				}
			} else if a.binaryFloat() {
				if len(p.TypedValue) == 0 {
					return nil, fmt.Errorf("a typed binary floating-point input is required for parameter %s", *a.Name)
				}
				text, ok := value.(string)
				if !ok {
					return nil, errors.New("binary floating-point input must be hexadecimal text")
				}
				value, err = plDebugNativeBinaryFloatHex(text, a.Type == "BINARY_DOUBLE")
				if err != nil {
					return nil, err
				}
			} else if a.national() {
				if len(p.TypedValue) == 0 {
					return nil, fmt.Errorf("a typed national text input is required for parameter %s", *a.Name)
				}
				text, ok := value.(string)
				if !ok {
					return nil, errors.New("national input must be text")
				}
				value = plDebugEncodeNationalInput(text)
			} else if a.interval() {
				if len(p.TypedValue) == 0 {
					return nil, fmt.Errorf("a typed interval text input is required for parameter %s", *a.Name)
				}
				text, ok := value.(string)
				if !ok {
					return nil, errors.New("interval input must be a SQL interval string")
				}
				value, err = plDebugNativeIntervalText(text, a.Type == "INTERVAL DAY TO SECOND")
				if err != nil {
					return nil, err
				}
			} else if lob {
				if _, ok := value.(plDebugLobInput); !ok {
					return nil, fmt.Errorf("a typed LOB input is required for parameter %s", *a.Name)
				}
			} else if a.Type == "DATE" || a.Type == "TIMESTAMP" {
				if len(p.TypedValue) == 0 {
					return nil, fmt.Errorf("a typed date/time input is required for parameter %s", *a.Name)
				}
				text, ok := value.(string)
				if !ok {
					return nil, fmt.Errorf("a date/time text input is required for parameter %s", *a.Name)
				}
				value, err = plDebugNativeTemporalComponents(text, a.Type == "TIMESTAMP")
				if err != nil {
					return nil, err
				}
			} else if a.Type == "PL/SQL BOOLEAN" {
				if len(p.TypedValue) == 0 {
					return nil, fmt.Errorf("a typed BOOLEAN input is required for parameter %s", *a.Name)
				}
				if _, ok := value.(bool); !ok {
					return nil, fmt.Errorf("a BOOLEAN input is required for parameter %s", *a.Name)
				}
			} else if a.decimalCarrier() {
				text, ok := value.(string)
				if !ok {
					if number, numeric := value.(json.Number); numeric {
						text, ok = number.String(), true
					}
				}
				if !ok {
					return nil, fmt.Errorf("an exact decimal NUMBER input is required for parameter %s", *a.Name)
				}
				value, err = plDebugNativeDecimal(text)
				if err != nil {
					return nil, fmt.Errorf("invalid NUMBER input for parameter %s: %w", *a.Name, err)
				}
			} else if _, ok := value.(string); !ok {
				return nil, fmt.Errorf("a text input is required for parameter %s", *a.Name)
			}
		}
		plan.arguments = append(plan.arguments, plDebugNativeInput{argument: a, state: state, value: value, record: record, collection: collection, object: object})
	}
	for _, other := range candidates {
		if other.ObjectID == target.ObjectID && other.SubprogramID == target.SubprogramID {
			continue
		}
		var graph *plDebugNativeTypeGraph
		if typedSignature != nil {
			graph = &typedSignature.TypeGraph
		}
		ambiguous, err := plDebugNativeCallMatches(other, plan.arguments, graph)
		if err != nil {
			return nil, err
		}
		if ambiguous {
			return nil, errors.New("the selected types and omitted defaults still leave an ambiguous PL/SQL call; choose explicit arguments or another signature")
		}
	}
	return plan, nil
}

func plDebugNativeDescribes(candidate plDebugNativeCandidate, params map[string]plDebugNativeParameter) bool {
	parameters := candidate.parameters()
	if len(parameters) != len(params) {
		return false
	}
	for _, a := range parameters {
		p, ok := params[*a.Name]
		if !ok || plDebugNativeMode(p.Mode) != a.Mode || plDebugNativeToken(p.Type) != a.Type {
			return false
		}
	}
	return true
}
func plDebugNativeCallMatches(candidate plDebugNativeCandidate, inputs []plDebugNativeInput, graph *plDebugNativeTypeGraph) (bool, error) {
	parameters := map[string]plDebugNativeArgument{}
	for _, a := range candidate.parameters() {
		parameters[*a.Name] = a
	}
	objectDifference, scalarDifference, weakerObject, incompatible := false, false, false, false
	characterCarrier := false
	for _, input := range inputs {
		characterCarrier = characterCarrier || input.argument.Type == "CHAR"
	}
	var uncertain error
	for _, input := range inputs {
		if input.state == "default" {
			continue
		}
		a, ok := parameters[*input.argument.Name]
		if !ok {
			return false, nil
		}
		delete(parameters, *input.argument.Name)
		if a.scalar() || input.argument.scalar() {
			sameType := a.Type == input.argument.Type
			if characterCarrier {
				character := func(name string) bool {
					return name == "CHAR" || name == "VARCHAR2" || name == "NCHAR" || name == "NVARCHAR2" || name == "RAW" || name == "ROWID" || name == "UROWID"
				}
				sameType = sameType || character(a.Type) && character(input.argument.Type)
			}
			scalarDifference = scalarDifference || !sameType || a.scalar() != input.argument.scalar()
			continue
		}
		actual, actualErr := plDebugNativeArgumentTypeRef(input.argument)
		formal, formalErr := plDebugNativeArgumentTypeRef(a)
		if actualErr != nil || formalErr != nil || actual == nil || formal == nil {
			uncertain = errors.New("competing composite overload identity is incomplete; refresh metadata")
			continue
		}
		if actual.key() == formal.key() {
			continue
		}
		if a.Type != "OBJECT" || input.argument.Type != "OBJECT" {
			incompatible = true
			continue
		}
		objectDifference = true
		if graph == nil || !plDebugNativeObjectHierarchyKnown(*graph, *actual) || !plDebugNativeObjectHierarchyKnown(*graph, *formal) {
			uncertain = errors.New("competing object overload hierarchy is incomplete; refresh metadata")
			continue
		}
		if plDebugNativeObjectAssignable(*graph, *actual, *formal) {
			weakerObject = true
		} else {
			incompatible = true
		}
	}
	for _, a := range parameters {
		if a.Mode != "IN" || a.Defaulted == nil || *a.Defaulted != "Y" {
			return false, nil
		}
	}
	if incompatible && !objectDifference {
		return false, nil
	}
	if objectDifference && scalarDifference {
		return false, errors.New("object overload hierarchy mixed with scalar conversion is not verified; choose a distinct callable signature")
	}
	if uncertain != nil {
		return false, uncertain
	}
	if incompatible || scalarDifference {
		return false, nil
	}
	if weakerObject {
		// Closest static OBJECT declarations win only for the proven same-shape
		// overloads. Omitted defaults must not manufacture a preference.
		if len(candidate.parameters()) != len(inputs) {
			return false, errors.New("object overload hierarchy with omitted formals is not verified")
		}
		for _, input := range inputs {
			if input.state == "default" {
				return false, errors.New("object overload hierarchy with omitted defaults is not verified")
			}
			for _, a := range candidate.parameters() {
				if a.Name != nil && *a.Name == *input.argument.Name && a.Mode != input.argument.Mode {
					return false, errors.New("object overload hierarchy with different parameter modes is not verified")
				}
			}
		}
		return false, nil
	}
	return true, nil
}

var plDebugNativeDecimalSyntax = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func plDebugNativeDecimal(text string) (string, error) {
	if !plDebugNativeDecimalSyntax.MatchString(text) {
		return "", errors.New("a finite decimal string is required")
	}
	negative := text[0] == '-'
	if text[0] == '-' || text[0] == '+' {
		text = text[1:]
	}
	parts := strings.Split(strings.ToLower(text), "e")
	mantissa := parts[0]
	fraction := 0
	if dot := strings.IndexByte(mantissa, '.'); dot >= 0 {
		fraction = len(mantissa) - dot - 1
	}
	digits := strings.TrimLeft(strings.ReplaceAll(mantissa, ".", ""), "0")
	if digits == "" {
		return "0", nil
	}
	short := strings.TrimRight(digits, "0")
	trailing := len(digits) - len(short)
	digits = short
	exponent := new(big.Int)
	if len(parts) == 2 {
		if _, ok := exponent.SetString(parts[1], 10); !ok {
			return "", errors.New("invalid decimal exponent")
		}
	}
	exponent.Add(exponent, big.NewInt(int64(len(digits)-1+trailing-fraction)))
	if exponent.Cmp(big.NewInt(-130)) < 0 || exponent.Cmp(big.NewInt(125)) > 0 {
		return "", errors.New("NUMBER input is outside the native finite range")
	}
	scale := int(exponent.Int64()) - (len(digits) - 1)
	var result string
	if scale >= 0 {
		result = digits + strings.Repeat("0", scale)
	} else {
		point := len(digits) + scale
		if point <= 0 {
			result = "0." + strings.Repeat("0", -point) + digits
		} else {
			result = digits[:point] + "." + digits[point:]
		}
	}
	if negative {
		result = "-" + result
	}
	return result, nil
}
