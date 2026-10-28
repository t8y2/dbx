package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPLDebugNativeDrainProcessHelper(t *testing.T) {
	gate := os.Getenv("DBX_PLDEBUG_DRAIN_TEST_GATE")
	if gate == "" {
		return
	}
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), abortStarted: make(chan struct{}), abortRelease: make(chan struct{}), abortCancelled: make(chan struct{})}
	first, second := &plDebugManagerTestConnector{engine: e}, &plDebugManagerTestConnector{engine: e}
	clean := os.Getenv("DBX_PLDEBUG_DRAIN_TEST_SCENARIO") == "clean"
	if clean {
		e.abortStarted, e.abortRelease, e.abortCancelled = nil, nil, nil
		e.cleanupStarted, e.cleanupRelease = make(chan struct{}), make(chan struct{})
		second.base.complete, second.base.output = 1, "original output😀\n"
		first.base.tx.base.closeStarted, first.base.tx.base.closeRelease = make(chan struct{}), make(chan struct{})
	}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "process-drain", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	r.mu.RLock()
	entry := r.plNativeEntries["process-drain"]
	r.mu.RUnlock()
	entry.mu.Lock()
	entry.cleanupDeadline = time.Now().Add(150 * time.Millisecond)
	entry.mu.Unlock()
	writeFacts := func() {
		facts := entry.snapshot()
		facts["controllerCloses"], facts["debuggeeCloses"], facts["rollbacks"], facts["targetAttempts"], facts["controls"] = first.base.tx.base.closes, second.base.tx.base.closes, second.base.tx.rollbacks, e.targetAttempts, e.controls
		raw, err := json.Marshal(facts)
		if err != nil {
			panic(err)
		}
		if err = os.WriteFile(gate+".facts", raw, 0600); err != nil {
			panic(err)
		}
	}
	go func() {
		if clean {
			<-first.base.tx.base.closeStarted
		} else {
			<-e.abortStarted
		}
		if err := os.WriteFile(gate+".started", []byte("original native abort entered"), 0600); err != nil {
			panic(err)
		}
		for {
			if _, err := os.Stat(gate + ".release"); err == nil {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		if clean {
			close(first.base.tx.base.closeRelease)
		} else {
			<-e.abortCancelled
			close(e.abortRelease)
			<-entry.cleanupDone
			writeFacts()
		}
	}()
	fmt.Fprintln(os.Stdout, `{"drainFixtureReady":true}`)
	runOracleAgent(os.Stdin, os.Stdout, os.Stderr, r)
	if clean {
		writeFacts()
		return
	}
	t.Fatal("dedicated agent returned with its original unknown physical pair still owned")
}

func TestPLDebugNativeAgentProcessRetainsUnknownDrainAfterEOFAndShutdown(t *testing.T) {
	for _, scenario := range []string{"unknown", "clean"} {
		for _, mode := range []string{"eof", "shutdown"} {
			t.Run(scenario+"/"+mode, func(t *testing.T) {
				executable, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				gate := filepath.Join(t.TempDir(), "original")
				command := exec.Command(executable, "-test.run=^TestPLDebugNativeDrainProcessHelper$", "-test.timeout=15s")
				command.Env = append(os.Environ(), "DBX_PLDEBUG_DRAIN_TEST_GATE="+gate, "DBX_PLDEBUG_DRAIN_TEST_SCENARIO="+scenario)
				input, err := command.StdinPipe()
				if err != nil {
					t.Fatal(err)
				}
				output, err := command.StdoutPipe()
				if err != nil {
					t.Fatal(err)
				}
				command.Stderr = os.Stderr
				if err = command.Start(); err != nil {
					t.Fatal(err)
				}
				exited := make(chan error, 1)
				processDone := make(chan struct{})
				go func() { exited <- command.Wait(); close(processDone) }()
				t.Cleanup(func() {
					_ = input.Close()
					select {
					case <-processDone:
						return
					default:
					}
					_ = command.Process.Kill()
					select {
					case <-processDone:
					case <-time.After(2 * time.Second):
						t.Error("owned test child did not exit after kill")
					}
				})
				ready := make(chan struct{})
				go func() {
					scanner := bufio.NewScanner(output)
					for scanner.Scan() {
						if strings.Contains(scanner.Text(), `"drainFixtureReady":true`) {
							close(ready)
						}
					}
				}()
				select {
				case <-ready:
				case err := <-exited:
					t.Fatalf("fixture exited before readiness: %v", err)
				case <-time.After(3 * time.Second):
					t.Fatal("fixture did not become ready")
				}
				if mode == "shutdown" {
					if _, err = fmt.Fprintln(input, `{"id":7,"method":"shutdown"}`); err != nil {
						t.Fatal(err)
					}
				}
				if err = input.Close(); err != nil {
					t.Fatal(err)
				}
				plDebugDrainWaitFile(t, gate+".started", processDone)
				select {
				case err := <-exited:
					t.Fatalf("agent exited while original abort was still live: %v", err)
				case <-time.After(225 * time.Millisecond):
				}
				if err = os.WriteFile(gate+".release", []byte("complete original native call"), 0600); err != nil {
					t.Fatal(err)
				}
				plDebugDrainWaitFile(t, gate+".facts", processDone)
				raw, err := os.ReadFile(gate + ".facts")
				if err != nil {
					t.Fatal(err)
				}
				var facts map[string]interface{}
				if err = json.Unmarshal(raw, &facts); err != nil {
					t.Fatal(err)
				}
				if scenario == "clean" {
					if facts["releaseState"] != "released" || facts["transactionOutcome"] != "rollback_confirmed" || facts["targetAttempts"] != float64(1) || facts["controls"] != float64(2) || facts["controllerCloses"] != float64(1) || facts["debuggeeCloses"] != float64(1) || facts["rollbacks"] != float64(1) {
						t.Fatalf("clean drain did not confirm its exact original resources: %#v", facts)
					}
					select {
					case err := <-exited:
						if err != nil {
							t.Fatalf("clean agent failed to exit: %v", err)
						}
					case <-time.After(time.Second):
						t.Fatal("clean agent did not exit after original release")
					}
					return
				}
				if facts["releaseState"] != "unknown" || facts["nativeDebugId"] != "native ' id" || facts["targetAttempts"] != float64(1) || facts["controls"] != float64(1) || facts["controllerCloses"] != float64(0) || facts["debuggeeCloses"] != float64(0) || facts["rollbacks"] != float64(0) {
					t.Fatalf("shutdown lost or falsely released original resources: %#v", facts)
				}
				select {
				case err := <-exited:
					t.Fatalf("unknown resources caused an unconfirmed graceful exit: %v", err)
				case <-time.After(40 * time.Millisecond):
				}
			})
		}
	}
}

func plDebugDrainWaitFile(t *testing.T, path string, exited <-chan struct{}) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case <-exited:
			if _, statErr := os.Stat(path); statErr == nil {
				return
			}
			t.Fatal("child exited before its original completion marker")
		case <-deadline.C:
			t.Fatal("original completion marker did not arrive")
		case <-ticker.C:
		}
	}
}
