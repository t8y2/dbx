package main

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"
)

// PL/SQL debugging over Oracle's DBMS_DEBUG package, implemented for pure
// Oracle connections the same way the oceanbase-oracle Java agent does it for
// OceanBase Oracle tenants: two dedicated sessions (debuggee + debugger), a
// per-schema helper package (DBX_PL_DEBUG_PACKAGE) that wraps the DBMS_DEBUG
// primitives with OUT registers, and the same request flow:
//
//	debuggee: SET_TIMEOUT_BEHAVIOUR -> INITIALIZE -> DEBUG_ON -> run target
//	debugger: ATTACH_SESSION(id) -> breakpoints -> continue/step -> values
//
// The helper package DDL matches the Java agent's definition (same package
// name, same routine signatures) so both agents can coexist on the same
// schema and reuse whichever copy was installed first.

const (
	plDebugPackageName   = "DBX_PL_DEBUG_PACKAGE"
	plDebugTimeoutMillis = int64(10 * 60 * 1000)
	plDebugOpenTimeout   = 20 * time.Second
)

const (
	procSetBreakpoint          = "DBX_SET_BREAKPOINT"
	procSetBreakpointAnonymous = "DBX_SET_BREAKPOINT_ANONYMOUS"
	procShowBreakpoints        = "DBX_SHOW_BREAKPOINTS"
	procPrintBacktrace         = "DBX_PRINT_BACKTRACE"
	procCntNextLine            = "DBX_CNT_NEXT_LINE"
	procCntNextBreakpoint      = "DBX_CNT_NEXT_BREAKPOINT"
	procCntStepIn              = "DBX_CNT_STEP_IN"
	procCntAbort               = "DBX_CNT_ABORT"
	procCntStepOut             = "DBX_CNT_STEP_OUT"
	procGetValues              = "DBX_GET_VALUES"
	procGetValue               = "DBX_GET_VALUE"
	procGetRuntimeInfo         = "DBX_GET_RUNTIME_INFO"
	procSynchronize            = "DBX_SYNCHRONIZE"
	procGetLine                = "DBX_GET_LINE"
)

const runInfoMessage = `message := ' breakpoint = ' || run_info.breakpoint` +
	` || ', stackdepth = ' || run_info.stackdepth` +
	` || ', reason = ' || run_info.reason` +
	` || ', line = ' || run_info."line#"` +
	` || ', programname = ' || run_info.program.name` +
	` || ', programowner = ' || run_info.program.owner;`

const plDebugPackageHeadDDL = `CREATE OR REPLACE PACKAGE "%[1]s".` + plDebugPackageName + ` AS
 PROCEDURE ` + procSetBreakpoint + `(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSetBreakpointAnonymous + `(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procShowBreakpoints + `(listing in out varchar2);` +
	` PROCEDURE ` + procPrintBacktrace + `(listing IN OUT VARCHAR, status OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procCntNextLine + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntNextBreakpoint + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntStepIn + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntAbort + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procCntStepOut + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procGetValues + `(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procGetValue + `(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procGetRuntimeInfo + `(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER);` +
	` PROCEDURE ` + procSynchronize + `(result OUT BINARY_INTEGER, message OUT VARCHAR2);` +
	` PROCEDURE ` + procGetLine + `(line OUT VARCHAR2, status OUT INTEGER);` +
	`END ` + plDebugPackageName + `;`

const plDebugPackageBodyDDL = `CREATE OR REPLACE PACKAGE BODY "%[1]s".` + plDebugPackageName + ` AS
-- DBX PL Debug Package Version: V1

PROCEDURE ` + procSetBreakpoint + `(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS pro_info dbms_debug.program_info; BEGIN pro_info.name := name; pro_info.owner := owner; result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#); END;

PROCEDURE ` + procSetBreakpointAnonymous + `(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info); result := dbms_debug.set_breakpoint(run_info.program, line#, breakpoint#); END;

PROCEDURE ` + procShowBreakpoints + `(listing in out varchar2) IS BEGIN dbms_debug.show_breakpoints(listing); END;

PROCEDURE ` + procPrintBacktrace + `(listing IN OUT VARCHAR, status OUT BINARY_INTEGER) IS run_info dbms_debug.runtime_info; result BINARY_INTEGER; BEGIN result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info); status := run_info.terminated; dbms_debug.print_backtrace(listing); END;

PROCEDURE ` + procCntNextLine + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_next_line); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntNextBreakpoint + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_any_return); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntStepIn + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_any_call); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntAbort + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.abort_execution); ` + runInfoMessage + ` END;

PROCEDURE ` + procCntStepOut + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.continue(run_info, dbms_debug.break_any_return); ` + runInfoMessage + ` END;

PROCEDURE ` + procGetValues + `(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER) IS BEGIN result := dbms_debug.get_values(scalar_values); END;

PROCEDURE ` + procGetValue + `(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER) IS BEGIN result := dbms_debug.get_value(variable_name, frame#, value); END;

PROCEDURE ` + procGetRuntimeInfo + `(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info); status := run_info.terminated; END;

PROCEDURE ` + procSynchronize + `(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS run_info dbms_debug.runtime_info; BEGIN result := dbms_debug.synchronize(run_info, dbms_debug.info_getLineinfo); ` + runInfoMessage + ` END;

PROCEDURE ` + procGetLine + `(line OUT VARCHAR2, status OUT INTEGER) IS log VARCHAR2(32767) := ''; fetched VARCHAR2(32767); BEGIN <<label>> loop dbms_output.get_line(fetched, status); if status = 1 then exit label; else log := log || chr(10) || fetched; end if; end loop label; line := log; END;

END ` + plDebugPackageName + `;`

type plDebugBreakpoint struct {
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	Line          int    `json:"line"`
	BreakpointNbr int    `json:"breakpointNumber"`
	Kind          string `json:"kind"`
}

type plDebugSession struct {
	mu                 sync.Mutex
	debugID            string
	owner              string
	debuggee           *sql.DB
	debugger           *sql.DB
	breakpoints        []plDebugBreakpoint
	terminated         bool
	closed             bool
	targetErr          string
	lastMessage        string
	lastBreakpoint     int
	lastStackDepth     int
	lastReason         int
	lastLine           int
	lastProgram        string
	lastProgramOwner   string
	lastActivityMillis int64
}

// plDebugOpenConfigured opens a dedicated single-connection pool so
// DBMS_DEBUG state stays pinned to one physical session.
func plDebugOpenConfigured(s *server) (*sql.DB, error) {
	db, err := openConfiguredSessionDB(s.params, plDebugOpenTimeout)
	if err != nil {
		return nil, err
	}
	// One physical session per pool: DBMS_DEBUG binds breakpoints and the
	// interpreter state to the session, so pooling would corrupt debugging.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func plDebugEnsureHelperPackage(db *sql.DB, owner string) error {
	quotedOwner := fmt.Sprintf(`"%s"`, owner)
	if _, err := db.Exec(fmt.Sprintf(plDebugPackageHeadDDL, quotedOwner)); err != nil {
		return fmt.Errorf("create %s head failed: %w", plDebugPackageName, err)
	}
	if _, err := db.Exec(fmt.Sprintf(plDebugPackageBodyDDL, quotedOwner)); err != nil {
		return fmt.Errorf("create %s body failed: %w", plDebugPackageName, err)
	}
	return nil
}

// plDebugStart runs the full start sequence on the given connections and
// returns the session handle. The caller owns both connections afterwards
// (the session closes them on Close).
func plDebugStart(s *server, debuggee, debugger *sql.DB, request map[string]interface{}) (*plDebugSession, error) {
	owner := strings.ToUpper(strings.TrimSpace(stringField(request, "schema")))
	if owner == "" {
		if err := debuggee.QueryRow("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL").Scan(&owner); err != nil {
			return nil, err
		}
		owner = strings.ToUpper(strings.TrimSpace(owner))
	}
	if err := plDebugEnsureHelperPackage(debuggee, owner); err != nil {
		return nil, err
	}

	session := &plDebugSession{
		owner:              owner,
		debuggee:           debuggee,
		debugger:           debugger,
		lastActivityMillis: nowMillis(),
	}

	var debugID string
	if err := debuggee.QueryRow("SELECT DBMS_DEBUG.INITIALIZE() FROM DUAL").Scan(&debugID); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.INITIALIZE failed: %w", err)
	}
	session.debugID = strings.TrimSpace(debugID)

	if _, err := debuggee.Exec("CALL DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR(2)"); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR failed: %w", err)
	}
	if _, err := debuggee.Exec("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;"); err != nil {
		return nil, fmt.Errorf("DBMS_OUTPUT.ENABLE failed: %w", err)
	}
	if _, err := debuggee.Exec("CALL DBMS_DEBUG.DEBUG_ON()"); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.DEBUG_ON failed: %w", err)
	}
	if _, err := debugger.Exec(fmt.Sprintf("CALL DBMS_DEBUG.ATTACH_SESSION('%s')", session.debugID)); err != nil {
		return nil, fmt.Errorf("DBMS_DEBUG.ATTACH_SESSION failed: %w", err)
	}

	// The target program blocks on its first line waiting for the debugger;
	// run it on its own goroutine and drive it through the debugger session.
	go session.runTarget(request)
	return session, nil
}

func (s *server) plDebugSession(debugID string) (*plDebugSession, error) {
	s.plDebugMu.Lock()
	session, ok := s.plDebugSessions[debugID]
	s.plDebugMu.Unlock()
	if !ok {
		return nil, fmt.Errorf("PL debug session not found: %s", debugID)
	}
	if session.expired() {
		s.closePlDebugSession(debugID)
		return nil, fmt.Errorf("PL debug session timed out: %s", debugID)
	}
	return session, nil
}

func (s *server) closePlDebugSession(debugID string) {
	s.plDebugMu.Lock()
	session, ok := s.plDebugSessions[debugID]
	if ok {
		delete(s.plDebugSessions, debugID)
	}
	s.plDebugMu.Unlock()
	if ok {
		_ = session.Close()
	}
}

// -- session operations ------------------------------------------------------

// setBreakpoints creates the requested source breakpoints and returns them
// with the server-assigned breakpoint numbers.
func (p *plDebugSession) setBreakpoints(requested []plDebugBreakpoint) ([]plDebugBreakpoint, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return nil, fmt.Errorf("debuggee has finished")
	}
	created := make([]plDebugBreakpoint, 0, len(requested))
	for _, requestedBreakpoint := range requested {
		if requestedBreakpoint.Line <= 0 {
			continue
		}
		kind := strings.ToUpper(strings.TrimSpace(requestedBreakpoint.Kind))
		var breakpointNumber, result int
		var err error
		if kind == "ANONYMOUS" {
			err = p.debugger.QueryRow(
				fmt.Sprintf(`BEGIN %s."%s"(:1, :2, :3); END;`, plDebugQualifiedPrefix(p.owner), procSetBreakpointAnonymous),
				requestedBreakpoint.Line,
				sql.Out{Dest: &breakpointNumber},
				sql.Out{Dest: &result},
			).Scan(&breakpointNumber, &result)
		} else {
			breakpointOwner := strings.ToUpper(strings.TrimSpace(requestedBreakpoint.Owner))
			if breakpointOwner == "" {
				breakpointOwner = p.owner
			}
			breakpointName := strings.ToUpper(strings.TrimSpace(requestedBreakpoint.Name))
			err = p.debugger.QueryRow(
				fmt.Sprintf(`BEGIN %s."%s"(:1, :2, :3, :4, :5); END;`, plDebugQualifiedPrefix(p.owner), procSetBreakpoint),
				breakpointOwner,
				breakpointName,
				requestedBreakpoint.Line,
				sql.Out{Dest: &breakpointNumber},
				sql.Out{Dest: &result},
			).Scan(&breakpointNumber, &result)
		}
		if err != nil {
			return nil, fmt.Errorf("set breakpoint at line %d failed: %w", requestedBreakpoint.Line, err)
		}
		if result != 0 {
			return nil, fmt.Errorf("set breakpoint at line %d failed: result=%d", requestedBreakpoint.Line, result)
		}
		kindValue := kind
		if kindValue == "" {
			kindValue = "PROCEDURE"
		}
		createdBreakpoint := plDebugBreakpoint{
			Owner:         requestedBreakpoint.Owner,
			Name:          requestedBreakpoint.Name,
			Line:          requestedBreakpoint.Line,
			BreakpointNbr: breakpointNumber,
			Kind:          kindValue,
		}
		p.breakpoints = append(p.breakpoints, createdBreakpoint)
		created = append(created, createdBreakpoint)
	}
	p.touch()
	return created, nil
}

func (p *plDebugSession) deleteBreakpoints(requested []plDebugBreakpoint) ([]plDebugBreakpoint, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	removed := make([]plDebugBreakpoint, 0, len(requested))
	for _, requestedBreakpoint := range requested {
		if requestedBreakpoint.BreakpointNbr <= 0 {
			continue
		}
		if _, err := p.debugger.Exec("CALL DBMS_DEBUG.DELETE_BREAKPOINT(?)", requestedBreakpoint.BreakpointNbr); err != nil {
			return nil, fmt.Errorf("delete breakpoint %d failed: %w", requestedBreakpoint.BreakpointNbr, err)
		}
		kept := p.breakpoints[:0]
		for _, stored := range p.breakpoints {
			if stored.BreakpointNbr != requestedBreakpoint.BreakpointNbr {
				kept = append(kept, stored)
			}
		}
		p.breakpoints = kept
		removed = append(removed, requestedBreakpoint)
	}
	p.touch()
	return removed, nil
}

func (p *plDebugSession) listBreakpoints() []plDebugBreakpoint {
	p.mu.Lock()
	defer p.mu.Unlock()
	list := make([]plDebugBreakpoint, len(p.breakpoints))
	copy(list, p.breakpoints)
	return list
}

// continueWith runs one of the CNT_* helpers. It blocks until the debuggee
// stops again (breakpoint / new line / return) or finishes.
func (p *plDebugSession) continueWith(procedure string) (map[string]interface{}, error) {
	p.mu.Lock()
	if p.terminated {
		p.mu.Unlock()
		return p.snapshot("debuggee has finished"), nil
	}
	p.mu.Unlock()

	var result int
	var message string
	err := p.debugger.QueryRow(
		fmt.Sprintf(`BEGIN %s."%s"(:1, :2); END;`, plDebugQualifiedPrefix(p.owner), procedure),
		sql.Out{Dest: &result},
		sql.Out{Dest: &message},
	).Scan(&result, &message)
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", procedure, err)
	}

	p.mu.Lock()
	p.applyRunInfoMessage(message)
	// reason 8 = finish, 15 = exit, 21 = abort: the program is done.
	if p.lastReason == 8 || p.lastReason == 15 || p.lastReason == 21 {
		p.terminated = true
	}
	if result != 0 {
		p.targetErr = fmt.Sprintf("%s failed: result=%d", procedure, result)
	}
	p.touch()
	response := p.snapshot(message)
	p.mu.Unlock()
	return response, nil
}

func (p *plDebugSession) abort() (map[string]interface{}, error) {
	return p.continueWith(procCntAbort)
}

// variables returns the raw scalar_values payload; format parsing (JSON for
// OceanBase, `*name*type*value` delimited text for Oracle) happens on the
// Rust side so both agents share one presentation path.
func (p *plDebugSession) variables() (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	response := p.snapshot("")
	if p.terminated {
		response["scalarValues"] = ""
		return response, nil
	}
	var scalarValues string
	var result int
	err := p.debugger.QueryRow(
		fmt.Sprintf(`BEGIN %s."%s"(:1, :2); END;`, plDebugQualifiedPrefix(p.owner), procGetValues),
		sql.Out{Dest: &scalarValues},
		sql.Out{Dest: &result},
	).Scan(&scalarValues, &result)
	if err != nil {
		return nil, fmt.Errorf("get_values failed: %w", err)
	}
	if result != 0 {
		return nil, fmt.Errorf("get_values failed: result=%d", result)
	}
	p.touch()
	response["scalarValues"] = scalarValues
	return response, nil
}

func (p *plDebugSession) stack() (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	response := p.snapshot("")
	if p.terminated {
		response["backtrace"] = ""
		return response, nil
	}
	var listing string
	var status int
	err := p.debugger.QueryRow(
		fmt.Sprintf(`BEGIN %s."%s"(:1, :2); END;`, plDebugQualifiedPrefix(p.owner), procPrintBacktrace),
		sql.Out{Dest: &listing},
		sql.Out{Dest: &status},
	).Scan(&listing, &status)
	if err != nil {
		return nil, fmt.Errorf("print_backtrace failed: %w", err)
	}
	p.touch()
	response["backtrace"] = listing
	response["dbmsStatus"] = status
	return response, nil
}

// log reads DBMS_OUTPUT from the debuggee connection; it is only readable
// after the interpreter released it (program finished or debug turned off).
func (p *plDebugSession) log() (map[string]interface{}, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	response := p.snapshot("")
	if !p.terminated {
		response["output"] = ""
		return response, nil
	}
	var line string
	var status int
	outputBuilder := &strings.Builder{}
	for {
		err := p.debuggee.QueryRow(
			fmt.Sprintf(`BEGIN %s."%s"(:1, :2); END;`, plDebugQualifiedPrefix(p.owner), procGetLine),
			sql.Out{Dest: &line},
			sql.Out{Dest: &status},
		).Scan(&line, &status)
		if err != nil || status == 1 {
			break
		}
		outputBuilder.WriteString(line)
		outputBuilder.WriteString("\n")
	}
	response["output"] = outputBuilder.String()
	return response, nil
}

// Close aborts a still-parked debuggee (best effort), turns debugging off and
// releases both sessions.
func (p *plDebugSession) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	terminated := p.terminated
	p.mu.Unlock()

	if !terminated {
		var abortedResult int
		var abortedMessage string
		_, _ = p.debugger.Exec(
			fmt.Sprintf(`BEGIN %s."%s"(:1, :2); END;`, plDebugQualifiedPrefix(p.owner), procCntAbort),
			sql.Out{Dest: &abortedResult},
			sql.Out{Dest: &abortedMessage},
		)
	}
	_, _ = p.debuggee.Exec("CALL DBMS_DEBUG.DEBUG_OFF()")
	_ = p.debugger.Close()
	_ = p.debuggee.Close()
	return nil
}

// -- helpers -----------------------------------------------------------------

// runTarget executes the debugging target on the debuggee connection. The
// statement blocks until the debugger drives the program to completion (or
// abort), so this runs on its own goroutine.
func (p *plDebugSession) runTarget(request map[string]interface{}) {
	defer func() {
		p.mu.Lock()
		p.terminated = true
		p.mu.Unlock()
		_, _ = p.debuggee.Exec("CALL DBMS_DEBUG.DEBUG_OFF()")
	}()

	objectType := strings.ToUpper(strings.TrimSpace(stringField(request, "objectType")))
	if objectType == "ANONYMOUS" {
		source := stripTrailingSlash(stringField(request, "source"))
		if _, err := p.debuggee.Exec(source); err != nil {
			p.mu.Lock()
			p.targetErr = err.Error()
			p.mu.Unlock()
		}
		return
	}
	routine, params, isFunction, routineErr := plDebugTargetRoutine(p.owner, request)
	if routineErr != nil {
		p.mu.Lock()
		p.targetErr = routineErr.Error()
		p.mu.Unlock()
		return
	}
	var block strings.Builder
	block.WriteString("BEGIN ")
	if isFunction {
		block.WriteString(":result := ")
	}
	block.WriteString(routine)
	block.WriteString("(")
	for index := range params {
		if index > 0 {
			block.WriteString(", ")
		}
		block.WriteString(fmt.Sprintf(":p%d", index+1))
	}
	block.WriteString("); END;")

	var resultValue string
	args := make([]interface{}, 0, len(params)+1)
	if isFunction {
		args = append(args, sql.Out{Dest: &resultValue})
	}
	for _, param := range params {
		args = append(args, param.value)
	}
	if _, err := p.debuggee.Exec(block.String(), args...); err != nil {
		p.mu.Lock()
		p.targetErr = err.Error()
		p.mu.Unlock()
	}
}

// plDebugTargetRoutine resolves the qualified routine name and its bound
// parameters for the debuggee call.
func plDebugTargetRoutine(owner string, request map[string]interface{}) (string, []interface{}, bool, error) {
	objectType := strings.ToUpper(strings.TrimSpace(stringField(request, "objectType")))
	packageName := strings.ToUpper(strings.TrimSpace(stringField(request, "packageName")))
	objectName := strings.ToUpper(strings.TrimSpace(stringField(request, "objectName")))
	if objectName == "" {
		return "", nil, false, fmt.Errorf("object name is required")
	}
	var routine string
	if packageName != "" {
		routine = fmt.Sprintf(`"%s"."%s"."%s"`, owner, packageName, objectName)
	} else {
		routine = fmt.Sprintf(`"%s"."%s"`, owner, objectName)
	}
	var rawParams []plDebugParam
	if raw, ok := request["params"]; ok && raw != nil {
		if decoded, ok := raw.([]interface{}); ok {
			for _, item := range decoded {
				if paramMap, ok := item.(map[string]interface{}); ok {
					rawParams = append(rawParams, plDebugParam{
						Name:  stringField(paramMap, "name"),
						Mode:  stringField(paramMap, "mode"),
						Type:  stringField(paramMap, "type"),
						Value: stringField(paramMap, "value"),
					})
				}
			}
		}
	}
	args := make([]interface{}, 0, len(rawParams))
	for _, param := range rawParams {
		mode := strings.ToUpper(strings.TrimSpace(param.Mode))
		if mode == "OUT" {
			args = append(args, sql.Out{Dest: new(string)})
			continue
		}
		args = append(args, param.Value)
	}
	return routine, args, objectType == "FUNCTION", nil
}

func (p *plDebugSession) snapshot(message string) map[string]interface{} {
	response := map[string]interface{}{
		"debugId":      p.debugID,
		"owner":        p.owner,
		"terminated":   p.terminated,
		"line":         p.lastLine,
		"program":      p.lastProgram,
		"programOwner": p.lastProgramOwner,
		"breakpoint":   p.lastBreakpoint,
		"reason":       p.lastReason,
		"stackDepth":   p.lastStackDepth,
		"error":        p.targetErr,
		"expired":      p.expired(),
	}
	if message != "" {
		response["message"] = message
	}
	return response
}

func (p *plDebugSession) applyRunInfoMessage(message string) {
	// message shape (from the helper package):
	// " breakpoint = N, stackdepth = N, reason = N, line = N, programname = X, programowner = Y"
	const prefix = " breakpoint = "
	if !strings.HasPrefix(message, prefix) {
		return
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(message, prefix), ", ") {
		if key, value, ok := strings.Cut(part, " = "); ok {
			fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	p.lastBreakpoint = atoiOrZero(fields["breakpoint"])
	p.lastStackDepth = atoiOrZero(fields["stackdepth"])
	p.lastReason = atoiOrZero(fields["reason"])
	p.lastLine = atoiOrZero(fields["line"])
	p.lastProgram = fields["programname"]
	p.lastProgramOwner = fields["programowner"]
}

func (p *plDebugSession) touch() {
	p.lastActivityMillis = nowMillis()
}

func (p *plDebugSession) expired() bool {
	return nowMillis()-p.lastActivityMillis > plDebugTimeoutMillis
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func atoiOrZero(value string) int {
	parsed := 0
	_, _ = fmt.Sscanf(value, "%d", &parsed)
	return parsed
}

func plDebugQualifiedPrefix(owner string) string {
	return fmt.Sprintf(`"%s"."%s"`, owner, plDebugPackageName)
}

/** JDBC chokes on a client-style trailing slash after an anonymous block. */
func stripTrailingSlash(sqlText string) string {
	trimmed := strings.TrimSpace(sqlText)
	for strings.HasSuffix(trimmed, "/") {
		trimmed = strings.TrimSpace(strings.TrimSuffix(trimmed, "/"))
	}
	return trimmed
}
