package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
)

type plDebugNativeBreakpointRules struct {
	IgnoreCount int64  `json:"ignoreCount"`
	Condition   string `json:"condition"`
	Message     string `json:"message"`
}

type plDebugNativeRuleEvent struct {
	Sequence         int64  `json:"sequence"`
	StopRevision     int64  `json:"stopRevision"`
	BreakpointNumber int64  `json:"breakpointNumber"`
	Message          string `json:"message,omitempty"`
	Warning          string `json:"warning,omitempty"`
}

func (e *plDebugNativeEntry) recordNativeRuleEvent(number int64, message, warning string) {
	if message == "" && warning == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ruleEventSequence++
	e.ruleEvents = append(e.ruleEvents, plDebugNativeRuleEvent{Sequence: e.ruleEventSequence, StopRevision: e.stopRevision + 1, BreakpointNumber: number, Message: message, Warning: warning})
	if len(e.ruleEvents) > 500 {
		e.ruleEvents = e.ruleEvents[len(e.ruleEvents)-500:]
	}
}

func (e *plDebugNativeEntry) applyNativeBreakpointRules(ctx context.Context, p *plDebugSession, method string, result map[string]interface{}) (next map[string]interface{}, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			e.server.plAllocation.mu.Lock()
			e.server.plAllocation.unknown = true
			e.server.plAllocation.mu.Unlock()
			next, err = nil, fmt.Errorf("native breakpoint rule inspection panic: %v", recovered)
		}
	}()
	if method != "pl_debug_resume" && method != "pl_debug_step_in" && method != "pl_debug_step_over" && method != "pl_debug_step_out" {
		return result, nil
	}
	for automatic := 0; ; {
		p.mu.Lock()
		stop := *p.nativeStop
		p.mu.Unlock()
		if !stop.Reason.Valid || stop.Reason.Int64 != plDebugReasonBreakpoint || !stop.Breakpoint.Valid || !stop.Terminated.Valid || stop.Terminated.Int64 != 0 {
			return result, nil
		}
		e.mu.Lock()
		owned, exists := e.ownedBreakpoints[stop.Breakpoint.Int64]
		e.mu.Unlock()
		if !exists {
			return result, nil
		}
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return nil, err
		}
		inventory, err := e.readNativeBreakpointInventory(ctx)
		if err != nil {
			return nil, err
		}
		verified := false
		for _, current := range inventory {
			if current.ID == owned.Native.ID && reflect.DeepEqual(current, owned.Native) {
				verified = true
				break
			}
		}
		warning := ""
		if !verified || !owned.Native.LocalActive || owned.Native.Line == nil || !stop.Line.Valid || stop.Line.Int64 != *owned.Native.Line {
			warning = "the stopped breakpoint does not match its original registration; stopped without applying rules"
			e.recordNativeRuleEvent(stop.Breakpoint.Int64, "", warning)
			return result, nil
		}
		if e.namedPlan != nil {
			if changed, err := e.checkNativeTargetVersion(ctx, "breakpoint rules"); err != nil {
				if changed {
					e.recordNativeRuleEvent(stop.Breakpoint.Int64, "", err.Error()+"; stopped without applying rules")
					return result, nil
				}
				return nil, err
			}
		}
		e.mu.Lock()
		owned.Hits++
		e.ownedBreakpoints[stop.Breakpoint.Int64] = owned
		e.mu.Unlock()
		skip := false
		if method == "pl_debug_resume" {
			skip = owned.Rules.IgnoreCount > 0 && owned.Hits < owned.Rules.IgnoreCount
			if !skip && owned.Rules.Condition != "" {
				if !stop.StackDepth.Valid || stop.StackDepth.Int64 <= 0 || int64(int(stop.StackDepth.Int64)) != stop.StackDepth.Int64 {
					return nil, errors.New("the condition has no verified native frame")
				}
				verdict, err := plDebugEvaluateCondition(owned.Rules.Condition, func(name string) (plDebugNativeVariable, error) {
					if err := e.nativeEntryCallAllowed(ctx); err != nil {
						return plDebugNativeVariable{}, err
					}
					value, err := plDebugNativeGetValue(ctx, e.server.plConnection, p.oci, name, int(stop.StackDepth.Int64))
					return plDebugNativeVariableResult(name, value), err
				})
				if err != nil {
					return nil, err
				}
				skip = verdict.State == "false"
				if verdict.State == "unparseable" {
					warning = fmt.Sprintf("condition could not be evaluated: %s; stopped", verdict.Reason)
				}
			}
		}
		if !skip {
			e.recordNativeRuleEvent(stop.Breakpoint.Int64, owned.Rules.Message, warning)
			return result, nil
		}
		if automatic >= 200 {
			e.recordNativeRuleEvent(stop.Breakpoint.Int64, owned.Rules.Message, "automatic continue limit (200) reached; stopped")
			return result, nil
		}
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return nil, err
		}
		result, err = e.runNativeControl(p, "pl_debug_resume", false)
		if err != nil {
			return nil, err
		}
		automatic++
		e.mu.Lock()
		e.stopRevision++
		e.mu.Unlock()
	}
}
