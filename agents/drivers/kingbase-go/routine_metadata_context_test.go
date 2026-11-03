package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"gitea.com/kingbase/gokb"
)

type routineDeadlineConnector struct {
	query func(context.Context, string) (driver.Rows, error)
}

func (connector routineDeadlineConnector) Connect(context.Context) (driver.Conn, error) {
	return &routineDeadlineConn{query: connector.query}, nil
}

func (routineDeadlineConnector) Driver() driver.Driver { return routineDeadlineDriver{} }

type routineDeadlineDriver struct{}

func (routineDeadlineDriver) Open(string) (driver.Conn, error) { return nil, driver.ErrSkip }

type routineDeadlineConn struct {
	query func(context.Context, string) (driver.Rows, error)
}

func (*routineDeadlineConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*routineDeadlineConn) Close() error                        { return nil }
func (*routineDeadlineConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }
func (connection *routineDeadlineConn) QueryContext(ctx context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	return connection.query(ctx, query)
}

func TestRoutineSourceSharesDeadlineAcrossCapabilityAndLegacyFallbacks(t *testing.T) {
	contexts := []context.Context{}
	queries := []string{}
	db := sql.OpenDB(routineDeadlineConnector{query: func(ctx context.Context, query string) (driver.Rows, error) {
		contexts = append(contexts, ctx)
		queries = append(queries, query)
		if strings.Contains(query, "p.prokind") {
			return nil, &gokb.Error{Code: gokb.ErrorCode("42703"), Message: "column p.prokind does not exist"}
		}
		for _, function := range []string{"sys_get_function_identity_arguments", "pg_get_function_identity_arguments", "sys_get_functiondef", "pg_get_functiondef"} {
			if strings.Contains(query, function+"(") {
				return nil, &gokb.Error{Code: gokb.ErrorCode("42883"), Message: "function " + function + "(oid) does not exist"}
			}
		}
		if strings.Contains(query, "SELECT COUNT(*)") {
			return &valueRows{columns: []string{"count"}, rows: [][]driver.Value{{int64(1)}}}, nil
		}
		if strings.Contains(query, "DBMS_METADATA.GET_PROCEDURE_DDL") {
			return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"CREATE PROCEDURE recovered_source"}}}, nil
		}
		return nil, errors.New("unexpected routine deadline probe query: " + query)
	}})
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	s := newServer()
	s.db = db
	started := time.Now()
	source, err := s.getObjectSourceWithSignature("public", "unique_name", "PROCEDURE", "", stringPtr("value integer"))
	finished := time.Now()
	if err != nil || source["source"] != "CREATE PROCEDURE recovered_source" {
		t.Fatalf("fallback chain failed before deadline verification: source=%v err=%v", source, err)
	}
	if len(queries) != 8 || !strings.Contains(queries[len(queries)-1], "DBMS_METADATA.GET_PROCEDURE_DDL") {
		t.Fatalf("expected kind, identity and source fallbacks followed by legacy validation: %v", queries)
	}
	deadline, ok := contexts[0].Deadline()
	if !ok || deadline.Before(started.Add(metadataTimeout)) || deadline.After(finished.Add(metadataTimeout)) {
		t.Fatalf("routine source did not forward the metadata timeout to the driver: deadline=%v present=%v", deadline, ok)
	}
	for index, ctx := range contexts {
		got, ok := ctx.Deadline()
		if !ok || !got.Equal(deadline) || ctx.Done() != contexts[0].Done() {
			t.Fatalf("fallback %d reset or lost the shared deadline: want=%v got=%v present=%v", index, deadline, got, ok)
		}
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatalf("source completion did not cancel the driver context for query %d: %v", index, ctx.Err())
		}
	}
}
