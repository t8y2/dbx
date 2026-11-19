package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"runtime/debug"
	"strings"
)

const plDebugNativeProbeSQL = `DECLARE
  p SYS.DBMS_DEBUG.program_info;
  r SYS.DBMS_DEBUG.runtime_info;
  frames SYS.DBMS_DEBUG.backtrace_table;
  major_version BINARY_INTEGER;
  minor_version BINARY_INTEGER;
BEGIN
  IF FALSE THEN
    p.namespace := 1; p.name := NULL; p.owner := NULL;
    r.terminated := 0; frames(1) := p;
  END IF;
  SYS.DBMS_DEBUG.PROBE_VERSION(major_version, minor_version);
  :1 := major_version; :2 := minor_version;
END;`

var plDebugNativeRequired = []string{"INITIALIZE", "ATTACH_SESSION", "DETACH_SESSION", "DEBUG_ON", "DEBUG_OFF", "SET_TIMEOUT_BEHAVIOUR", "SYNCHRONIZE", "CONTINUE", "SET_BREAKPOINT"}

func plDebugProbeErrorState(err error) string {
	if strings.Contains(err.Error(), "ORA-01031") {
		return "permission_denied"
	}
	return "error"
}

func plDebugProbeNames(ctx context.Context, conn *sql.Conn, query string, args ...any) ([]string, error) {
	rows, err := conn.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return names, nil
}

func (s *server) plDebugProbe() map[string]interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	conn := s.plConnection
	if conn == nil && s.db != nil {
		var err error
		conn, err = s.db.Conn(ctx)
		if err != nil {
			result := s.plDebugProbeOnConnection(ctx, nil)
			result["reason"] = err.Error()
			return result
		}
		defer conn.Close()
	}
	return s.plDebugProbeOnConnection(ctx, conn)
}

func (s *server) plDebugInspect(params map[string]json.RawMessage) (interface{}, error) {
	var target *plDebugNativeStart
	if raw, ok := params["target"]; ok && strings.TrimSpace(string(raw)) != "null" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, errors.New("target must be an object")
		}
		request, err := plDebugDecodeNativeStart(fields)
		if err != nil {
			return nil, err
		}
		target = &request
	}
	if target != nil && target.MetadataPreparation != "" {
		return nil, errors.New("typed Oracle metadata preparation requires its dedicated PL/SQL channel")
	}
	if s.db == nil {
		return nil, errors.New("debug inspection requires a connected metadata session")
	}
	ctx, cancel := context.WithTimeout(context.Background(), plDebugCallTimeout)
	defer cancel()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	result := map[string]interface{}{"capabilities": s.plDebugProbeOnConnection(ctx, conn)}
	if target != nil {
		preview, err := plDebugPreviewNativeTarget(ctx, conn, *target, usesOCIProfile(s.params))
		if err != nil {
			return nil, err
		}
		result["targetPreview"] = preview
	}
	return result, nil
}

func (s *server) plDebugProbeOnConnection(ctx context.Context, conn *sql.Conn) map[string]interface{} {
	result := map[string]interface{}{"engine": "oracle", "supported": false, "canAttemptStart": false, "startVerified": false, "status": "unknown", "engineVersion": nil, "driverVersion": nil, "warnings": []string{}}
	if conn == nil {
		result["reason"] = "Native discovery requires a connected metadata or dedicated PL/SQL session"
		return result
	}
	query := "SELECT DISTINCT PROCEDURE_NAME FROM SYS.ALL_PROCEDURES WHERE OWNER = 'SYS' AND OBJECT_NAME = :1 AND PROCEDURE_NAME IS NOT NULL ORDER BY PROCEDURE_NAME"
	methods, catalogErr := plDebugProbeNames(ctx, conn, query, "DBMS_DEBUG")
	output, outputErr := plDebugProbeNames(ctx, conn, query, "DBMS_OUTPUT")
	seen := map[string]bool{}
	for _, name := range methods {
		seen[name] = true
	}
	visible := catalogErr == nil && len(methods) > 0
	missing := []string{}
	if visible {
		for _, name := range plDebugNativeRequired {
			if !seen[name] {
				missing = append(missing, name)
			}
		}
	}
	result["procedures"], result["missingProcedures"] = methods, missing
	result["catalogStatus"] = "unknown"
	if visible {
		result["catalogStatus"] = "supported"
	} else if catalogErr != nil {
		result["catalogStatus"] = plDebugProbeErrorState(catalogErr)
		result["catalogError"] = catalogErr.Error()
	}
	result["dbmsDebug"] = visible
	result["variablesSupported"] = seen["GET_VALUE"]
	if seen["GET_VALUE"] {
		result["variablesFallback"] = "get_value"
	}
	capabilities := map[string]interface{}{}
	groups := map[string][]string{"control": plDebugNativeRequired, "breakpoints": {"SET_BREAKPOINT", "DELETE_BREAKPOINT", "ENABLE_BREAKPOINT", "DISABLE_BREAKPOINT"}, "exceptions": {"CONTINUE"}, "variables": {"GET_VALUE"}, "getValue": {"GET_VALUE"}, "setValue": {"SET_VALUE"}, "stack": {"PRINT_BACKTRACE"}, "execute": {"EXECUTE"}}
	for feature, names := range groups {
		declared := true
		for _, name := range names {
			declared = declared && seen[name]
		}
		status := "unknown"
		if visible && !declared {
			status = "unsupported"
		}
		var declaration interface{}
		if visible {
			declaration = declared
		}
		capabilities[feature] = map[string]interface{}{"status": status, "declared": declaration, "canAttempt": declared, "verified": false}
	}
	outputSeen := map[string]bool{}
	for _, name := range output {
		outputSeen[name] = true
	}
	outputVisible := outputErr == nil && len(output) > 0
	outputDeclared := outputSeen["ENABLE"] && outputSeen["GET_LINE"]
	outputStatus := "unknown"
	if outputVisible && !outputDeclared {
		outputStatus = "unsupported"
	}
	if outputErr != nil {
		outputStatus = plDebugProbeErrorState(outputErr)
	}
	capabilities["output"] = map[string]interface{}{"status": outputStatus, "canAttempt": outputDeclared, "verified": false}
	result["capabilities"], result["dbmsOutput"] = capabilities, interface{}(nil)
	if outputVisible {
		result["dbmsOutput"] = outputDeclared
	}
	if outputErr != nil {
		result["outputError"] = outputErr.Error()
	}
	privileges, privilegeErr := plDebugProbeNames(ctx, conn, "SELECT PRIVILEGE FROM SESSION_PRIVS")
	privilegeSeen := map[string]bool{}
	for _, name := range privileges {
		privilegeSeen[name] = true
	}
	warnings := []string{}
	if privilegeErr != nil {
		warnings = append(warnings, "SESSION_PRIVS could not be read; target privileges remain unverified")
		result["privilegeStatus"] = plDebugProbeErrorState(privilegeErr)
	} else {
		result["privilegeStatus"] = "supported"
		if !privilegeSeen["DEBUG ANY PROCEDURE"] {
			warnings = append(warnings, "Cross-schema targets require their effective DEBUG privilege or DEBUG ANY PROCEDURE")
		}
	}
	result["warnings"] = warnings
	major, minor := -1, -1
	_, shapeErr := conn.ExecContext(ctx, plDebugNativeProbeSQL, plDebugOutArgs(usesOCIProfile(s.params), &major, &minor)...)
	if shapeErr == nil && (major < 0 || minor < 0) {
		shapeErr = errors.New("PROBE_VERSION did not return a complete native version")
	}
	shape := map[string]interface{}{"status": "supported", "major": major, "minor": minor}
	if shapeErr != nil {
		shape = map[string]interface{}{"status": plDebugProbeErrorState(shapeErr), "message": shapeErr.Error()}
	}
	result["nativeShape"] = shape
	canAttempt := shapeErr == nil && len(missing) == 0 && !(outputVisible && !outputDeclared)
	result["reason"] = "Native call shape verified; target execution is checked when starting"
	if len(missing) > 0 {
		result["status"] = "unsupported"
		result["reason"] = "DBMS_DEBUG is missing required methods: " + strings.Join(missing, ", ")
	} else if shapeErr != nil {
		result["status"] = plDebugProbeErrorState(shapeErr)
		result["reason"] = "Native call shape could not be verified: " + shapeErr.Error()
	} else if outputVisible && !outputDeclared {
		result["status"] = "unsupported"
		result["reason"] = "The visible DBMS_OUTPUT package must declare ENABLE and GET_LINE"
	}
	if privilegeErr == nil && !privilegeSeen["DEBUG CONNECT SESSION"] {
		canAttempt = false
		result["status"] = "permission_denied"
		result["reason"] = "The current session does not report DEBUG CONNECT SESSION; review the effective debugging privileges"
	}
	result["supported"], result["canAttemptStart"] = canAttempt, canAttempt
	for _, versionQuery := range oracleDatabaseVersionQueries {
		if ctx.Err() != nil {
			break
		}
		var version string
		if err := conn.QueryRowContext(ctx, versionQuery).Scan(&version); err == nil {
			result["engineVersion"] = version
			break
		} else {
			result["versionError"] = err.Error()
		}
	}
	module := "github.com/sijms/go-ora/v2"
	if usesOCIProfile(s.params) {
		module = "github.com/godror/godror"
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == module {
				result["driverVersion"] = dep.Version
				break
			}
		}
	}
	return result
}
