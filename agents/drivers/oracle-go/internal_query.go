package main

import (
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
)

// Internal queries are the dictionary reads DBX issues on its own (object
// inventories, source integrity checks, compiler errors, routine readback). They
// are flagged with skipServerOutput by the client.
//
// On a high-latency link the per-statement bookkeeping of a user query dominated
// them: draining DBMS_OUTPUT costs two round trips and switching CURRENT_SCHEMA one
// more, while the dictionary read itself is a single round trip. Saving one
// routine runs dozens of these reads, which is how a save reached two minutes.

// sessionSchemaCache remembers which CURRENT_SCHEMA an internal query last set on a
// physical session, so consecutive internal queries on that session skip the
// identical ALTER SESSION. It is deliberately short-lived: every request that is not
// known to leave session state untouched clears it (see keepsSessionSchemas), so a
// user statement that switched schema can never leave a stale entry behind.
type sessionSchemaCache struct {
	mu      sync.Mutex
	schemas map[any]string
}

// sessionSchemaCacheLimit bounds the entries left by connections the pool closed
// between clears; a few per pool lifetime is the expected size.
const sessionSchemaCacheLimit = 64

func (c *sessionSchemaCache) matches(key any, schema string) bool {
	if key == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, ok := c.schemas[key]
	return ok && current == schema
}

func (c *sessionSchemaCache) remember(key any, schema string) {
	if key == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.schemas == nil || len(c.schemas) >= sessionSchemaCacheLimit {
		c.schemas = map[any]string{}
	}
	c.schemas[key] = schema
}

func (c *sessionSchemaCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.schemas = nil
}

// keepsSessionSchemas reports whether a request is known not to change any
// session's CURRENT_SCHEMA. Everything else clears the cache before it runs.
func keepsSessionSchemas(method string, params map[string]json.RawMessage) bool {
	switch method {
	case "execute_query":
		return isInternalQueryRequest(params)
	case "get_object_source", "validate_connection":
		return true
	default:
		return false
	}
}

func isInternalQueryRequest(params map[string]json.RawMessage) bool {
	raw, ok := params["skipServerOutput"]
	if !ok || strings.TrimSpace(string(raw)) != "true" {
		return false
	}
	var sqlText string
	if err := json.Unmarshal(params["sql"], &sqlText); err != nil {
		return false
	}
	return isInternalReadOnlySQL(sqlText)
}

// isInternalReadOnlySQL is the write-safety gate for the internal path: only a plain
// SELECT/WITH read qualifies. DDL, DML, PL/SQL blocks and SELECT ... FOR UPDATE (which
// takes row locks) always run through the original path -- schema switched every time,
// DBMS_OUTPUT captured -- even if a caller flags them, and they clear the schema cache.
// A false negative only costs the old round trips, so the check errs on that side.
func isInternalReadOnlySQL(sqlText string) bool {
	sqlText = trimStatementSQL(sqlText)
	if !isQuerySQL(sqlText) {
		return false
	}
	return !strings.Contains(strings.ToUpper(sqlText), "FOR UPDATE")
}

// isRoutineDefinitionDDL reports a CREATE [OR REPLACE] of a stored PL/SQL unit:
// procedure, function, package (body), trigger or type (body). Creating one only
// compiles it -- no PL/SQL runs, so the statement cannot write to DBMS_OUTPUT -- and
// DBX's routine writer discards INFO messages anyway, so capturing around it was two
// to three wasted round trips per save. Views, tables, ALTER ... COMPILE, anonymous
// blocks and every other statement keep the capture.
func isRoutineDefinitionDDL(sqlText string) bool {
	object, ok := parseOracleCompiledObject(trimStatementSQL(sqlText))
	if !ok || object.action != "created" || len(object.types) != 1 {
		return false
	}
	switch object.types[0] {
	case "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY", "TRIGGER", "TYPE", "TYPE BODY":
		return true
	default:
		return false
	}
}

// runsWithoutServerOutput reports whether a flagged statement may skip DBMS_OUTPUT
// capture: a plain read, or a routine definition. Only reads may additionally reuse
// the session schema (internalSchemaCacheKey); a routine definition still switches
// CURRENT_SCHEMA on every run and clears the schema cache like any other write, and
// its compilation errors are read back on the same pinned session as before.
func runsWithoutServerOutput(opts queryOptions) bool {
	return opts.SkipServerOutput && (isInternalReadOnlySQL(opts.SQL) || isRoutineDefinitionDDL(opts.SQL))
}

// executeInternalQuery runs a statement admitted by runsWithoutServerOutput. Like a
// captured user statement it pins one physical session so the schema switch, the
// statement and any compilation-error readback share it, but it never touches
// DBMS_OUTPUT: neither a dictionary read nor compiling a routine writes to the
// buffer, and leaving it alone keeps the capture bookkeeping of user statements intact.
func (s *server) executeInternalQuery(opts queryOptions) (queryResult, error) {
	run := func() (queryResult, error) {
		result, err := s.executeQueryWithoutOutput(opts)
		if err == nil && opts.ReportCompilationErrors {
			err = s.compilationErrorForStatement(trimStatementSQL(opts.SQL))
		}
		return result, err
	}
	// Already on a pinned session (nested call or interactive transaction).
	if s.statementConn != nil {
		return run()
	}
	if s.manualConn != nil {
		_, release := s.beginStatementContext()
		defer release()
		return run()
	}
	db, err := s.requireDB()
	if err != nil {
		return run()
	}
	ctx, release := s.beginStatementContext()
	defer release()
	conn, err := db.Conn(ctx)
	if err != nil {
		return run()
	}
	previous := s.statementConn
	s.statementConn = conn
	defer func() {
		s.statementConn = previous
		if repinned := s.takeRepinnedStatementConn(); repinned != nil {
			_ = repinned.Close()
		}
		_ = conn.Close()
	}()
	return run()
}

// internalSchemaCacheKey identifies the physical session an internal query is pinned
// to, or nil when the schema switch must always run: user statements, interactive
// transactions, unpinned execution, and drivers whose connections cannot be told
// apart all keep the original behaviour.
func (s *server) internalSchemaCacheKey(opts queryOptions) any {
	if !opts.SkipServerOutput || !isInternalReadOnlySQL(opts.SQL) || s.statementConn == nil || s.manualConn != nil {
		return nil
	}
	key := pinnedConnectionKey(s.statementConn)
	if _, shared := key.(dbmsOutputSharedConnectionKey); shared {
		return nil
	}
	return key
}

func pinnedConnectionKey(conn *sql.Conn) any {
	return sqlConnDBMSOutputSession{conn: conn}.identity()
}

// applyStatementSchema switches CURRENT_SCHEMA for a statement, skipping the
// round trip when an internal query finds its pinned session already there.
func (s *server) applyStatementSchema(opts queryOptions) error {
	key := s.internalSchemaCacheKey(opts)
	if s.sessionSchemas.matches(key, opts.Schema) {
		// setSchema would also record the statement's schema for a repinned
		// replacement connection; keep that in step.
		s.statementSchema = opts.Schema
		return nil
	}
	if err := s.setSchema(opts.Schema); err != nil {
		return err
	}
	s.sessionSchemas.remember(key, opts.Schema)
	return nil
}
