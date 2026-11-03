package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"sync"
	"time"
)

var errPLDebugAllocationUnknown = errors.New("PL/SQL physical connection release is unknown; isolate the original dedicated runtime")

func newPLDebugConnector(params connectParams) (driver.Connector, error) {
	if usesOCIProfile(params) {
		return newPLDebugOCIConnector(params)
	}
	return newOracleThinConnector(params, nil)
}

type plDebugAllocation struct {
	mu                sync.Mutex
	connector         driver.Connector
	attempted         bool
	opening           bool
	retiring          bool
	unknown           bool
	closed            bool
	raw               driver.Conn
	closeDone         chan struct{}
	closeErr          error
	logoffRequired    bool
	logoffConfirmed   bool
	logoffErr         error
	rawCloseConfirmed bool
	rawCloseErr       error
	cleanupDeadline   time.Time
	active            *plDebugPhysicalCall
	oci               bool
	breakCall         func() error
	statements        map[*plDebugStatement]struct{}
	closingStatements int
	rows              map[*plDebugRows]struct{}
	closingRows       int
}

func (a *plDebugAllocation) Driver() driver.Driver { return a.connector.Driver() }

func (a *plDebugAllocation) Connect(ctx context.Context) (driver.Conn, error) {
	a.mu.Lock()
	if a.attempted || a.retiring {
		a.mu.Unlock()
		return nil, errors.New("PL/SQL physical allocation cannot reconnect or replay")
	}
	a.attempted, a.opening = true, true
	a.mu.Unlock()
	raw, err := a.connector.Connect(ctx)
	a.mu.Lock()
	a.opening = false
	a.raw = raw
	if conn, ok := raw.(interface{ Break() error }); ok {
		a.breakCall = conn.Break
	}
	if err != nil || raw == nil || ctx.Err() != nil {
		// go-ora may return no handle after opening a socket. No public API
		// establishes release in that case, or cancellation-watcher completion.
		a.unknown = true
		a.mu.Unlock()
		if err != nil {
			return nil, fmt.Errorf("%w: connect: %v", errPLDebugAllocationUnknown, err)
		}
		return nil, errPLDebugAllocationUnknown
	}
	retiring := a.retiring
	a.mu.Unlock()
	if retiring {
		if err := a.close(); err != nil {
			return nil, err
		}
		return nil, errors.New("PL/SQL allocation retired while connecting")
	}
	return &plDebugPhysicalConnection{Conn: raw, allocation: a}, nil
}

func (a *plDebugAllocation) close() error {
	a.mu.Lock()
	a.retiring = true
	if a.cleanupDeadline.IsZero() {
		a.cleanupDeadline = time.Now().Add(plDebugReleaseTimeout)
	}
	if a.active != nil {
		call := a.active
		rows := call.rows
		claimed := a.claimCancellationLocked(call)
		a.mu.Unlock()
		if rows != nil {
			go func() { _ = rows.Close() }()
		}
		if claimed {
			go a.runCancellation(call)
		}
		return errPLDebugAllocationUnknown
	}
	if len(a.statements) != 0 || len(a.rows) != 0 {
		a.mu.Unlock()
		return errPLDebugAllocationUnknown
	}
	if (a.opening || a.unknown) && a.closeDone == nil {
		a.mu.Unlock()
		return errPLDebugAllocationUnknown
	}
	if a.closeDone == nil {
		a.closeDone = make(chan struct{})
		go a.closeRaw(a.raw)
	}
	done, deadline := a.closeDone, a.cleanupDeadline
	a.mu.Unlock()
	select {
	case <-done:
		return a.closeResult()
	default:
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case <-done:
		return a.closeResult()
	case <-timer.C:
		return errPLDebugAllocationUnknown
	}
}

func (a *plDebugAllocation) closeResult() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closeErr
}

func (a *plDebugAllocation) closeRaw(raw driver.Conn) {
	var logoffErr, rawErr error
	defer func() {
		if recovered := recover(); recovered != nil {
			rawErr = fmt.Errorf("raw PL/SQL connection close panicked: %v", recovered)
		}
		a.mu.Lock()
		a.logoffErr = logoffErr
		a.rawCloseErr = rawErr
		a.rawCloseConfirmed = rawErr == nil
		a.closeErr = errors.Join(logoffErr, rawErr)
		a.closed = a.closeErr == nil
		a.unknown = a.closeErr != nil
		close(a.closeDone)
		a.mu.Unlock()
	}()
	if raw != nil {
		if original, ok := raw.(*oracleQueryConnection); ok && !a.oci {
			a.mu.Lock()
			a.logoffRequired = true
			a.mu.Unlock()
			if logoff, ok := original.oracleThinConnection.(interface{ Logoff() error }); ok {
				logoffErr = plDebugTerminalCloseStep("Logoff", logoff.Logoff)
			} else {
				logoffErr = errors.New("the original thin connection cannot confirm its Logoff acknowledgement")
			}
			a.mu.Lock()
			a.logoffConfirmed = logoffErr == nil
			a.logoffErr = logoffErr
			a.mu.Unlock()
		}
		rawErr = plDebugTerminalCloseStep("Close", raw.Close)
	}
}

func plDebugTerminalCloseStep(stage string, close func() error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("PL/SQL %s panicked: %v", stage, recovered)
		}
	}()
	return close()
}

type plDebugPhysicalConnection struct {
	driver.Conn
	allocation *plDebugAllocation
}

func (c *plDebugPhysicalConnection) Close() error { return c.allocation.close() }

func (c *plDebugPhysicalConnection) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if conn, ok := c.Conn.(driver.ConnBeginTx); ok {
		return conn.BeginTx(ctx, opts)
	}
	if opts.Isolation != 0 || opts.ReadOnly {
		return nil, errors.New("driver does not support the requested transaction options")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return c.Conn.Begin()
}

func (c *plDebugPhysicalConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	var owned *plDebugStatement
	_, err := c.allocation.exec(ctx, func(private context.Context) (driver.Result, error) {
		var stmt driver.Stmt
		var err error
		if conn, ok := c.Conn.(driver.ConnPrepareContext); ok {
			stmt, err = conn.PrepareContext(private, query)
		} else {
			stmt, err = c.Conn.Prepare(query)
		}
		if err != nil {
			return nil, err
		}
		owned = &plDebugStatement{Stmt: stmt, allocation: c.allocation}
		a := c.allocation
		a.mu.Lock()
		if a.statements == nil {
			a.statements = make(map[*plDebugStatement]struct{})
		}
		a.statements[owned] = struct{}{}
		a.mu.Unlock()
		if a.oci {
			if err := configurePLDebugOCIStatement(stmt); err != nil {
				_ = owned.Close()
				return nil, err
			}
		}
		return nil, nil
	})
	if err != nil {
		return nil, err
	}
	return owned, nil
}

func (c *plDebugPhysicalConnection) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *plDebugPhysicalConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if conn, ok := c.Conn.(driver.ExecerContext); ok {
		return c.allocation.exec(ctx, func(private context.Context) (driver.Result, error) { return conn.ExecContext(private, query, args) })
	}
	return nil, driver.ErrSkip
}

func (c *plDebugPhysicalConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if conn, ok := c.Conn.(driver.QueryerContext); ok {
		return c.allocation.query(ctx, func(private context.Context) (driver.Rows, error) { return conn.QueryContext(private, query, args) })
	}
	return nil, driver.ErrSkip
}

func (c *plDebugPhysicalConnection) CheckNamedValue(value *driver.NamedValue) error {
	_, fastExec := c.Conn.(driver.ExecerContext)
	_, fastQuery := c.Conn.(driver.QueryerContext)
	if !fastExec && !fastQuery {
		return nil
	}
	if conn, ok := c.Conn.(driver.NamedValueChecker); ok {
		return conn.CheckNamedValue(value)
	}
	return driver.ErrSkip
}

func (c *plDebugPhysicalConnection) Ping(ctx context.Context) error {
	if conn, ok := c.Conn.(driver.Pinger); ok {
		return conn.Ping(ctx)
	}
	return nil
}

func (c *plDebugPhysicalConnection) ResetSession(ctx context.Context) error {
	if conn, ok := c.Conn.(driver.SessionResetter); ok {
		return conn.ResetSession(ctx)
	}
	return nil
}

func (c *plDebugPhysicalConnection) IsValid() bool {
	if conn, ok := c.Conn.(driver.Validator); ok {
		return conn.IsValid()
	}
	return true
}

func (a *plDebugAllocation) open(ctx context.Context) (*sql.DB, *sql.Conn, error) {
	db := sql.OpenDB(a)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return db, conn, nil
}
