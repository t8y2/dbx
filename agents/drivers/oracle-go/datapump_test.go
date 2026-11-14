package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/network"
)

// datapumpTestDriver 为 pinned 连接伪造一个 Oracle 会话：应答预检 SELECT、
// 为启动/状态块填 OUT 绑定值，并记录每条语句供测试断言引擎的行为序列。
type datapumpTestDriver struct {
	mu sync.Mutex

	events []string

	// statusSeq 脚本化 GET_STATUS 的返回序列；耗尽后一直返回 EXECUTING 10%.
	statusSeq []datapumpStatusValues

	user, version, dirPath string
	privCount              int
	exportRoles            int
	importRoles            int

	failStage            string // "open" | "status" | "stop"
	jobStateRow          string // 非空时 USER_DATAPUMP_JOBS 返回该状态行；空 = 无行（完成自清理）
	stopSeen, detachSeen bool
	opens                int
}

func (d *datapumpTestDriver) Open(string) (driver.Conn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.opens++
	return &datapumpTestConn{d: d}, nil
}

type datapumpTestConn struct{ d *datapumpTestDriver }

func (*datapumpTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("context APIs required")
}
func (c *datapumpTestConn) Close() error                       { return nil }
func (c *datapumpTestConn) Begin() (driver.Tx, error)          { return nil, errors.New("transactions unused") }
func (*datapumpTestConn) CheckNamedValue(*driver.NamedValue) error { return nil }

func (d *datapumpTestDriver) record(event string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.events = append(d.events, event)
}

func (d *datapumpTestDriver) eventString() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return strings.Join(d.events, ",")
}

func datapumpSetDest(dest any, value any) {
	switch pointer := dest.(type) {
	case *float64:
		*pointer = value.(float64)
	case *string:
		*pointer = value.(string)
	}
}

func datapumpFillOut(args []driver.NamedValue, name string, value any) {
	for _, arg := range args {
		if arg.Name != name {
			continue
		}
		switch out := arg.Value.(type) {
		case sql.Out:
			datapumpSetDest(out.Dest, value)
		case go_ora.Out:
			datapumpSetDest(out.Dest, value)
		}
	}
}

func (c *datapumpTestConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	switch {
	case strings.Contains(query, "DBMS_DATAPUMP.OPEN"):
		c.d.record("open")
		if c.d.failStage == "open" {
			return nil, errors.New("ORA-31631: privileges are required")
		}
		datapumpFillOut(args, "handle", float64(101))
	case strings.Contains(query, "GET_STATUS"):
		c.d.mu.Lock()
		var status datapumpStatusValues
		if len(c.d.statusSeq) > 0 {
			status = c.d.statusSeq[0]
			c.d.statusSeq = c.d.statusSeq[1:]
		} else {
			status = datapumpStatusValues{JobState: "EXECUTING", Percent: 10}
		}
		c.d.mu.Unlock()
		datapumpFillOut(args, "job_state", status.JobState)
		datapumpFillOut(args, "percent", status.Percent)
		datapumpFillOut(args, "phase", status.PhaseCode)
		datapumpFillOut(args, "error_count", status.ErrorCount)
		datapumpFillOut(args, "error_text", status.ErrorText)
		if c.d.failStage == "status" {
			// 带真实 ORA 码：oracleVendorCode 只认 network.OracleError。
			return nil, &network.OracleError{ErrCode: 31626}
		}
	case strings.Contains(query, "STOP_JOB"):
		c.d.record("stop")
		if c.d.failStage == "stop" {
			return nil, errors.New("ORA-31627: job is not executing")
		}
		c.d.mu.Lock()
		c.d.stopSeen = true
		c.d.mu.Unlock()
	case strings.Contains(query, "DETACH"):
		c.d.record("detach")
		c.d.mu.Lock()
		c.d.detachSeen = true
		c.d.mu.Unlock()
	}
	return driver.RowsAffected(1), nil
}

type datapumpTestRows struct {
	values [][]driver.Value
}

func (*datapumpTestRows) Columns() []string { return []string{"VALUE"} }
func (*datapumpTestRows) Close() error      { return nil }
func (r *datapumpTestRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

func (c *datapumpTestConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.d.record("query")
	one := func(value driver.Value) driver.Rows { return &datapumpTestRows{values: [][]driver.Value{{value}}} }
	switch {
	case strings.Contains(query, "ALL_DIRECTORIES"):
		if c.d.dirPath == "" {
			return &datapumpTestRows{}, nil
		}
		return one(c.d.dirPath), nil
	case strings.Contains(query, "USER_TAB_PRIVS"):
		return one(int64(c.d.privCount)), nil
	case strings.Contains(query, "USER_ROLE_PRIVS"):
		count := c.d.exportRoles
		if strings.Contains(query, "IMP_FULL_DATABASE") {
			count = c.d.importRoles
		}
		return one(int64(count)), nil
	case strings.Contains(query, "PRODUCT_COMPONENT_VERSION"):
		return one(c.d.version), nil
	case strings.Contains(query, "USER_DATAPUMP_JOBS"):
		c.d.record("jobstate")
		if c.d.jobStateRow != "" {
			return one(c.d.jobStateRow), nil
		}
		return &datapumpTestRows{}, nil // 无行 = 任务已干净完成并自清理
	case strings.Contains(query, "SESSION_USER"):
		return one(c.d.user), nil
	}
	return nil, fmt.Errorf("unexpected query: %s", query)
}

type datapumpTestConnector struct{ d *datapumpTestDriver }

func (c datapumpTestConnector) Driver() driver.Driver                        { return c.d }
func (c datapumpTestConnector) Connect(context.Context) (driver.Conn, error) { return c.d.Open("") }

func datapumpTestServer(t *testing.T) (*server, *datapumpTestDriver) {
	t.Helper()
	d := &datapumpTestDriver{user: "ALICE", version: "19.0.0.0.0", dirPath: "/u01/dumps", privCount: 2}
	db := sql.OpenDB(datapumpTestConnector{d})
	s := newServer()
	s.db = db
	t.Cleanup(func() {
		s.closeDatapump()
		_ = s.disconnect()
	})
	return s, d
}

// datapumpFastPoll 关掉服务器端的 GET_STATUS 等待、改用客户端节奏控制，
// 让测试里的循环以毫秒级迭代.
func datapumpFastPoll(t *testing.T) {
	t.Helper()
	prevTimeout, prevLease, prevDelay := datapumpStatusTimeoutSec, datapumpLeaseDuration, datapumpIdlePollDelay
	datapumpStatusTimeoutSec, datapumpLeaseDuration, datapumpIdlePollDelay = 0, time.Minute, 2*time.Millisecond
	t.Cleanup(func() {
		datapumpStatusTimeoutSec, datapumpLeaseDuration, datapumpIdlePollDelay = prevTimeout, prevLease, prevDelay
	})
}

func datapumpValidRequest(operation string) datapumpStartRequest {
	return datapumpStartRequest{
		OperationID: operation,
		Kind:        datapumpKindExport,
		Mode:        datapumpModeSchema,
		Directory:   "DUMP_DIR",
		DumpFile:    "exp.dmp",
		Schemas:     []string{"ALICE"},
	}
}

func datapumpWaitState(t *testing.T, s *server, operation, want string) datapumpStatusResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		result := s.datapumpStatusResultFor(operation)
		if result.State == want {
			return result
		}
		if time.Now().After(deadline) {
			t.Fatalf("state %q never reached; last result: %+v", want, result)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDatapumpStartRejectsInvalidRequestBeforeDatabase(t *testing.T) {
	s, d := datapumpTestServer(t)
	request := datapumpValidRequest("op-1")
	request.Directory = ""
	result := s.startDatapump(request)
	if result.State != "failed" || result.Reason != "datapump_name_required" {
		t.Fatalf("expected validation failure, got %+v", result)
	}
	if result.Context["field"] != "directory" {
		t.Errorf("expected field context, got %v", result.Context)
	}
	if got := d.eventString(); got != "" {
		t.Errorf("validation must not touch the database, got events %q", got)
	}
}

func TestDatapumpPreflightFailures(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*datapumpTestDriver, *datapumpStartRequest)
		wantReason string
		wantIn     map[string]string
	}{
		{
			name:       "directory missing",
			mutate:     func(d *datapumpTestDriver, _ *datapumpStartRequest) { d.dirPath = "" },
			wantReason: "datapump_preflight_directory_missing",
			wantIn:     map[string]string{"directory": "DUMP_DIR"},
		},
		{
			name:       "directory without write",
			mutate:     func(d *datapumpTestDriver, _ *datapumpStartRequest) { d.privCount = 1 },
			wantReason: "datapump_preflight_directory_no_privilege",
			wantIn:     map[string]string{"path": "/u01/dumps", "user": "ALICE"},
		},
		{
			name:       "ancient database",
			mutate:     func(d *datapumpTestDriver, _ *datapumpStartRequest) { d.version = "10.2.0.4.0" },
			wantReason: "datapump_preflight_version_unsupported",
			wantIn:     map[string]string{"version": "10.2.0.4.0"},
		},
		{
			name: "cross schema without full role",
			mutate: func(_ *datapumpTestDriver, r *datapumpStartRequest) {
				r.Schemas = []string{"SCOTT"}
			},
			wantReason: "datapump_preflight_cross_schema_denied",
			wantIn:     map[string]string{"role": "EXP_FULL_DATABASE", "user": "ALICE"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, d := datapumpTestServer(t)
			request := datapumpValidRequest("op-1")
			tt.mutate(d, &request)
			result := s.startDatapump(request)
			if result.State != "failed" || result.Reason != tt.wantReason {
				t.Fatalf("want (%q), got %+v", tt.wantReason, result)
			}
			for key, value := range tt.wantIn {
				if result.Context[key] != value {
					t.Errorf("context[%q] = %q, want %q (full: %v)", key, result.Context[key], value, result.Context)
				}
			}
			if strings.Contains(d.eventString(), "open") {
				t.Error("preflight failure must run before OPEN")
			}
		})
	}
}

func TestDatapumpCrossSchemaAllowedWithFullRole(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)
	d.exportRoles = 1
	d.statusSeq = []datapumpStatusValues{{JobState: "COMPLETED", Percent: 100}}
	request := datapumpValidRequest("op-1")
	request.Schemas = []string{"SCOTT"}

	result := s.startDatapump(request)
	if result.State != "running" {
		t.Fatalf("expected running, got %+v", result)
	}
	datapumpWaitState(t, s, "op-1", "succeeded")
	if !strings.Contains(d.eventString(), "open") {
		t.Error("expected the open block to run")
	}
}

func TestDatapumpExportLifecycle(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)
	d.statusSeq = []datapumpStatusValues{
		{JobState: "EXECUTING", Percent: 42, PhaseCode: 5},
		{JobState: "COMPLETED", Percent: 100},
	}

	result := s.startDatapump(datapumpValidRequest("op-1"))
	if result.State != "running" || result.JobName != "DBX_EXPORT_OPX1" {
		t.Fatalf("unexpected start result: %+v", result)
	}
	// 进度由轮询 goroutine 异步产出：等待第一个快照出现，
	// 而不是假设循环已经跑过一轮.
	deadline := time.Now().Add(3 * time.Second)
	var running datapumpStatusResult
	for {
		running = s.datapumpStatusResultFor("op-1")
		if running.Percent > 0 || running.State != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no progress snapshot arrived: %+v", running)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// status RPC 必须把租约期限往后推.
	leaseEntry := s.datapumps["op-1"]
	leaseEntry.mu.Lock()
	leaseAfter := leaseEntry.leaseDeadline
	leaseEntry.mu.Unlock()
	if time.Until(leaseAfter) < datapumpLeaseDuration-time.Second {
		t.Error("status RPC must renew the lease")
	}

	final := datapumpWaitState(t, s, "op-1", "succeeded")
	if final.Percent != 100 || final.JobState != "COMPLETED" {
		t.Errorf("unexpected final snapshot: %+v", final)
	}
	events := d.eventString()
	if !strings.Contains(events, "detach") {
		t.Errorf("completed jobs must detach, events: %s", events)
	}
	if strings.Contains(events, "stop") {
		t.Errorf("successful runs must not STOP_JOB, events: %s", events)
	}
}

func TestDatapumpCompletedWithErrorsFails(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)
	d.statusSeq = []datapumpStatusValues{{
		JobState:   "COMPLETED WITH ERRORS",
		Percent:    100,
		ErrorCount: 2,
		ErrorText:  "ORA-31693: table data object failed to load\n",
	}}

	s.startDatapump(datapumpValidRequest("op-1"))
	final := datapumpWaitState(t, s, "op-1", "failed")
	if final.Reason != "datapump_completed_with_errors" {
		t.Errorf("reason = %q, want datapump_completed_with_errors", final.Reason)
	}
	if final.ErrorCount != 2 || !strings.Contains(final.ErrorText, "ORA-31693") {
		t.Errorf("error snapshot must reach the host: %+v", final)
	}
	if !strings.Contains(d.eventString(), "detach") {
		t.Error("terminal jobs must still detach")
	}
}

func TestDatapumpStopCancelsRunningJob(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)
	// 不脚本化终态：任务保持 EXECUTING 直到被停止.
	s.startDatapump(datapumpValidRequest("op-1"))

	result := s.stopDatapump("op-1")
	if result.State != "cancelled" {
		t.Fatalf("stop must land in cancelled, got %+v", result)
	}
	if !d.stopSeen {
		t.Error("stop must execute STOP_JOB on the server")
	}
	status := s.datapumpStatusResultFor("op-1")
	if status.State != "cancelled" {
		t.Errorf("post-cancel status = %+v", status)
	}
}

func TestDatapumpLeaseExpiryStopsJob(t *testing.T) {
	s, d := datapumpTestServer(t)
	prevTimeout, prevLease, prevWait := datapumpStatusTimeoutSec, datapumpLeaseDuration, datapumpStopWait
	datapumpStatusTimeoutSec, datapumpLeaseDuration, datapumpStopWait = 0, 50*time.Millisecond, 2*time.Second
	t.Cleanup(func() { datapumpStatusTimeoutSec, datapumpLeaseDuration, datapumpStopWait = prevTimeout, prevLease, prevWait })

	s.startDatapump(datapumpValidRequest("op-1"))
	// 不发 status RPC：租约必须过期且循环必须自动停止任务.
	deadline := time.Now().Add(3 * time.Second)
	for {
		leaseEntry := s.datapumps["op-1"]
		leaseEntry.mu.Lock()
		state := leaseEntry.state
		leaseEntry.mu.Unlock()
		if state == "lease_expired" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("lease never expired, state %q", state)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !d.stopSeen {
		t.Error("lease expiry must STOP_JOB the orphaned job")
	}
}

func TestDatapumpStartIdempotencyAndConcurrent(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)

	first := s.startDatapump(datapumpValidRequest("op-1"))
	if first.State != "running" {
		t.Fatalf("first start failed: %+v", first)
	}
	retry := s.startDatapump(datapumpValidRequest("op-1"))
	if retry.State != "running" || retry.JobName != first.JobName {
		t.Errorf("idempotent retry must return the live job: %+v", retry)
	}
	if strings.Count(d.eventString(), "open") != 1 {
		t.Errorf("retry must not open a second job, events: %s", d.eventString())
	}
	// 多任务：第二个不同 operationId 的任务应该成功启动，不再报 busy。
	other := s.startDatapump(datapumpValidRequest("op-2"))
	if other.State != "running" {
		t.Errorf("second concurrent job must succeed (multi-task): %+v", other)
	}
}

func TestDatapumpCleanCompletionAfterHandleInvalidation(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)
	// 第一轮正常执行，第二轮 GET_STATUS 抛 ORA-31626（任务完成、句柄失效），
	// 任务表已无该行 → 引擎应判定为成功而不是 job_lost。
	d.failStage = "status"
	s.startDatapump(datapumpValidRequest("op-1"))
	final := datapumpWaitState(t, s, "op-1", "succeeded")
	if final.Reason != "" {
		t.Errorf("clean completion must not carry a failure reason: %+v", final)
	}
}

func TestDatapumpHandleInvalidationWithResidualJobRow(t *testing.T) {
	s, d := datapumpTestServer(t)
	datapumpFastPoll(t)
	d.failStage = "status"
	d.jobStateRow = "NOT RUNNING" // 任务行还在 = 非正常完成
	s.startDatapump(datapumpValidRequest("op-1"))
	final := datapumpWaitState(t, s, "op-1", "failed")
	if final.Reason != "datapump_job_lost" {
		t.Errorf("residual job row must stay job_lost, got %+v", final)
	}
}

func TestDatapumpStatusUnknownOperation(t *testing.T) {
	s, _ := datapumpTestServer(t)
	result := s.datapumpStatusResultFor("nope")
	if result.State != "failed" || result.Reason != "datapump_session_unavailable" {
		t.Fatalf("unexpected result for unknown operation: %+v", result)
	}
}
