package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	go_ora "github.com/sijms/go-ora/v2"
)

// fakeDBMSOutputSession is a scripted physical session: it records what ran on it
// and hands out buffered lines, so the enable/drain logic is testable without a
// database. Its fetchLines mirrors the server-side fetch block: it collects up to
// maxLines buffered lines in one call and reports when the buffer emptied itself.
type fakeDBMSOutputSession struct {
	key      any
	lines    []string
	execErr  error
	fetchErr error
	// failFetches is how many upcoming fetches fail with fetchErr; a negative
	// value fails every fetch.
	failFetches int
	execCalls   int
	execSQL     []string
	fetchCalls  int
	// batchSizes records the line bound each fetch was asked for.
	batchSizes []int
	// leftover is handed back with the first fetch, the way the block hands back
	// the one line that did not fit the payload; truncatedFrom marks it as the
	// prefix of a longer line.
	leftover      string
	truncatedFrom int
}

func (f *fakeDBMSOutputSession) identity() any { return f.key }

func (f *fakeDBMSOutputSession) exec(_ context.Context, sqlText string) error {
	f.execCalls++
	f.execSQL = append(f.execSQL, sqlText)
	return f.execErr
}

func (f *fakeDBMSOutputSession) fetchLines(_ context.Context, maxLines int) (dbmsOutputBatch, error) {
	f.fetchCalls++
	f.batchSizes = append(f.batchSizes, maxLines)
	if f.failFetches != 0 {
		if f.failFetches > 0 {
			f.failFetches--
		}
		return dbmsOutputBatch{}, f.fetchErr
	}
	if maxLines > len(f.lines) {
		maxLines = len(f.lines)
	}
	batch := dbmsOutputBatch{}
	if maxLines > 0 {
		batch.lines = append([]string(nil), f.lines[:maxLines]...)
		f.lines = f.lines[maxLines:]
	}
	if f.leftover != "" {
		batch.leftover = f.leftover
		batch.hasLeftover = true
		batch.truncatedFrom = f.truncatedFrom
		f.leftover = ""
		f.truncatedFrom = 0
	}
	// The real block keeps reading until GET_LINE reports an empty buffer, so a
	// fetch that emptied it is terminal.
	batch.drained = len(f.lines) == 0
	return batch, nil
}

func TestEnableDBMSOutputRunsOncePerPhysicalConnection(t *testing.T) {
	tracker := &dbmsOutputTracker{}
	first := &fakeDBMSOutputSession{key: "conn-1"}
	enableDBMSOutput(context.Background(), first, tracker)
	enableDBMSOutput(context.Background(), first, tracker)
	if first.execCalls != 1 {
		t.Fatalf("ENABLE executed %d times on one physical connection, want 1", first.execCalls)
	}
	if len(first.execSQL) != 1 || first.execSQL[0] != dbmsOutputEnableSQL {
		t.Fatalf("unexpected ENABLE statements: %q", first.execSQL)
	}

	// A different physical connection needs its own ENABLE.
	second := &fakeDBMSOutputSession{key: "conn-2"}
	enableDBMSOutput(context.Background(), second, tracker)
	if second.execCalls != 1 {
		t.Fatalf("ENABLE executed %d times on the second connection, want 1", second.execCalls)
	}

	// A connection without an identity cannot be tracked, so nothing is run.
	unknown := &fakeDBMSOutputSession{}
	enableDBMSOutput(context.Background(), unknown, tracker)
	if unknown.execCalls != 0 {
		t.Fatalf("ENABLE executed %d times without a connection identity, want 0", unknown.execCalls)
	}
}

func TestEnableDBMSOutputFailureIsRememberedAndNeverRetried(t *testing.T) {
	tracker := &dbmsOutputTracker{}
	session := &fakeDBMSOutputSession{key: "conn-1", execErr: errors.New("ORA-06550: DBMS_OUTPUT not available")}
	for attempt := 0; attempt < 3; attempt++ {
		enableDBMSOutput(context.Background(), session, tracker)
	}
	if session.execCalls != 1 {
		t.Fatalf("failed ENABLE was retried: %d attempts, want 1", session.execCalls)
	}
}

func TestDrainDBMSOutputKeepsLineOrderAndStopsAtStatusOne(t *testing.T) {
	session := &fakeDBMSOutputSession{key: "conn-1", lines: []string{"first", "second", "third"}}
	messages := drainDBMSOutput(context.Background(), session, dbmsOutputMaxLines)
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want 3: %+v", len(messages), messages)
	}
	for index, want := range []string{"first", "second", "third"} {
		if messages[index].Severity != "INFO" {
			t.Fatalf("message %d severity = %q, want INFO", index, messages[index].Severity)
		}
		if messages[index].Message != want {
			t.Fatalf("message %d = %q, want %q", index, messages[index].Message, want)
		}
	}
	// The three lines and the status = 1 call that ends the block share one
	// round trip: batching is what keeps a large buffer affordable (R4).
	if session.fetchCalls != 1 {
		t.Fatalf("fetch called %d times, want 1 for a buffer that fits one batch", session.fetchCalls)
	}
}

func TestDrainDBMSOutputWithoutOutputReturnsNoMessages(t *testing.T) {
	session := &fakeDBMSOutputSession{key: "conn-1"}
	messages := drainDBMSOutput(context.Background(), session, dbmsOutputMaxLines)
	if len(messages) != 0 {
		t.Fatalf("got %d messages for an empty buffer, want 0", len(messages))
	}
	if session.fetchCalls != 1 {
		t.Fatalf("fetch called %d times for an empty buffer, want 1", session.fetchCalls)
	}
}

func TestDrainDBMSOutputTruncatesAtLimitWithNotice(t *testing.T) {
	session := &fakeDBMSOutputSession{key: "conn-1", lines: []string{"1", "2", "3", "4", "5"}}
	messages := drainDBMSOutput(context.Background(), session, 3)
	if len(messages) != 4 {
		t.Fatalf("got %d messages, want 3 lines plus one truncation notice: %+v", len(messages), messages)
	}
	for index, want := range []string{"1", "2", "3"} {
		if messages[index].Message != want {
			t.Fatalf("message %d = %q, want %q", index, messages[index].Message, want)
		}
	}
	notice := messages[3]
	if notice.Severity != "INFO" || !strings.Contains(notice.Message, "truncated") {
		t.Fatalf("truncation notice = %+v, want an INFO message mentioning truncation", notice)
	}
	// The bound asks for exactly one line past the limit; the rest of the buffer
	// stays where it is.
	if session.batchSizes[0] != 4 {
		t.Fatalf("fetch asked for %d lines with limit 3, want 4", session.batchSizes[0])
	}
	if len(session.lines) != 1 {
		t.Fatalf("the buffer kept %d lines, want the 1 line that proves the truncation", len(session.lines))
	}
}

func TestDrainDBMSOutputKeepsExactlyLimitLinesWithoutTruncationNotice(t *testing.T) {
	session := &fakeDBMSOutputSession{key: "conn-1", lines: []string{"1", "2", "3"}}
	messages := drainDBMSOutput(context.Background(), session, 3)
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want exactly the 3 buffered lines: %+v", len(messages), messages)
	}
	for _, message := range messages {
		if strings.Contains(message.Message, "truncated") {
			t.Fatalf("a buffer of exactly the limit was reported as truncated: %+v", messages)
		}
	}
	if session.fetchCalls != 1 {
		t.Fatalf("fetch called %d times, want the whole buffer in one batch", session.fetchCalls)
	}
}

func TestDrainDBMSOutputKeepsDrainingAfterAFailedFetch(t *testing.T) {
	// R5: one line that the register could not hold (ORA-06502) must not end the
	// drain. The server reads the line into a VARCHAR2(32767) local first, so the
	// session buffer advanced and the following lines are still readable.
	session := &fakeDBMSOutputSession{
		key:         "conn-1",
		lines:       []string{"after-the-failure"},
		fetchErr:    errors.New("ORA-06502: PL/SQL: numeric or value error: character string buffer too small"),
		failFetches: 1,
	}
	messages := drainDBMSOutput(context.Background(), session, dbmsOutputMaxLines)
	if len(messages) != 1 || messages[0].Message != "after-the-failure" {
		t.Fatalf("messages after one failed fetch = %+v, want the following line", messages)
	}
	if session.fetchCalls != 2 {
		t.Fatalf("fetch called %d times, want one failure plus one success", session.fetchCalls)
	}
}

func TestDrainDBMSOutputStopsAfterTwoConsecutiveFailures(t *testing.T) {
	// A failure ends the drain only once the buffer itself cannot advance: two
	// consecutive failures leave nothing to read, and the lines already read are
	// still returned. A fetch failure must never turn into a statement failure
	// (drainDBMSOutput returns no error).
	session := &fakeDBMSOutputSession{
		key:         "conn-1",
		lines:       []string{"unreachable"},
		fetchErr:    errors.New("ORA-03113: end-of-file on communication channel"),
		failFetches: -1,
	}
	messages := drainDBMSOutput(context.Background(), session, dbmsOutputMaxLines)
	if len(messages) != 0 {
		t.Fatalf("got %d messages after consecutive failures, want 0", len(messages))
	}
	if session.fetchCalls != 2 {
		t.Fatalf("fetch called %d times after consecutive failures, want 2", session.fetchCalls)
	}
}

func TestDrainDBMSOutputCarriesTheLeftoverLineInOrder(t *testing.T) {
	// The block hands back a complete line that did not fit the payload in its
	// own register so it is neither lost nor reordered.
	session := &fakeDBMSOutputSession{key: "conn-1"}
	batch := dbmsOutputBatch{lines: []string{"one", "two"}, leftover: "three", hasLeftover: true}
	messages := dbmsOutputBatchMessages(batch)
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want the leftover appended: %+v", len(messages), messages)
	}
	for index, want := range []string{"one", "two", "three"} {
		if messages[index].Message != want {
			t.Fatalf("message %d = %q, want %q", index, messages[index].Message, want)
		}
	}
	if session.fetchCalls != 0 {
		t.Fatal("the batch message helper must not touch the session")
	}
}

func TestQueryResultOmitsMessagesKeyWithoutOutput(t *testing.T) {
	encoded, err := json.Marshal(queryResult{Columns: []string{"a"}, ColumnTypes: []string{"NUMBER"}, Rows: [][]any{{1}}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, present := decoded["messages"]; present {
		t.Fatalf("queryResult without DBMS_OUTPUT must not carry a messages key: %s", encoded)
	}
	if strings.Contains(string(encoded), "messages") {
		t.Fatalf("queryResult without DBMS_OUTPUT must not even mention messages: %s", encoded)
	}

	pageEncoded, err := json.Marshal(queryPageResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(pageEncoded), "messages") {
		t.Fatalf("queryPageResult without DBMS_OUTPUT must not carry a messages key: %s", pageEncoded)
	}

	withMessages, err := json.Marshal(queryResult{Messages: []queryMessage{{Severity: "INFO", Message: "hello"}}})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(withMessages), `"messages":[{"severity":"INFO","message":"hello"}]`; !strings.Contains(got, want) {
		t.Fatalf("messages shape = %s, want it to contain %s", got, want)
	}
	if strings.Contains(string(withMessages), "code") || strings.Contains(string(withMessages), "detail") || strings.Contains(string(withMessages), "hint") {
		t.Fatalf("optional message fields must stay absent when unset: %s", withMessages)
	}
}

func TestWithStatementDBMSOutputWithoutConnectionStillRunsTheStatement(t *testing.T) {
	s := newServer()
	ran := false
	messages := s.withStatementDBMSOutput("BEGIN NULL; END;", func() error {
		ran = true
		return nil
	})
	if !ran {
		t.Fatal("the statement did not run when no connection could be pinned")
	}
	if len(messages) != 0 {
		t.Fatalf("got %d messages without a connection, want 0", len(messages))
	}

	// A nested call must leave the lines to the outer drain instead of pinning a
	// second physical connection.
	s.statementConn = &sql.Conn{}
	nestedRan := false
	nested := s.withStatementDBMSOutput("BEGIN NULL; END;", func() error {
		nestedRan = true
		return nil
	})
	if !nestedRan {
		t.Fatal("the nested statement did not run")
	}
	if len(nested) != 0 {
		t.Fatalf("a nested capture returned %d messages, want 0", len(nested))
	}
}

// oracleDBMSOutputDriver is a fake Oracle driver whose connections each keep
// their own DBMS_OUTPUT buffer, which is what makes per-physical-connection
// behaviour observable. Its Exec path mirrors go-ora: sql.Out / go_ora.Out
// arguments are unpacked and their destinations are written in place.
type oracleDBMSOutputDriver struct {
	mu                 sync.Mutex
	enableErr          error
	enableCount        int
	getLineCount       int
	statements         []string
	nextStatementLines []string
	nextStatementErr   error
	outBinds           []string
	events             []string
	// rejectRegisterAbove makes the fetch fail like a server that refuses a bind
	// whose declared size exceeds the limit (PLS-00215 through ORA-06550).
	rejectRegisterAbove int
}

func openOracleDBMSOutputTestDB(t *testing.T) (*sql.DB, *oracleDBMSOutputDriver) {
	t.Helper()
	name := "oracle-test-dbms-output-" + strings.ReplaceAll(t.Name(), "/", "-")
	drv := &oracleDBMSOutputDriver{}
	sql.Register(name, drv)
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db, drv
}

func (d *oracleDBMSOutputDriver) Open(string) (driver.Conn, error) {
	return &oracleDBMSOutputConn{driver: d}, nil
}

func (d *oracleDBMSOutputDriver) scriptLines(lines []string) {
	d.mu.Lock()
	d.nextStatementLines = lines
	d.mu.Unlock()
}

// scriptStatementError makes the next statement fail, the way a PL/SQL block
// that raises and still wrote to the buffer before raising does.
func (d *oracleDBMSOutputDriver) scriptStatementError(err error) {
	d.mu.Lock()
	d.nextStatementErr = err
	d.mu.Unlock()
}

func (d *oracleDBMSOutputDriver) counts() (enable, getLine int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.enableCount, d.getLineCount
}

func (d *oracleDBMSOutputDriver) outBindKinds() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.outBinds...)
}

func (d *oracleDBMSOutputDriver) eventLog() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.events...)
}

type oracleDBMSOutputConn struct {
	driver  *oracleDBMSOutputDriver
	enabled bool
	buffer  []string
}

func (c *oracleDBMSOutputConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("use the context APIs")
}

func (c *oracleDBMSOutputConn) Close() error { return nil }

func (c *oracleDBMSOutputConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not supported")
}

var (
	_ driver.ExecerContext     = (*oracleDBMSOutputConn)(nil)
	_ driver.NamedValueChecker = (*oracleDBMSOutputConn)(nil)
)

// CheckNamedValue mirrors go-ora's Connection.CheckNamedValue: OUT bind values
// pass through untouched so the driver can unpack them while executing.
func (c *oracleDBMSOutputConn) CheckNamedValue(*driver.NamedValue) error { return nil }

func (c *oracleDBMSOutputConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.driver.mu.Lock()
	defer c.driver.mu.Unlock()
	if strings.Contains(query, "DBMS_OUTPUT.ENABLE") {
		c.driver.enableCount++
		c.driver.events = append(c.driver.events, "enable")
		if c.driver.enableErr != nil {
			c.enabled = false
			return nil, c.driver.enableErr
		}
		c.enabled = true
		return driver.RowsAffected(0), nil
	}
	if strings.Contains(query, "DBMS_OUTPUT.GET_LINE") {
		c.driver.getLineCount++
		c.driver.events = append(c.driver.events, "get_line")
		// The fetch block takes the line bound and the register capacity first and
		// hands its payload back in the registers that follow (see
		// dbmsOutputFetchSQLTemplate).
		maxLines, chars := namedInt(args, 0), namedInt(args, 1)
		c.driver.outBinds = append(c.driver.outBinds, describeOutBind(args, 2))
		if c.driver.rejectRegisterAbove > 0 && chars > c.driver.rejectRegisterAbove {
			return nil, fmt.Errorf(
				"ORA-06550: line 2, column 3: PLS-00215: string length constraints must be in range (1 .. %d)",
				c.driver.rejectRegisterAbove,
			)
		}
		payload, count, leftover, status, dropped := c.fetchBatch(maxLines, chars)
		setOutDest(args, 2, payload)
		setOutDest(args, 3, count)
		setOutDest(args, 4, leftover)
		setOutDest(args, 5, status)
		setOutDest(args, 6, dropped)
		return driver.RowsAffected(0), nil
	}
	c.driver.statements = append(c.driver.statements, query)
	c.driver.events = append(c.driver.events, "statement")
	if strings.Contains(strings.ToUpper(query), "DBMS_OUTPUT.DISABLE") {
		// DBMS_OUTPUT.DISABLE turns the session buffer off and discards what it
		// held, so a script that disables output takes the feature away from every
		// later statement on this physical connection until ENABLE runs again.
		c.enabled = false
		c.buffer = nil
		c.driver.nextStatementLines = nil
		c.driver.nextStatementErr = nil
		return driver.RowsAffected(0), nil
	}
	if c.driver.nextStatementErr != nil {
		if c.enabled {
			// The statement wrote into the buffer before it raised, exactly like a
			// block that calls PUT_LINE and then hits ORA-20002.
			c.buffer = append(c.buffer, c.driver.nextStatementLines...)
		}
		err := c.driver.nextStatementErr
		c.driver.nextStatementErr = nil
		c.driver.nextStatementLines = nil
		return nil, err
	}
	// Without a successful ENABLE the session keeps no output, exactly like a
	// session where DBMS_OUTPUT is unavailable or disabled.
	if c.enabled {
		c.buffer = append(c.buffer, c.driver.nextStatementLines...)
	}
	c.driver.nextStatementLines = nil
	return driver.RowsAffected(1), nil
}

// fetchBatch mirrors the server-side fetch block: it frames buffered lines
// ("<character count><TAB><line>") while they fit the batch budget, hands the one
// line that no longer fits back in the leftover register (whole when a register
// can carry it, cut to the register size otherwise) and never takes a line out of
// the buffer that it cannot deliver in the same call. It returns the payload, the
// frame count, the leftover, the terminal status and the original length of a
// truncated line.
func (c *oracleDBMSOutputConn) fetchBatch(maxLines, chars int) (string, int, string, int, int) {
	if maxLines <= 0 {
		return "", 0, "", 1, 0
	}
	var payload strings.Builder
	count := 0
	// The block caps every budget by the register capacity the client declared,
	// so a downgraded register also shrinks the payload.
	budget := dbmsOutputBatchBytes
	if chars < budget {
		budget = chars
	}
	register := dbmsOutputRegisterBytes
	if chars < register {
		register = chars
	}
	payloadFits := func(extra string) bool {
		return payload.Len()+len(extra) <= budget &&
			utf8.RuneCountInString(payload.String())+utf8.RuneCountInString(extra) <= budget
	}
	for count < maxLines {
		if payload.Len() > budget-16 ||
			utf8.RuneCountInString(payload.String()) > budget-16 {
			return payload.String(), count, "", 0, 0
		}
		if len(c.buffer) == 0 {
			return payload.String(), count, "", 1, 0
		}
		line := c.buffer[0]
		frame := dbmsOutputFrame(line)
		if payloadFits(frame) {
			c.buffer = c.buffer[1:]
			payload.WriteString(frame)
			count++
			continue
		}
		// The line is already out of the session buffer, so this call has to carry
		// it: whole when one register can hold it, cut to the register size
		// otherwise.
		c.buffer = c.buffer[1:]
		if len(line) <= register && utf8.RuneCountInString(line) <= chars {
			return payload.String(), count, line, 2, 0
		}
		cut := line
		if len(cut) > register {
			cut = cut[:register]
		}
		for utf8.RuneCountInString(cut) > chars {
			cut = cut[:len(cut)-1]
		}
		cut = strings.ToValidUTF8(cut, "")
		return payload.String(), count, cut, 3, utf8.RuneCountInString(line)
	}
	return payload.String(), count, "", 0, 0
}

// dbmsOutputFrame encodes one line the way the fetch block does.
func dbmsOutputFrame(line string) string {
	return strconv.Itoa(utf8.RuneCountInString(line)) + "\t" + line
}

// namedInt reads one integer input bind.
func namedInt(args []driver.NamedValue, index int) int {
	if index >= len(args) {
		return 0
	}
	switch value := args[index].Value.(type) {
	case int:
		return value
	case int64:
		return int(value)
	default:
		return 0
	}
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// describeOutBind records which OUT bind type reached the driver, so tests can
// assert the binding each driver needs.
func describeOutBind(args []driver.NamedValue, index int) string {
	if index >= len(args) {
		return "missing"
	}
	switch out := args[index].Value.(type) {
	case go_ora.Out:
		return fmt.Sprintf("go_ora.Out(size=%d)", out.Size)
	case *go_ora.Out:
		return fmt.Sprintf("go_ora.Out(size=%d)", out.Size)
	case sql.Out:
		return "sql.Out"
	case *sql.Out:
		return "sql.Out"
	default:
		return fmt.Sprintf("%T", args[index].Value)
	}
}

// describeInValue records the text of an argument that is not an OUT register, so a
// test can assert the values a helper call forwards. An OUT register (whose value only
// receives data) reports "" and is covered by describeOutBind instead.
func describeInValue(args []driver.NamedValue, index int) string {
	if index >= len(args) {
		return "missing"
	}
	switch value := args[index].Value.(type) {
	case go_ora.Out, *go_ora.Out, sql.Out, *sql.Out:
		return ""
	default:
		return fmt.Sprintf("%v", value)
	}
}

// setOutDest writes one returned value into the OUT destination of the indexed
// argument, the way go-ora's Stmt._exec does after execution.
func setOutDest(args []driver.NamedValue, index int, value any) {
	if index >= len(args) {
		return
	}
	var dest any
	switch out := args[index].Value.(type) {
	case go_ora.Out:
		dest = out.Dest
	case *go_ora.Out:
		dest = out.Dest
	case sql.Out:
		dest = out.Dest
	case *sql.Out:
		dest = out.Dest
	}
	switch target := dest.(type) {
	case *string:
		if text, ok := value.(string); ok {
			*target = text
		}
	case *int:
		if number, ok := value.(int); ok {
			*target = number
		}
	}
}

func TestStatementDBMSOutputEnablesOnceAndAttributesEachStatement(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	run := func(sqlText string, lines []string) []queryMessage {
		drv.scriptLines(lines)
		return s.withStatementDBMSOutput(sqlText, func() error {
			_, err := s.execContext(context.Background(), sqlText)
			return err
		})
	}
	first := run("BEGIN dbms_output.put_line('one'); END;", []string{"one"})
	second := run("BEGIN dbms_output.put_line('two'); END;", []string{"two"})

	if len(first) != 1 || first[0].Message != "one" {
		t.Fatalf("first statement messages = %+v, want the line it wrote", first)
	}
	if len(second) != 1 || second[0].Message != "two" {
		// A second statement must not re-report the first statement's lines.
		t.Fatalf("second statement messages = %+v, want only its own line", second)
	}
	enable, getLine := drv.counts()
	if enable != 1 {
		t.Fatalf("DBMS_OUTPUT.ENABLE ran %d times for one pooled connection, want 1", enable)
	}
	if getLine < 2 {
		t.Fatalf("GET_LINE ran %d times, want at least one drain per statement", getLine)
	}
	// Output written while the buffer is off is discarded, so ENABLE must run
	// before the statement that writes into it.
	if events := drv.eventLog(); len(events) == 0 || events[0] != "enable" {
		t.Fatalf("first session event = %v, want ENABLE before the statement", events)
	}
	// The thin go-ora driver reads an OUT string back only when the bind carries
	// a buffer size, so the line must be bound with go_ora.Out.
	for _, kind := range drv.outBindKinds() {
		if !strings.HasPrefix(kind, "go_ora.Out(size=") || kind == "go_ora.Out(size=0)" {
			t.Fatalf("thin driver bound the line as %q, want a sized go_ora.Out", kind)
		}
	}
}

func TestStatementDBMSOutputBindsSqlOutForTheOCIDriver(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	s.params = connectParams{DriverProfile: "oci"}

	drv.scriptLines([]string{"oci line"})
	messages := s.withStatementDBMSOutput("BEGIN dbms_output.put_line('oci line'); END;", func() error {
		_, err := s.execContext(context.Background(), "BEGIN dbms_output.put_line('oci line'); END;")
		return err
	})
	if len(messages) != 1 || messages[0].Message != "oci line" {
		t.Fatalf("messages = %+v, want the line the statement wrote", messages)
	}
	kinds := drv.outBindKinds()
	if len(kinds) == 0 || kinds[0] != "sql.Out" {
		t.Fatalf("OCI driver bound the line as %v, want sql.Out", kinds)
	}
}

func TestManualTransactionCapturesDBMSOutputOnItsOwnConnection(t *testing.T) {
	db, driver := openOracleManualTxTestDB(t)
	s := newServer()
	s.db = db
	if err := s.beginManualTransaction(""); err != nil {
		t.Fatalf("begin manual transaction: %v", err)
	}
	// The manual transaction already pins a physical session; capture must reuse
	// it instead of pinning a second connection.
	for _, statement := range []string{"UPDATE t SET a = 1", "UPDATE t SET a = 2"} {
		if _, err := s.executeQuery(queryOptions{SQL: statement, MaxRows: 10}); err != nil {
			t.Fatalf("%s in transaction: %v", statement, err)
		}
	}
	driver.mu.Lock()
	execs := append([]string(nil), driver.execs...)
	driver.mu.Unlock()
	enableCount := 0
	for _, query := range execs {
		if strings.Contains(query, "DBMS_OUTPUT.ENABLE") {
			enableCount++
		}
	}
	if enableCount != 1 {
		t.Fatalf("DBMS_OUTPUT.ENABLE ran %d times inside one manual transaction, want 1: %q", enableCount, execs)
	}
	if s.statementConn != nil {
		t.Fatal("the statement connection was not released")
	}
	if s.statementCtx != nil || s.statementCancel != nil {
		t.Fatal("the statement context was not released")
	}
	if err := s.rollbackManualTransaction(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
}

func TestExecuteQueryEnableFailureKeepsStatementResult(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	drv.mu.Lock()
	drv.enableErr = errors.New("ORA-06550: PLS-00201: identifier 'DBMS_OUTPUT' must be declared")
	drv.mu.Unlock()

	drv.scriptLines([]string{"must not appear"})
	first, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('must not appear'); END;"})
	if err != nil {
		t.Fatalf("a failed DBMS_OUTPUT.ENABLE must not fail the statement: %v", err)
	}
	if len(first.Rows) != 0 || first.AffectedRows != 1 {
		t.Fatalf("statement result changed by a failed ENABLE: %+v", first)
	}
	if len(first.Messages) != 0 {
		t.Fatalf("a session without DBMS_OUTPUT reported messages: %+v", first.Messages)
	}
	encoded, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "messages") {
		t.Fatalf("failed capture must leave the response unchanged: %s", encoded)
	}

	// The failure is remembered: the next statement must not retry ENABLE.
	drv.scriptLines(nil)
	if _, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('again'); END;"}); err != nil {
		t.Fatalf("second statement failed: %v", err)
	}
	if enable, _ := drv.counts(); enable != 1 {
		t.Fatalf("DBMS_OUTPUT.ENABLE ran %d times after a failure, want 1", enable)
	}
	if len(drv.statements) != 2 {
		t.Fatalf("recorded %d statements, want both to run: %q", len(drv.statements), drv.statements)
	}
}

// -- R2: a script that disables the buffer must not poison the pool ----------

func TestDBMSOutputDisablesCaptureDetectsDisableStatements(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want bool
	}{
		{name: "plain", sql: "BEGIN DBMS_OUTPUT.DISABLE; END;", want: true},
		{name: "lower case", sql: "begin dbms_output.disable; end;", want: true},
		{name: "mixed case spaced", sql: "BEGIN\n  Dbms_Output . Disable ;\nEND;", want: true},
		{name: "quoted identifiers", sql: `BEGIN "DBMS_OUTPUT"."DISABLE"; END;`, want: true},
		{name: "enable only", sql: dbmsOutputEnableSQL, want: false},
		{name: "line comment", sql: "-- dbms_output.disable\nBEGIN dbms_output.put_line('x'); END;", want: false},
		{name: "trailing line comment", sql: "BEGIN DBMS_OUTPUT.ENABLE(1000); END; -- dbms_output.disable", want: false},
		{name: "block comment", sql: "/* dbms_output.disable */ BEGIN dbms_output.put_line('x'); END;", want: false},
		{name: "string literal", sql: "BEGIN INSERT INTO t VALUES ('dbms_output.disable'); END;", want: false},
		{name: "other package", sql: "BEGIN dbx_output.disable; END;", want: false},
		{name: "no disable at all", sql: "UPDATE t SET a = 1", want: false},
	}
	for _, testCase := range cases {
		if got := dbmsOutputDisablesCapture(testCase.sql); got != testCase.want {
			t.Fatalf("%s: dbmsOutputDisablesCapture(%q) = %v, want %v", testCase.name, testCase.sql, got, testCase.want)
		}
	}
}

func TestDBMSOutputTrackerForgetLetsTheNextStatementEnableAgain(t *testing.T) {
	tracker := &dbmsOutputTracker{}
	session := &fakeDBMSOutputSession{key: "conn-1"}
	enableDBMSOutput(context.Background(), session, tracker)
	if session.execCalls != 1 {
		t.Fatalf("first ENABLE ran %d times, want 1", session.execCalls)
	}
	// Without the statement disabling the buffer, the bookkeeping stands.
	enableDBMSOutput(context.Background(), session, tracker)
	if session.execCalls != 1 {
		t.Fatalf("ENABLE ran %d times without a DISABLE, want 1", session.execCalls)
	}
	tracker.forget(session.identity())
	enableDBMSOutput(context.Background(), session, tracker)
	if session.execCalls != 2 {
		t.Fatalf("ENABLE ran %d times after the bookkeeping was dropped, want 2", session.execCalls)
	}
}

func TestExecuteQueryReenablesOutputAfterAScriptDisablesIt(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	// g1 writes a line.
	drv.scriptLines([]string{"g1"})
	first, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('g1'); END;"})
	if err != nil {
		t.Fatalf("g1 failed: %v", err)
	}
	if len(first.Messages) != 1 || first.Messages[0].Message != "g1" {
		t.Fatalf("g1 messages = %+v, want its own line", first.Messages)
	}

	// g2 disables the buffer for the whole physical session.
	if _, err := s.executeQuery(queryOptions{SQL: "BEGIN DBMS_OUTPUT.DISABLE; END;"}); err != nil {
		t.Fatalf("g2 failed: %v", err)
	}

	// g3 must see the buffer enabled again: the DISABLE dropped the bookkeeping
	// instead of leaving the connection poisoned until it was recycled.
	drv.scriptLines([]string{"g3"})
	third, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('g3'); END;"})
	if err != nil {
		t.Fatalf("g3 failed: %v", err)
	}
	if len(third.Messages) != 1 || third.Messages[0].Message != "g3" {
		t.Fatalf("g3 messages = %+v, want its own line after a DISABLE", third.Messages)
	}
	if enable, _ := drv.counts(); enable != 2 {
		t.Fatalf("DBMS_OUTPUT.ENABLE ran %d times, want one per enable epoch (2)", enable)
	}
}

// -- R3: lines of a failed statement must never leak to the next one ---------

func TestFailedStatementLinesDoNotLeakToTheNextStatement(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	// h1 writes leak-1 and then fails with ORA-20002. The line is drained with the
	// failed statement (and dropped together with its error response); what must
	// not happen is that it stays in the session buffer.
	drv.scriptLines([]string{"leak-1"})
	drv.scriptStatementError(errors.New("ORA-20002: simulated failure"))
	first, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('leak-1'); RAISE_APPLICATION_ERROR(-20002, 'boom'); END;"})
	if err == nil {
		t.Fatal("the failing statement unexpectedly succeeded")
	}
	if len(first.Messages) != 1 || first.Messages[0].Message != "leak-1" {
		t.Fatalf("failed statement messages = %+v, want the line it wrote before failing", first.Messages)
	}

	// h2 must report only its own line.
	drv.scriptLines([]string{"leak-2"})
	second, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('leak-2'); END;"})
	if err != nil {
		t.Fatalf("h2 failed: %v", err)
	}
	if len(second.Messages) != 1 || second.Messages[0].Message != "leak-2" {
		t.Fatalf("h2 messages = %+v, want only its own line (a failed statement's lines leaked)", second.Messages)
	}
}

// -- R5: long lines ----------------------------------------------------------

// The field regression: a go-ora OUT string register declared with 32767
// characters still refused a framed payload above 8191 bytes with ORA-06502, and
// because the lines had already been taken out of the session buffer the whole
// batch (up to 512 lines) vanished. The budgets must be the *measured* capacity,
// and the block must stop reading before the payload is too full to frame a line.
func TestDBMSOutputFetchBudgetFitsTheMeasuredRegisterCapacity(t *testing.T) {
	if dbmsOutputBatchBytes >= dbmsOutputRegisterBytes {
		t.Fatalf("batch budget %d must stay below the measured register capacity %d",
			dbmsOutputBatchBytes, dbmsOutputRegisterBytes)
	}
	if dbmsOutputLineChars != dbmsOutputRegisterBytes {
		t.Fatalf("register declared with %d characters, want the measured capacity %d",
			dbmsOutputLineChars, dbmsOutputRegisterBytes)
	}
	// go-ora turns the declaration into MaxLen = characters x 4 bytes
	// (parameter_encode.go:653-661), which has to stay inside the server's own
	// 32767-byte VARCHAR2 limit -- the 32767-character declaration did not.
	for _, size := range []int{dbmsOutputLineChars, dbmsOutputLineSafeChars} {
		if size*4 > 32767 {
			t.Fatalf("register declaration %d characters x 4 bytes exceeds the 32767-byte limit", size)
		}
	}
	if strings.Contains(dbmsOutputFetchSQL, "$") {
		t.Fatalf("the fetch block still carries an unsubstituted placeholder: %s", dbmsOutputFetchSQL)
	}
	if !strings.Contains(dbmsOutputFetchSQL, "DBMS_OUTPUT.GET_LINE") ||
		!strings.Contains(dbmsOutputFetchSQL, "VARCHAR2(32767 BYTE)") {
		t.Fatalf("the fetch block must read through a server-side 32767-byte local: %s", dbmsOutputFetchSQL)
	}
	// The payload guard is what makes "read but not delivered" impossible: the
	// block stops reading while the payload still has room for a frame, and it
	// caps the budget by the register capacity the client declared.
	if !strings.Contains(dbmsOutputFetchSQL,
		fmt.Sprintf("LENGTHB(dbx_payload) > LEAST(%d, :2) - 16", dbmsOutputBatchBytes)) {
		t.Fatalf("the fetch block must stop reading before the payload is full: %s", dbmsOutputFetchSQL)
	}
	if !strings.Contains(dbmsOutputFetchSQL,
		fmt.Sprintf("LENGTHB(dbx_line) <= LEAST(%d, :2)", dbmsOutputRegisterBytes)) {
		t.Fatalf("the whole-line limit must be the measured register capacity: %s", dbmsOutputFetchSQL)
	}
	// The accumulator lengths have to be NVL-wrapped. The payload starts NULL, and
	// NULL + anything is NULL, so a bare LENGTHB(dbx_payload) makes the framing
	// comparison NULL -- which is not TRUE -- and every batch falls into the
	// leftover arm after a single line. Measured on Oracle 19c EE: 10000 buffered
	// lines took more than 300s, i.e. one round trip per line, instead of the ~20
	// the batch bounds are sized for.
	for _, needed := range []string{
		fmt.Sprintf("NVL(LENGTHB(dbx_payload), 0) + dbx_head + LENGTHB(dbx_line)"),
		fmt.Sprintf("NVL(LENGTH(dbx_payload), 0) + dbx_head + LENGTH(dbx_line)"),
	} {
		if !strings.Contains(dbmsOutputFetchSQL, needed) {
			t.Fatalf("the payload accumulator length must be NULL-safe (%s): %s", needed, dbmsOutputFetchSQL)
		}
	}
	if strings.Contains(dbmsOutputFetchSQL, "dbx_need_bytes := LENGTHB(dbx_payload)") ||
		strings.Contains(dbmsOutputFetchSQL, "dbx_need_chars := LENGTH(dbx_payload)") {
		t.Fatalf("the payload accumulator length is read without NVL, which makes the first "+
			"comparison of every batch NULL and collapses the batch to one line: %s", dbmsOutputFetchSQL)
	}
}

func TestStatementDBMSOutputKeepsALineLongerThanTheOldBuffer(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	// 4001 characters used to raise ORA-06502 against the old 4000-character
	// register, and the drain then dropped every line after it (R5).
	long := strings.Repeat("x", 4001)
	drv.scriptLines([]string{long, "after-the-long-line"})
	result, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('long'); END;"})
	if err != nil {
		t.Fatalf("statement failed: %v", err)
	}
	if len(result.Messages) != 2 {
		t.Fatalf("got %d messages, want the long line and the line after it: %d first characters",
			len(result.Messages), len(result.Messages))
	}
	if result.Messages[0].Message != long {
		t.Fatalf("long line came back with %d characters, want %d unchanged",
			len(result.Messages[0].Message), len(long))
	}
	if result.Messages[1].Message != "after-the-long-line" {
		t.Fatalf("line after the long one = %q, want it preserved", result.Messages[1].Message)
	}
	want := fmt.Sprintf("go_ora.Out(size=%d)", dbmsOutputLineChars)
	for _, kind := range drv.outBindKinds() {
		if kind != want {
			t.Fatalf("payload register bound as %q, want %q", kind, want)
		}
	}
}

// A line that no register can hold has to be cut, and the cut has to be visible:
// the trailing lines must still arrive and an INFO message must say what was
// lost. The pre-fix behaviour lost the whole batch instead.
func TestStatementDBMSOutputKeepsEveryLineAroundALongOne(t *testing.T) {
	cases := []struct {
		name string
		size int
	}{
		// 4001 was the size that started R5: the old 4000-character register
		// rejected it.
		{name: "4001", size: 4001},
		// The measured single-line ceiling: 8186 characters / 8191 bytes survived
		// the field bisect, 8187 / 8192 did not.
		{name: "8186", size: 8186},
		{name: "8187", size: 8187},
		{name: "8191", size: 8191},
		// Above the register capacity: cut to 8191 with a notice.
		{name: "8192", size: 8192},
		{name: "20000", size: 20000},
		// DBMS_OUTPUT itself refuses anything above 32767 bytes, so 20000 is the
		// largest legal line in this table.
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			db, drv := openOracleDBMSOutputTestDB(t)
			s := newServer()
			s.db = db

			long := strings.Repeat("L", testCase.size)
			trailing := "after-long-" + testCase.name
			drv.scriptLines([]string{long, trailing})
			result, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('long'); END;"})
			if err != nil {
				t.Fatalf("statement failed: %v", err)
			}
			// The trailing line is what the regression killed: it must always be
			// the last line of the buffer, whatever happened to the long one.
			last := result.Messages[len(result.Messages)-1]
			if last.Message != trailing {
				t.Fatalf("last message = %q, want the trailing line %q (messages: %d)",
					last.Message, trailing, len(result.Messages))
			}
			var truncationNotices []string
			for _, message := range result.Messages {
				if strings.Contains(message.Message, "truncated") {
					truncationNotices = append(truncationNotices, message.Message)
				}
			}
			longest := 0
			for _, message := range result.Messages {
				if strings.HasPrefix(message.Message, "LLL") && len(message.Message) > longest {
					longest = len(message.Message)
				}
			}
			if testCase.size <= dbmsOutputRegisterBytes {
				// Inside the measured capacity the whole line has to survive.
				if longest != testCase.size {
					t.Fatalf("long line came back with %d characters, want all %d", longest, testCase.size)
				}
				if len(truncationNotices) != 0 {
					t.Fatalf("a line inside the register capacity was reported as truncated: %v", truncationNotices)
				}
				return
			}
			if longest != dbmsOutputRegisterBytes {
				t.Fatalf("over-long line came back with %d characters, want it cut to %d",
					longest, dbmsOutputRegisterBytes)
			}
			if len(truncationNotices) != 1 ||
				!strings.Contains(truncationNotices[0], fmt.Sprintf("was %d characters long", testCase.size)) {
				t.Fatalf("truncation notices = %v, want one naming the original length %d",
					truncationNotices, testCase.size)
			}
		})
	}
}

func TestStatementDBMSOutputCarriesAFullRegisterLineInTheLeftover(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	// A line that fills a register cannot be framed inside the payload budget; it
	// has to travel whole in the leftover register instead of being truncated or
	// taking the lines that follow with it.
	big := strings.Repeat("y", dbmsOutputRegisterBytes)
	drv.scriptLines([]string{big, "tail"})
	result, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('big'); END;"})
	if err != nil {
		t.Fatalf("statement failed: %v", err)
	}
	if len(result.Messages) != 2 {
		t.Fatalf("got %d messages, want the oversized line plus the tail: %+v", len(result.Messages), result.Messages)
	}
	if result.Messages[0].Message != big {
		t.Fatalf("oversized line came back with %d characters, want %d unchanged",
			len(result.Messages[0].Message), len(big))
	}
	if result.Messages[1].Message != "tail" {
		t.Fatalf("line after the oversized one = %q, want it preserved", result.Messages[1].Message)
	}
}

func TestDBMSOutputParsePayloadSplitsFramesExactly(t *testing.T) {
	payload := dbmsOutputFrame("") +
		dbmsOutputFrame("plain") +
		dbmsOutputFrame("with\ttab and\nnewline") +
		dbmsOutputFrame("中文行") +
		dbmsOutputFrame("trailing")
	lines, framed := dbmsOutputParsePayload(payload, 5)
	if !framed {
		t.Fatal("a well formed payload was reported as malformed")
	}
	want := []string{"", "plain", "with\ttab and\nnewline", "中文行", "trailing"}
	if len(lines) != len(want) {
		t.Fatalf("parsed %d lines, want %d: %#v", len(lines), len(want), lines)
	}
	for index := range want {
		if lines[index] != want[index] {
			t.Fatalf("line %d = %q, want %q", index, lines[index], want[index])
		}
	}

	if lines, framed := dbmsOutputParsePayload("", 0); len(lines) != 0 || !framed {
		t.Fatalf("an empty payload parsed as %#v (framed=%v), want no lines", lines, framed)
	}
	if lines, framed := dbmsOutputParsePayload("not-a-frame", 1); framed || len(lines) != 0 {
		t.Fatalf("a malformed payload parsed as %#v (framed=%v), want no lines and no panic", lines, framed)
	}
	// A frame that promises more characters than it carries keeps what did parse.
	partial, framed := dbmsOutputParsePayload(dbmsOutputFrame("ok")+"9\there", 2)
	if framed || len(partial) != 1 || partial[0] != "ok" {
		t.Fatalf("truncated payload parsed as %#v (framed=%v), want the intact frame only", partial, framed)
	}
}

// -- R4: batching ------------------------------------------------------------

// runStatementDBMSOutput runs one statement through the real executeQuery path
// with the given buffered lines and returns the messages it produced.
func runStatementDBMSOutput(t *testing.T, lines []string) []queryMessage {
	t.Helper()
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	drv.scriptLines(lines)
	result, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('lines'); END;"})
	if err != nil {
		t.Fatalf("statement failed: %v", err)
	}
	return result.Messages
}

// Every line of a batch must arrive, whatever the line length and however many
// round trips the budget forces: the field regression dropped whole batches
// (456 lines of 15 characters, 100 lines of 100 characters, 1000 short lines)
// because the block read more than the register could hand back.
func TestStatementDBMSOutputDeliversEveryLineOfALargeBuffer(t *testing.T) {
	cases := []struct {
		name      string
		lineSize  int
		lineCount int
	}{
		{name: "15x456", lineSize: 15, lineCount: 456},
		{name: "15x512", lineSize: 15, lineCount: 512},
		{name: "15x1000", lineSize: 15, lineCount: 1000},
		{name: "10x1000", lineSize: 10, lineCount: 1000},
		{name: "20x1000", lineSize: 20, lineCount: 1000},
		{name: "30x600", lineSize: 30, lineCount: 600},
		{name: "30x200", lineSize: 30, lineCount: 200},
		{name: "50x1000", lineSize: 50, lineCount: 1000},
		{name: "100x100", lineSize: 100, lineCount: 100},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			lines := make([]string, 0, testCase.lineCount)
			for index := 0; index < testCase.lineCount; index++ {
				lines = append(lines, strings.Repeat(string(rune('a'+index%26)), testCase.lineSize))
			}
			messages := runStatementDBMSOutput(t, lines)
			if len(messages) != len(lines) {
				t.Fatalf("got %d messages for %d lines, want one per line", len(messages), len(lines))
			}
			for index, line := range lines {
				if messages[index].Message != line {
					t.Fatalf("message %d = %q, want %q", index, messages[index].Message, line)
				}
			}
			for _, message := range messages {
				if strings.Contains(message.Message, "truncated") {
					t.Fatalf("a buffer of short lines was reported as truncated: %q", message.Message)
				}
			}
		})
	}
}

func TestStatementDBMSOutputDrainsManyLinesInOneRoundTrip(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	lines := make([]string, 0, 300)
	for index := 0; index < 300; index++ {
		lines = append(lines, fmt.Sprintf("line-%03d", index))
	}
	drv.scriptLines(lines)
	result, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('many'); END;"})
	if err != nil {
		t.Fatalf("statement failed: %v", err)
	}
	if len(result.Messages) != len(lines) {
		t.Fatalf("got %d messages, want %d", len(result.Messages), len(lines))
	}
	for index, line := range lines {
		if result.Messages[index].Message != line {
			t.Fatalf("message %d = %q, want %q", index, result.Messages[index].Message, line)
		}
	}
	// The whole buffer travels in one payload: one round trip instead of one per
	// line, which is what makes the per-line latency affordable.
	if _, fetches := drv.counts(); fetches != 1 {
		t.Fatalf("the drain used %d round trips for 300 lines, want 1", fetches)
	}
}

func TestDBMSOutputDrainAsksForOneLinePastTheBound(t *testing.T) {
	session := &fakeDBMSOutputSession{key: "conn-1", lines: []string{"1", "2", "3", "4"}}
	drainDBMSOutput(context.Background(), session, 2)
	if len(session.batchSizes) == 0 || session.batchSizes[0] != 3 {
		t.Fatalf("first batch size = %v, want 3 (the bound plus one)", session.batchSizes)
	}
}

// A line longer than any register can carry is cut, but it is still delivered and
// the cut is reported: the lines that follow it keep arriving.
func TestDrainDBMSOutputSurfacesATruncatedLineAndKeepsGoing(t *testing.T) {
	truncated := strings.Repeat("z", dbmsOutputRegisterBytes)
	session := &fakeDBMSOutputSession{
		key:           "conn-1",
		lines:         []string{"after-the-cut"},
		leftover:      truncated,
		truncatedFrom: 20000,
	}
	messages := drainDBMSOutput(context.Background(), session, dbmsOutputMaxLines)
	if len(messages) != 3 {
		t.Fatalf("got %d messages, want the following line, the cut line and one notice: %+v", len(messages), messages)
	}
	if messages[0].Message != "after-the-cut" {
		t.Fatalf("first message = %q, want the line the payload carried", messages[0].Message)
	}
	if messages[1].Message != truncated || len(messages[1].Message) != dbmsOutputRegisterBytes {
		t.Fatalf("cut line came back with %d characters, want the %d-character prefix",
			len(messages[1].Message), dbmsOutputRegisterBytes)
	}
	notice := messages[2]
	if notice.Severity != "INFO" || !strings.Contains(notice.Message, "truncated") ||
		!strings.Contains(notice.Message, "was 20000 characters long") {
		t.Fatalf("notice = %+v, want an INFO message naming the original length", notice)
	}
}

// The 10000-line bound and its INFO notice survive the new batching.
func TestDrainDBMSOutputStopsAtTheLineLimitWithNotice(t *testing.T) {
	lines := make([]string, 0, dbmsOutputMaxLines+1)
	for index := 0; index <= dbmsOutputMaxLines; index++ {
		lines = append(lines, fmt.Sprintf("line-%05d", index))
	}
	session := &fakeDBMSOutputSession{key: "conn-1", lines: lines}
	messages := drainDBMSOutput(context.Background(), session, dbmsOutputMaxLines)
	if len(messages) != dbmsOutputMaxLines+1 {
		t.Fatalf("got %d messages, want %d lines plus one notice", len(messages), dbmsOutputMaxLines)
	}
	for index := 0; index < dbmsOutputMaxLines; index++ {
		if messages[index].Message != lines[index] {
			t.Fatalf("message %d = %q, want %q", index, messages[index].Message, lines[index])
		}
	}
	notice := messages[dbmsOutputMaxLines]
	if notice.Severity != "INFO" ||
		!strings.Contains(notice.Message, fmt.Sprintf("truncated after %d lines", dbmsOutputMaxLines)) {
		t.Fatalf("last message = %+v, want the line-limit notice", notice)
	}
}

// The register size is a guess: go-ora declares the OUT buffer as
// characters x bytes-per-character, which can exceed the server's own 32767-byte
// VARCHAR2 limit. A server that refuses that bind must not cost every later
// statement its output, so one rejection permanently falls back to the byte-safe
// size and the fetch is retried at once.
func TestDBMSOutputRegisterFallsBackWhenTheServerRejectsIt(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	drv.mu.Lock()
	drv.rejectRegisterAbove = dbmsOutputLineSafeChars
	drv.mu.Unlock()

	drv.scriptLines([]string{"after-fallback"})
	first, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('after-fallback'); END;"})
	if err != nil {
		t.Fatalf("statement failed: %v", err)
	}
	if len(first.Messages) != 1 || first.Messages[0].Message != "after-fallback" {
		t.Fatalf("messages after the fallback = %+v, want the buffered line", first.Messages)
	}
	if got := s.dbmsOutputBinding.chars(); got != dbmsOutputLineSafeChars {
		t.Fatalf("register size after the fallback = %d, want %d", got, dbmsOutputLineSafeChars)
	}

	// The rejected size is never tried again, on this or any later statement, and
	// the smaller register keeps its own (smaller) payload budget: a buffer that
	// used to overflow the declared register must still arrive line by line.
	second := make([]string, 0, 200)
	for index := 0; index < 200; index++ {
		second = append(second, strings.Repeat("F", 50))
	}
	drv.scriptLines(second)
	secondResult, err := s.executeQuery(queryOptions{SQL: "BEGIN dbms_output.put_line('second'); END;"})
	if err != nil {
		t.Fatalf("second statement failed: %v", err)
	}
	if len(secondResult.Messages) != len(second) {
		t.Fatalf("got %d messages in the fallback tier, want %d", len(secondResult.Messages), len(second))
	}
	for index, line := range second {
		if secondResult.Messages[index].Message != line {
			t.Fatalf("fallback message %d = %q, want %q", index, secondResult.Messages[index].Message, line)
		}
	}
	large := fmt.Sprintf("go_ora.Out(size=%d)", dbmsOutputLineChars)
	small := fmt.Sprintf("go_ora.Out(size=%d)", dbmsOutputLineSafeChars)
	kinds := drv.outBindKinds()
	if len(kinds) < 2 || kinds[0] != large {
		t.Fatalf("register binds = %v, want the rejected size to be tried once first", kinds)
	}
	for _, kind := range kinds[1:] {
		if kind != small {
			t.Fatalf("register binds = %v, want only %q after the one rejection", kinds, small)
		}
	}
}

// dbmsOutputLooksLikeBindFailure must not downgrade the register for an ordinary
// session failure: the fallback is permanent, so a network error would cost the
// larger buffer for the life of the process.
func TestDBMSOutputBindFailureDetection(t *testing.T) {
	rejected := []string{
		"ORA-06502: PL/SQL: numeric or value error: character string buffer too small",
		"ORA-06550: line 1, column 7: PLS-00215: string length constraints must be in range (1 .. 32767)",
		"ORA-01461: can bind a LONG value only for insert into a LONG column",
	}
	for _, text := range rejected {
		if !dbmsOutputLooksLikeBindFailure(errors.New(text)) {
			t.Fatalf("%q must be recognised as a register failure", text)
		}
	}
	for _, text := range []string{
		"ORA-03113: end-of-file on communication channel",
		"ORA-01031: insufficient privileges",
		"",
	} {
		if dbmsOutputLooksLikeBindFailure(errors.New(text)) {
			t.Fatalf("%q must not downgrade the register", text)
		}
	}
	if dbmsOutputLooksLikeBindFailure(nil) {
		t.Fatal("a nil error must not downgrade the register")
	}
}
