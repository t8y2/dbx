package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type plDebugNativeReply struct {
	Stop *plDebugNativeStop `json:"nativeStop"`
}

func plDebugDecodeNativeStop(message string) (*plDebugNativeStop, bool) {
	var reply plDebugNativeReply
	if len(message) == 0 || message[0] != '{' || json.Unmarshal([]byte(message), &reply) != nil || reply.Stop == nil {
		return nil, false
	}
	return reply.Stop, true
}

func (p *plDebugSession) plDebugNativeCall(routine string, in []any, out ...any) error {
	if len(in) != 0 || len(out) != 2 {
		return errors.New("native action binding is not yet available")
	}
	result, ok := out[0].(*int)
	if !ok {
		return errors.New("native result requires an integer destination")
	}
	message, ok := out[1].(*string)
	if !ok {
		return errors.New("native runtime reply requires a structured destination")
	}
	parent := p.nativeContext
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, p.debugCallTimeout())
	defer cancel()
	stop, err := plDebugNativeControl(ctx, p.nativeDebugger, p.oci, routine)
	if err != nil {
		return err
	}
	*result = int(stop.Result.Int64)
	encoded, err := json.Marshal(plDebugNativeReply{Stop: &stop})
	if err != nil {
		return err
	}
	*message = string(encoded)
	return nil
}

func (p *plDebugSession) applyNativeStop(stop *plDebugNativeStop) {
	p.nativeStop = stop
	p.lastLine, p.lastBreakpoint, p.lastStackDepth, p.lastReason = 0, 0, 0, 0
	p.lastProgram, p.lastProgramOwner = "", ""
	if stop.Line.Valid {
		p.lastLine = int(stop.Line.Int64)
	}
	if stop.Breakpoint.Valid {
		p.lastBreakpoint = int(stop.Breakpoint.Int64)
	}
	if stop.StackDepth.Valid {
		p.lastStackDepth = int(stop.StackDepth.Int64)
	}
	if stop.Reason.Valid {
		p.lastReason = int(stop.Reason.Int64)
	}
	if stop.Program.Valid {
		p.lastProgram = stop.Program.String
	}
	if stop.Owner.Valid {
		p.lastProgramOwner = stop.Owner.String
	}
	p.terminated = stop.Terminated.Valid && stop.Terminated.Int64 != 0
}

func plDebugNativeInteger(value sql.NullInt64) interface{} {
	if !value.Valid {
		return nil
	}
	return value.Int64
}
func plDebugNativeString(value sql.NullString) interface{} {
	if !value.Valid {
		return nil
	}
	return value.String
}
func (stop *plDebugNativeStop) snapshot() map[string]interface{} {
	return map[string]interface{}{"result": plDebugNativeInteger(stop.Result), "line": plDebugNativeInteger(stop.Line), "terminated": plDebugNativeInteger(stop.Terminated), "breakpoint": plDebugNativeInteger(stop.Breakpoint), "stackDepth": plDebugNativeInteger(stop.StackDepth), "interpreterDepth": plDebugNativeInteger(stop.InterpreterDepth), "reason": plDebugNativeInteger(stop.Reason), "namespace": plDebugNativeInteger(stop.Namespace), "program": plDebugNativeString(stop.Program), "owner": plDebugNativeString(stop.Owner), "dbLink": plDebugNativeString(stop.DBLink), "programLine": plDebugNativeInteger(stop.ProgramLine), "libUnitType": plDebugNativeInteger(stop.LibUnitType), "entrypoint": plDebugNativeString(stop.Entrypoint)}
}
