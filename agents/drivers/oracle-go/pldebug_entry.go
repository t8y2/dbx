package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"
)

type plDebugNativeProgramProbe struct {
	State           string                    `json:"state"`
	StopRevision    int64                     `json:"stopRevision"`
	Before          []plDebugNativeBreakpoint `json:"before"`
	After           []plDebugNativeBreakpoint `json:"after"`
	Number          *int64                    `json:"number"`
	Result          *int64                    `json:"result"`
	NewBreakpoint   bool                      `json:"newBreakpoint"`
	DeleteAttempted bool                      `json:"deleteAttempted"`
	Deleted         bool                      `json:"deleted"`
	Program         *plDebugNativeBreakpoint  `json:"program"`
	Error           string                    `json:"error"`
	Uncertain       bool                      `json:"uncertain"`
	Rejected        bool                      `json:"rejected"`
}

func (e *plDebugNativeEntry) readNativeBreakpointInventory(ctx context.Context) ([]plDebugNativeBreakpoint, error) {
	listing, capture, err := plDebugNativeBreakpoints(ctx, e.server.plConnection, e.server.plAllocation, usesOCIProfile(e.server.params))
	if capture != nil && capture.ReferencesPending {
		e.mu.Lock()
		e.nativeReadPending = append(e.nativeReadPending, capture)
		e.mu.Unlock()
	}
	return listing, err
}

func (e *plDebugNativeEntry) nativeEntryCallAllowed(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closeRequested || e.closeReason == "lease_expired" {
		return errors.New("native entry inspection was closed before dispatch")
	}
	if !e.leaseDeadline.IsZero() && !time.Now().Before(e.leaseDeadline) {
		e.markLeaseExpiredLocked()
		go func() { _, _ = e.close() }()
		return errors.New("the original debug operation lease expired before dispatch")
	}
	return nil
}

func (e *plDebugNativeEntry) finishNativeReads(deadline time.Time) error {
	e.mu.Lock()
	pending := append([]*plDebugNativeCapture{}, e.nativeReadPending...)
	e.mu.Unlock()
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	for _, capture := range pending {
		capture.finishReferences(ctx, e.server.plAllocation)
		if capture.ReferencesPending {
			return errors.New("original native inspection references are not released")
		}
	}
	e.mu.Lock()
	finished := map[*plDebugNativeCapture]bool{}
	for _, capture := range pending {
		finished[capture] = true
	}
	remaining := []*plDebugNativeCapture{}
	for _, capture := range e.nativeReadPending {
		if !finished[capture] {
			remaining = append(remaining, capture)
		}
	}
	e.nativeReadPending = remaining
	e.mu.Unlock()
	if len(remaining) != 0 {
		return errors.New("original native inspection references were published during cleanup")
	}
	return nil
}

func (e *plDebugNativeEntry) inspectNativeCurrentProgram(ctx context.Context, stop plDebugNativeStop) error {
	if plDebugNativeStopState(stop) != "paused" || !stop.Line.Valid || stop.Line.Int64 <= 0 || (stop.Program.Valid && stop.Owner.Valid) {
		return nil
	}
	probe := &plDebugNativeProgramProbe{State: "unresolved"}
	e.mu.Lock()
	if e.programProbe != nil && e.programProbe.StopRevision == e.stopRevision {
		message := e.programProbe.Error
		e.mu.Unlock()
		if message != "" {
			return errors.New(message)
		}
		return nil
	}
	probe.StopRevision = e.stopRevision
	e.programProbe = probe
	e.mu.Unlock()
	finish := func(err error) error {
		e.mu.Lock()
		probe.Error = err.Error()
		e.mu.Unlock()
		return err
	}
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return finish(err)
	}
	before, err := e.readNativeBreakpointInventory(ctx)
	if err != nil {
		return finish(err)
	}
	e.mu.Lock()
	probe.Before = before
	e.mu.Unlock()
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return finish(err)
	}
	e.mu.Lock()
	probe.Uncertain = true
	e.mu.Unlock()
	result, number, rejected, err := plDebugNativeSetBreakpoint(ctx, e.server.plConnection, usesOCIProfile(e.server.params), nil, nil, nil, nil, stop.Line.Int64)
	existing := false
	var previous plDebugNativeBreakpoint
	for _, item := range before {
		if number.Valid && item.ID == number.Int64 {
			existing, previous = true, item
			break
		}
	}
	e.mu.Lock()
	if result.Valid {
		probe.Result = &result.Int64
	}
	if number.Valid {
		probe.Number = &number.Int64
	}
	probe.NewBreakpoint = result.Valid && result.Int64 == 0 && number.Valid && !existing
	probe.Rejected = err == nil && result.Valid && result.Int64 != 0 && rejected.Valid && rejected.Int64 == 1
	if probe.Rejected {
		probe.Uncertain = false
	}
	e.mu.Unlock()
	if err != nil {
		return finish(err)
	}
	if result.Int64 != 0 {
		return finish(fmt.Errorf("current-program SET_BREAKPOINT returned %d", result.Int64))
	}
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return finish(err)
	}
	after, readErr := e.readNativeBreakpointInventory(ctx)
	e.mu.Lock()
	probe.After = after
	e.mu.Unlock()
	var current *plDebugNativeBreakpoint
	afterByID := map[int64]plDebugNativeBreakpoint{}
	for _, item := range after {
		afterByID[item.ID] = item
		if item.ID == number.Int64 {
			copy := item
			current = &copy
		}
	}
	inventoryChanged := false
	for _, item := range before {
		observed, present := afterByID[item.ID]
		if !present || !reflect.DeepEqual(item, observed) {
			inventoryChanged = true
		}
	}
	expectedCount := len(before)
	if !existing {
		expectedCount++
	}
	if len(after) != expectedCount {
		inventoryChanged = true
	}
	if existing {
		if readErr != nil {
			return finish(readErr)
		}
		if inventoryChanged || current == nil || !reflect.DeepEqual(previous, *current) {
			return finish(errors.New("current-program breakpoint changed an existing native record; automatic entry stopped"))
		}
		e.mu.Lock()
		probe.Uncertain = false
		e.mu.Unlock()
	} else {
		// SHOW failure still leaves a known new breakpoint owned by this operation.
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return finish(err)
		}
		e.mu.Lock()
		probe.DeleteAttempted = true
		e.mu.Unlock()
		deleted, deleteErr := plDebugNativeDeleteBreakpoint(ctx, e.server.plConnection, usesOCIProfile(e.server.params), number.Int64)
		if deleteErr != nil {
			return finish(deleteErr)
		}
		if deleted.Int64 != 0 {
			return finish(fmt.Errorf("temporary breakpoint DELETE returned %d", deleted.Int64))
		}
		e.mu.Lock()
		probe.Deleted, probe.Uncertain = true, false
		e.mu.Unlock()
		if readErr != nil {
			e.mu.Lock()
			probe.Uncertain = true
			e.mu.Unlock()
			return finish(readErr)
		}
		if inventoryChanged {
			e.mu.Lock()
			probe.Uncertain = true
			e.mu.Unlock()
			return finish(errors.New("current-program breakpoint changed other native records; automatic entry stopped"))
		}
	}
	if current == nil || current.Line == nil || *current.Line != stop.Line.Int64 || current.Status == nil || !current.LocalActive || current.Owner == nil || current.Name == nil || current.DBLink != nil {
		return finish(errors.New("current-program breakpoint did not identify an exact local active location"))
	}
	if (stop.Owner.Valid && stop.Owner.String != *current.Owner) || (stop.Program.Valid && stop.Program.String != *current.Name) || stop.DBLink.Valid {
		return finish(errors.New("current-program breakpoint conflicts with the native stop"))
	}
	e.mu.Lock()
	probe.State, probe.Program = "native_location", current
	e.mu.Unlock()
	return nil
}

func (e *plDebugNativeEntry) driveNativeEntry(ctx context.Context, p *plDebugSession, stop plDebugNativeStop, steps int) (plDebugNativeStop, error) {
	limit := plDebugStartStepInLimit + e.block.SourceLineOffset
	if e.request.PackageName != "" {
		limit = plDebugPackageStepInLimit + e.block.SourceLineOffset
	}
	for {
		if plDebugNativeStopState(stop) != "paused" {
			return stop, nil
		}
		e.mu.Lock()
		returned := e.targetReturned
		revision := e.stopRevision
		e.mu.Unlock()
		if returned {
			e.mu.Lock()
			e.entryState = "ended_before_entry"
			e.mu.Unlock()
			return stop, nil
		}
		if e.namedPlan == nil && (!stop.Namespace.Valid || stop.Namespace.Int64 != 0 || stop.Program.Valid || stop.Owner.Valid) {
			return stop, nil
		}
		stack := e.readNativeMappedStack(ctx, stop, revision)
		e.server.plAllocation.mu.Lock()
		unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		e.publishNativeStackLocked(stack, unknown)
		state := e.entryState
		stack = *e.nativeStack
		e.mu.Unlock()
		if state != "wrapper" || stack.MappingState != "verified" || stack.Error != "" || stack.SourceError != "" || len(stack.Frames) == 0 || !stop.Line.Valid {
			return stop, nil
		}
		if !stop.Reason.Valid || (stop.Reason.Int64 != plDebugReasonEnter && stop.Reason.Int64 != plDebugReasonLine) {
			return stop, nil
		}
		last := int64(e.block.SourceLineOffset + e.block.SourceLineCount)
		if e.namedPlan != nil {
			last = int64(e.block.CallLastLine)
		}
		if last <= 0 || stop.Line.Int64 > last {
			e.mu.Lock()
			e.entryState = "wrapper_after_call"
			e.mu.Unlock()
			return stop, nil
		}
		if steps >= limit {
			e.mu.Lock()
			e.entryState = "unresolved"
			e.entryError = fmt.Sprintf("entry stepping stopped at its %d-step limit", limit)
			e.mu.Unlock()
			return stop, nil
		}
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return stop, err
		}
		next, err := plDebugNativeControl(ctx, e.server.plConnection, p.oci, procCntStepIn)
		if err != nil {
			return stop, err
		}
		if next.Result.Int64 != 0 {
			return stop, fmt.Errorf("native entry step failed (%d); do not repeat the operation", next.Result.Int64)
		}
		stop = next
		steps++
		p.mu.Lock()
		p.applyNativeStop(&stop)
		cached := p.snapshot("")
		p.mu.Unlock()
		e.mu.Lock()
		e.cached = cached
		e.stopRevision++
		e.nativeStack = nil
		e.programProbe = nil
		e.entryState = "unresolved"
		e.entryError = ""
		e.mu.Unlock()
	}
}
