package faultproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgproto3"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func unitServer(t *testing.T, inject bool) *Server {
	t.Helper()
	s, e := New(Config{Upstream: fixtureAddress, Listen: "127.0.0.1:0", AllowInjection: inject, DisposableLab: true, PauseTimeout: 500 * time.Millisecond, IOTimeout: 2 * time.Second})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestConfigurationAndRules(t *testing.T) {
	for _, cfg := range []Config{{Upstream: "127.0.0.1:1"}, {Upstream: "127.0.0.1:00", DisposableLab: true}, {Upstream: "[::1]:55433", Listen: "[0:0:0:0:0:0:0:1]:55433", DisposableLab: true}, {Upstream: "example.com:5432", DisposableLab: true}, {Upstream: "127.0.0.1:1", Listen: "0.0.0.0:55433", DisposableLab: true}, {Upstream: "127.0.0.1:1", PauseTimeout: time.Hour, DisposableLab: true}} {
		if _, err := New(cfg); err == nil {
			t.Fatal("unsafe config accepted", cfg)
		}
	}
	s := unitServer(t, false)
	if _, err := s.AddRule(Rule{}); err != ErrReadOnly {
		t.Fatal(err)
	}
	s = unitServer(t, true)
	r := Rule{Phase: "execute", Action: "pause", Hits: 1, TTLMS: 1000}
	if _, err := s.AddRule(r); err == nil {
		t.Fatal("unscoped rule accepted")
	}
	r.Selector.Application = "test"
	r.TTLMS = 10
	if _, err := s.AddRule(r); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if len(s.Snapshot().Rules) != 0 {
		t.Fatal("expired rule retained")
	}
}
func TestSQLBoundaries(t *testing.T) {
	for _, sql := range []string{"SELECT 1; SELECT 2", "COPY t FROM STDIN", "CALL proc()", "DO $$BEGIN END$$", "PREPARE p AS SELECT 1", "COMMIT PREPARED 'p'", "BEGIN; COMMIT", "SELECT E'a\\'; COMMIT'", "SET standard_conforming_strings=off", "CREATE DATABASE realdb"} {
		if _, e := classify(sql); e == nil {
			t.Errorf("accepted %q", sql)
		}
	}
	for _, sql := range []string{"/* a /* nested */ */ SELECT ';'; -- tail", "SELECT $$;hidden$$", "INSERT INTO t(v) VALUES ($1)", "COMMIT", "ROLLBACK TO SAVEPOINT x", "CREATE TABLE t(id int)"} {
		if _, e := classify(sql); e != nil {
			t.Errorf("rejected %q: %v", sql, e)
		}
	}
}
func TestConcurrentRuleAndBarrier(t *testing.T) {
	s := unitServer(t, true)
	a, b := net.Pipe()
	defer b.Close()
	c := newSession(s, "c-test", a)
	defer c.stop()
	c.app = "test"
	r, e := s.AddRule(Rule{Phase: "execute", Action: "pause", Hits: 1, TTLMS: 1000, Selector: Selector{Application: "test"}})
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { done <- s.gate(c, "execute", statement{command: "SELECT"}) }()
	}
	p := waitPause(t, s, 1)[0]
	if p.RuleID != r.ID {
		t.Fatal(p)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := s.Resume(p.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := s.Resume(p.ID, false); err == nil {
		t.Fatal("double resume")
	}
}
func waitPause(t *testing.T, s *Server, n int) []Pause {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		p := s.Snapshot().Pauses
		if len(p) == n {
			return p
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("pause count did not reach", n, s.Snapshot())
	return nil
}
func integration(t *testing.T) (*Server, *pgx.Conn) {
	t.Helper()
	if os.Getenv("DBX_FAULT_LAB_TEST") != "1" {
		t.Skip("set DBX_FAULT_LAB_TEST=1 only for the disposable PG17 fixture")
	}
	t.Setenv("PGPASSFILE", t.TempDir()+"/absent")
	t.Setenv("PGSERVICEFILE", t.TempDir()+"/absent")
	t.Setenv("PGSERVICE", "")
	s := unitServer(t, true)
	if e := s.Start(); e != nil {
		t.Fatal(e)
	}
	c := connect(t, fixtureAddress, "fixture_admin")
	t.Cleanup(func() { c.Close(context.Background()) })
	return s, c
}
func connect(t *testing.T, addr, app string) *pgx.Conn {
	t.Helper()
	h, p, _ := net.SplitHostPort(addr)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, e := pgx.Connect(ctx, fmt.Sprintf("host=%s port=%s user=dbx_fault_fixture dbname=postgres sslmode=disable application_name=%s", h, p, app))
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func add(t *testing.T, s *Server, phase, action, command, app string, hits int) {
	t.Helper()
	_, e := s.AddRule(Rule{Phase: phase, Action: action, Hits: hits, TTLMS: 10000, Selector: Selector{Application: app, Command: command}})
	if e != nil {
		t.Fatal(e)
	}
}
func TestRealPreparedPauseResume(t *testing.T) {
	s, _ := integration(t)
	c := connect(t, s.Addr(), "lab_prepared")
	defer c.Close(context.Background())
	for _, name := range []string{"", "cached"} {
		if name != "" {
			if _, e := c.Prepare(context.Background(), name, "SELECT $1::int"); e != nil {
				t.Fatal(e)
			}
		}
		add(t, s, "execute", "pause", "SELECT", "lab_prepared", 1)
		done := make(chan error, 1)
		go func() {
			var n int
			sql := "SELECT $1::int"
			if name != "" {
				sql = name
			}
			e := c.QueryRow(context.Background(), sql, 42).Scan(&n)
			if e == nil && n != 42 {
				e = fmt.Errorf("value %d", n)
			}
			done <- e
		}()
		p := waitPause(t, s, 1)[0]
		select {
		case e := <-done:
			t.Fatal("executed while paused", e)
		case <-time.After(25 * time.Millisecond):
		}
		if e := s.Resume(p.ID, false); e != nil {
			t.Fatal(e)
		}
		if e := <-done; e != nil {
			t.Fatal(e)
		}
	}
	bytes, _ := json.Marshal(s.Snapshot())
	if strings.Contains(string(bytes), "SELECT $1") || strings.Contains(string(bytes), "SecretKey") || strings.Contains(string(bytes), "parameters") {
		t.Fatal("raw protocol data leaked")
	}
}
func TestRealGORMCommitAbortAndLocks(t *testing.T) {
	s, admin := integration(t)
	ctx := context.Background()
	if _, e := admin.Exec(ctx, "CREATE TABLE IF NOT EXISTS fault_items (id bigint PRIMARY KEY, value text)"); e != nil {
		t.Fatal(e)
	}
	if _, e := admin.Exec(ctx, "TRUNCATE fault_items"); e != nil {
		t.Fatal(e)
	}
	h, p, _ := net.SplitHostPort(s.Addr())
	g, e := gorm.Open(postgres.Open(fmt.Sprintf("host=%s port=%s user=dbx_fault_fixture dbname=postgres sslmode=disable application_name=lab_gorm", h, p)), &gorm.Config{PrepareStmt: true, Logger: logger.Default.LogMode(logger.Silent)})
	if e != nil {
		t.Fatal(e)
	}
	sqlDB, _ := g.DB()
	defer sqlDB.Close()
	type item struct {
		ID    int64
		Value string
	}
	if e = g.Table("fault_items").Create(&item{ID: 1, Value: "original-success"}).Error; e != nil {
		t.Fatal(e, s.Snapshot())
	}
	add(t, s, "commit", "abort", "COMMIT", "lab_gorm", 1)
	e = g.Transaction(func(tx *gorm.DB) error {
		if e := tx.Exec("SELECT pg_advisory_xact_lock(?)", 728192).Error; e != nil {
			return e
		}
		return tx.Table("fault_items").Create(&item{ID: 2, Value: "must-not-commit"}).Error
	})
	if e == nil {
		t.Fatal("forced abort reported success")
	}
	deadline := time.Now().Add(2 * time.Second)
	released := false
	for time.Now().Before(deadline) {
		var ok bool
		if e = admin.QueryRow(ctx, "SELECT pg_try_advisory_lock(728192)").Scan(&ok); e != nil {
			t.Fatal(e)
		}
		if ok {
			released = true
			admin.Exec(ctx, "SELECT pg_advisory_unlock(728192)")
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !released {
		t.Fatal("backend lock not released")
	}
	var count int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM fault_items").Scan(&count); e != nil || count != 1 {
		t.Fatal("abort committed data or original success lost", count, e)
	}
	found := false
	for _, e := range s.Snapshot().Events {
		if e.Kind == "injected_abort" && e.Command == "COMMIT" && e.Outcome == "not_forwarded" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing before-commit event")
	}
}
func TestRealErrorSyncRecovery(t *testing.T) {
	s, _ := integration(t)
	c := connect(t, s.Addr(), "lab_error")
	defer c.Close(context.Background())
	if _, e := c.Exec(context.Background(), "SELECT 1 / $1::int", 0); e == nil {
		t.Fatal("expected upstream error")
	}
	var n int
	if e := c.QueryRow(context.Background(), "SELECT $1::int", 7).Scan(&n); e != nil || n != 7 {
		t.Fatal("Sync recovery failed", n, e)
	}
}
func TestRealPauseTimeoutAndCancel(t *testing.T) {
	for _, cancelCase := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelCase), func(t *testing.T) {
			s, _ := integration(t)
			c := connect(t, s.Addr(), "lab_cancel")
			defer c.Close(context.Background())
			add(t, s, "execute", "pause", "SELECT", "lab_cancel", 1)
			done := make(chan error, 1)
			go func() { _, e := c.Exec(context.Background(), "SELECT $1::int", 1); done <- e }()
			waitPause(t, s, 1)
			if cancelCase {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				if e := c.PgConn().CancelRequest(ctx); e != nil {
					t.Fatal(e)
				}
			}
			select {
			case e := <-done:
				if e == nil {
					t.Fatal("pause unexpectedly succeeded")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("cleanup stuck")
			}
			waitPause(t, s, 0)
		})
	}
}
func TestRealRunningCancel(t *testing.T) {
	s, _ := integration(t)
	c := connect(t, s.Addr(), "lab_running_cancel")
	defer c.Close(context.Background())
	done := make(chan error, 1)
	go func() { _, e := c.Exec(context.Background(), "SELECT pg_sleep($1)", 1); done <- e }()
	time.Sleep(75 * time.Millisecond)
	if e := c.PgConn().CancelRequest(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := <-done; e == nil {
		t.Fatal("running cancel ineffective")
	}
	if _, e := c.Exec(context.Background(), "SELECT 1"); e != nil {
		t.Fatal("cancel Sync recovery", e)
	}
}
func TestRealConnectionDropAndUnsupported(t *testing.T) {
	s, admin := integration(t)
	add(t, s, "connect", "drop", "", "lab_drop", 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	h, p, _ := net.SplitHostPort(s.Addr())
	c, e := pgx.Connect(ctx, fmt.Sprintf("host=%s port=%s user=dbx_fault_fixture dbname=postgres sslmode=disable application_name=lab_drop", h, p))
	if e == nil {
		c.Close(ctx)
		t.Fatal("connection drop failed")
	}
	c = connect(t, s.Addr(), "lab_unsupported")
	defer c.Close(ctx)
	if _, e = c.Exec(ctx, "CREATE TABLE fault_forbidden(id int); SELECT 1"); e == nil {
		t.Fatal("multi-statement accepted")
	}
	var absent bool
	if e = admin.QueryRow(ctx, "SELECT to_regclass('fault_forbidden') IS NULL").Scan(&absent); e != nil || !absent {
		t.Fatal("unsupported SQL reached upstream", absent, e)
	}
}

func TestRealExtendedImplicitCommitAbort(t *testing.T) {
	s, admin := integration(t)
	ctx := context.Background()
	admin.Exec(ctx, "CREATE TABLE IF NOT EXISTS fault_implicit (id int PRIMARY KEY)")
	admin.Exec(ctx, "TRUNCATE fault_implicit")
	c := connect(t, s.Addr(), "lab_implicit")
	defer c.Close(ctx)
	add(t, s, "commit", "abort", "SYNC", "lab_implicit", 1)
	if _, e := c.Exec(ctx, "INSERT INTO fault_implicit(id) VALUES ($1)", 1); e == nil {
		t.Fatal("implicit commit unexpectedly succeeded")
	}
	var count int
	if e := admin.QueryRow(ctx, "SELECT count(*) FROM fault_implicit").Scan(&count); e != nil || count != 0 {
		t.Fatal("implicit aborted transaction committed", count, e)
	}
}
func TestRealSimpleAutocommitCommitGateFailsClosed(t *testing.T) {
	s, admin := integration(t)
	ctx := context.Background()
	c := connect(t, s.Addr(), "lab_simple")
	defer c.Close(ctx)
	add(t, s, "commit", "abort", "", "lab_simple", 1)
	if _, e := c.Exec(ctx, "CREATE TABLE fault_simple_forbidden(id int)"); e == nil {
		t.Fatal("unavailable boundary silently ignored")
	}
	var absent bool
	if e := admin.QueryRow(ctx, "SELECT to_regclass('fault_simple_forbidden') IS NULL").Scan(&absent); e != nil || !absent {
		t.Fatal("simple autocommit statement reached upstream")
	}
}
func TestRealTLSRequiredFails(t *testing.T) {
	s, _ := integration(t)
	h, p, _ := net.SplitHostPort(s.Addr())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c, e := pgx.Connect(ctx, fmt.Sprintf("host=%s port=%s user=dbx_fault_fixture dbname=postgres sslmode=require", h, p))
	if e == nil {
		c.Close(ctx)
		t.Fatal("TLS required silently downgraded")
	}
}

func TestLostCommitReplyIsUnknown(t *testing.T) {
	t.Setenv("PGPASSFILE", t.TempDir()+"/absent")
	t.Setenv("PGSERVICEFILE", t.TempDir()+"/absent")
	t.Setenv("PGSERVICE", "")
	upstream, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer upstream.Close()
	seen := make(chan string, 2)
	go func() {
		conn, err := upstream.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		b := pgproto3.NewBackend(conn, conn)
		if _, e := b.ReceiveStartupMessage(); e != nil {
			return
		}
		b.Send(&pgproto3.AuthenticationOk{})
		b.Send(&pgproto3.ParameterStatus{Name: "server_version", Value: "17.11"})
		b.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
		b.Flush()
		for {
			m, e := b.Receive()
			if e != nil {
				return
			}
			q, ok := m.(*pgproto3.Query)
			if !ok {
				return
			}
			seen <- q.String
			if strings.EqualFold(q.String, "COMMIT") {
				return
			}
			b.Send(&pgproto3.CommandComplete{CommandTag: []byte("BEGIN")})
			b.Send(&pgproto3.ReadyForQuery{TxStatus: 'T'})
			b.Flush()
		}
	}()
	s, e := New(Config{Upstream: upstream.Addr().String(), Listen: "127.0.0.1:0", DisposableLab: true, IOTimeout: time.Second})
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	if e = s.Start(); e != nil {
		t.Fatal(e)
	}
	c := connect(t, s.Addr(), "unknown")
	defer c.Close(context.Background())
	if _, e = c.Exec(context.Background(), "BEGIN"); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Exec(context.Background(), "COMMIT"); e == nil {
		t.Fatal("lost commit reply succeeded")
	}
	if <-seen != "BEGIN" || <-seen != "COMMIT" {
		t.Fatal("commit was not sent")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, event := range s.Snapshot().Events {
			if event.Kind == "disconnected" && event.Outcome == "unknown" {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("unknown outcome not recorded", s.Snapshot())
}
func TestRealPipelineFailsClosed(t *testing.T) {
	s, admin := integration(t)
	ctx := context.Background()
	admin.Exec(ctx, "CREATE TABLE IF NOT EXISTS fault_pipeline(id int PRIMARY KEY)")
	admin.Exec(ctx, "TRUNCATE fault_pipeline")
	c := connect(t, s.Addr(), "lab_pipeline")
	defer c.Close(ctx)
	pipeline := c.PgConn().StartPipeline(ctx)
	pipeline.SendQueryParams("INSERT INTO fault_pipeline(id) VALUES (1)", nil, nil, nil, nil)
	pipeline.SendQueryParams("INSERT INTO fault_pipeline(id) VALUES (2)", nil, nil, nil, nil)
	e := pipeline.Sync()
	if e == nil {
		e = pipeline.Close()
	}
	if e == nil {
		t.Fatal("unsupported pipeline accepted")
	}
	var n int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM fault_pipeline").Scan(&n); e != nil || n != 0 {
		t.Fatal("partial pipeline committed", n, e)
	}
}
func TestRealSavepointOutcome(t *testing.T) {
	s, _ := integration(t)
	c := connect(t, s.Addr(), "lab_savepoint")
	defer c.Close(context.Background())
	for _, q := range []string{"BEGIN", "SAVEPOINT a", "ROLLBACK TO SAVEPOINT a", "RELEASE SAVEPOINT a", "COMMIT"} {
		if _, e := c.Exec(context.Background(), q); e != nil {
			t.Fatal(e)
		}
	}
	for _, e := range s.Snapshot().Events {
		if e.Kind == "transaction_result" && e.Outcome == "rolled_back" {
			t.Fatal("savepoint reported whole transaction rollback")
		}
	}
}
func TestRealConcurrentBarriers(t *testing.T) {
	s, _ := integration(t)
	a := connect(t, s.Addr(), "lab_parallel")
	b := connect(t, s.Addr(), "lab_parallel")
	defer a.Close(context.Background())
	defer b.Close(context.Background())
	add(t, s, "execute", "pause", "SELECT", "lab_parallel", 2)
	done := make(chan error, 2)
	for _, c := range []*pgx.Conn{a, b} {
		go func(c *pgx.Conn) { _, e := c.Exec(context.Background(), "SELECT $1::int", 1); done <- e }(c)
	}
	p := waitPause(t, s, 2)
	if p[0].ID == p[1].ID || p[0].ConnectionID == p[1].ConnectionID {
		t.Fatal("barriers collided")
	}
	s.Resume(p[0].ID, false)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		t.Fatal("other connection released", e)
	case <-time.After(20 * time.Millisecond):
	}
	s.Resume(p[1].ID, true)
	if e := <-done; e == nil {
		t.Fatal("abort unexpectedly succeeded")
	}
}

func TestRealSCRAMAuthentication(t *testing.T) {
	s, admin := integration(t)
	ctx := context.Background()
	if _, e := admin.Exec(ctx, "CREATE ROLE dbx_fault_scram LOGIN PASSWORD 'synthetic-fixture-only'"); e != nil {
		t.Fatal(e)
	}
	h, p, _ := net.SplitHostPort(s.Addr())
	c, e := pgx.Connect(ctx, fmt.Sprintf("host=%s port=%s user=dbx_fault_scram password=synthetic-fixture-only dbname=postgres sslmode=disable application_name=lab_scram", h, p))
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close(ctx)
	var n int
	if e = c.QueryRow(ctx, "SELECT $1::int", 9).Scan(&n); e != nil || n != 9 {
		t.Fatal(n, e)
	}
	b, _ := json.Marshal(s.Snapshot())
	if strings.Contains(string(b), "synthetic-fixture-only") {
		t.Fatal("password leaked")
	}
}
