package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"testing"
)

func queryClassificationCases() []struct {
	name    string
	sqlText string
	want    bool
} {
	return []struct {
		name    string
		sqlText string
		want    bool
	}{
		{"select", "SELECT 1", true},
		{"with", "WITH sample AS (SELECT 1) SELECT * FROM sample", true},
		{"with_dml_existing_route", "WITH sample AS (SELECT 1) UPDATE rows SET id = 1", true},
		{"show", "SHOW search_path", true},
		{"explain", "EXPLAIN SELECT 1", true},
		{"mixed_case", "sElEcT 1", true},
		{"mixed_whitespace", " \t\r\n\f\vSELECT 1 \t\n", true},
		{"unicode_leading_whitespace", "\u2003SELECT 1", true},
		{"reported_query", "--12313\nselect count(*) from medins_prod_inv_d limit 100;", true},
		{"line_comment_crlf", "-- SELECT is in a comment\r\nSELECT 1", true},
		{"line_comment_cr", "-- comment\rSELECT 1", true},
		{"repeated_line_comments", "-- first\n\t-- second\nSELECT 1", true},
		{"line_comment_markers", "-- /* ' \" $$ */\nSELECT 1", true},
		{"block_comment", "/* comment */SELECT 1", true},
		{"leading_hint", "/*+ hint */ SELECT 1", true},
		{"multiline_block_comment", "/* first\nsecond */\nSELECT 1", true},
		{"repeated_block_comments", "/**//* second */ SELECT 1", true},
		{"nested_block_comments", "/* outer /* inner */ outer */SELECT 1", true},
		{"deeply_nested_block_comments", "/* a /* b /* c */ b */ a */ SELECT 1", true},
		{"block_comment_markers", "/* -- ' \" $$ */SELECT 1", true},
		{"comment_with_semicolon", "/* DELETE FROM rows; */ SELECT 1", true},
		{"mixed_comments", " \t-- first\r\n /* second */\f-- third\n/**/\tSELECT 1", true},
		{"commented_with", "-- comment\nWITH sample AS (SELECT 1) SELECT * FROM sample", true},
		{"commented_show", "/* comment */SHOW search_path", true},
		{"commented_explain", "-- comment\nEXPLAIN SELECT 1", true},
		{"keyword_before_parenthesis", "SELECT(1)", true},
		{"keyword_before_comment", "SELECT/* comment */1", true},
		{"keyword_before_string", "SELECT'-- not a comment /* either */'", true},
		{"quoted_comment_markers", "/* header */ SELECT '--', '/*', '*/', \"--\", $$/*$$", true},
		{"trailing_comment", "SELECT 1 -- comment", true},
		{"insert", "INSERT INTO rows VALUES (1)", false},
		{"update", "UPDATE rows SET id = 1", false},
		{"delete", "DELETE FROM rows", false},
		{"dml_returning_existing_route", "INSERT INTO rows VALUES (1) RETURNING id", false},
		{"merge", "MERGE INTO rows USING source ON rows.id = source.id WHEN MATCHED THEN DELETE", false},
		{"ddl", "CREATE TABLE rows (id integer)", false},
		{"commented_insert", "-- SELECT 1\nINSERT INTO rows VALUES (1)", false},
		{"commented_update", "/* SELECT 1 */UPDATE rows SET id = 1", false},
		{"commented_delete", "/* outer /* SELECT 1 */ outer */ DELETE FROM rows", false},
		{"keyword_in_string", "'-- comment' SELECT 1", false},
		{"keyword_in_identifier", "\"/* comment */\" SELECT 1", false},
		{"keyword_in_dollar_string", "$$-- comment$$ SELECT 1", false},
		{"keyword_in_tagged_dollar_string", "$tag$/* comment */$tag$ SELECT 1", false},
		{"comment_before_string", "/* header */ 'SELECT 1'", false},
		{"empty", "", false},
		{"whitespace_only", " \t\r\n\f\v", false},
		{"line_comment_only", "-- SELECT 1", false},
		{"block_comment_only", "/* SELECT 1 */", false},
		{"mixed_comments_only", "-- first\n /* second */ -- third", false},
		{"unterminated_block_comment", "/* SELECT 1", false},
		{"unterminated_nested_comment", "/* outer /* inner */ SELECT 1", false},
		{"quotes_inside_comment_do_not_prevent_nesting", "/* '/*' */ SELECT 1", false},
		{"unterminated_last_comment", "/* complete */ /* SELECT 1", false},
		{"unterminated_overlapping_comment", "/*/ SELECT 1", false},
		{"stray_comment_end", "*/ SELECT 1", false},
		{"keyword_suffix_letters", "selection", false},
		{"with_suffix", "without", false},
		{"show_suffix", "showcase", false},
		{"explain_suffix", "explained", false},
		{"keyword_suffix_digit", "select1", false},
		{"keyword_suffix_underscore", "select_rows", false},
		{"keyword_suffix_dollar", "select$rows", false},
		{"keyword_suffix_hash", "select#rows", false},
		{"keyword_suffix_unicode", "select表", false},
		{"keyword_contains_unicode", "wİth sample AS (SELECT 1) SELECT * FROM sample", false},
		{"keyword_prefix_underscore", "_select", false},
		{"keyword_prefix_digit", "1select", false},
		{"split_keyword", "sel/**/ect 1", false},
		{"hash_is_not_a_line_comment", "# header\nSELECT 1", false},
		{"commented_keyword_suffix", "/* header */select_rows", false},
	}
}

func TestIsQuerySQL(test *testing.T) {
	for _, testCase := range queryClassificationCases() {
		test.Run(testCase.name, func(test *testing.T) {
			if actual := isQuerySQL(testCase.sqlText); actual != testCase.want {
				test.Fatalf("isQuerySQL(%q) = %v, want %v", testCase.sqlText, actual, testCase.want)
			}
		})
	}
}

func TestQueryClassificationRoutesExecution(test *testing.T) {
	for _, paged := range []bool{false, true} {
		mode := "execute"
		if paged {
			mode = "pagination"
		}
		test.Run(mode, func(test *testing.T) {
			for _, testCase := range queryClassificationCases() {
				test.Run(testCase.name, func(test *testing.T) {
					testDriver := &queryRoutingDriver{values: []int64{42}}
					server := newQueryRoutingServer(test, testDriver)
					opts := queryOptions{SQL: testCase.sqlText}
					var columns []string
					var rows [][]any
					var affectedRows int64
					var err error
					if paged {
						var result queryPageResult
						result, err = server.executeQueryPage(opts, 10)
						columns, rows, affectedRows = result.Columns, result.Rows, result.AffectedRows
					} else {
						var result queryResult
						result, err = server.executeQuery(opts)
						columns, rows, affectedRows = result.Columns, result.Rows, result.AffectedRows
					}
					if err != nil {
						test.Fatal(err)
					}
					wantSQL := []string{trimStatementSQL(testCase.sqlText)}
					if testCase.want {
						if !reflect.DeepEqual(testDriver.queries, wantSQL) || len(testDriver.executions) != 0 {
							test.Errorf("QueryContext = %q, ExecContext = %q; want only QueryContext(%q)", testDriver.queries, testDriver.executions, wantSQL[0])
						}
						if !reflect.DeepEqual(columns, []string{"id"}) || !reflect.DeepEqual(rows, [][]any{{int64(42)}}) || affectedRows != 0 {
							test.Errorf("expected result set, got columns=%v rows=%v affected=%d", columns, rows, affectedRows)
						}
					} else {
						if !reflect.DeepEqual(testDriver.executions, wantSQL) || len(testDriver.queries) != 0 {
							test.Errorf("QueryContext = %q, ExecContext = %q; want only ExecContext(%q)", testDriver.queries, testDriver.executions, wantSQL[0])
						}
						if len(columns) != 0 || len(rows) != 0 || affectedRows != 7 {
							test.Errorf("expected affected rows, got columns=%v rows=%v affected=%d", columns, rows, affectedRows)
						}
					}
				})
			}
		})
	}
}

func TestCommentedQueryPagination(test *testing.T) {
	testDriver := &queryRoutingDriver{values: []int64{1, 2, 3}}
	server := newQueryRoutingServer(test, testDriver)
	sqlText := "-- first\n/* outer /* inner */ outer */ SELECT id FROM rows"
	first, err := server.executeQueryPage(queryOptions{SQL: sqlText}, 1)
	if err != nil {
		test.Fatal(err)
	}
	if first.SessionID == nil || !first.HasMore || !reflect.DeepEqual(first.Rows, [][]any{{int64(1)}}) {
		test.Fatalf("unexpected first page: %#v", first)
	}
	last, err := server.fetchQueryPage(*first.SessionID, 2)
	if err != nil {
		test.Fatal(err)
	}
	if last.HasMore || last.Truncated || !reflect.DeepEqual(last.Rows, [][]any{{int64(2)}, {int64(3)}}) || len(server.sessions) != 0 {
		test.Fatalf("unexpected final page: %#v, sessions=%d", last, len(server.sessions))
	}
	if !reflect.DeepEqual(testDriver.queries, []string{sqlText}) || len(testDriver.executions) != 0 {
		test.Fatalf("QueryContext = %q, ExecContext = %q", testDriver.queries, testDriver.executions)
	}
}

func TestCommentedQueryErrorsPropagate(test *testing.T) {
	for _, sqlText := range []string{"-- header\nSELECT 1", "/* header */ UPDATE rows SET id = 1", "/* unterminated SELECT 1"} {
		test.Run(sqlText, func(test *testing.T) {
			for _, paged := range []bool{false, true} {
				wantErr := errors.New("database rejected SQL")
				testDriver := &queryRoutingDriver{err: wantErr}
				server := newQueryRoutingServer(test, testDriver)
				var err error
				if paged {
					_, err = server.executeQueryPage(queryOptions{SQL: sqlText}, 1)
				} else {
					_, err = server.executeQuery(queryOptions{SQL: sqlText})
				}
				if !errors.Is(err, wantErr) {
					test.Fatalf("paged=%v: got %v, want %v", paged, err, wantErr)
				}
			}
		})
	}
}

type queryRoutingDriver struct {
	queries    []string
	executions []string
	values     []int64
	err        error
}

func (testDriver *queryRoutingDriver) Open(string) (driver.Conn, error) {
	return &queryRoutingConn{testDriver: testDriver}, nil
}

func (testDriver *queryRoutingDriver) Connect(context.Context) (driver.Conn, error) {
	return testDriver.Open("")
}

func (testDriver *queryRoutingDriver) Driver() driver.Driver { return testDriver }

type queryRoutingConn struct {
	testDriver *queryRoutingDriver
}

func (*queryRoutingConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*queryRoutingConn) Close() error                        { return nil }
func (*queryRoutingConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (conn *queryRoutingConn) QueryContext(ctx context.Context, sqlText string, _ []driver.NamedValue) (driver.Rows, error) {
	conn.testDriver.queries = append(conn.testDriver.queries, sqlText)
	if conn.testDriver.err != nil {
		return nil, conn.testDriver.err
	}
	return &paginationTimeoutRows{ctx: ctx, values: conn.testDriver.values, blockAt: -1}, nil
}

func (conn *queryRoutingConn) ExecContext(_ context.Context, sqlText string, _ []driver.NamedValue) (driver.Result, error) {
	conn.testDriver.executions = append(conn.testDriver.executions, sqlText)
	return driver.RowsAffected(7), conn.testDriver.err
}

func newQueryRoutingServer(test *testing.T, testDriver *queryRoutingDriver) *server {
	test.Helper()
	server := newServer()
	server.db = sql.OpenDB(testDriver)
	server.db.SetMaxOpenConns(1)
	test.Cleanup(func() {
		server.closeAllQuerySessions()
		_ = server.db.Close()
	})
	return server
}
