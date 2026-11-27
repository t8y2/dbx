package main

import (
	"reflect"
	"sort"
	"testing"

	"github.com/apache/iotdb-client-go/v2/client"
)

func aliasSet(sql string) []string {
	aliases := []string{}
	for alias := range timeAggregationAliases(sql) {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)
	return aliases
}

func TestTimeAggregationAliasesRecognizeAliasedTimeAggregates(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want []string
	}{
		{"max_time alias", "SELECT max_time(s1) AS latest FROM root.db.d1", []string{"latest"}},
		{"min_time alias", "SELECT min_time(s1) AS earliest FROM root.db.d1", []string{"earliest"}},
		{"max_by over time", "SELECT max_by(time, s1) AS at_max FROM root.db.d1", []string{"at_max"}},
		{"min_by over Time", "SELECT min_by(Time, s1) AS at_min FROM root.db.d1", []string{"at_min"}},
		{"upper case keywords", "SELECT MAX_TIME(s1) AS Upper FROM root.db.d1", []string{"Upper"}},
		{"lower case keywords", "select max_time(s1) as lower from root.db.d1", []string{"lower"}},
		{"whitespace around call", "SELECT max_time ( s1 )   AS spaced FROM root.db.d1", []string{"spaced"}},
		{"leading whitespace and newlines", "\n  SELECT\n\tmax_time(s1)\n AS multi\nFROM root.db.d1", []string{"multi"}},
		{"backtick alias", "SELECT min_by(time, s1) AS `bt` FROM root.db.d1", []string{"bt"}},
		{"double quoted alias with space", `SELECT max_time(s1) AS "my alias" FROM root.db.d1`, []string{"my alias"}},
		{"single quoted alias", "SELECT max_time(s1) AS 'q1' FROM root.db.d1", []string{"q1"}},
		{"doubled backtick collapses", "SELECT max_time(s1) AS `odd``name` FROM root.db.d1", []string{"odd`name"}},
		{"doubled single quote collapses", "SELECT max_time(s1) AS 'it''s' FROM root.db.d1", []string{"it's"}},
		{"doubled double quote collapses", `SELECT max_time(s1) AS "say ""hi""" FROM root.db.d1`, []string{`say "hi"`}},
		{"alias casing is kept and compared exactly", "SELECT max_time(s1) AS a, min_time(s1) AS A FROM root.db.d1", []string{"A", "a"}},
		{"only time aggregates are collected", "SELECT max_time(s1) AS t, count(s1) AS c, avg(s1) AS a, max_value(s1) AS mv FROM root.db.d1", []string{"t"}},
		{"nested commas stay inside their call", "SELECT avg(round(s1, 2)) AS r, max_by(time, s1) AS m FROM root.db.d1", []string{"m"}},
		{"wildcard series", "SELECT max_time(*) AS w FROM root.db.d1", []string{"w"}},
		{"keywords inside a path node are not clause keywords", "SELECT max_time(root.from.s1) AS m FROM root.from", []string{"m"}},
		{"alias that spells a keyword", "SELECT max_time(s1) AS `from` FROM root.db.d1", []string{"from"}},
		{"unquoted name characters are not keyword boundaries", "SELECT max_time(root.db.d$from.s1) AS x$as FROM root.db.d$from", []string{"x$as"}},
		{"colon at and hash inside a name", "SELECT min_by(time, s1) AS a:from, max_time(s1) AS b@as, max_time(s1) AS c#into FROM root.db.d1", []string{"a:from", "b@as", "c#into"}},
		{"braces inside a name", "SELECT max_time(s1) AS {from} FROM root.db.d1", []string{"{from}"}},
		{"unquoted CJK alias", "SELECT max_by(time, s1) AS 最大值时刻 FROM root.db.d1 ALIGN BY DEVICE", []string{"最大值时刻"}},
		{"clauses after FROM are ignored", "SELECT max_time(s1) AS m FROM root.db.d1 GROUP BY ([0, 10), 1ms) ALIGN BY DEVICE", []string{"m"}},
		{"select into stops at INTO", "SELECT max_time(s1) AS m INTO root.copy.d1(t) FROM root.db.d1", []string{"m"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := aliasSet(tc.sql); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("aliases of %q = %#v, want %#v", tc.sql, got, tc.want)
			}
		})
	}
}

func TestTimeAggregationAliasesIgnoreNonTimeAggregatesAndOtherStatements(t *testing.T) {
	for name, sql := range map[string]string{
		"no alias":                        "SELECT max_time(s1) FROM root.db.d1",
		"max_by with time as the value":   "SELECT max_by(s1, time) AS x FROM root.db.d1",
		"max_by over another time column": "SELECT max_by(event_time, s1) AS x FROM root.db.d1",
		"unrelated prefix":                "SELECT max_timer(s1) AS x FROM root.db.d1",
		"arithmetic on the aggregate":     "SELECT max_time(s1) + 1 AS x FROM root.db.d1",
		"aggregate nested in a function":  "SELECT abs(max_time(s1)) AS x FROM root.db.d1",
		"plain series alias":              "SELECT s1 AS x FROM root.db.d1",
		"select last has fixed columns":   "SELECT LAST max_time(s1) AS x FROM root.db.d1",
		"not a select":                    "SHOW TIMESERIES root.db.**",
		"no from clause":                  "SELECT max_time(s1) AS x",
		"empty":                           "",
	} {
		t.Run(name, func(t *testing.T) {
			if got := aliasSet(sql); len(got) != 0 {
				t.Fatalf("aliases of %q = %#v, want none", sql, got)
			}
		})
	}
}

func TestIsTimeAggregationExpressionRequiresASingleCall(t *testing.T) {
	for _, expression := range []string{
		"max_time(root.db.d1.s1)",
		" MIN_TIME(root.db.d1.s1) ",
		"max_time ( root.db.d1.s1 )",
		"max_by(Time,root.db.d1.s1)",
		"MIN_BY( time , root.db.d1.s1 )",
		"max_time(root.db.d1.`odd)name`)",
	} {
		if !isTimeAggregationExpression(expression) {
			t.Fatalf("%q must be a time aggregate", expression)
		}
	}
	for _, expression := range []string{
		"max_time(s1) + 1",
		"max_time(s1",
		"max_time()",
		"max_timer(s1)",
		"max_bytes(time,s1)",
		"max_by(s1,time)",
		"max_by(event_time,s1)",
		"max_by(time)",
		"avg(s1)",
		"max_time",
		"",
	} {
		if isTimeAggregationExpression(expression) {
			t.Fatalf("%q must not be a time aggregate", expression)
		}
	}
}

// https://github.com/t8y2/dbx/issues/15876: `AS alias` replaced the column name
// the aggregate was recognised by, so the grid and exports showed raw epochs.
func TestAliasedTreeTimeAggregatesPresentAsTimestamps(t *testing.T) {
	sql := "SELECT max_time(s1) AS latest, max_by(time, s1) AS at_max, max_by(s1, time) AS value_at, count(s1) AS c, avg(s1) AS a FROM root.db.d1"
	columns := []string{"latest", "at_max", "value_at", "c", "a"}
	values := []string{"INT64", "INT64", "INT64", "INT64", "DOUBLE"}

	got := normalizedColumnTypes(values, columns, client.TreeSqlDialect, "ms", sql)
	want := []string{"TIMESTAMP(ms)", "TIMESTAMP(ms)", "INT64", "INT64", "DOUBLE"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("aliased tree aggregate types = %#v, want %#v", got, want)
	}

	// Precision comes from the server, exactly as for unaliased columns.
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"latest"}, client.TreeSqlDialect, "ns", "SELECT max_time(s1) AS latest FROM root.db.d1"); !reflect.DeepEqual(got, []string{"TIMESTAMP(ns)"}) {
		t.Fatalf("aliased aggregate must use the server precision: %#v", got)
	}
}

func TestAliasedTimeAggregatesStayScopedToTheirQuery(t *testing.T) {
	sql := "SELECT max_time(s1) AS latest FROM root.db.d1"

	// The alias only means a time aggregate in the tree dialect.
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"latest"}, client.TableSqlDialect, "ms", sql); !reflect.DeepEqual(got, []string{"INT64"}) {
		t.Fatalf("table dialect must stay INT64: %#v", got)
	}
	// A same-named INT64 column from a statement that does not alias a time
	// aggregate to it is ordinary data.
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"latest"}, client.TreeSqlDialect, "ms", "SELECT count(s1) AS latest FROM root.db.d1"); !reflect.DeepEqual(got, []string{"INT64"}) {
		t.Fatalf("count alias must stay INT64: %#v", got)
	}
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"latest"}, client.TreeSqlDialect, "ms", ""); !reflect.DeepEqual(got, []string{"INT64"}) {
		t.Fatalf("without SQL an unaliased-looking name must stay INT64: %#v", got)
	}
	// Alias matching is exact, like IoTDB's own column names.
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"Latest"}, client.TreeSqlDialect, "ms", sql); !reflect.DeepEqual(got, []string{"INT64"}) {
		t.Fatalf("alias casing must match exactly: %#v", got)
	}
	// Only INT64 results are rewritten.
	if got := normalizedColumnTypes([]string{"DOUBLE"}, []string{"latest"}, client.TreeSqlDialect, "ms", sql); !reflect.DeepEqual(got, []string{"DOUBLE"}) {
		t.Fatalf("non-INT64 result must be left alone: %#v", got)
	}
	// The unaliased spelling keeps working without any SQL.
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"max_time(root.db.d1.s1)"}, client.TreeSqlDialect, "ms", ""); !reflect.DeepEqual(got, []string{"TIMESTAMP(ms)"}) {
		t.Fatalf("unaliased max_time must stay a timestamp: %#v", got)
	}
	// A column name that merely starts with an aggregate is not one.
	if got := normalizedColumnTypes([]string{"INT64"}, []string{"max_time(root.db.d1.s1) + 1"}, client.TreeSqlDialect, "ms", ""); !reflect.DeepEqual(got, []string{"INT64"}) {
		t.Fatalf("arithmetic on max_time must stay INT64: %#v", got)
	}
}
