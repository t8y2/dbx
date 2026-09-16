package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/t8y2/dbx/agents/go-common/gohive"
)

func TestRunHiveInitStatementsExecutesAndDrainsResults(t *testing.T) {
	var resultRows *scriptedRows
	behavior := &scriptedBehavior{}
	behavior.query = func(ctx context.Context, query string) (driver.Rows, error) {
		switch query {
		case "SET hive.exec.dynamic.partition=true":
			resultRows = newScriptedRows(ctx, []string{"set"}, []string{"STRING"}, [][]driver.Value{
				{"hive.exec.dynamic.partition=true"},
			})
			return resultRows, nil
		case "USE analytics":
			return nil, &gohive.NonQueryResult{}
		default:
			return nil, errors.New("unexpected init statement")
		}
	}
	server := newScriptedServer(t, behavior)

	err := runHiveInitStatements(
		context.Background(),
		server.connection,
		[]string{"SET hive.exec.dynamic.partition=true", "USE analytics"},
		77,
	)
	if err != nil {
		t.Fatal(err)
	}
	queries, executions, _, _ := behavior.snapshot()
	if !reflect.DeepEqual(queries, []string{"SET hive.exec.dynamic.partition=true", "USE analytics"}) || len(executions) != 0 {
		t.Fatalf("unexpected init statements: queries=%v executions=%v", queries, executions)
	}
	if resultRows == nil || !resultRows.isClosed() {
		t.Fatal("initFile result set was not drained and closed")
	}
}

func TestRunHiveInitStatementsStopsOnFailure(t *testing.T) {
	behavior := &scriptedBehavior{}
	behavior.query = func(context.Context, string) (driver.Rows, error) {
		return nil, errors.New("permission denied")
	}
	server := newScriptedServer(t, behavior)

	err := runHiveInitStatements(context.Background(), server.connection, []string{"USE restricted", "USE skipped"}, 100)
	if err == nil || !strings.Contains(err.Error(), "execute Hive initFile statement: permission denied") {
		t.Fatalf("unexpected initFile error: %v", err)
	}
	queries, _, _, _ := behavior.snapshot()
	if !reflect.DeepEqual(queries, []string{"USE restricted"}) {
		t.Fatalf("initFile continued after failure: %v", queries)
	}
}
