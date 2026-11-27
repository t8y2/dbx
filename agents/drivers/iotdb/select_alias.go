package main

import "strings"

// Tree-dialect max_time/min_time and max_by/min_by(Time, …) aggregates return
// epoch values as plain INT64, so the agent types those columns as TIMESTAMP
// to let the grid and exports render standard times. For an unaliased column
// the aggregate is visible in the column name, but `AS alias` replaces that
// name: IoTDB 1.3.x reports the alias itself with its quotes removed and
// doubled quote characters collapsed. The SELECT list is parsed here to recover
// which aliases stand for such an aggregate.

// timeAggregationAliases returns the result column names that a tree-dialect
// SELECT gives, through `AS alias`, to a time aggregate. Names are compared
// exactly: IoTDB keeps the alias casing, so `a` and `A` are distinct columns.
func timeAggregationAliases(sql string) map[string]struct{} {
	aliases := map[string]struct{}{}
	for _, item := range selectListItems(sql) {
		expression, alias, ok := splitResultColumnAlias(item)
		if ok && isTimeAggregationExpression(expression) {
			aliases[alias] = struct{}{}
		}
	}
	return aliases
}

// isTimeAggregationExpression reports whether expression is exactly one call to
// max_time/min_time, or to max_by/min_by with Time as the first argument. It is
// used for SELECT-list expressions and for unaliased result column names, which
// IoTDB spells the same way (for example `max_by(Time, root.db.d1.s1)`).
func isTimeAggregationExpression(expression string) bool {
	call := strings.TrimSpace(expression)
	nameEnd := 0
	for nameEnd < len(call) && isFunctionNameByte(call[nameEnd]) {
		nameEnd++
	}
	name := strings.ToLower(call[:nameEnd])
	if name != "max_time" && name != "min_time" && name != "max_by" && name != "min_by" {
		return false
	}
	// IoTDB accepts whitespace between the function name and its parenthesis.
	arguments, ok := callArguments(strings.TrimLeft(call[nameEnd:], " \t\r\n"))
	if !ok {
		return false
	}
	if name == "max_time" || name == "min_time" {
		return strings.TrimSpace(arguments) != ""
	}
	comma := strings.IndexByte(arguments, ',')
	return comma > 0 && strings.EqualFold(strings.TrimSpace(arguments[:comma]), "time")
}

// callArguments returns the text between the parentheses of text, which must
// start with "(" and whose matching ")" must be its last byte, so that
// `max_time(s1) + 1` or a truncated name is not mistaken for a plain call.
func callArguments(text string) (string, bool) {
	if text == "" || text[0] != '(' {
		return "", false
	}
	depth := 0
	for i := 0; i < len(text); {
		switch text[i] {
		case '\'', '"', '`':
			i = skipQuoted(text, i)
			continue
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return text[1:i], i == len(text)-1
			}
		}
		i++
	}
	return "", false
}

// selectListItems splits the select list of a tree-dialect SELECT into its
// comma-separated result columns. It stops at the first top-level FROM or INTO
// and returns nil for anything that is not a plain SELECT: `SELECT LAST`
// reports fixed columns, and other statements have no select list.
func selectListItems(sql string) []string {
	i := skipSpace(sql, 0)
	if !hasKeywordAt(sql, i, "select") {
		return nil
	}
	i = skipSpace(sql, i+len("select"))
	if hasKeywordAt(sql, i, "last") {
		return nil
	}
	var items []string
	depth, start := 0, i
	for i < len(sql) {
		switch c := sql[i]; {
		case c == '\'' || c == '"' || c == '`':
			i = skipQuoted(sql, i)
			continue
		case c == '(':
			depth++
		case c == ')':
			if depth > 0 {
				depth--
			}
		case c == ',' && depth == 0:
			items = append(items, sql[start:i])
			start = i + 1
		case depth == 0 && (hasKeywordAt(sql, i, "from") || hasKeywordAt(sql, i, "into")):
			return append(items, sql[start:i])
		}
		i++
	}
	return nil
}

// splitResultColumnAlias splits `expression AS alias`. IoTDB's grammar is
// `resultColumn: expression (AS alias)?` with `alias: constant | identifier`,
// so an alias always follows AS and is a quoted or bare token. The returned
// alias is what the server reports as the column name.
func splitResultColumnAlias(item string) (expression, alias string, ok bool) {
	depth, asIndex := 0, -1
	for i := 0; i < len(item); {
		switch c := item[i]; {
		case c == '\'' || c == '"' || c == '`':
			i = skipQuoted(item, i)
			continue
		case c == '(':
			depth++
		case c == ')':
			if depth > 0 {
				depth--
			}
		case depth == 0 && hasKeywordAt(item, i, "as"):
			asIndex = i
		}
		i++
	}
	if asIndex < 0 {
		return "", "", false
	}
	raw := strings.TrimSpace(item[asIndex+len("as"):])
	if raw == "" {
		return "", "", false
	}
	return item[:asIndex], unquoteAlias(raw), true
}

// unquoteAlias strips the quotes of a '…', "…" or `…` alias and collapses its
// doubled quote characters, matching the column name IoTDB 1.3.7 reports.
func unquoteAlias(alias string) string {
	if len(alias) >= 2 {
		quote := alias[0]
		if (quote == '\'' || quote == '"' || quote == '`') && alias[len(alias)-1] == quote {
			doubled := string([]byte{quote, quote})
			return strings.ReplaceAll(alias[1:len(alias)-1], doubled, string(quote))
		}
	}
	return alias
}

// skipQuoted returns the index just past the quoted literal that starts at
// text[start]. A doubled quote character inside the literal is an escape.
func skipQuoted(text string, start int) int {
	quote := text[start]
	for i := start + 1; i < len(text); i++ {
		if text[i] != quote {
			continue
		}
		if i+1 < len(text) && text[i+1] == quote {
			i++
			continue
		}
		return i + 1
	}
	return len(text)
}

func skipSpace(text string, index int) int {
	for index < len(text) && strings.IndexByte(" \t\r\n", text[index]) >= 0 {
		index++
	}
	return index
}

// hasKeywordAt reports whether text holds the keyword at index as a whole word.
// '.' and every character IoTDB allows in an unquoted name count as part of a
// word, so a path node such as `root.from.s1` or an identifier such as `x$as`
// is never read as a clause keyword.
func hasKeywordAt(text string, index int, keyword string) bool {
	end := index + len(keyword)
	if index < 0 || end > len(text) || !strings.EqualFold(text[index:end], keyword) {
		return false
	}
	if index > 0 && isWordByte(text[index-1]) {
		return false
	}
	return end == len(text) || !isWordByte(text[end])
}

func isFunctionNameByte(b byte) bool {
	return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// isWordByte covers IoTDB's unquoted name characters (NAME_CHAR in the 1.3.7
// SqlLexer.g4: letters, digits and _ : @ # $ { } plus CJK), a path's '.', and
// every non-ASCII byte so multi-byte names stay in one word.
func isWordByte(b byte) bool {
	return isFunctionNameByte(b) || b >= 0x80 || strings.IndexByte(".:@#${}", b) >= 0
}
