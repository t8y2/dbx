package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugValueTestConnector struct {
	plDebugTransactionTestConnector
	execute func(string, []driver.NamedValue) (driver.Result, error)
}

func (c *plDebugValueTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.plDebugTransactionTestConnector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugValueTestConnection{conn.(*plDebugTransactionTestConnection), c.execute}, nil
}

type plDebugValueTestConnection struct {
	*plDebugTransactionTestConnection
	execute func(string, []driver.NamedValue) (driver.Result, error)
}

func (*plDebugValueTestConnection) CheckNamedValue(*driver.NamedValue) error { return nil }
func (c *plDebugValueTestConnection) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.execute(query, args)
}

func TestPLDebugNativeScalarValuesKeepNativeResultAndExactBindings(t *testing.T) {
	for _, oci := range []bool{false, true} {
		for _, result := range []sql.NullInt64{{Int64: 0, Valid: true}, {Int64: 32, Valid: true}, {Int64: 3, Valid: true}, {}} {
			calls := 0
			name := "\"Mixed.name\"\n|\x00"
			value := sql.NullString{String: "NULL|\n\x00值", Valid: true}
			c := &plDebugValueTestConnector{}
			c.execute = func(_ string, args []driver.NamedValue) (driver.Result, error) {
				calls++
				if !oci {
					out, ok := args[3].Value.(go_ora.Out)
					if !ok || out.Size != 32767 {
						t.Fatalf("scalar output buffer: %#v", args[3].Value)
					}
				}
				if args[0].Value != name || args[1].Value != 7 {
					t.Fatalf("changed variable/frame: %#v", args)
				}
				if err := plDebugManagerSetOut(args[2], result); err != nil {
					return nil, err
				}
				return driver.RowsAffected(0), plDebugManagerSetOut(args[3], value)
			}
			db := sql.OpenDB(c)
			conn, err := db.Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			got, err := plDebugNativeGetValue(context.Background(), conn, oci, name, 7)
			if (err != nil) != !result.Valid || got.Result != result || got.Value != value || calls != 1 {
				t.Fatalf("got %+v, %v, calls=%d", got, err, calls)
			}
			conn.Close()
			db.Close()
		}
	}
}

func TestPLDebugNativeSetValueNeverReplaysUncertainAssignment(t *testing.T) {
	for _, oci := range []bool{false, true} {
		for _, driverError := range []error{nil, errors.New("transport lost after execution")} {
			for _, nativeResult := range []sql.NullInt64{{}, {Int64: 0, Valid: true}, {Int64: 7, Valid: true}} {
				calls := 0
				assignment := "\"Mixed.name\" := '值|\n';"
				c := &plDebugValueTestConnector{}
				c.execute = func(_ string, args []driver.NamedValue) (driver.Result, error) {
					calls++
					if args[0].Value != 4 || args[1].Value != assignment {
						t.Fatalf("changed assignment/frame: %#v", args)
					}
					if err := plDebugManagerSetOut(args[2], nativeResult); err != nil {
						return nil, err
					}
					return driver.RowsAffected(0), driverError
				}
				db := sql.OpenDB(c)
				conn, err := db.Conn(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				result, err := plDebugNativeSetValue(context.Background(), conn, oci, 4, assignment)
				if (err != nil) != (driverError != nil || !nativeResult.Valid) || result != nativeResult || calls != 1 {
					t.Fatalf("result=%+v err=%v calls=%d", result, err, calls)
				}
				if driverError != nil && !errors.Is(err, driverError) {
					t.Fatal("lost driver error")
				}
				conn.Close()
				db.Close()
			}
		}
	}
}
