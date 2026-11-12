package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

type plDebugNativeCompileEntry struct {
	mu                         sync.Mutex
	agentSessionID, frozen, id string
	allocation                 *plDebugAllocation
	receipt                    map[string]interface{}
}

func (e *plDebugNativeCompileEntry) snapshot() map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	result := make(map[string]interface{}, len(e.receipt)+2)
	for key, value := range e.receipt {
		result[key] = value
	}
	result["operationId"], result["releaseState"] = e.id, "unconfirmed"
	if e.allocation != nil {
		e.allocation.mu.Lock()
		if e.allocation.closed && !e.allocation.unknown {
			result["releaseState"] = "released"
		}
		e.allocation.mu.Unlock()
	}
	return result
}

func (e *plDebugNativeCompileEntry) update(values map[string]interface{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for key, value := range values {
		e.receipt[key] = value
	}
}

func (r *runtimeServer) nativeCompileUnresolvedLocked() bool {
	for _, entry := range r.plCompileEntries {
		value := entry.snapshot()
		if value["finished"] != true || value["releaseState"] != "released" || value["ddlState"] == "unknown" {
			return true
		}
	}
	return false
}

func (r *runtimeServer) nativeCompileStatus(params map[string]json.RawMessage) (interface{}, error) {
	r.mu.RLock()
	entry := r.plCompileEntries[stringParam(params, "operationId")]
	r.mu.RUnlock()
	if entry == nil || entry.agentSessionID != stringParam(params, "agentSessionId") {
		return nil, errors.New("the original compilation operation was not found")
	}
	return entry.snapshot(), nil
}

func (r *runtimeServer) compileNativeTarget(params map[string]json.RawMessage) (interface{}, error) {
	id, agentID := stringParam(params, "operationId"), stringParam(params, "agentSessionId")
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(id) || agentID == "" {
		return nil, errors.New("a stable compilation operationId and agentSessionId are required")
	}
	var targetFields map[string]json.RawMessage
	if err := json.Unmarshal(params["target"], &targetFields); err != nil || targetFields == nil {
		return nil, errors.New("an exact named compilation target is required")
	}
	if stringParam(targetFields, "metadataPreparation") == "debug_compile" {
		delete(targetFields, "metadataPreparation")
	}
	target, err := plDebugDecodeNativeStart(targetFields)
	if err != nil {
		return nil, err
	}
	var confirmed map[string]interface{}
	decoder := json.NewDecoder(bytes.NewReader(params["preview"]))
	decoder.UseNumber()
	if err := decoder.Decode(&confirmed); err != nil || confirmed == nil {
		return nil, errors.New("a confirmed compilation preview is required")
	}
	frozen, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	var content map[string]interface{}
	decoder = json.NewDecoder(bytes.NewReader(frozen))
	decoder.UseNumber()
	if err := decoder.Decode(&content); err != nil {
		return nil, err
	}
	frozen, err = json.Marshal(content)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	if existing := r.plCompileEntries[id]; existing != nil {
		r.mu.Unlock()
		if existing.agentSessionID != agentID || existing.frozen != string(frozen) {
			return nil, errors.New("compilation operationId conflicts with its original request")
		}
		return existing.snapshot(), nil
	}
	session := r.sessions[agentID]
	if session == nil || r.plMetadataBusy || len(r.plNativeEntries) != 0 || r.nativeCompileUnresolvedLocked() || len(r.plCompileEntries) >= 8 {
		r.mu.Unlock()
		return nil, errors.New("the original debugger or compilation must be resolved and released before compiling")
	}
	if !session.mu.TryLock() {
		r.mu.Unlock()
		return nil, errors.New("the original dedicated compilation connection is busy")
	}
	if session.server.plConnection == nil {
		session.mu.Unlock()
		r.mu.Unlock()
		return nil, errors.New("the original dedicated compilation connection is not ready")
	}
	entry := &plDebugNativeCompileEntry{id: id, agentSessionID: agentID, frozen: string(frozen), allocation: session.server.plAllocation,
		receipt: map[string]interface{}{"dispatched": false, "ddlState": "not_started", "finished": false}}
	if r.plCompileEntries == nil {
		r.plCompileEntries = map[string]*plDebugNativeCompileEntry{}
	}
	r.plCompileEntries[id] = entry
	r.plMetadataBusy = true
	r.mu.Unlock()
	defer func() { session.mu.Unlock(); r.mu.Lock(); r.plMetadataBusy = false; r.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	entry.execute(ctx, session.server.plConnection, target, confirmed)
	return entry.snapshot(), nil
}

func (e *plDebugNativeCompileEntry) execute(ctx context.Context, conn *sql.Conn, target plDebugNativeStart, confirmed map[string]interface{}) {
	defer e.update(map[string]interface{}{"finished": true})
	current, err := plDebugPreviewNativeCompile(ctx, conn, target)
	if err != nil {
		e.update(map[string]interface{}{"error": err.Error()})
		return
	}
	actual, err := json.Marshal(current)
	var canonical map[string]interface{}
	if err == nil {
		decoder := json.NewDecoder(bytes.NewReader(actual))
		decoder.UseNumber()
		err = decoder.Decode(&canonical)
	}
	if err != nil || current["canCompile"] != true || !reflect.DeepEqual(confirmed, canonical) {
		e.update(map[string]interface{}{"error": "the compilation target changed after confirmation; refresh its preview"})
		return
	}
	if err := ctx.Err(); err != nil {
		e.update(map[string]interface{}{"error": err.Error()})
		return
	}
	unit, err := plDebugNativeCompileTarget(current["schema"].(string), target)
	if err != nil {
		e.update(map[string]interface{}{"error": err.Error()})
		return
	}
	e.update(map[string]interface{}{"dispatched": true, "ddlState": "unknown"})
	if _, err := conn.ExecContext(ctx, unit.SQL); err != nil {
		state := "unknown"
		code := regexp.MustCompile(`ORA-[0-9]{5}\b`).FindString(err.Error())
		if ctx.Err() == nil {
			switch code {
			case "ORA-00900", "ORA-00904", "ORA-00942", "ORA-01031", "ORA-04043", "ORA-04063", "ORA-06550", "ORA-24344":
				state = "failed"
			}
		}
		e.update(map[string]interface{}{"ddlState": state, "ddlError": err.Error()})
		return
	}
	e.update(map[string]interface{}{"ddlState": "executed"})
	observed, err := plDebugNativeCompileReadback(ctx, conn, unit)
	if err != nil {
		e.update(map[string]interface{}{"readbackError": err.Error()})
	} else {
		e.update(map[string]interface{}{"readback": observed})
	}
}

func plDebugNativeCompileReadback(ctx context.Context, conn *sql.Conn, unit plDebugNativeCompileUnit) (map[string]interface{}, error) {
	result := map[string]interface{}{"status": "not_visible"}
	seen := false
	err := plDebugNativeRows(ctx, conn, "SELECT TO_CHAR(OBJECT_ID, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), STATUS FROM SYS.ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2 AND OBJECT_TYPE = :3", []interface{}{unit.Schema, unit.ObjectName, unit.ObjectType}, func(rows *sql.Rows) error {
		var id, status sql.NullString
		if err := rows.Scan(&id, &status); err != nil {
			return err
		}
		if seen || !id.Valid || id.String == "" {
			return errors.New("compilation readback has an incomplete or ambiguous object identity")
		}
		seen = true
		result["objectId"], result["status"] = id.String, plDebugNativeOptional(status)
		return nil
	})
	if err != nil {
		return nil, err
	}
	diagnostics := []map[string]interface{}{}
	countBytes := 0
	err = plDebugNativeRows(ctx, conn, "SELECT SEQUENCE, LINE, POSITION, TEXT, ATTRIBUTE, MESSAGE_NUMBER FROM SYS.ALL_ERRORS WHERE OWNER = :1 AND NAME = :2 AND TYPE = :3 ORDER BY SEQUENCE", []interface{}{unit.Schema, unit.ObjectName, unit.ObjectType}, func(rows *sql.Rows) error {
		values := make([]sql.NullString, 6)
		if err := rows.Scan(&values[0], &values[1], &values[2], &values[3], &values[4], &values[5]); err != nil {
			return err
		}
		diagnostic := map[string]interface{}{}
		for index, key := range []string{"sequence", "line", "position", "text", "attribute", "messageNumber"} {
			countBytes += len(values[index].String)
			diagnostic[key] = plDebugNativeOptional(values[index])
		}
		if len(diagnostics) >= 8192 || countBytes > 1048576 {
			return errors.New("compilation diagnostics exceeded the readback budget")
		}
		diagnostics = append(diagnostics, diagnostic)
		return ctx.Err()
	})
	result["diagnostics"], result["diagnosticsComplete"] = diagnostics, err == nil
	if err != nil {
		result["diagnosticsError"] = err.Error()
		return result, nil
	}
	settings, err := plDebugNativeCompileSettings(ctx, conn, unit)
	if err != nil {
		result["settingsError"] = err.Error()
	} else {
		result["settings"] = settings
	}
	return result, nil
}

func plDebugInspectNativeCompile(ctx context.Context, conn *sql.Conn, target plDebugNativeStart) (map[string]interface{}, error) {
	preview, err := plDebugPreviewNativeCompile(ctx, conn, target)
	if err != nil {
		return nil, err
	}
	unit, err := plDebugNativeCompileTarget(preview["schema"].(string), target)
	if err != nil {
		return nil, err
	}
	observation := map[string]interface{}{"schema": unit.Schema, "objectName": unit.ObjectName, "objectType": unit.ObjectType}
	if current, err := plDebugNativeCompileReadback(ctx, conn, unit); err != nil {
		observation["error"] = err.Error()
	} else {
		observation["readback"] = current
	}
	return map[string]interface{}{"compilePreview": preview, "compileObservation": observation}, nil
}

type plDebugNativeCompileUnit struct {
	Schema         string `json:"schema"`
	ObjectName     string `json:"objectName"`
	ObjectType     string `json:"objectType"`
	SQL            string `json:"sql"`
	ReusesSettings bool   `json:"reusesSettings"`
}

func plDebugNativeCompileTarget(owner string, target plDebugNativeStart) (plDebugNativeCompileUnit, error) {
	if owner == "" || target.ObjectName == "" || (target.ObjectType != "PROCEDURE" && target.ObjectType != "FUNCTION") {
		return plDebugNativeCompileUnit{}, errors.New("debug compilation requires an exact named procedure or function")
	}
	unit := plDebugNativeCompileUnit{Schema: owner, ObjectName: target.ObjectName, ObjectType: target.ObjectType, ReusesSettings: true}
	keyword, suffix := target.ObjectType, ""
	if target.PackageName != "" {
		unit.ObjectName, unit.ObjectType = target.PackageName, "PACKAGE BODY"
		keyword, suffix = "PACKAGE", " BODY"
	}
	unit.SQL = "ALTER " + keyword + " " + quoteIdentifier(owner) + "." + quoteIdentifier(unit.ObjectName) + " COMPILE DEBUG" + suffix + " REUSE SETTINGS"
	return unit, nil
}

func plDebugNativeCompileSettings(ctx context.Context, conn *sql.Conn, unit plDebugNativeCompileUnit) (map[string]interface{}, error) {
	result := map[string]interface{}{"state": "unknown", "reason": "not_visible"}
	seen := false
	err := plDebugNativeRows(ctx, conn, "SELECT PLSQL_DEBUG, PLSQL_OPTIMIZE_LEVEL FROM SYS.ALL_PLSQL_OBJECT_SETTINGS WHERE OWNER = :1 AND NAME = :2 AND TYPE = :3", []interface{}{unit.Schema, unit.ObjectName, unit.ObjectType}, func(rows *sql.Rows) error {
		if seen {
			return errors.New("debug compilation settings have an ambiguous object identity")
		}
		seen = true
		var debug, level sql.NullString
		if err := rows.Scan(&debug, &level); err != nil {
			return err
		}
		state := "unknown"
		if debug.Valid {
			switch strings.ToUpper(debug.String) {
			case "TRUE":
				state = "ready"
			case "FALSE":
				state = "requires_compile"
			}
		}
		result = map[string]interface{}{"state": state, "plsqlDebug": plDebugNativeOptional(debug), "optimizeLevel": plDebugNativeOptional(level)}
		return nil
	})
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		code := regexp.MustCompile(`ORA-([0-9]+)`).FindStringSubmatch(err.Error())
		if len(code) == 2 {
			number, _ := strconv.Atoi(code[1])
			if number == 942 || number == 1031 || number == 904 {
				return map[string]interface{}{"state": "unknown", "reason": "settings_unavailable", "vendorCode": number}, nil
			}
		}
		return nil, err
	}
	return result, nil
}

func plDebugNativeCompileSources(ctx context.Context, conn *sql.Conn, unit plDebugNativeCompileUnit) ([]plDebugNativeSource, error) {
	types := []string{unit.ObjectType}
	if unit.ObjectType == "PACKAGE BODY" {
		types = append(types, "PACKAGE")
	}
	budget := &plDebugNativeSourceBudget{bytes: 1048576, lines: 8192}
	sources := make([]plDebugNativeSource, 0, len(types))
	for _, kind := range types {
		var objectID string
		seen := false
		err := plDebugNativeRows(ctx, conn, "SELECT TO_CHAR(OBJECT_ID, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), STATUS FROM SYS.ALL_OBJECTS WHERE OWNER = :1 AND OBJECT_NAME = :2 AND OBJECT_TYPE = :3", []interface{}{unit.Schema, unit.ObjectName, kind}, func(rows *sql.Rows) error {
			var id, status sql.NullString
			if err := rows.Scan(&id, &status); err != nil {
				return err
			}
			if seen || !id.Valid || id.String == "" {
				return errors.New("debug compilation source has an incomplete or ambiguous object identity")
			}
			seen, objectID = true, id.String
			return nil
		})
		if err != nil {
			return nil, err
		}
		if !seen {
			sources = append(sources, plDebugNativeSource{Owner: unit.Schema, Name: unit.ObjectName, ObjectType: kind, State: "not_visible", Lines: []plDebugNativeSourceLine{}})
			continue
		}
		source, err := plDebugLoadNativeSourceBounded(ctx, conn, plDebugNativeCandidate{Schema: unit.Schema, ObjectName: unit.ObjectName, ObjectType: kind, ObjectID: objectID}, budget)
		if err != nil {
			return nil, err
		}
		sources = append(sources, source)
	}
	return sources, ctx.Err()
}

func plDebugPreviewNativeCompile(ctx context.Context, conn *sql.Conn, target plDebugNativeStart) (map[string]interface{}, error) {
	owner, err := plDebugNativeTargetOwner(ctx, conn, target.Schema)
	if err != nil {
		return nil, err
	}
	unit, err := plDebugNativeCompileTarget(owner, target)
	if err != nil {
		return nil, err
	}
	sources, err := plDebugNativeCompileSources(ctx, conn, unit)
	if err != nil {
		return nil, err
	}
	result := map[string]interface{}{"schema": unit.Schema, "objectName": unit.ObjectName, "objectType": unit.ObjectType, "sql": unit.SQL, "reusesSettings": unit.ReusesSettings, "sources": sources, "canCompile": false, "state": "source_unavailable"}
	for _, source := range sources {
		if source.State != "candidate" || source.Status == nil || (*source.Status != "VALID" && *source.Status != "INVALID") {
			return result, nil
		}
	}
	// This budget marker only bounds raw signatures; it never selects a VALID target or prepares types.
	target.Schema, target.MetadataPreparation = owner, "debug_compile"
	_, signatures, err := plDebugLoadNativeTargets(ctx, conn, target)
	if err != nil {
		return nil, err
	}
	settings, err := plDebugNativeCompileSettings(ctx, conn, unit)
	if err != nil {
		return nil, err
	}
	after, err := plDebugNativeCompileSources(ctx, conn, unit)
	if err != nil {
		return nil, err
	}
	_, afterSignatures, err := plDebugLoadNativeTargets(ctx, conn, target)
	if err != nil {
		return nil, err
	}
	if !reflect.DeepEqual(sources, after) || !reflect.DeepEqual(signatures, afterSignatures) {
		return nil, errors.New("the debug compilation target changed while preparing its preview")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result["signatures"], result["settings"], result["canCompile"], result["state"] = signatures, settings, true, "available"
	return result, nil
}
