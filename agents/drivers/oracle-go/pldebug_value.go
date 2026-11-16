package main

import (
	"context"
	"database/sql"
	"errors"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugNativeValue struct {
	Result sql.NullInt64
	Value  sql.NullString
}

var errPLDebugNativeValueResultMissing = errors.New("native GET_VALUE did not return its result code")
var errPLDebugNativeSetResultMissing = errors.New("native SET_VALUE did not return its result code; do not replay the assignment")

func plDebugNativeGetValue(ctx context.Context, conn *sql.Conn, oci bool, variable string, nativeFrame int) (plDebugNativeValue, error) {
	value := plDebugNativeValue{}
	var valueOut interface{} = sql.Out{Dest: &value.Value}
	if !oci {
		valueOut = go_ora.Out{Dest: &value.Value, Size: 32767}
	}
	_, err := conn.ExecContext(ctx, `DECLARE
  scalar_value VARCHAR2(32767);
BEGIN
  :3 := SYS.DBMS_DEBUG.GET_VALUE(:1, :2, scalar_value, NULL);
  :4 := scalar_value;
END;`, variable, nativeFrame, plDebugOutArg(oci, &value.Result), valueOut)
	if err == nil && !value.Result.Valid {
		err = errPLDebugNativeValueResultMissing
	}
	return value, err
}

func plDebugNativeSetValue(ctx context.Context, conn *sql.Conn, oci bool, nativeFrame int, assignment string) (sql.NullInt64, error) {
	var result sql.NullInt64
	_, err := conn.ExecContext(ctx, `BEGIN :3 := SYS.DBMS_DEBUG.SET_VALUE(:1, :2); END;`, nativeFrame, assignment, plDebugOutArg(oci, &result))
	if err == nil && !result.Valid {
		err = errPLDebugNativeSetResultMissing
	}
	return result, err
}
