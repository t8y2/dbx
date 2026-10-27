package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
)

// Preserve the thin driver's optional interfaces (notably transaction options,
// cancellation and named values) while handling query panics below database/sql.
// Recovering above sql.DB.QueryContext skips its releaseConn call; above
// sql.Tx.QueryContext it also leaves the transaction's read lock held.
type oracleThinConnection interface {
	driver.Conn
	driver.ConnBeginTx
	driver.ConnPrepareContext
	driver.QueryerContext
	driver.ExecerContext
	driver.Pinger
	driver.NamedValueChecker
	driver.SessionResetter
}

type oracleQueryConnector struct{ driver.Connector }

func (c oracleQueryConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	thin, ok := conn.(oracleThinConnection)
	if !ok {
		_ = conn.Close()
		return nil, fmt.Errorf("Oracle thin connection does not implement the required context interfaces")
	}
	return &oracleQueryConnection{oracleThinConnection: thin}, nil
}

type oracleQueryConnection struct {
	oracleThinConnection
	// database/sql serializes access to a driver connection, including IsValid.
	failed error
}

func (c *oracleQueryConnection) unusableError() error {
	var decodeErr oracleProtocolDecodeError
	if errors.As(c.failed, &decodeErr) {
		return fmt.Errorf("Oracle connection is unusable after a response decode error; roll back the transaction or reconnect: %w", c.failed)
	}
	return fmt.Errorf("Oracle connection is unusable after a driver panic; roll back the transaction or reconnect: %w", c.failed)
}

func (c *oracleQueryConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (rows driver.Rows, err error) {
	if c.failed != nil {
		return nil, c.unusableError()
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			c.failed = oracleDriverPanicError{value: recovered}
			rows, err = nil, c.unusableError()
		}
	}()
	rows, err = c.oracleThinConnection.QueryContext(ctx, query, args)
	if isOracleProtocolDecodeFailure(err) {
		// The driver stopped reading in the middle of the response, so the rest
		// of it is still on the wire and the next call on this session reads it
		// as its own reply (issue #13667). Retire the session like a panic does.
		c.failed = oracleProtocolDecodeError{err: err}
		return nil, c.failed
	}
	return rows, err
}

// oracleProtocolDecodeError marks a go-ora failure to decode a server response.
// It keeps the driver's message so callers see the original error text.
type oracleProtocolDecodeError struct{ err error }

func (e oracleProtocolDecodeError) Error() string { return e.err.Error() }

func (e oracleProtocolDecodeError) Unwrap() error { return e.err }

// isOracleProtocolDecodeFailure reports whether err is one of the go-ora errors
// raised when it misreads a response, for example on a NULL value of an object
// type such as MDSYS.SDO_GEOMETRY. Server errors (ORA-xxxxx) carry none of these
// messages, so they leave the session in service.
func isOracleProtocolDecodeFailure(err error) bool {
	if err == nil {
		return false
	}
	message := err.Error()
	return strings.Contains(message, "TTC error: received code ") ||
		strings.Contains(message, "invalid size for GetInt") ||
		strings.Contains(message, "invalid NUMBER")
}

// oracleConnPoisoned reports whether a driver panic or a response decode error
// already made conn unusable.
func oracleConnPoisoned(conn *sql.Conn) bool {
	poisoned := false
	_ = conn.Raw(func(driverConn any) error {
		guarded, ok := driverConn.(*oracleQueryConnection)
		poisoned = ok && guarded.failed != nil
		return nil
	})
	return poisoned
}

// Invalidate via Validator, not ErrBadConn: ErrBadConn would tell database/sql
// to replay the original statement, even when it has already acquired locks or
// invoked a function with side effects. The original panic remains diagnostic.
func (c *oracleQueryConnection) IsValid() bool { return c.failed == nil }

func (c *oracleQueryConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if c.failed != nil {
		return nil, c.unusableError()
	}
	return c.oracleThinConnection.ExecContext(ctx, query, args)
}

func (c *oracleQueryConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if c.failed != nil {
		return nil, c.unusableError()
	}
	return c.oracleThinConnection.PrepareContext(ctx, query)
}

func (c *oracleQueryConnection) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *oracleQueryConnection) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if c.failed != nil {
		return nil, c.unusableError()
	}
	tx, err := c.oracleThinConnection.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &oracleQueryTransaction{Tx: tx, conn: c}, nil
}

func (c *oracleQueryConnection) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

type oracleQueryTransaction struct {
	driver.Tx
	conn *oracleQueryConnection
}

func (t *oracleQueryTransaction) Commit() error {
	if t.conn.failed != nil {
		// sql.Tx considers Commit final even when it returns an error. Roll back
		// instead of committing a transaction whose query outcome is uncertain.
		err := t.Tx.Rollback()
		if err != nil {
			return fmt.Errorf("%w (rollback failed: %v)", t.conn.unusableError(), err)
		}
		return t.conn.unusableError()
	}
	return t.Tx.Commit()
}
