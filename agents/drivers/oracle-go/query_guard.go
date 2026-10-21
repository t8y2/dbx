package main

import (
	"context"
	"database/sql/driver"
	"fmt"
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
	return c.oracleThinConnection.QueryContext(ctx, query, args)
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
