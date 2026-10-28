package main

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

func TestPLDebugRetainedResultPagesUseOriginalIdentityAfterRelease(t *testing.T) {
	r := newRuntimeServer()
	r.plDebugRuntime = true
	entry := &plDebugNativeEntry{agentSessionID: "owner", captureFinished: true, namedResult: map[string]interface{}{"outParamsState": "available"}, releaseState: "released"}
	r.plNativeEntries = map[string]*plDebugNativeEntry{"original": entry}
	reference, err := entry.resultCache.retain([]byte("A🙂中文\x00"), false, "X")
	if err != nil {
		t.Fatal(err)
	}
	request := func(offset, limit interface{}) map[string]interface{} {
		return map[string]interface{}{"debugId": "original", "agentSessionId": "owner", "generation": reference["generation"], "resultId": reference["resultId"], "offset": offset, "limit": limit}
	}
	first := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_result_page", request(0, 2)))
	if first["data"] != "A" || first["nextOffset"] != 1 {
		t.Fatal("UTF16 page split a surrogate pair")
	}
	next := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_result_page", request(1, 2)))
	if next["data"] != "🙂" || next["nextOffset"] != 3 {
		t.Fatal("UTF16 cursor lost emoji")
	}
	for _, bad := range []map[string]interface{}{request(2, 2), request(1, 1), request(nil, 2), request("0", 2), request(0, 1.5)} {
		if plDebugManagerRPC(t, r, "pl_debug_get_result_page", bad).Error == nil {
			t.Fatal("invalid cursor/coerced bounds accepted")
		}
	}
	wrong := request(0, 2)
	wrong["agentSessionId"] = "foreign"
	if plDebugManagerRPC(t, r, "pl_debug_get_result_page", wrong).Error == nil {
		t.Fatal("foreign owner read retained result")
	}
	wrong = request(0, 2)
	wrong["generation"] = "other"
	if plDebugManagerRPC(t, r, "pl_debug_get_result_page", wrong).Error == nil {
		t.Fatal("wrong generation read retained result")
	}
	listed := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_results", map[string]interface{}{"debugId": "original", "agentSessionId": "owner"}))
	if listed["collectionState"] != "available" || len(listed["results"].([]map[string]interface{})) != 1 {
		t.Fatal("released entry lost original manifest")
	}
	listed["results"].([]map[string]interface{})[0]["resultId"] = "mutated"
	again := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_result_page", request(0, 2)))
	if again["data"] != "A" || again["resultId"] != reference["resultId"] {
		t.Fatal("repeated page mutated immutable cache")
	}
}

func TestPLDebugResultCacheEncodedBudgetAndBinaryOffsets(t *testing.T) {
	cache := plDebugResultCache{used: plDebugTypedResultBytes - 4096 - 4}
	reference, err := cache.retain([]byte{0, 255, 128, 1}, true, "B")
	if err != nil {
		t.Fatal(err)
	}
	if reference["length"] != 3 || reference["complete"] != false || reference["truncated"] != true || cache.used > plDebugTypedResultBytes {
		t.Fatal("base64 budget counted raw bytes")
	}
	page, err := cache.page(reference["generation"].(string), reference["resultId"].(string), 1, 2)
	if err != nil || page["data"] != "/4A=" || page["nextOffset"] != 3 {
		t.Fatal("binary offsets were not byte based")
	}
	text := plDebugResultCache{used: plDebugTypedResultBytes - 4096 - 3}
	manifest, err := text.retain([]byte(strings.Repeat("🙂", 2)), false, "C")
	if err != nil || manifest["length"] != 0 || manifest["complete"] != false {
		t.Fatal("UTF8 budget split a character")
	}
}

func TestPLDebugRetainedResultsCapabilityOnlyOnNativeRuntime(t *testing.T) {
	for _, native := range []bool{false, true} {
		r := newRuntimeServer()
		r.plDebugRuntime = native
		result := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "handshake", nil))
		present := false
		for _, capability := range result["capabilities"].([]string) {
			present = present || capability == "pl_debug_retained_results_v1"
		}
		if present != native {
			t.Fatal("result capability advertised by an unconnected dispatcher")
		}
	}
}

func TestPLDebugExecuteTargetPublishesRetainedLobAfterCapture(t *testing.T) {
	for _, failRead := range []bool{false, true} {
		connector := &plDebugCaptureTestConnector{complete: 1, rollback: -1}
		r, server, tx := openNativeCaptureTest(t, connector, "thin")
		name := "X"
		plan := &plDebugNativePlan{typedSignature: &plDebugNativeTypedSignature{SignatureVersion: 2}, arguments: []plDebugNativeInput{{argument: plDebugNativeArgument{Name: &name, Position: 1, Mode: "OUT", Type: "CLOB"}}}}
		call, err := plan.bind(false)
		if err != nil {
			t.Fatal(err)
		}
		call.phase = sql.NullInt64{Int64: 3, Valid: true}
		call.copied[0] = sql.NullInt64{Int64: 3, Valid: true}
		call.lengths[0] = sql.NullInt64{Int64: 3, Valid: true}
		*call.lobs[0].bind.(go_ora.Out).Dest.(*go_ora.Clob) = go_ora.Clob{String: "A🙂", Valid: true}
		if failRead {
			call.lobs[0].read = func(int) ([]byte, error) { return []byte("A"), errors.New("interrupted reader") }
		}
		entry := &plDebugNativeEntry{server: server, agentSessionID: "a", namedPlan: plan, namedCall: call, captureDone: make(chan struct{}), dispatchDone: make(chan struct{})}
		session := &plDebugSession{targetDone: make(chan struct{})}
		block, err := plan.block()
		if err != nil {
			t.Fatal(err)
		}
		entry.executeTarget(tx, session, block)
		if !entry.captureFinished || !entry.targetReturned || !session.targetReturned || entry.capture.ReferencesPending {
			t.Fatal("manager did not finish original capture")
		}
		field := entry.namedResult["outParams"].([]map[string]interface{})[0]
		wantState, wantData := "value", "A🙂"
		if failRead {
			wantState, wantData = "partial", "A"
		}
		if field["value"] != nil || field["resultRef"] == nil || field["state"] != wantState || entry.namedResult["executionOutcome"] != "succeeded" {
			t.Fatal("manager published inline LOB or lost business result")
		}
		reference := field["resultRef"].(map[string]interface{})
		page, err := entry.resultCache.page(reference["generation"].(string), reference["resultId"].(string), 0, 3)
		if err != nil || page["data"] != wantData || call.lobs[0].data != nil {
			t.Fatal("manager cache did not consume and retain copied LOB")
		}
		resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
		if resp.Error != nil {
			t.Fatal(resp.Error)
		}
		page, err = entry.resultCache.page(reference["generation"].(string), reference["resultId"].(string), 0, 3)
		if err != nil || page["data"] != wantData {
			t.Fatal("physical release invalidated retained result")
		}
		if failRead && (reference["complete"] != false || reference["error"] != "read_failed") {
			t.Fatal("partial read cache lost failure provenance")
		}
	}
}
