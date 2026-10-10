package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

// Adapt the existing scripted drivers to the same interfaces as go-ora. The
// production connector and database/sql still own all recovery and lifecycle.
type oracleGuardTestConnector struct{ drv driver.Driver }

func (c oracleGuardTestConnector) Driver() driver.Driver { return c.drv }

func (c oracleGuardTestConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.drv.Open("")
	return &oracleGuardTestConn{Conn: conn}, err
}

type oracleGuardTestConn struct{ driver.Conn }

func (c *oracleGuardTestConn) QueryContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	return c.Conn.(driver.QueryerContext).QueryContext(ctx, q, args)
}
func (c *oracleGuardTestConn) ExecContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	return c.Conn.(driver.ExecerContext).ExecContext(ctx, q, args)
}
func (c *oracleGuardTestConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	return c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
}
func (c *oracleGuardTestConn) PrepareContext(_ context.Context, q string) (driver.Stmt, error) {
	return c.Conn.Prepare(q)
}
func (c *oracleGuardTestConn) Ping(context.Context) error               { return nil }
func (c *oracleGuardTestConn) ResetSession(context.Context) error       { return nil }
func (c *oracleGuardTestConn) CheckNamedValue(*driver.NamedValue) error { return driver.ErrSkip }

type oracleGuardFaultDriver struct {
	oracleManualTxDriver
	queryCalls int
	closed     int
	blocked    chan struct{}
}

func (d *oracleGuardFaultDriver) Open(string) (driver.Conn, error) {
	return &oracleGuardFaultConn{oracleManualTxConn: &oracleManualTxConn{driver: &d.oracleManualTxDriver}, fault: d}, nil
}

type oracleGuardFaultConn struct {
	*oracleManualTxConn
	fault *oracleGuardFaultDriver
}

func (c *oracleGuardFaultConn) QueryContext(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	c.fault.queryCalls++
	if q == "SELECT WAIT_QUERY FROM DUAL" {
		close(c.fault.blocked)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if q == "SELECT WAIT_FETCH FROM DUAL" {
		return &oracleGuardBlockedRows{ctx: ctx, blocked: c.fault.blocked}, nil
	}
	if q == "SELECT FAULT FROM DUAL" {
		panic("injected query decode failure")
	}
	return c.oracleManualTxConn.QueryContext(ctx, q, args)
}

type oracleGuardBlockedRows struct {
	ctx     context.Context
	blocked chan struct{}
}

func (*oracleGuardBlockedRows) Columns() []string { return []string{"A"} }
func (*oracleGuardBlockedRows) Close() error      { return nil }
func (r *oracleGuardBlockedRows) Next([]driver.Value) error {
	close(r.blocked)
	<-r.ctx.Done()
	return r.ctx.Err()
}

func TestRuntimeMetadataPanicReleasesRowsBeforeAndDuringFirstPage(t *testing.T) {
	for _, method := range []string{"execute_query", "execute_query_page", "start_table_read"} {
		for _, call := range []int{1, 2, 3} {
			t.Run(fmt.Sprintf("%s/column_call_%d", method, call), func(t *testing.T) {
				steps := []oracleViewSourceQueryStep{}
				for i := 0; i < 6; i++ {
					steps = append(steps,
						oracleViewSourceQueryStep{queryContains: "SELECT 1", args: []driver.Value{}, columnsPanicText: "injected metadata failure", columnsPanicCall: call},
						oracleViewSourceQueryStep{queryContains: "SELECT 1", args: []driver.Value{}, rows: [][]driver.Value{{int64(1)}}},
					)
				}
				db, _ := openOracleViewSourceTestDB(t, steps)
				db.SetMaxOpenConns(1)
				s := newServer()
				s.db = db
				runtime := newRuntimeServer()
				runtime.sessions["a"] = &agentSession{server: s}
				for i := 0; i < 6; i++ {
					request := fmt.Sprintf(`{"id":1,"method":%q,"params":{"agentSessionId":"a","sql":"SELECT 1 FROM DUAL","pageSize":2,"timeoutSecs":1}}`, method)
					resp, shutdown := runtime.handleLine(request)
					if shutdown || resp.Error == nil {
						t.Fatalf("expected metadata panic: %+v", resp)
					}
					if db.Stats().InUse != 0 || len(s.activeRows) != 0 || len(s.sessions) != 0 || len(s.tableReadSessions) != 0 {
						t.Fatalf("panic %d leaked cursor/connection: %+v", i, db.Stats())
					}
					resp, _ = runtime.handleLine(`{"id":2,"method":"execute_query","params":{"agentSessionId":"a","sql":"SELECT 1 FROM DUAL","timeoutSecs":1}}`)
					if resp.Error != nil {
						t.Fatalf("same session is unusable: %v", resp.Error)
					}
				}
			})
		}
	}
}

func TestRuntimeCancellationRestoresQueryAndFetch(t *testing.T) {
	for _, phase := range []string{"QUERY", "FETCH"} {
		t.Run(phase, func(t *testing.T) {
			drv := &oracleGuardFaultDriver{blocked: make(chan struct{})}
			db := sql.OpenDB(oracleQueryConnector{oracleGuardTestConnector{drv}})
			db.SetMaxOpenConns(1)
			t.Cleanup(func() { db.Close() })
			s := newServer()
			s.db = db
			runtime := newRuntimeServer()
			runtime.sessions["a"] = &agentSession{server: s}
			done := make(chan response, 1)
			go func() {
				request, _ := json.Marshal(map[string]any{"id": 1, "method": "execute_query_page", "params": map[string]any{"agentSessionId": "a", "sql": "SELECT WAIT_" + phase + " FROM DUAL", "pageSize": 2}})
				resp, _ := runtime.handleLine(string(request))
				done <- resp
			}()
			select {
			case <-drv.blocked:
			case <-time.After(time.Second):
				t.Fatal("query did not reach blocking phase")
			}
			resp, _ := runtime.handleLine(`{"id":2,"method":"cancel_session","params":{"agentSessionId":"a"}}`)
			if resp.Error != nil {
				t.Fatal(resp.Error)
			}
			select {
			case resp := <-done:
				if resp.Error == nil {
					t.Fatal("cancel lost its error")
				}
			case <-time.After(time.Second):
				t.Fatal("cancel did not release session lock")
			}
			if db.Stats().InUse != 0 || len(s.activeRows) != 0 {
				t.Fatal("cancel leaked resources")
			}
			resp, _ = runtime.handleLine(`{"id":3,"method":"execute_query","params":{"agentSessionId":"a","sql":"SELECT 1 FROM DUAL","timeoutSecs":1}}`)
			if resp.Error != nil {
				t.Fatalf("query after cancel failed: %v", resp.Error)
			}
		})
	}
}
func (c *oracleGuardFaultConn) Close() error {
	c.fault.closed++
	return c.oracleManualTxConn.Close()
}

func TestOracleQueryPanicDoesNotExhaustPoolOrReplay(t *testing.T) {
	drv := &oracleGuardFaultDriver{}
	db := sql.OpenDB(oracleQueryConnector{oracleGuardTestConnector{drv}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	s := newServer()
	s.db = db
	for i := 0; i < 8; i++ {
		_, err := s.executeSelectOnce("SELECT 1 FROM DUAL", 10, 1, false)
		if err != nil {
			t.Fatal(err)
		}
		calls := drv.queryCalls
		_, err = s.queryRowsWithTimeout("SELECT FAULT FROM DUAL", nil, 1)
		var panicErr oracleDriverPanicError
		if !errors.As(err, &panicErr) {
			t.Fatalf("lost panic: %v", err)
		}
		if drv.queryCalls != calls+1 {
			t.Fatal("statement was implicitly replayed")
		}
		if stats := db.Stats(); stats.InUse != 0 || stats.OpenConnections != 0 || len(s.activeRows) != 0 {
			t.Fatalf("failure %d leaked resources: %+v active_rows=%d", i, stats, len(s.activeRows))
		}
		if drv.closed != i+1 {
			t.Fatalf("poisoned connection was not closed: %d", drv.closed)
		}
	}
	if _, err := s.executeSelectOnce("SELECT 1 FROM DUAL", 10, 1, false); err != nil {
		t.Fatal(err)
	}
}

func TestOracleQueryPanicAllowsManualTransactionCleanup(t *testing.T) {
	for _, commit := range []bool{false, true} {
		t.Run(fmt.Sprint("commit=", commit), func(t *testing.T) {
			drv := &oracleGuardFaultDriver{}
			db := sql.OpenDB(oracleQueryConnector{oracleGuardTestConnector{drv}})
			db.SetMaxOpenConns(1)
			t.Cleanup(func() { db.Close() })
			s := newServer()
			s.db = db
			if err := s.beginManualTransaction(""); err != nil {
				t.Fatal(err)
			}
			if _, err := s.queryRowsWithTimeout("SELECT FAULT FROM DUAL", nil, 1); err == nil {
				t.Fatal("expected failure")
			}
			if !s.hasManualTransaction() {
				t.Fatal("transaction state silently cleared")
			}
			calls := drv.queryCalls
			if _, err := s.executeQuery(queryOptions{SQL: "SELECT 1 FROM DUAL"}); err == nil {
				t.Fatal("poisoned transaction reused")
			}
			if _, err := s.executeQuery(queryOptions{SQL: "UPDATE t SET a=2"}); err == nil {
				t.Fatal("write ran in poisoned transaction")
			}
			if drv.queryCalls != calls || len(drv.execs) != 0 {
				t.Fatal("failed transaction reached driver again")
			}
			done := make(chan error, 1)
			go func() {
				if commit {
					done <- s.commitManualTransaction()
				} else {
					done <- s.rollbackManualTransaction()
				}
			}()
			select {
			case err := <-done:
				if (err != nil) != commit {
					t.Fatalf("unexpected cleanup error: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("panic left transaction lock held")
			}
			if drv.committed || !drv.rolledBack || s.hasManualTransaction() || db.Stats().InUse != 0 {
				t.Fatal("incorrect transaction cleanup")
			}
			if _, err := s.executeSelectOnce("SELECT 1 FROM DUAL", 10, 1, false); err != nil {
				t.Fatal(err)
			}
		})
	}
}
