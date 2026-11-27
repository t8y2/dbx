package main

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	sqlWordToken  byte = 'w'
	sqlCommaToken byte = ','
)

// selectAliasExpressions maps every explicit AS alias in the statement to the
// expression it names. IoTDB replaces the server-side column name with the
// alias, so the statement is the only place where the original aggregate
// survives: without it `max_by(time, x) AS t` is indistinguishable from a
// plain INT64 column (#15876).
func selectAliasExpressions(sql string) map[string]string {
	list, ok := selectListOf(sql)
	if !ok {
		return nil
	}
	var aliases map[string]string
	for _, item := range splitSelectItems(list) {
		expression, alias, ok := splitSelectAlias(item)
		if !ok {
			continue
		}
		if aliases == nil {
			aliases = make(map[string]string, 4)
		}
		aliases[alias] = expression
	}
	return aliases
}

// selectListOf returns the text between the statement's SELECT and the FROM
// that closes it. Subqueries keep their own parentheses, so only the outermost
// clause is returned.
func selectListOf(sql string) (string, bool) {
	start, end := -1, -1
	scanSQLTopLevel(sql, func(kind byte, text string, tokenStart, tokenEnd int) bool {
		if kind != sqlWordToken {
			return true
		}
		if start < 0 {
			if strings.EqualFold(text, "SELECT") {
				start = tokenEnd
			}
			return true
		}
		if strings.EqualFold(text, "FROM") {
			end = tokenStart
			return false
		}
		return true
	})
	if start < 0 || end < start {
		return "", false
	}
	return sql[start:end], true
}

// splitSelectItems splits the SELECT list on the commas that separate its
// items, leaving commas inside function arguments and literals alone.
func splitSelectItems(list string) []string {
	items := make([]string, 0, 8)
	start := 0
	scanSQLTopLevel(list, func(kind byte, _ string, tokenStart, _ int) bool {
		if kind == sqlCommaToken {
			items = append(items, list[start:tokenStart])
			start = tokenStart + 1
		}
		return true
	})
	return append(items, list[start:])
}

// splitSelectAlias splits one SELECT item of the form
// "<expression> AS <alias>". IoTDB rejects aliases without an explicit AS, so
// an item that does not end with one has no alias.
func splitSelectAlias(item string) (string, string, bool) {
	asStart, alias := -1, ""
	scanSQLTopLevel(item, func(kind byte, text string, tokenStart, tokenEnd int) bool {
		if kind != sqlWordToken || !strings.EqualFold(text, "AS") {
			return true
		}
		parsed, ok := parseSelectAlias(item[tokenEnd:])
		if ok {
			asStart, alias = tokenStart, parsed
		}
		return true
	})
	if asStart < 0 || alias == "" {
		return "", "", false
	}
	return strings.TrimSpace(item[:asStart]), alias, true
}

// parseSelectAlias reads the identifier that follows AS and must reach the end
// of the item. IoTDB reports the identifier as written, without the backticks
// or double quotes that may wrap it.
func parseSelectAlias(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	if quote := trimmed[0]; quote == '"' || quote == '`' {
		body := trimmed[1:]
		var alias strings.Builder
		for index := 0; index < len(body); index++ {
			if body[index] != quote {
				alias.WriteByte(body[index])
				continue
			}
			if index+1 < len(body) && body[index+1] == quote {
				alias.WriteByte(quote)
				index++
				continue
			}
			if strings.TrimSpace(body[index+1:]) != "" {
				return "", false
			}
			return alias.String(), true
		}
		return "", false
	}
	end := 0
	for end < len(trimmed) {
		current, size := utf8.DecodeRuneInString(trimmed[end:])
		if current != '_' && current != '$' && !unicode.IsLetter(current) && !unicode.IsDigit(current) {
			break
		}
		end += size
	}
	if end == 0 || strings.TrimSpace(trimmed[end:]) != "" {
		return "", false
	}
	return trimmed[:end], true
}

// scanSQLTopLevel visits the words and commas of a SQL fragment in order while
// skipping literals, quoted identifiers and comments. Only tokens outside
// parentheses are reported, so an aggregate's argument list never looks like a
// list of its own.
func scanSQLTopLevel(fragment string, visit func(kind byte, text string, start, end int) bool) {
	depth := 0
	for index := 0; index < len(fragment); {
		current := fragment[index]
		switch {
		case current == '\'' || current == '"' || current == '`':
			index = skipSQLQuoted(fragment, index)
		case current == '-' && strings.HasPrefix(fragment[index:], "--"):
			index = skipSQLLineComment(fragment, index)
		case current == '/' && strings.HasPrefix(fragment[index:], "/*"):
			index = skipSQLBlockComment(fragment, index)
		case current == '(':
			depth++
			index++
		case current == ')':
			if depth > 0 {
				depth--
			}
			index++
		case current == ',' && depth == 0:
			if !visit(sqlCommaToken, ",", index, index+1) {
				return
			}
			index++
		default:
			runeValue, size := utf8.DecodeRuneInString(fragment[index:])
			if runeValue != '_' && !unicode.IsLetter(runeValue) {
				index += size
				continue
			}
			start := index
			for index < len(fragment) {
				runeValue, size = utf8.DecodeRuneInString(fragment[index:])
				if runeValue != '_' && runeValue != '$' && !unicode.IsLetter(runeValue) && !unicode.IsDigit(runeValue) {
					break
				}
				index += size
			}
			if depth == 0 && !visit(sqlWordToken, fragment[start:index], start, index) {
				return
			}
		}
	}
}

// skipSQLQuoted returns the index just past the literal or quoted identifier
// that starts at index; a doubled quote character stays inside it.
func skipSQLQuoted(fragment string, index int) int {
	quote := fragment[index]
	for position := index + 1; position < len(fragment); position++ {
		if fragment[position] != quote {
			continue
		}
		if position+1 < len(fragment) && fragment[position+1] == quote {
			position++
			continue
		}
		return position + 1
	}
	return len(fragment)
}

func skipSQLLineComment(fragment string, index int) int {
	if newline := strings.IndexByte(fragment[index:], '\n'); newline >= 0 {
		return index + newline + 1
	}
	return len(fragment)
}

func skipSQLBlockComment(fragment string, index int) int {
	if closing := strings.Index(fragment[index+2:], "*/"); closing >= 0 {
		return index + 2 + closing + 2
	}
	return len(fragment)
}
