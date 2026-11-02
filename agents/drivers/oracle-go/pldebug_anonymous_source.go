package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type plDebugNativeFrameSourceLine struct {
	Line int64   `json:"line"`
	Text *string `json:"text"`
}

const plDebugNativeFrameSourceBlock = `DECLARE
  listing SYS.DBMS_DEBUG.vc2_table;
  position BINARY_INTEGER;
` + plDebugNativeJSONDeclarations + `BEGIN
  SYS.DBMS_DEBUG.SHOW_FRAME_SOURCE(1, :1, listing, :2);
  SYS.DBMS_LOB.CREATETEMPORARY(payload, TRUE);
  append_text('[');
  position := listing.FIRST;
  WHILE position IS NOT NULL LOOP
    IF position != listing.FIRST THEN append_text(','); END IF;
    append_text('{"line":'); append_integer(position);
    append_text(',"text":'); append_string(listing(position));
    append_text('}');
    position := listing.NEXT(position);
  END LOOP;
  append_text(']');
  :3 := payload;
  :4 := 1;
  :5 := 0;
EXCEPTION WHEN OTHERS THEN
  IF payload IS NOT NULL AND SYS.DBMS_LOB.ISTEMPORARY(payload) = 1 THEN
    SYS.DBMS_LOB.FREETEMPORARY(payload);
  END IF;
  RAISE;
END;`

func plDebugReadNativeFrameSource(ctx context.Context, conn *sql.Conn, allocation *plDebugAllocation, oci bool, frameID int64, expected string) ([]plDebugNativeFrameSourceLine, *plDebugNativeCapture, error) {
	last := strings.Count(expected, "\n") + 2
	capture, err := plDebugReadNativeJSON(ctx, conn, allocation, oci, plDebugNativeFrameSourceBlock, last, frameID)
	if err != nil {
		return nil, capture, err
	}
	var lines []plDebugNativeFrameSourceLine
	if err := json.Unmarshal([]byte(capture.Output), &lines); err != nil {
		return nil, capture, err
	}
	if lines == nil {
		return nil, capture, errors.New("anonymous frame source did not return an array")
	}
	return lines, capture, nil
}

func plDebugNativeFrameSourceMatches(expected string, observed []plDebugNativeFrameSourceLine) bool {
	lines := strings.Split(expected, "\n")
	if len(lines) != len(observed) {
		return false
	}
	for i, line := range lines {
		if observed[i].Line != int64(i+1) {
			return false
		}
		text := ""
		if observed[i].Text != nil {
			text = *observed[i].Text
		}
		if text == line || text == line+"\n" || text == line+"\r\n" {
			continue
		}
		if i < len(lines)-1 && strings.HasSuffix(line, "\r") {
			withoutCR := strings.TrimSuffix(line, "\r")
			if text == withoutCR || text == withoutCR+"\n" {
				continue
			}
		}
		return false
	}
	return true
}

func (e *plDebugNativeEntry) resolveNativeAnonymousSources(ctx context.Context, stack *plDebugNativeStack) {
	if stack.MappingState != "verified" || stack.Error != "" {
		return
	}
	for i := range stack.Frames {
		frame := &stack.Frames[i]
		if !frame.Anonymous || frame.Namespace == nil || frame.Program != nil || frame.Owner != nil || frame.DBLink != nil {
			continue
		}
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			frame.SourceState = "error"
			stack.SourceError, frame.SourceError = err.Error(), err.Error()
			return
		}
		lines, capture, err := plDebugReadNativeFrameSource(ctx, e.server.plConnection, e.server.plAllocation, usesOCIProfile(e.server.params), frame.NativeFrameID, e.block.SQL)
		if capture != nil && capture.ReferencesPending {
			e.mu.Lock()
			e.nativeReadPending = append(e.nativeReadPending, capture)
			e.mu.Unlock()
		}
		if err != nil {
			frame.SourceState = "error"
			stack.SourceError, frame.SourceError = err.Error(), err.Error()
			return
		}
		if !plDebugNativeFrameSourceMatches(e.block.SQL, lines) {
			frame.SourceState = "unresolved"
			continue
		}
		frame.SourceRef = &plDebugNativeSourceRef{ID: e.request.OperationID + ":wrapper", SourceRevision: 1, StopRevision: stack.StopRevision, NativeFrameID: frame.NativeFrameID, LineBasis: "submitted_wrapper", IdentityState: "native", EvidenceKind: "anonymous_source", ObjectType: "ANONYMOUS", Source: e.request.Source, LineOffset: e.block.SourceLineOffset, Namespace: frame.Namespace}
		frame.IdentityState = "native"
		frame.SourceState = "wrapper"
		frame.SourceLine = nil
		if plDebugNativeToken(e.request.ObjectType) == "ANONYMOUS" && frame.Line != nil {
			line := *frame.Line - int64(e.block.SourceLineOffset)
			if line >= 1 && line <= int64(e.block.SourceLineCount) {
				frame.SourceState = "resolved"
				frame.SourceLine = &line
			}
		}
	}
	complete := len(stack.Frames) != 0 && len(stack.NativeRecords) == len(stack.Frames)
	for _, frame := range stack.Frames {
		complete = complete && frame.IdentityState == "native"
	}
	stack.Complete = complete
}
