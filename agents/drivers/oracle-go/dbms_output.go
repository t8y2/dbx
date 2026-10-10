package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	go_ora "github.com/sijms/go-ora/v2"
)

// Oracle's DBMS_OUTPUT buffer belongs to one physical session: enabling it, the
// statement that writes into it and every GET_LINE call must run on the same
// Oracle session, otherwise the buffered lines stay invisible. Normal (non-debug)
// execution therefore pins one physical connection per statement: the statement
// runs on it, DBMS_OUTPUT is enabled on it once, and the buffer is drained from
// it before the result is returned.
//
// The PL/SQL debug path (pl_debug_*) keeps reading its buffer through the
// DBX_GET_LINE helper package it installs on its own connections and is not
// involved here.

const (
	// dbmsOutputEnableSQL turns the session buffer on. The size matches what the
	// Dameng agent requests so both agents behave the same way.
	dbmsOutputEnableSQL = "BEGIN DBMS_OUTPUT.ENABLE(1000000); END;"
	// dbmsOutputMaxLines bounds a single drain: a pathological buffer must not
	// turn into an unbounded number of round trips. Batching (see
	// dbmsOutputFetchSQL below) is what keeps the bound affordable: one round trip
	// carries roughly dbmsOutputBatchBytes of output instead of a single line.
	dbmsOutputMaxLines = 10000
	// dbmsOutputBatchLines caps the lines one batched fetch may collect even when
	// they are short enough to fit several times over the byte budget.
	dbmsOutputBatchLines = 512
	// dbmsOutputBatchBytes is the framed-payload budget of one batch, in bytes and
	// in characters. It must be the *real* deliverable capacity of one OUT string
	// register, not the declared size: on Oracle 21c XE a go-ora register declared
	// with 32767 characters (go-ora sets MaxCharLen = size and
	// MaxLen = size x 4, parameter_encode.go:653-661) still refused a framed
	// payload above 8191 with ORA-06502 at the assignment to the register, and
	// because DBMS_OUTPUT.GET_LINE had already removed those lines from the
	// session buffer the whole batch was lost. 8000 keeps a margin below that
	// measured ceiling in both units.
	dbmsOutputBatchBytes = 8000
	// dbmsOutputRegisterBytes is the largest value one OUT string register can
	// actually hand back, measured by bisecting the payload on Oracle 21c XE:
	// 8191 bytes arrived, 8192 raised ORA-06502 (8186 characters / 8191 bytes was
	// the largest single line that survived, 8187 / 8192 the smallest that did
	// not). A complete line up to this size can therefore travel in one register
	// on its own; a longer one has to be truncated.
	dbmsOutputRegisterBytes = 8191
	// dbmsOutputMaxTrackedConnections bounds the per-connection bookkeeping.
	// Pooled connections come and go; forgetting the oldest entries only costs
	// one extra ENABLE on a recycled connection.
	dbmsOutputMaxTrackedConnections = 256
	// dbmsOutputLineChars is the capacity one OUT string register is declared
	// with, in characters. It is dbmsOutputRegisterBytes -- the measured ceiling,
	// not the 32767 the server would accept in principle: go-ora turns the size
	// into MaxLen = size x 4 bytes (32764 here, inside the server's own 32767-byte
	// VARCHAR2 limit, unlike the old 32767 x 4 = 131068 declaration), and the
	// server still delivers at most dbmsOutputRegisterBytes of the value. Text
	// that has to be truncated is cut in bytes (SUBSTRB), so the declared byte
	// length can never exceed what the register can carry for any charset.
	dbmsOutputLineChars = dbmsOutputRegisterBytes
	// dbmsOutputLineSafeChars is the fallback declaration for a server that
	// rejects even the measured ceiling itself. It only has to keep the
	// *declaration* inside the server's limit (4000 x 4 = 16000 bytes) and it is
	// the size the verified DBX_GET_LINE path uses (plDebugLineChars).
	dbmsOutputLineSafeChars = 4000
)

// dbmsOutputFetchSQLTemplate is the batched DBMS_OUTPUT fetch. It replaces one
// GET_LINE round trip per line with one round trip per payload:
//
//   - Every line the block reads is already gone from the session buffer, so the
//     block never reads a line it cannot deliver: it stops adding to the payload
//     while the payload still has room for a frame (the two EXIT guards), and a
//     line that does not fit the remaining room leaves in the leftover register
//     (:5) instead of being dropped. Nothing is ever "taken but not delivered".
//   - Every line is framed as "<character count><TAB><line>" so a line may
//     contain any byte (including tabs and newlines) and the client still splits
//     the payload exactly.
//   - :1 is the maximum number of lines for this batch and :2 the register
//     capacity in characters. The payload budget is the $BUDGET constant
//     substituted below, in bytes and in characters, capped by :2 so a smaller
//     register (after the fallback) also shrinks the payload; the whole-line
//     limit is $REGISTER bytes, capped by :2 the same way. Both stays inside the
//     measured register capacity. The payload (:3) and the leftover (:5) are
//     separate bind variables with separate maximum lengths -- ORA-06502 is
//     raised by the assignment that overflows its own variable, which is why each
//     register is budgeted on its own -- so it is safe for one call to carry a
//     full payload and one leftover line, and no line is ever left behind.
//   - :6 is the terminal status: 1 when the session buffer reported itself
//     empty, 2 when a complete line was carried in :5, 3 when :5 carries the
//     longest prefix of a line that no register can hold (with its original
//     character length in :7), and 0 when the batch stopped on the line bound
//     with a successful read, i.e. more lines wait.
const dbmsOutputFetchSQLTemplate = `DECLARE
  dbx_line       VARCHAR2(32767 BYTE);
  dbx_payload    VARCHAR2(32767 BYTE);
  dbx_leftover   VARCHAR2(32767 BYTE);
  dbx_status     INTEGER := 1;
  dbx_count      INTEGER := 0;
  dbx_head       INTEGER;
  dbx_need_bytes INTEGER;
  dbx_need_chars INTEGER;
  dbx_dropped    INTEGER := 0;
BEGIN
  LOOP
    EXIT WHEN dbx_count >= :1;
    -- Stop before reading another line once the payload is too full to frame
    -- one: a line that has been read has to be delivered by this call. The budget
    -- is capped by the register capacity the client declared (:2), so a smaller
    -- register after the fallback also shrinks the payload.
    EXIT WHEN LENGTHB(dbx_payload) > LEAST($BUDGET, :2) - 16 OR LENGTH(dbx_payload) > LEAST($BUDGET, :2) - 16;
    DBMS_OUTPUT.GET_LINE(dbx_line, dbx_status);
    EXIT WHEN dbx_status <> 0;
    dbx_line := NVL(dbx_line, '');
    dbx_head := LENGTH(TO_CHAR(LENGTH(dbx_line))) + 1;
    -- NVL on the accumulator's length, not just LENGTHB(dbx_payload): the payload
    -- starts NULL, and NULL + anything is NULL, so a bare LENGTHB(dbx_payload)
    -- makes dbx_need_bytes NULL on the FIRST line of every batch. The comparison
    -- below is then NULL -- not TRUE -- and control falls into the ELSE arm, which
    -- hands the single line back as dbx_leftover and exits. Measured on Oracle 19c
    -- EE: 10000 buffered lines took more than 300s, i.e. one round trip per line,
    -- instead of the ~20 the batch bounds are sized for.
    dbx_need_bytes := NVL(LENGTHB(dbx_payload), 0) + dbx_head + LENGTHB(dbx_line);
    dbx_need_chars := NVL(LENGTH(dbx_payload), 0) + dbx_head + LENGTH(dbx_line);
    IF dbx_need_bytes <= LEAST($BUDGET, :2) AND dbx_need_chars <= LEAST($BUDGET, :2) THEN
      dbx_payload := dbx_payload || TO_CHAR(LENGTH(dbx_line)) || CHR(9) || dbx_line;
      dbx_count := dbx_count + 1;
    ELSE
      IF LENGTHB(dbx_line) <= LEAST($REGISTER, :2) AND LENGTH(dbx_line) <= :2 THEN
        dbx_leftover := dbx_line;
        dbx_status := 2;
      ELSE
        dbx_dropped := LENGTH(dbx_line);
        dbx_leftover := SUBSTRB(dbx_line, 1, LEAST($REGISTER, :2));
        IF LENGTH(dbx_leftover) > :2 THEN
          dbx_leftover := SUBSTR(dbx_leftover, 1, :2);
        END IF;
        dbx_status := 3;
      END IF;
      EXIT;
    END IF;
  END LOOP;
  :3 := dbx_payload;
  :4 := dbx_count;
  :5 := dbx_leftover;
  :6 := dbx_status;
  :7 := dbx_dropped;
END;`

// dbmsOutputFetchSQL is the fetch block with its size bounds filled in.
var dbmsOutputFetchSQL = strings.NewReplacer(
	"$BUDGET", strconv.Itoa(dbmsOutputBatchBytes),
	"$REGISTER", strconv.Itoa(dbmsOutputRegisterBytes),
).Replace(dbmsOutputFetchSQLTemplate)

// queryMessage is one server message attached to a statement result. The field
// names and the optional code/detail/hint fields mirror the shared
// QueryMessage contract on the Rust side.
type queryMessage struct {
	Severity string  `json:"severity"`
	Message  string  `json:"message"`
	Code     *string `json:"code,omitempty"`
	Detail   *string `json:"detail,omitempty"`
	Hint     *string `json:"hint,omitempty"`
}

// logDBMSOutput reports a best-effort DBMS_OUTPUT failure on stderr. Buffered
// output is a diagnostic extra: it must never surface as a query error.
func logDBMSOutput(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "oracle-go: dbms_output: "+format+"\n", args...)
}

// dbmsOutputBatch is one batched fetch: the lines the server collected (in
// order, every one of them already removed from the session buffer) plus the
// batch's terminal state.
type dbmsOutputBatch struct {
	lines []string
	// leftover is one more complete line the server removed from the session
	// buffer that did not fit this payload. It belongs directly after lines.
	leftover    string
	hasLeftover bool
	// truncatedFrom is the original length in characters of the leftover when the
	// server had to cut it down to what a register can carry (> 0 means the
	// leftover is a prefix, not the whole line).
	truncatedFrom int
	// drained reports that the server buffer emptied itself during this batch.
	drained bool
}

// dbmsOutputSession is the part of one physical Oracle connection that message
// capture needs. Production code uses sqlConnDBMSOutputSession; tests substitute
// a fake so the enable/drain logic runs without a database.
type dbmsOutputSession interface {
	// identity identifies the physical connection. Two sessions that share one
	// Oracle session must return equal (and comparable) values.
	identity() any
	// exec runs a statement that returns no rows.
	exec(ctx context.Context, sqlText string) error
	// fetchLines performs one batched DBMS_OUTPUT fetch, collecting at most
	// maxLines lines.
	fetchLines(ctx context.Context, maxLines int) (dbmsOutputBatch, error)
}

// dbmsOutputTracker remembers per physical connection that DBMS_OUTPUT.ENABLE
// was already attempted. A failed attempt is remembered too: the package stays
// invisible for that session, and retrying on every statement would only add a
// round trip to every query.
type dbmsOutputTracker struct {
	mu        sync.Mutex
	attempted map[any]struct{}
}

// markAttempted reports whether this is the first attempt for the connection.
func (t *dbmsOutputTracker) markAttempted(key any) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.attempted == nil {
		t.attempted = map[any]struct{}{}
	}
	if _, exists := t.attempted[key]; exists {
		return false
	}
	if len(t.attempted) >= dbmsOutputMaxTrackedConnections {
		t.attempted = map[any]struct{}{}
	}
	t.attempted[key] = struct{}{}
	return true
}

// reset forgets every connection. It is used when the pool itself is replaced,
// so closed connections are not kept alive by the bookkeeping.
func (t *dbmsOutputTracker) reset() {
	t.mu.Lock()
	t.attempted = nil
	t.mu.Unlock()
}

// forget drops the bookkeeping of one physical connection so the next statement
// on it runs ENABLE again. A statement that calls DBMS_OUTPUT.DISABLE turns the
// buffer off for its session; without this the captured statements that follow
// would all report no output until the connection was recycled (R2).
func (t *dbmsOutputTracker) forget(key any) {
	if key == nil {
		return
	}
	t.mu.Lock()
	delete(t.attempted, key)
	t.mu.Unlock()
}

// dbmsOutputBinding remembers the OUT buffer size used by the batched fetch. It
// starts at dbmsOutputLineChars and is permanently reduced to
// dbmsOutputLineSafeChars if the server rejects a bind that large, so one
// unsupported register size can never turn every later statement's capture off.
type dbmsOutputBinding struct {
	mu       sync.Mutex
	capacity int
}

// chars reports the register size in characters, defaulting to the largest
// buffer DBMS_OUTPUT can fill.
func (b *dbmsOutputBinding) chars() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.capacity <= 0 {
		return dbmsOutputLineChars
	}
	return b.capacity
}

// downgrade falls back to the byte-safe register size, reporting whether this
// call changed it. Only the first rejection downgrades.
func (b *dbmsOutputBinding) downgrade() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.capacity == dbmsOutputLineSafeChars {
		return false
	}
	b.capacity = dbmsOutputLineSafeChars
	return true
}

// enableDBMSOutput turns the buffer on for one physical connection, exactly
// once. Failures only reach the log: a connection without EXECUTE on
// DBMS_OUTPUT must still run every statement normally.
func enableDBMSOutput(ctx context.Context, session dbmsOutputSession, tracker *dbmsOutputTracker) {
	key := session.identity()
	if key == nil {
		return
	}
	if !tracker.markAttempted(key) {
		return
	}
	if err := session.exec(ctx, dbmsOutputEnableSQL); err != nil {
		logDBMSOutput("DBMS_OUTPUT.ENABLE failed: %v", err)
	}
}

// drainDBMSOutput reads buffered lines in order until the session buffer reports
// itself empty, the limit is reached, or two consecutive fetches fail. Failures
// never fail the statement: already read lines are still returned.
//
// A failed fetch does not end the drain on its own: the fetch block is built so
// that every line it takes out of the session buffer is delivered by the same
// call, so a failure means the connection itself is in trouble and the lines
// already read are still returned (a second consecutive failure stops the loop).
func drainDBMSOutput(ctx context.Context, session dbmsOutputSession, limit int) []queryMessage {
	if limit <= 0 {
		limit = dbmsOutputMaxLines
	}
	var messages []queryMessage
	consecutiveFailures := 0
	for {
		// One line past the bound is what keeps a buffer of exactly `limit` lines
		// from being reported as truncated.
		batchLines := limit - len(messages) + 1
		if batchLines > dbmsOutputBatchLines {
			batchLines = dbmsOutputBatchLines
		}
		if batchLines < 1 {
			batchLines = 1
		}
		batch, err := session.fetchLines(ctx, batchLines)
		if err != nil {
			logDBMSOutput("DBMS_OUTPUT.GET_LINE failed: %v", err)
			consecutiveFailures++
			if consecutiveFailures >= 2 {
				return messages
			}
			continue
		}
		consecutiveFailures = 0
		if len(batch.lines) == 0 && !batch.hasLeftover && !batch.drained {
			// No line and no terminal status: reporting progress would loop.
			return messages
		}
		messages = append(messages, dbmsOutputBatchMessages(batch)...)
		if len(messages) > limit {
			// The extra line proves the buffer is bigger than the bound, so report
			// the cut and stop instead of draining it all. The lines the server
			// left behind stay in the session buffer; paths that do not capture
			// (paged reads) cannot drain them either.
			return append(messages[:limit], queryMessage{
				Severity: "INFO",
				Message:  fmt.Sprintf("DBMS_OUTPUT truncated after %d lines", limit),
			})
		}
		if batch.drained {
			return messages
		}
	}
}

// dbmsOutputBatchMessages turns one batch into result messages, keeping the
// server's order: the lines the payload carried, then the leftover line, then --
// when the server had to cut that line down to what a register can carry -- an
// INFO notice that spells out the loss. No line is ever dropped silently.
func dbmsOutputBatchMessages(batch dbmsOutputBatch) []queryMessage {
	messages := make([]queryMessage, 0, len(batch.lines)+2)
	for _, line := range batch.lines {
		messages = append(messages, queryMessage{Severity: "INFO", Message: line})
	}
	if batch.hasLeftover {
		messages = append(messages, queryMessage{Severity: "INFO", Message: batch.leftover})
	}
	if batch.truncatedFrom > 0 {
		messages = append(messages, queryMessage{
			Severity: "INFO",
			Message: fmt.Sprintf(
				"DBMS_OUTPUT line truncated to %d characters: a single line cannot exceed %d characters, the original line was %d characters long",
				utf8.RuneCountInString(batch.leftover), dbmsOutputRegisterBytes, batch.truncatedFrom,
			),
		})
	}
	return messages
}

// ensureDBMSOutput turns the buffer on for one session before a statement runs:
// Oracle discards output written while the buffer is off, so the enable has to
// precede the statement and happens once per physical connection. It never
// returns an error.
func (s *server) ensureDBMSOutput(ctx context.Context, session dbmsOutputSession) {
	enableDBMSOutput(ctx, session, &s.dbmsOutput)
}

// statementContext is the context of the statement currently executing, or a
// background context when no statement pinned one. The statement and its
// DBMS_OUTPUT capture share it so cancel_session interrupts both.
func (s *server) statementContext() context.Context {
	s.activeCancelMu.Lock()
	defer s.activeCancelMu.Unlock()
	if s.statementCtx != nil {
		return s.statementCtx
	}
	return context.Background()
}

// beginStatementContext registers the context shared by one statement and its
// DBMS_OUTPUT capture. The returned function releases it.
func (s *server) beginStatementContext() (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	s.activeCancelMu.Lock()
	previousCtx, previousCancel := s.statementCtx, s.statementCancel
	s.statementCtx, s.statementCancel = ctx, cancel
	s.activeCancelMu.Unlock()
	return ctx, func() {
		cancel()
		s.activeCancelMu.Lock()
		s.statementCtx, s.statementCancel = previousCtx, previousCancel
		s.activeCancelMu.Unlock()
	}
}

// withStatementDBMSOutput runs one statement and returns the DBMS_OUTPUT lines
// that statement produced. Capture is always best effort: the statement runs on
// every path, and a connection that cannot be pinned or enabled simply yields no
// messages.
//
// sqlText is the statement's text (DBMS_OUTPUT.DISABLE detection needs it;
// execute_transaction passes all of its statements joined by newlines).
func (s *server) withStatementDBMSOutput(sqlText string, run func() error) []queryMessage {
	// A nested call is already inside an outer capture on the same pinned
	// connection (for example execute_query_page delegating a non-SELECT
	// statement); the outer drain owns those lines.
	if s.statementConn != nil {
		_ = run()
		return nil
	}
	// An interactive transaction already pins its own physical session, so the
	// statement, ENABLE and the drain all share one Oracle session.
	if s.manualConn != nil {
		ctx, release := s.beginStatementContext()
		defer release()
		session := s.statementDBMSOutputSession(s.manualConn)
		s.ensureDBMSOutput(ctx, session)
		_ = run()
		return s.finishStatementDBMSOutput(ctx, session, sqlText)
	}
	db, err := s.requireDB()
	if err != nil {
		_ = run()
		return nil
	}
	ctx, release := s.beginStatementContext()
	defer release()
	conn, err := db.Conn(ctx)
	if err != nil {
		logDBMSOutput("capture disabled for this statement: %v", err)
		_ = run()
		return nil
	}
	previous := s.statementConn
	s.statementConn = conn
	defer func() {
		s.statementConn = previous
		_ = conn.Close()
	}()
	session := s.statementDBMSOutputSession(conn)
	s.ensureDBMSOutput(ctx, session)
	_ = run()
	return s.finishStatementDBMSOutput(ctx, session, sqlText)
}

// finishStatementDBMSOutput handles the capture bookkeeping that follows a
// statement. It runs for successful and failed statements alike: skipping the
// drain on failure left the lines of the failed statement in the session buffer,
// where the next statement reported them as its own (R3). Attributing them to
// the failed statement's result is deliberate -- when the caller turns the
// failure into an error response the messages are dropped with that result, but
// they are consumed, so they can never surface on the statement after it.
func (s *server) finishStatementDBMSOutput(ctx context.Context, session dbmsOutputSession, sqlText string) []queryMessage {
	if dbmsOutputDisablesCapture(sqlText) {
		// The statement turned the buffer off for its session, so the next
		// statement has to run ENABLE again (R2).
		s.dbmsOutput.forget(session.identity())
	}
	return drainDBMSOutput(ctx, session, dbmsOutputMaxLines)
}

// statementDBMSOutputSession adapts one pinned connection, selecting the OUT
// binding its driver understands.
func (s *server) statementDBMSOutputSession(conn *sql.Conn) dbmsOutputSession {
	return sqlConnDBMSOutputSession{conn: conn, oci: usesOCIProfile(s.params), binding: &s.dbmsOutputBinding}
}

// beginStatementTx opens a transaction on the statement's pinned physical
// connection so DBMS_OUTPUT produced by its statements can be drained from the
// same Oracle session afterwards.
func (s *server) beginStatementTx(ctx context.Context) (*sql.Tx, error) {
	if s.statementConn != nil {
		return s.statementConn.BeginTx(ctx, nil)
	}
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	return db.BeginTx(ctx, nil)
}

// sqlConnDBMSOutputSession adapts a pinned *sql.Conn to dbmsOutputSession.
type sqlConnDBMSOutputSession struct {
	conn *sql.Conn
	// oci selects the OCI (godror) driver, which binds sql.Out directly and sizes
	// an OUT string itself (32767 bytes, stmt.go:1422-1426 of godror v0.51.5, so
	// it already holds every line the server can produce). The built-in go-ora
	// driver needs its own Out type carrying the client-side buffer size the
	// payload is read back into.
	oci bool
	// binding carries the register size shared by every connection of this
	// server, so a server that rejects the largest one only pays for it once.
	binding *dbmsOutputBinding
}

func (s sqlConnDBMSOutputSession) identity() any {
	if s.conn == nil {
		return nil
	}
	var driverConn any
	// Raw only exposes the driver connection to the callback. The value is kept
	// as an opaque bookkeeping key and never used as a connection.
	if err := s.conn.Raw(func(conn any) error {
		driverConn = conn
		return nil
	}); err != nil {
		return nil
	}
	return physicalConnectionKey(driverConn)
}

func (s sqlConnDBMSOutputSession) exec(ctx context.Context, sqlText string) error {
	if s.conn == nil {
		return nil
	}
	_, err := s.conn.ExecContext(ctx, sqlText)
	return err
}

// chars reports the register size in characters the payload is read back into.
func (s sqlConnDBMSOutputSession) chars() int {
	if s.binding == nil {
		return dbmsOutputLineChars
	}
	return s.binding.chars()
}

// fetchLines runs one batched fetch through ExecContext: go-ora only recognises
// OUT binds in its Exec path (Stmt._exec) and writes the OUT destinations in
// place, while its query path binds every argument as input. go-ora also reads an
// OUT string back only when the bind declares a buffer size, which its own Out
// type carries; godror sizes sql.Out itself.
//
// The retry below is only a net for a server that rejects the register
// *declaration* itself, which happens while binding, before the block runs and
// therefore before any line leaves the session buffer. It is not a fix for an
// oversized value: the earlier version declared 32767 characters (go-ora turns
// that into MaxLen = 131068 bytes) and delivered a payload above the register's
// real 8191-byte capacity, which raised ORA-06502 at the assignment -- after
// DBMS_OUTPUT.GET_LINE had already consumed those lines, so the whole batch was
// unrecoverable and this retry only helped from the second batch on. The block
// now budgets both the payload and every single line inside the measured
// capacity (dbmsOutputBatchBytes / dbmsOutputRegisterBytes), so no assignment can
// overflow a register and this path cannot be reached by oversized text.
func (s sqlConnDBMSOutputSession) fetchLines(ctx context.Context, maxLines int) (dbmsOutputBatch, error) {
	if s.conn == nil {
		return dbmsOutputBatch{drained: true}, nil
	}
	chars := s.chars()
	batch, err := s.fetchLinesSized(ctx, maxLines, chars)
	if err == nil {
		return batch, nil
	}
	if chars != dbmsOutputLineChars || !dbmsOutputLooksLikeBindFailure(err) {
		return dbmsOutputBatch{}, err
	}
	if s.binding == nil || !s.binding.downgrade() {
		return dbmsOutputBatch{}, err
	}
	logDBMSOutput("line register reduced to %d characters after: %v", dbmsOutputLineSafeChars, err)
	return s.fetchLinesSized(ctx, maxLines, dbmsOutputLineSafeChars)
}

func (s sqlConnDBMSOutputSession) fetchLinesSized(
	ctx context.Context,
	maxLines int,
	chars int,
) (dbmsOutputBatch, error) {
	var payload string
	var count int
	var leftover string
	var status int
	var dropped int
	args := []any{maxLines, chars}
	if s.oci {
		args = append(args,
			sql.Out{Dest: &payload},
			sql.Out{Dest: &count},
			sql.Out{Dest: &leftover},
			sql.Out{Dest: &status},
			sql.Out{Dest: &dropped},
		)
	} else {
		args = append(args,
			go_ora.Out{Dest: &payload, Size: chars},
			go_ora.Out{Dest: &count},
			go_ora.Out{Dest: &leftover, Size: chars},
			go_ora.Out{Dest: &status},
			go_ora.Out{Dest: &dropped},
		)
	}
	if _, err := s.conn.ExecContext(ctx, dbmsOutputFetchSQL, args...); err != nil {
		return dbmsOutputBatch{}, err
	}
	lines, framed := dbmsOutputParsePayload(payload, count)
	if !framed {
		logDBMSOutput("ignored a malformed payload (%d lines announced, %d parsed)", count, len(lines))
	}
	batch := dbmsOutputBatch{lines: lines}
	switch status {
	case 1:
		batch.drained = true
	case 2:
		batch.leftover = leftover
		batch.hasLeftover = true
	case 3:
		// The line had to be cut to the register size, in bytes. SUBSTRB can cut
		// a multi-byte character in half, so repair the rune at the end before it
		// reaches the JSON layer.
		batch.leftover = strings.ToValidUTF8(leftover, "")
		batch.hasLeftover = true
		batch.truncatedFrom = dropped
	}
	return batch, nil
}

// dbmsOutputParsePayload splits one framed payload ("<character count><TAB>"
// before every line) back into lines. Announcements are in characters, so the
// parser counts runes and keeps working when one byte is not a whole character.
// A malformed frame stops the parse: the lines decoded so far are returned
// rather than an error, because capture is diagnostic only.
func dbmsOutputParsePayload(payload string, count int) ([]string, bool) {
	if count <= 0 {
		return nil, payload == ""
	}
	lines := make([]string, 0, count)
	remaining := payload
	for index := 0; index < count; index++ {
		separator := strings.IndexByte(remaining, '\t')
		if separator <= 0 {
			return lines, false
		}
		size, err := strconv.Atoi(remaining[:separator])
		if err != nil || size < 0 {
			return lines, false
		}
		rest := remaining[separator+1:]
		if size == 0 {
			lines = append(lines, "")
			remaining = rest
			continue
		}
		width := 0
		runes := 0
		for width < len(rest) && runes < size {
			_, runeWidth := utf8.DecodeRuneInString(rest[width:])
			width += runeWidth
			runes++
		}
		if runes < size {
			return lines, false
		}
		lines = append(lines, rest[:width])
		remaining = rest[width:]
	}
	return lines, true
}

// dbmsOutputLooksLikeBindFailure reports whether a fetch error indicates that the
// OUT register itself was refused, rather than the session or the network being
// down. Oracle reports an over-long bind as a parse/bind error: PLS-00215 for a
// length constraint, ORA-06550 for the block that could not be compiled, and
// ORA-06502/ORA-01461 for a buffer that could not hold the value.
func dbmsOutputLooksLikeBindFailure(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToUpper(err.Error())
	for _, marker := range []string{"ORA-06502", "ORA-06550", "ORA-01461", "ORA-03115", "PLS-00215"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

// dbmsOutputDisablesCapture reports whether a statement turns DBMS_OUTPUT off for
// its session. Comments are stripped first, so a commented-out
// "dbms_output.disable" keeps the bookkeeping, and quoted literals are ignored,
// so a string that merely contains the text cannot clear it either. Double quotes
// are dropped from the comparison, so the quoted spelling
// "DBMS_OUTPUT"."DISABLE" is recognised too.
func dbmsOutputDisablesCapture(sqlText string) bool {
	if !strings.Contains(strings.ToUpper(sqlText), "DISABLE") {
		return false
	}
	cleaned := dbmsOutputStripLiterals(stripStatementSQLComments(sqlText))
	normalized := strings.ToUpper(strings.Join(strings.Fields(cleaned), ""))
	return strings.Contains(strings.ReplaceAll(normalized, `"`, ""), "DBMS_OUTPUT.DISABLE")
}

// stripStatementSQLComments removes `--` and block comments from a whole
// statement through the same scanner the PL/SQL debug path uses, so the two
// cannot disagree about what a comment is.
func stripStatementSQLComments(sqlText string) string {
	inBlockComment := false
	var builder strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		builder.WriteString(plDebugStripSQLComments(line, &inBlockComment))
		builder.WriteByte('\n')
	}
	return builder.String()
}

// dbmsOutputStripLiterals blanks the contents of single-quoted string literals
// (including the q'[...]' form, whose body the plain scanner already treats as
// one literal), so text inside a literal cannot be mistaken for a call.
func dbmsOutputStripLiterals(sqlText string) string {
	var builder strings.Builder
	inLiteral := false
	for index := 0; index < len(sqlText); index++ {
		switch {
		case !inLiteral && sqlText[index] == '\'':
			inLiteral = true
			builder.WriteByte(' ')
		case inLiteral && sqlText[index] == '\'':
			if index+1 < len(sqlText) && sqlText[index+1] == '\'' {
				index++
				continue
			}
			inLiteral = false
			builder.WriteByte(' ')
		case inLiteral:
			builder.WriteByte(' ')
		default:
			builder.WriteByte(sqlText[index])
		}
	}
	return builder.String()
}

// dbmsOutputSharedConnectionKey collects driver connections that cannot be told
// apart. Holding such a value keeps its connection alive, which is why only
// reference kinds are used as keys.
type dbmsOutputSharedConnectionKey struct{}

// physicalConnectionKey returns a comparable key identifying one physical
// connection. *sql.Conn hides the driver connection, so the driver connection
// value itself is the key: holding it keeps that object alive, which also stops a
// recycled address from being mistaken for the connection that just closed.
func physicalConnectionKey(driverConn any) any {
	if driverConn == nil {
		return nil
	}
	switch reflect.TypeOf(driverConn).Kind() {
	case reflect.Pointer, reflect.Chan, reflect.UnsafePointer:
		return driverConn
	default:
		// A driver that does not hand back a reference type cannot be told apart
		// per connection; share one key instead of guessing.
		return dbmsOutputSharedConnectionKey{}
	}
}
