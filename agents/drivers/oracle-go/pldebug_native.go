package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type plDebugNativeStop struct {
	Result           sql.NullInt64
	Line             sql.NullInt64
	Terminated       sql.NullInt64
	Breakpoint       sql.NullInt64
	StackDepth       sql.NullInt64
	InterpreterDepth sql.NullInt64
	Reason           sql.NullInt64
	Namespace        sql.NullInt64
	Program          sql.NullString
	Owner            sql.NullString
	DBLink           sql.NullString
	ProgramLine      sql.NullInt64
	LibUnitType      sql.NullInt64
	Entrypoint       sql.NullString
}

const plDebugNativeInfoMask = "SYS.DBMS_DEBUG.info_getStackDepth + SYS.DBMS_DEBUG.info_getLineinfo + SYS.DBMS_DEBUG.info_getBreakpoint"

func plDebugNativeControl(ctx context.Context, conn *sql.Conn, oci bool, routine string) (plDebugNativeStop, error) {
	var call string
	flags := map[string]string{
		procCntNextLine:       "SYS.DBMS_DEBUG.break_next_line",
		procCntNextBreakpoint: "SYS.DBMS_DEBUG.break_any_return",
		procCntStepIn:         "SYS.DBMS_DEBUG.break_any_call",
		procCntStepOut:        "SYS.DBMS_DEBUG.break_any_return",
		procCntAbort:          "SYS.DBMS_DEBUG.abort_execution",
		procCntException:      "SYS.DBMS_DEBUG.break_exception + SYS.DBMS_DEBUG.break_handler",
	}
	switch routine {
	case procSynchronize:
		call = "SYS.DBMS_DEBUG.SYNCHRONIZE(run_info, " + plDebugNativeInfoMask + ")"
	case procGetRuntimeInfo:
		call = "SYS.DBMS_DEBUG.GET_RUNTIME_INFO(" + plDebugNativeInfoMask + ", run_info)"
	default:
		flag, ok := flags[routine]
		if !ok {
			return plDebugNativeStop{}, fmt.Errorf("unknown native PL/SQL control action: %s", routine)
		}
		call = "SYS.DBMS_DEBUG.CONTINUE(run_info, " + flag + ", " + plDebugNativeInfoMask + ")"
	}
	query := `DECLARE
  run_info SYS.DBMS_DEBUG.runtime_info;
  result BINARY_INTEGER;
BEGIN
  result := ` + call + `;
  :1 := result;
  :2 := run_info.line#;
  :3 := run_info.terminated;
  :4 := run_info.breakpoint;
  :5 := run_info.stackdepth;
  :6 := run_info.interpreterdepth;
  :7 := run_info.reason;
  :8 := run_info.program.namespace;
  :9 := run_info.program.name;
  :10 := run_info.program.owner;
  :11 := run_info.program.dblink;
  :12 := run_info.program.line#;
  :13 := run_info.program.libunittype;
  :14 := run_info.program.entrypointname;
END;`
	stop := plDebugNativeStop{}
	args := plDebugOutArgs(oci, &stop.Result, &stop.Line, &stop.Terminated, &stop.Breakpoint, &stop.StackDepth, &stop.InterpreterDepth, &stop.Reason, &stop.Namespace, &stop.Program, &stop.Owner, &stop.DBLink, &stop.ProgramLine, &stop.LibUnitType, &stop.Entrypoint)
	_, err := conn.ExecContext(ctx, query, args...)
	if err != nil {
		return stop, err
	}
	if !stop.Result.Valid {
		return stop, errors.New("native PL/SQL control did not return its result code")
	}
	return stop, nil
}

func plDebugNativeInitialize(ctx context.Context, conn *sql.Conn, oci bool) (string, error) {
	var id sql.NullString
	_, err := conn.ExecContext(ctx, `BEGIN :1 := SYS.DBMS_DEBUG.INITIALIZE(); END;`, plDebugOutArg(oci, &id))
	if err != nil {
		return "", err
	}
	if !id.Valid || id.String == "" {
		return "", errors.New("native INITIALIZE returned no debug identifier; do not initialize again")
	}
	return id.String, nil
}

func plDebugNativeEnable(ctx context.Context, conn *sql.Conn, oci bool) error {
	var timeout, behaviour sql.NullInt64
	_, err := conn.ExecContext(ctx, `BEGIN
  SYS.DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR(SYS.DBMS_DEBUG.abort_on_timeout);
  :1 := SYS.DBMS_DEBUG.SET_TIMEOUT(:2);
  :3 := SYS.DBMS_DEBUG.GET_TIMEOUT_BEHAVIOUR();
  SYS.DBMS_OUTPUT.ENABLE(NULL);
  SYS.DBMS_DEBUG.DEBUG_ON;
END;`, plDebugOutArg(oci, &timeout), plDebugServerTimeoutSeconds, plDebugOutArg(oci, &behaviour))
	if err != nil {
		return err
	}
	if !timeout.Valid || timeout.Int64 != plDebugServerTimeoutSeconds || !behaviour.Valid || behaviour.Int64 != 3 {
		return errors.New("native debug timeout policy could not be confirmed")
	}
	return nil
}
