package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/network"
)

type legacyJobTestDriver struct {
	nativeError                                error
	events                                     []string
	opens, commits, rollbacks, closed          int
	id                                         string
	fail                                       string
	commitError, rollbackError                 bool
	what, nextDate, interval, instance, broken string
}

func (d *legacyJobTestDriver) Open(string) (driver.Conn, error) {
	d.opens++
	return &legacyJobTestConn{d: d, id: d.opens}, nil
}

type legacyJobTestConn struct {
	d  *legacyJobTestDriver
	id int
}

func (*legacyJobTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("context APIs required")
}
func (c *legacyJobTestConn) Close() error { c.d.closed++; return nil }
func (c *legacyJobTestConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}
func (c *legacyJobTestConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	c.d.events = append(c.d.events, fmt.Sprintf("%d:begin", c.id))
	return &legacyJobTestTx{c}, nil
}
func (*legacyJobTestConn) CheckNamedValue(*driver.NamedValue) error { return nil }
func (c *legacyJobTestConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	stage := "schema"
	if strings.Contains(query, "DBMS_JOB.SUBMIT") {
		stage = "submit"
	}
	if strings.Contains(query, "DBMS_JOB.BROKEN") {
		stage = "broken"
	}
	c.d.events = append(c.d.events, fmt.Sprintf("%d:%s", c.id, stage))
	if c.d.fail == stage {
		if c.d.nativeError != nil {
			return nil, c.d.nativeError
		}
		return nil, errors.New("native body/argument must not escape in diagnostics")
	}
	if stage == "submit" {
		if strings.Contains(query, "private") {
			return nil, errors.New("body interpolated instead of bound")
		}
		for _, arg := range args {
			switch arg.Name {
			case "what":
				c.d.what = arg.Value.(string)
			case "next_date":
				c.d.nextDate = arg.Value.(string)
			case "repeat_interval":
				c.d.interval = arg.Value.(string)
			case "instance":
				c.d.instance = fmt.Sprint(arg.Value)
			}
			switch out := arg.Value.(type) {
			case sql.Out:
				*out.Dest.(*string) = c.d.id
			case go_ora.Out:
				*out.Dest.(*string) = c.d.id
			}
		}
	}
	if stage == "broken" {
		for _, arg := range args {
			if arg.Name == "broken" {
				c.d.broken = "N"
				if fmt.Sprint(arg.Value) == "1" {
					c.d.broken = "Y"
				}
			}
		}
	}
	return driver.RowsAffected(1), nil
}
func (c *legacyJobTestConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.d.events = append(c.d.events, fmt.Sprintf("%d:read", c.id))
	if c.d.fail == "read" {
		return nil, errors.New("read failed with sensitive body")
	}
	if c.d.fail == "mismatch" {
		c.d.what += "changed"
	}
	return &oracleManualTxRows{columns: []string{"JOB", "WHAT", "NEXT_DATE", "INTERVAL", "BROKEN", "INSTANCE", "LOG_USER", "PRIV_USER", "SCHEMA_USER"}, values: [][]driver.Value{{c.d.id, c.d.what, c.d.nextDate, c.d.interval, c.d.broken, c.d.instance, "Owner", "Owner", "Owner"}}}, nil
}

type legacyJobTestTx struct{ c *legacyJobTestConn }

func (t *legacyJobTestTx) Commit() error {
	t.c.d.commits++
	t.c.d.events = append(t.c.d.events, fmt.Sprintf("%d:commit", t.c.id))
	if t.c.d.commitError {
		return errors.New("commit acknowledgement lost")
	}
	return nil
}
func (t *legacyJobTestTx) Rollback() error {
	t.c.d.rollbacks++
	t.c.d.events = append(t.c.d.events, fmt.Sprintf("%d:rollback", t.c.id))
	if t.c.d.rollbackError {
		return errors.New("rollback acknowledgement lost")
	}
	return nil
}
func legacyJobServer(t *testing.T) (*server, *legacyJobTestDriver) {
	t.Helper()
	d := &legacyJobTestDriver{id: "9007199254740993"}
	db := sql.OpenDB(legacyJobTestConnector{d})
	db.SetMaxOpenConns(4)
	s := newServer()
	s.db = db
	t.Cleanup(func() { _ = s.disconnect() })
	return s, d
}

type legacyJobTestConnector struct{ d *legacyJobTestDriver }

func (c legacyJobTestConnector) Driver() driver.Driver                        { return c.d }
func (c legacyJobTestConnector) Connect(context.Context) (driver.Conn, error) { return c.d.Open("") }

const legacyJobPrepareParams = `{"operationId":"operation-a","what":"BEGIN p('private'); END;","nextDate":"2030-01-02 03:04:05","interval":"SYSDATE+1","enabled":false,"instance":0,"timeoutSecs":1}`

func legacyJobRPC(t *testing.T, s *server, method, params string) map[string]any {
	t.Helper()
	response, _ := s.handleLine(`{"jsonrpc":"2.0","id":1,"method":"` + method + `","params":` + params + `}`)
	if response.Error != nil {
		t.Fatalf("%s RPC rejected: %v", method, response.Error)
	}
	wire, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(wire), "private") || strings.Contains(string(wire), "sensitive") {
		t.Fatal("job inputs escaped through operation diagnostics")
	}
	var result map[string]any
	if err = json.Unmarshal(wire, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func TestLegacyJobRPCPinsOnePhysicalTransactionBeforeFirstCommit(t *testing.T) {
	for _, profile := range []string{"thin", "oci"} {
		t.Run(profile, func(t *testing.T) {
			s, d := legacyJobServer(t)
			s.params.DriverProfile = profile
			prepared := legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
			if prepared["phase"] != "prepared" || prepared["jobId"] != d.id {
				t.Fatalf("unexpected preparation: %v", prepared)
			}
			if got := strings.Join(d.events, ","); got != "1:begin,1:submit,1:broken,1:read" {
				t.Fatalf("unsafe initial sequence: %s", got)
			}
			if d.commits != 0 || d.closed != 0 {
				t.Fatal("prepared job was committed or its physical session was released")
			}
			legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
			if len(d.events) != 4 {
				t.Fatal("duplicate prepare resubmitted the job")
			}
			params := `{"operationId":"operation-a","jobId":"` + d.id + `"}`
			if legacyJobRPC(t, s, "commit_legacy_job", params)["phase"] != "committed" {
				t.Fatal("commit not confirmed")
			}
			legacyJobRPC(t, s, "commit_legacy_job", params)
			if d.commits != 1 || d.closed != 1 {
				t.Fatalf("commit replay or unreleased connection: %v", d.events)
			}
		})
	}
}
func TestLegacyJobRPCUnknownIDCannotCommitAndDoesNotGuessFromTheCatalog(t *testing.T) {
	s, d := legacyJobServer(t)
	d.id = ""
	result := legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
	if result["phase"] != "rolled_back" || d.commits != 0 || d.rollbacks != 1 {
		t.Fatalf("unsafe unknown ID: %v / %v", result, d.events)
	}
	if got := strings.Join(d.events, ","); got != "1:begin,1:submit,1:rollback" {
		t.Fatalf("guessed or configured an unknown ID: %s", got)
	}
	legacyJobRPC(t, s, "commit_legacy_job", `{"operationId":"operation-a","jobId":"41"}`)
	if d.commits != 0 {
		t.Fatal("committed after missing OUT ID")
	}
}

func TestLegacyJobRPCEnabledCreationStillAppliesTheChosenStateBeforeTheFirstCommit(t *testing.T) {
	s, d := legacyJobServer(t)
	params := strings.Replace(legacyJobPrepareParams, `"enabled":false`, `"enabled":true`, 1)
	result := legacyJobRPC(t, s, "prepare_legacy_job", params)
	if result["phase"] != "prepared" || d.broken != "N" || d.commits != 0 {
		t.Fatalf("initial enabled state was not prepared atomically: %v / %v", result, d.events)
	}
	found := false
	for _, capability := range legacyJobRPC(t, s, "handshake", `{}`)["capabilities"].([]any) {
		if capability == "native_job_legacy_v1" {
			found = true
		}
	}
	if !found {
		t.Fatal("legacy session protocol capability missing")
	}
}
func TestLegacyJobRPCBeforeCommitFailuresRollbackAndCleanupNeverActivates(t *testing.T) {
	for _, stage := range []string{"submit", "broken", "read", "mismatch"} {
		t.Run(stage, func(t *testing.T) {
			s, d := legacyJobServer(t)
			d.fail = stage
			result := legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
			if result["phase"] != "rolled_back" || d.commits != 0 || d.rollbacks != 1 || d.closed != 1 {
				t.Fatalf("unsafe failure cleanup: %v / %v", result, d.events)
			}
		})
	}
}

type legacyJobCodedError struct{}

func (legacyJobCodedError) Error() string { return "private native input" }
func (legacyJobCodedError) Code() int     { return 27486 }

func TestLegacyJobRPCPreservesTypedNativeCodesWithoutReturningTheNativeMessage(t *testing.T) {
	for _, cause := range []error{network.NewOracleError(27486), legacyJobCodedError{}} {
		s, d := legacyJobServer(t)
		d.fail = "submit"
		d.nativeError = cause
		result := legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
		if result["vendorCode"] != float64(27486) || result["phase"] != "rolled_back" {
			t.Fatalf("typed diagnostic lost: %v", result)
		}
	}
}

func TestLegacyJobRPCInvalidPreparationIsRejectedBeforeOpeningItsTransaction(t *testing.T) {
	for _, params := range []string{strings.Replace(legacyJobPrepareParams, "2030-01-02 03:04:05", "SYSDATE", 1), strings.Replace(legacyJobPrepareParams, `"instance":0`, `"instance":-1`, 1)} {
		s, d := legacyJobServer(t)
		if legacyJobRPC(t, s, "prepare_legacy_job", params)["phase"] != "not_started" || len(d.events) != 0 {
			t.Fatal("invalid preparation reached the database")
		}
	}
}

func TestLegacyJobRPCCommitLostResponseIsUnknownAndNeverReplayed(t *testing.T) {
	s, d := legacyJobServer(t)
	legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
	d.commitError = true
	params := `{"operationId":"operation-a","jobId":"` + d.id + `"}`
	result := legacyJobRPC(t, s, "commit_legacy_job", params)
	if result["phase"] != "unknown" || result["jobId"] != d.id {
		t.Fatalf("lost commit was not preserved: %v", result)
	}
	legacyJobRPC(t, s, "commit_legacy_job", params)
	legacyJobRPC(t, s, "rollback_legacy_job", params)
	if d.commits != 1 || d.rollbacks != 0 || d.closed != 1 {
		t.Fatalf("commit/rollback was replayed after uncertainty: %v", d.events)
	}
}
func TestLegacyJobRPCCancelRollsBackItsOwnConnectionNotTheEditorTransaction(t *testing.T) {
	s, d := legacyJobServer(t)
	if err := s.beginManualTransaction(""); err != nil {
		t.Fatal(err)
	}
	legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
	result := legacyJobRPC(t, s, "rollback_legacy_job", `{"operationId":"operation-a","jobId":"`+d.id+`"}`)
	if result["phase"] != "rolled_back" || !s.hasManualTransaction() {
		t.Fatalf("cancel touched editor transaction: %v", result)
	}
	if got := strings.Join(d.events, ","); got != "1:begin,2:begin,2:submit,2:broken,2:read,2:rollback" {
		t.Fatalf("physical sessions were mixed: %s", got)
	}
}
func TestLegacyJobRPCFailedRollbackIsUnknownAndTheConnectionIsDiscarded(t *testing.T) {
	s, d := legacyJobServer(t)
	legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
	d.rollbackError = true
	result := legacyJobRPC(t, s, "rollback_legacy_job", `{"operationId":"operation-a","jobId":"`+d.id+`"}`)
	if result["phase"] != "unknown" || d.closed != 1 || d.commits != 0 {
		t.Fatalf("unconfirmed rollback was reported as safe: %v / %v", result, d.events)
	}
}

func TestLegacyJobRPCALostPrepareResponseCanRollbackByItsOwnedOperationWithoutGuessingAnID(t *testing.T) {
	s, d := legacyJobServer(t)
	legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
	if legacyJobRPC(t, s, "commit_legacy_job", `{"operationId":"operation-a"}`)["phase"] != "unknown" || d.commits != 0 {
		t.Fatal("a missing OUT ID authorized a commit")
	}
	result := legacyJobRPC(t, s, "rollback_legacy_job", `{"operationId":"operation-a"}`)
	if result["phase"] != "rolled_back" || d.rollbacks != 1 || d.commits != 0 {
		t.Fatalf("lost OUT response prevented rollback of the owned transaction: %v / %v", result, d.events)
	}
}
func TestLegacyJobRPCMismatchedOperationCannotCommitOrReplaceThePreparedJob(t *testing.T) {
	s, d := legacyJobServer(t)
	legacyJobRPC(t, s, "prepare_legacy_job", legacyJobPrepareParams)
	result := legacyJobRPC(t, s, "commit_legacy_job", `{"operationId":"different-operation","jobId":"`+d.id+`"}`)
	if result["phase"] != "unknown" || d.commits != 0 {
		t.Fatal("foreign operation committed a prepared job")
	}
	changed := strings.Replace(legacyJobPrepareParams, "SYSDATE+1", "SYSDATE+7", 1)
	result = legacyJobRPC(t, s, "prepare_legacy_job", changed)
	if result["reason"] != "native_job_operation_mismatch" || d.commits != 0 || d.opens != 1 {
		t.Fatal("immutable preparation was replaced")
	}
	if err := s.disconnect(); err != nil {
		t.Fatal(err)
	}
	if d.commits != 0 || d.rollbacks != 1 || d.closed != 1 {
		t.Fatalf("disconnect activated or leaked a job: %v", d.events)
	}
}
