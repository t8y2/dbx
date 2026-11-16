package main

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

type plDebugNativeSourceToken struct {
	Text                       string
	Quoted, Literal            bool
	Identifier                 bool
	Start, End, Line, LastLine int
}

func (t plDebugNativeSourceToken) word(value string) bool {
	return !t.Quoted && !t.Literal && t.Text == value
}

func plDebugNativeSourceTokens(source plDebugNativeSource) ([]plDebugNativeSourceToken, error) {
	parts := make([]string, 0, len(source.Lines))
	for _, line := range source.Lines {
		text := strings.TrimSuffix(line.Text, "\n")
		text = strings.TrimSuffix(text, "\r")
		if strings.ContainsAny(text, "\r\n") {
			return nil, errors.New("source row contains more than one physical line")
		}
		parts = append(parts, text)
	}
	text := strings.Join(parts, "\n")
	tokens := []plDebugNativeSourceToken{}
	line := 1
	for pos := 0; pos < len(text); {
		start, first := pos, line
		r, size := utf8.DecodeRuneInString(text[pos:])
		if unicode.IsSpace(r) {
			if r == '\n' {
				line++
			}
			pos += size
			continue
		}
		if strings.HasPrefix(text[pos:], "--") {
			end := strings.IndexByte(text[pos:], '\n')
			if end < 0 {
				break
			}
			pos += end
			continue
		}
		if strings.HasPrefix(text[pos:], "/*") {
			end := strings.Index(text[pos+2:], "*/")
			if end < 0 {
				return nil, errors.New("unterminated source comment")
			}
			pos += end + 4
			line += strings.Count(text[start:pos], "\n")
			continue
		}
		if text[pos] == '$' {
			return nil, errors.New("conditional compilation requires a resolved source configuration")
		}
		qPrefix := 0
		if pos+1 < len(text) && (text[pos] == 'q' || text[pos] == 'Q') && text[pos+1] == '\'' {
			qPrefix = 2
		}
		if pos+2 < len(text) && (text[pos] == 'n' || text[pos] == 'N') && (text[pos+1] == 'q' || text[pos+1] == 'Q') && text[pos+2] == '\'' {
			qPrefix = 3
		}
		if qPrefix != 0 {
			if pos+qPrefix >= len(text) {
				return nil, errors.New("unterminated alternative quoted source literal")
			}
			delim, width := utf8.DecodeRuneInString(text[pos+qPrefix:])
			close := delim
			switch delim {
			case '[':
				close = ']'
			case '{':
				close = '}'
			case '(':
				close = ')'
			case '<':
				close = '>'
			}
			if unicode.IsSpace(delim) || delim == '\'' {
				return nil, errors.New("invalid alternative quote delimiter")
			}
			body := pos + qPrefix + width
			end := strings.Index(text[body:], string(close)+"'")
			if end < 0 {
				return nil, errors.New("unterminated alternative quoted source literal")
			}
			pos = body + end + len(string(close)) + 1
			line += strings.Count(text[start:pos], "\n")
			tokens = append(tokens, plDebugNativeSourceToken{Literal: true, Start: start, End: pos, Line: first, LastLine: line})
			continue
		}
		if text[pos] == '\'' {
			pos++
			closed := false
			for pos < len(text) {
				if text[pos] == '\'' {
					if pos+1 < len(text) && text[pos+1] == '\'' {
						pos += 2
						continue
					}
					pos++
					closed = true
					break
				}
				pos++
			}
			if !closed {
				return nil, errors.New("unterminated source literal")
			}
			line += strings.Count(text[start:pos], "\n")
			tokens = append(tokens, plDebugNativeSourceToken{Literal: true, Start: start, End: pos, Line: first, LastLine: line})
			continue
		}
		identifier, next, ok := readOracleIdentifierToken(text, pos)
		if ok {
			pos = next
			line += strings.Count(text[start:pos], "\n")
			tokens = append(tokens, plDebugNativeSourceToken{Text: identifier.Name, Quoted: identifier.Quoted, Identifier: true, Start: start, End: pos, Line: first, LastLine: line})
			continue
		}
		if text[pos] == '"' {
			return nil, errors.New("unterminated source identifier")
		}
		pos += size
		tokens = append(tokens, plDebugNativeSourceToken{Text: text[start:pos], Start: start, End: pos, Line: first, LastLine: line})
	}
	return tokens, nil
}

type plDebugNativeRoutineParameter struct {
	Name, Mode, Type   string
	TypeStart, TypeEnd int
}
type plDebugNativeRoutineRange struct {
	Name, Owner, Kind, ReturnType string
	Parameters                    []plDebugNativeRoutineParameter
	First, Last, Start, End       int
	Parent                        int
}
type plDebugNativeRoutineScan struct {
	Tokens            []plDebugNativeSourceToken
	Ranges            []plDebugNativeRoutineRange
	DeclarationScopes []plDebugNativeDeclarationScope
	Initialization    int
	Error             string
}

type plDebugNativeDeclarationScope struct {
	Start, Begin, End, Parent int
}

func plDebugNativeRoutineHeader(tokens []plDebugNativeSourceToken, start int) (plDebugNativeRoutineRange, int, bool) {
	return plDebugNativeRoutineHeaderMode(tokens, start, false)
}

func plDebugNativeRoutineHeaderMode(tokens []plDebugNativeSourceToken, start int, declarationsOnly bool) (plDebugNativeRoutineRange, int, bool) {
	node := plDebugNativeRoutineRange{Kind: tokens[start].Text, First: tokens[start].Line, Start: tokens[start].Start, Parent: -1, Parameters: []plDebugNativeRoutineParameter{}}
	pos := start + 1
	if pos >= len(tokens) || !tokens[pos].Identifier {
		return node, pos, false
	}
	node.Name = tokens[pos].Text
	pos++
	if pos+1 < len(tokens) && tokens[pos].word(".") {
		if !tokens[pos+1].Identifier {
			return node, pos, false
		}
		node.Owner, node.Name = node.Name, tokens[pos+1].Text
		pos += 2
	}
	if pos < len(tokens) && tokens[pos].word("(") {
		pos++
		begin, depth := pos, 0
		for pos < len(tokens) {
			if tokens[pos].word("(") {
				depth++
			}
			if tokens[pos].word(")") {
				if depth == 0 {
					if pos == begin && len(node.Parameters) != 0 {
						return node, pos, false
					}
					if pos > begin {
						param, ok := plDebugNativeRoutineParamMode(tokens[begin:pos], declarationsOnly)
						if !ok {
							return node, pos, false
						}
						node.Parameters = append(node.Parameters, param)
					}
					pos++
					break
				}
				depth--
			}
			if tokens[pos].word(",") && depth == 0 {
				param, ok := plDebugNativeRoutineParamMode(tokens[begin:pos], declarationsOnly)
				if !ok {
					return node, pos, false
				}
				node.Parameters = append(node.Parameters, param)
				begin = pos + 1
			}
			pos++
		}
	}
	if node.Kind == "FUNCTION" {
		if pos+1 >= len(tokens) || !tokens[pos].word("RETURN") {
			return node, pos, false
		}
		pos++
		if !tokens[pos].Identifier || tokens[pos].Quoted && !declarationsOnly {
			return node, pos, false
		}
		node.ReturnType = tokens[pos].Text
		pos++
		if declarationsOnly {
			for pos < len(tokens) && !tokens[pos].word("IS") && !tokens[pos].word("AS") && !tokens[pos].word(";") && !tokens[pos].word("AUTHID") && !tokens[pos].word("DETERMINISTIC") && !tokens[pos].word("PIPELINED") && !tokens[pos].word("RESULT_CACHE") {
				pos++
			}
		} else if pos < len(tokens) && (tokens[pos].word(".") || tokens[pos].word("%")) {
			return node, pos, false
		}
	}
	for pos < len(tokens) {
		if tokens[pos].word("IS") || tokens[pos].word("AS") || tokens[pos].word(";") {
			return node, pos, true
		}
		if tokens[pos].word("AUTHID") {
			if pos+1 >= len(tokens) || (!tokens[pos+1].word("CURRENT_USER") && !tokens[pos+1].word("DEFINER")) {
				return node, pos, false
			}
			pos += 2
			continue
		}
		if tokens[pos].word("DETERMINISTIC") || tokens[pos].word("PIPELINED") || tokens[pos].word("RESULT_CACHE") {
			pos++
			continue
		}
		if tokens[pos].word("PARALLEL_ENABLE") || tokens[pos].word("RELIES_ON") {
			pos++
			if pos >= len(tokens) || !tokens[pos].word("(") {
				continue
			}
		}
		if tokens[pos].word("ACCESSIBLE") {
			if pos+2 >= len(tokens) || !tokens[pos+1].word("BY") || !tokens[pos+2].word("(") {
				return node, pos, false
			}
			pos += 2
		}
		if tokens[pos].word("(") {
			depth := 0
			for pos < len(tokens) {
				if tokens[pos].word("(") {
					depth++
				}
				if tokens[pos].word(")") {
					depth--
				}
				pos++
				if depth == 0 {
					break
				}
			}
			if depth != 0 {
				return node, pos, false
			}
			continue
		}
		return node, pos, false
	}
	return node, pos, false
}

func plDebugNativeRoutineParamMode(tokens []plDebugNativeSourceToken, declarationsOnly bool) (plDebugNativeRoutineParameter, bool) {
	param := plDebugNativeRoutineParameter{Mode: "IN"}
	if len(tokens) < 2 || !tokens[0].Identifier {
		return param, false
	}
	param.Name = tokens[0].Text
	pos := 1
	if tokens[pos].word("IN") {
		pos++
		if pos < len(tokens) && tokens[pos].word("OUT") {
			param.Mode = "IN OUT"
			pos++
		}
	} else if tokens[pos].word("OUT") {
		param.Mode = "OUT"
		pos++
	}
	if pos < len(tokens) && tokens[pos].word("NOCOPY") {
		pos++
	}
	if pos >= len(tokens) || !tokens[pos].Identifier || tokens[pos].Quoted && !declarationsOnly {
		return param, false
	}
	if declarationsOnly {
		param.TypeStart = tokens[pos].Start
		end, depth := pos, 0
		for end < len(tokens) {
			if depth == 0 && (tokens[end].word("DEFAULT") || tokens[end].word(":")) {
				break
			}
			if tokens[end].word("(") {
				depth++
			}
			if tokens[end].word(")") {
				depth--
			}
			if depth < 0 {
				return param, false
			}
			end++
		}
		if end == pos || depth != 0 {
			return param, false
		}
		param.TypeEnd = tokens[end-1].End
		return param, true
	}
	param.Type = tokens[pos].Text
	pos++
	if pos < len(tokens) && (tokens[pos].word(".") || tokens[pos].word("%")) {
		return param, false
	}
	if pos < len(tokens) && tokens[pos].word("(") {
		depth := 0
		for pos < len(tokens) {
			if tokens[pos].word("(") {
				depth++
			}
			if tokens[pos].word(")") {
				depth--
			}
			pos++
			if depth == 0 {
				break
			}
		}
		if depth != 0 {
			return param, false
		}
	}
	if pos == len(tokens) {
		return param, true
	}
	if tokens[pos].word("DEFAULT") && pos+1 < len(tokens) {
		return param, true
	}
	if pos+2 < len(tokens) && tokens[pos].word(":") && tokens[pos+1].word("=") {
		return param, true
	}
	return param, false
}

func plDebugScanNativeRoutines(source plDebugNativeSource) plDebugNativeRoutineScan {
	return plDebugScanNativeRoutinesMode(source, false)
}

func plDebugScanNativeRoutinesMode(source plDebugNativeSource, declarationsOnly bool) plDebugNativeRoutineScan {
	tokens, err := plDebugNativeSourceTokens(source)
	scan := plDebugNativeRoutineScan{Tokens: tokens, Ranges: []plDebugNativeRoutineRange{}}
	if err != nil {
		scan.Error = err.Error()
		return scan
	}
	var routine func(int, int) (int, bool)
	var declarations func(int, int, bool) (int, bool)
	var body func(int, int) (int, bool)
	rootName := ""
	body = func(pos, parent int) (int, bool) {
		blocks := []string{"BEGIN"}
		pos++
		for pos < len(tokens) {
			t := tokens[pos]
			if t.word("DECLARE") {
				nestedParent := parent
				if parent < 0 {
					nestedParent = -2
				}
				next, ok := declarations(pos+1, nestedParent, false)
				if !ok {
					return pos, false
				}
				pos = next
				continue
			}
			if t.word("PROCEDURE") || t.word("FUNCTION") {
				return pos, false
			}
			if t.word("BEGIN") || t.word("IF") || t.word("LOOP") || t.word("CASE") {
				blocks = append(blocks, t.Text)
				pos++
				continue
			}
			if !t.word("END") {
				pos++
				continue
			}
			if len(blocks) == 0 {
				return pos, false
			}
			kind := blocks[len(blocks)-1]
			pos++
			if kind == "IF" || kind == "LOOP" {
				if pos >= len(tokens) || !tokens[pos].word(kind) {
					return pos, false
				}
				pos++
			} else if kind == "CASE" {
				if pos < len(tokens) && tokens[pos].word("CASE") {
					pos++
				}
			} else if pos < len(tokens) && (tokens[pos].word("IF") || tokens[pos].word("LOOP") || tokens[pos].word("CASE")) {
				return pos, false
			}
			blocks = blocks[:len(blocks)-1]
			if len(blocks) != 0 {
				continue
			}
			if pos < len(tokens) && !tokens[pos].word(";") {
				name := rootName
				if parent >= 0 {
					name = scan.Ranges[parent].Name
				}
				if tokens[pos].Text != name {
					return pos, false
				}
				pos++
			}
			if pos >= len(tokens) || !tokens[pos].word(";") {
				return pos, false
			}
			return pos + 1, true
		}
		return pos, false
	}
	declarations = func(pos, parent int, packageBody bool) (int, bool) {
		declarationStart := pos
		for pos < len(tokens) {
			if tokens[pos].word("PROCEDURE") || tokens[pos].word("FUNCTION") {
				next, ok := routine(pos, parent)
				if !ok {
					return pos, false
				}
				pos = next
				continue
			}
			if tokens[pos].word("BEGIN") {
				if packageBody {
					scan.Initialization = tokens[pos].Line
				}
				end, ok := body(pos, parent)
				if ok {
					scan.DeclarationScopes = append(scan.DeclarationScopes, plDebugNativeDeclarationScope{Start: declarationStart, Begin: pos, End: end, Parent: parent})
				}
				return end, ok
			}
			if tokens[pos].word("END") && packageBody {
				declarationEnd := pos
				pos++
				if pos < len(tokens) && !tokens[pos].word(";") {
					if tokens[pos].Text != rootName {
						return pos, false
					}
					pos++
				}
				if pos >= len(tokens) || !tokens[pos].word(";") {
					return pos, false
				}
				scan.DeclarationScopes = append(scan.DeclarationScopes, plDebugNativeDeclarationScope{Start: declarationStart, Begin: declarationEnd, End: pos + 1, Parent: parent})
				return pos + 1, true
			}
			depth, cases := 0, 0
			for pos < len(tokens) {
				t := tokens[pos]
				if t.word("(") {
					depth++
				}
				if t.word(")") {
					depth--
					if depth < 0 {
						return pos, false
					}
				}
				if t.word("CASE") {
					cases++
				}
				if t.word("END") && cases > 0 {
					cases--
				}
				if t.word(";") && depth == 0 && cases == 0 {
					pos++
					break
				}
				if t.word("BEGIN") && depth == 0 && cases == 0 {
					return pos, false
				}
				pos++
			}
		}
		return pos, false
	}
	routine = func(start, parent int) (int, bool) {
		node, pos, ok := plDebugNativeRoutineHeaderMode(tokens, start, declarationsOnly)
		if !ok {
			return pos, false
		}
		if tokens[pos].word(";") {
			return pos + 1, true
		}
		node.Parent = parent
		index := len(scan.Ranges)
		scan.Ranges = append(scan.Ranges, node)
		end, ok := declarations(pos+1, index, false)
		if !ok {
			return end, false
		}
		scan.Ranges[index].End = tokens[end-1].End
		scan.Ranges[index].Last = tokens[end-1].LastLine
		return end, true
	}
	pos := 0
	closed := false
	if len(tokens) > 0 && (tokens[0].word("PROCEDURE") || tokens[0].word("FUNCTION")) {
		pos, closed = routine(0, -1)
	} else if len(tokens) > 2 && tokens[0].word("PACKAGE") {
		pos = 1
		if tokens[pos].word("BODY") {
			pos++
		}
		rootName = tokens[pos].Text
		pos++
		if pos+1 < len(tokens) && tokens[pos].word(".") {
			if rootName != source.Owner {
				pos = 0
			} else {
				rootName = tokens[pos+1].Text
				pos += 2
			}
		}
		if rootName != source.Name {
			pos = 0
		}
		if pos > 0 && pos < len(tokens) && (tokens[pos].word("IS") || tokens[pos].word("AS")) {
			pos, closed = declarations(pos+1, -1, true)
		} else {
			pos = 0
		}
	}
	if !closed || pos != len(tokens) || pos == 0 {
		scan.Error = "source lexical scopes could not be closed reliably"
		scan.Ranges = nil
	}
	return scan
}

func (s plDebugNativeRoutineScan) ownerAtLine(line int) (int, bool) {
	owner, seen := -1, false
	for _, token := range s.Tokens {
		if line < token.Line || line > token.LastLine {
			continue
		}
		current, width := -1, 0
		for i, node := range s.Ranges {
			if token.Start >= node.Start && token.End <= node.End && (current < 0 || node.End-node.Start < width) {
				current, width = i, node.End-node.Start
			}
		}
		if seen && current != owner {
			return -1, false
		}
		owner, seen = current, true
	}
	if !seen {
		width := 0
		for i, node := range s.Ranges {
			if line >= node.First && line <= node.Last && (owner < 0 || node.End-node.Start < width) {
				owner, width = i, node.End-node.Start
			}
		}
	}
	return owner, true
}

type plDebugNativeRoutineIdentity struct {
	State        string  `json:"state"`
	Name         *string `json:"name"`
	SubprogramID *int64  `json:"subprogramId"`
	FirstLine    int     `json:"firstLine"`
	LastLine     int     `json:"lastLine"`
	EvidenceKind string  `json:"evidenceKind"`
	Error        string  `json:"error"`
}

func plDebugNativeIdentifyRoutine(source plDebugNativeSource, target plDebugNativeCandidate, line int) plDebugNativeRoutineIdentity {
	return plDebugScanNativeRoutines(source).identify(target, line)
}

func (scan plDebugNativeRoutineScan) identify(target plDebugNativeCandidate, line int) plDebugNativeRoutineIdentity {
	identity := plDebugNativeRoutineIdentity{State: "unresolved", EvidenceKind: "source_signature"}
	if scan.Error != "" {
		identity.Error = scan.Error
		return identity
	}
	selected := -1
	for i, node := range scan.Ranges {
		if node.Parent != -1 || node.Name != target.ObjectName || node.Kind != target.ObjectType || (node.Owner != "" && node.Owner != target.Schema) {
			continue
		}
		params := target.parameters()
		if len(params) != len(node.Parameters) {
			continue
		}
		matches := true
		for i, param := range params {
			parsed := node.Parameters[i]
			if param.Name == nil || *param.Name != parsed.Name || param.Mode != parsed.Mode || param.Type != parsed.Type || !param.scalar() {
				matches = false
			}
		}
		returned := target.returns()
		if node.Kind == "FUNCTION" && (returned == nil || !returned.scalar() || returned.Type != node.ReturnType) {
			matches = false
		}
		if !matches {
			continue
		}
		if selected >= 0 {
			identity.State = "ambiguous"
			return identity
		}
		selected = i
	}
	owner, unique := scan.ownerAtLine(line)
	if !unique {
		identity.State = "ambiguous"
		return identity
	}
	if owner < 0 {
		if target.PackageName != nil {
			identity.State = "package_initialization"
		}
		return identity
	}
	actual := scan.Ranges[owner]
	identity.Name = &actual.Name
	identity.FirstLine, identity.LastLine = actual.First, actual.Last
	if selected < 0 {
		identity.Error = "no unique closed source definition matches the frozen signature"
		return identity
	}
	if owner != selected {
		identity.State = "other_routine"
		return identity
	}
	identity.State = "verified"
	id := target.SubprogramID
	identity.SubprogramID = &id
	return identity
}
