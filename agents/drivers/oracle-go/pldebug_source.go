package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"
)

type plDebugNativeSourceRef struct {
	ID             string  `json:"id"`
	SourceRevision int64   `json:"sourceRevision"`
	StopRevision   int64   `json:"stopRevision"`
	NativeFrameID  int64   `json:"nativeFrameId"`
	LineBasis      string  `json:"lineBasis"`
	IdentityState  string  `json:"identityState"`
	EvidenceKind   string  `json:"evidenceKind"`
	ObjectType     string  `json:"objectType"`
	Source         string  `json:"source"`
	LineOffset     int     `json:"lineOffset"`
	Owner          *string `json:"owner"`
	Name           *string `json:"name"`
	ObjectID       *string `json:"objectId"`
	Namespace      *int64  `json:"namespace"`
}

type plDebugNativeSourceLine struct {
	Number int64  `json:"line"`
	Text   string `json:"text"`
}

const (
	plDebugNativeNamespaceTopLevel    = 1
	plDebugNativeNamespacePackageBody = 2
)

type plDebugNativeSource struct {
	Owner      string                    `json:"owner"`
	Name       string                    `json:"name"`
	ObjectType string                    `json:"objectType"`
	ObjectID   string                    `json:"objectId"`
	Status     *string                   `json:"status"`
	LastDDL    *string                   `json:"lastDdl"`
	State      string                    `json:"state"`
	Lines      []plDebugNativeSourceLine `json:"lines"`
}

func plDebugLoadNativeSource(ctx context.Context, conn *sql.Conn, target plDebugNativeCandidate) (plDebugNativeSource, error) {
	return plDebugLoadNativeSourceBounded(ctx, conn, target, nil)
}

type plDebugNativeSourceBudget struct {
	bytes int
	lines int
}

func plDebugLoadNativeSourceBounded(ctx context.Context, conn *sql.Conn, target plDebugNativeCandidate, budget *plDebugNativeSourceBudget) (plDebugNativeSource, error) {
	source := plDebugNativeSource{Owner: target.Schema, Name: target.ObjectName, ObjectType: target.ObjectType, State: "not_visible", Lines: []plDebugNativeSourceLine{}}
	if target.PackageName != nil {
		source.Name, source.ObjectType = *target.PackageName, "PACKAGE BODY"
	}
	err := plDebugNativeRows(ctx, conn, `SELECT TO_CHAR(o.OBJECT_ID, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), o.STATUS,
  TO_CHAR(o.LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS'), s.LINE, s.TEXT
FROM SYS.ALL_OBJECTS o LEFT JOIN SYS.ALL_SOURCE s
  ON s.OWNER = o.OWNER AND s.NAME = o.OBJECT_NAME AND s.TYPE = o.OBJECT_TYPE
WHERE o.OWNER = :1 AND o.OBJECT_NAME = :2 AND o.OBJECT_TYPE = :3
ORDER BY s.LINE`, []interface{}{source.Owner, source.Name, source.ObjectType}, func(rows *sql.Rows) error {
		var id, status, lastDDL, text sql.NullString
		var line sql.NullInt64
		if err := rows.Scan(&id, &status, &lastDDL, &line, &text); err != nil {
			return err
		}
		if !id.Valid || id.String == "" {
			return errors.New("source metadata did not include an object identity")
		}
		if target.PackageName == nil && id.String != target.ObjectID {
			return errors.New("debug target object changed before its source was read")
		}
		if source.State == "not_visible" {
			source.ObjectID, source.Status, source.LastDDL = id.String, plDebugNativeOptional(status), plDebugNativeOptional(lastDDL)
			source.State = "source_unavailable"
		} else if source.ObjectID != id.String || !reflect.DeepEqual(source.Status, plDebugNativeOptional(status)) || !reflect.DeepEqual(source.LastDDL, plDebugNativeOptional(lastDDL)) {
			return errors.New("source query returned conflicting object metadata")
		}
		if !line.Valid {
			if text.Valid || len(source.Lines) != 0 {
				return errors.New("source query returned an incomplete line identity")
			}
			return nil
		}
		if line.Int64 != int64(len(source.Lines)+1) || !text.Valid {
			return errors.New("source query returned missing, duplicate, or incomplete lines")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if budget != nil {
			if budget.lines < 1 || len(text.String) > budget.bytes {
				return errors.New("debug compilation source exceeds the preview budget")
			}
			budget.lines--
			budget.bytes -= len(text.String)
		}
		source.Lines = append(source.Lines, plDebugNativeSourceLine{Number: line.Int64, Text: text.String})
		source.State = "candidate"
		return nil
	})
	return source, err
}

func plDebugNativeSourceUnchanged(before, after plDebugNativeSource) bool {
	return reflect.DeepEqual(before, after)
}

func plDebugLoadNativeSignatureSource(ctx context.Context, conn *sql.Conn, target plDebugNativeCandidate) (*plDebugNativeSource, error) {
	if target.PackageName == nil {
		return nil, nil
	}
	target.ObjectName, target.ObjectType, target.PackageName = *target.PackageName, "PACKAGE", nil
	source, err := plDebugLoadNativeSource(ctx, conn, target)
	return &source, err
}

func (e *plDebugNativeEntry) resolveNativeNamedSources(ctx context.Context, stack *plDebugNativeStack) {
	if e.namedPlan == nil || stack.MappingState != "verified" {
		return
	}
	e.mu.Lock()
	var probe *plDebugNativeProgramProbe
	if e.programProbe != nil {
		copy := *e.programProbe
		probe = &copy
	}
	e.mu.Unlock()
	validated := false
	scans := map[string]plDebugNativeRoutineScan{}
	for i := range stack.Frames {
		frame := &stack.Frames[i]
		owner, program, kind, evidence := frame.Owner, frame.Program, frame.NamespaceKind, "backtrace"
		proved := i == 0 && probe != nil && probe.StopRevision == stack.StopRevision && probe.State == "native_location" && !probe.Uncertain && probe.Program != nil && frame.Namespace != nil && frame.Line != nil && probe.Program.Line != nil && *frame.Line == *probe.Program.Line
		if proved {
			owner, program, evidence = probe.Program.Owner, probe.Program.Name, "current_breakpoint"
		}
		if i == 0 && frame.Namespace != nil && kind == "" {
			switch *frame.Namespace {
			case plDebugNativeNamespaceTopLevel:
				kind = "toplevel_or_spec"
			case plDebugNativeNamespacePackageBody:
				kind = "package_body"
			}
			if !proved {
				evidence = "runtime"
			}
		}
		if (!proved && frame.IdentityState != "native") || owner == nil || program == nil || frame.DBLink != nil || (stack.Error != "" && i != 0) {
			continue
		}
		var source *plDebugNativeSource
		suffix := ""
		if e.targetSource != nil && *owner == e.targetSource.Owner && *program == e.targetSource.Name && ((kind == "package_body" && e.targetSource.ObjectType == "PACKAGE BODY") || (kind == "toplevel_or_spec" && (e.targetSource.ObjectType == "PROCEDURE" || e.targetSource.ObjectType == "FUNCTION"))) {
			source, suffix = e.targetSource, "target"
		} else if e.targetSignatureSource != nil && *owner == e.targetSignatureSource.Owner && *program == e.targetSignatureSource.Name && kind == "toplevel_or_spec" {
			source, suffix = e.targetSignatureSource, "spec"
		}
		if source == nil || source.State != "candidate" {
			continue
		}
		if !validated {
			if err := e.nativeEntryCallAllowed(ctx); err != nil {
				frame.SourceState = "error"
				stack.SourceError, frame.SourceError = err.Error(), err.Error()
				return
			}
			changed, err := e.checkNativeTargetVersion(ctx, "source mapping")
			if err != nil {
				frame.SourceState = "error"
				if changed {
					frame.SourceState = "stale"
				}
				stack.SourceError, frame.SourceError = err.Error(), err.Error()
				return
			}
			validated = true
		}
		var text strings.Builder
		for _, line := range source.Lines {
			text.WriteString(line.Text)
		}
		sourceOwner, name, id := source.Owner, source.Name, source.ObjectID
		frame.SourceRef = &plDebugNativeSourceRef{ID: e.request.OperationID + ":" + suffix, SourceRevision: 1, StopRevision: stack.StopRevision, NativeFrameID: frame.NativeFrameID, LineBasis: "all_source", IdentityState: "native", EvidenceKind: evidence, ObjectType: source.ObjectType, Source: text.String(), Owner: &sourceOwner, Name: &name, ObjectID: &id, Namespace: frame.Namespace}
		frame.SourceState, frame.SourceLine = "source_only", nil
		if frame.Line != nil && *frame.Line >= 1 && *frame.Line <= int64(len(source.Lines)) {
			frame.SourceState, frame.SourceLine = "resolved", frame.Line
			scan, exists := scans[suffix]
			if !exists {
				scan = plDebugScanNativeRoutines(*source)
				scans[suffix] = scan
			}
			identity := scan.identify(e.namedPlan.target, int(*frame.Line))
			frame.RoutineIdentity = &identity
		}
	}
}

func (e *plDebugNativeEntry) checkNativeTargetVersion(ctx context.Context, stage string) (bool, error) {
	_, candidates, err := plDebugLoadNativeTargets(ctx, e.server.plConnection, e.request)
	if err != nil {
		return false, err
	}
	plan, err := plDebugSelectNativeTarget(candidates, e.request)
	if err != nil || !reflect.DeepEqual(plan.target, e.namedPlan.target) {
		return true, fmt.Errorf("debug target signature changed before %s; refresh the target", stage)
	}
	source, err := plDebugLoadNativeSource(ctx, e.server.plConnection, plan.target)
	if err != nil {
		return false, err
	}
	if !plDebugNativeSourceUnchanged(*e.targetSource, source) {
		return true, fmt.Errorf("debug target source changed before %s; refresh the target", stage)
	}
	signature, err := plDebugLoadNativeSignatureSource(ctx, e.server.plConnection, plan.target)
	if err != nil {
		return false, err
	}
	if !reflect.DeepEqual(e.targetSignatureSource, signature) {
		return true, fmt.Errorf("debug target package specification changed before %s; refresh the target", stage)
	}
	if stage == "dispatch" && e.namedPlan.typedSignature != nil {
		e.server.plDebugMu.Lock()
		conn := e.server.plDebuggeeConnection
		e.server.plDebugMu.Unlock()
		if err := plDebugRevalidateNativeTypedSignature(ctx, conn, e.namedPlan, false, usesOCIProfile(e.server.params)); err != nil {
			return true, err
		}
	}
	return false, nil
}
