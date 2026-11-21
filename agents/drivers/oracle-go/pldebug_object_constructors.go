package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Constructor grammar mirrors the verified Java adapter; the shared Oracle
// source lexer owns quoted identifiers, comments and alternative literals.
type plDebugNativeConstructorParameter struct {
	Name       string   `json:"name"`
	Type       []string `json:"type"`
	Defaulted  bool     `json:"defaulted"`
	QuotedType bool     `json:"quotedType"`
}
type plDebugNativeConstructor struct {
	ID         string                              `json:"id"`
	Parameters []plDebugNativeConstructorParameter `json:"parameters"`
}
type plDebugNativeConstructorDescription struct {
	State        string                     `json:"state"`
	Constructors []plDebugNativeConstructor `json:"constructors"`
}

type plDebugNativeConstructorFormal struct {
	Name      string                   `json:"name"`
	Type      plDebugNativeMetadataRow `json:"type"`
	Defaulted bool                     `json:"defaulted"`
}
type plDebugNativeConstructorCallable struct {
	ID         string                           `json:"id"`
	Origin     string                           `json:"origin"`
	Parameters []plDebugNativeConstructorFormal `json:"parameters"`
}
type plDebugNativeConstructorCallables struct {
	State        string                             `json:"state"`
	Constructors []plDebugNativeConstructorCallable `json:"constructors"`
}

func plDebugNativeConstructorTypeEqual(left, right plDebugNativeMetadataRow) bool {
	for _, key := range []string{"ATTR_TYPE_OWNER", "ATTR_TYPE_PACKAGE"} {
		if left.text(key) != right.text(key) {
			return false
		}
	}
	if carrier := plDebugNativeConstructorNumericCarrier(left); carrier != "" {
		return carrier == plDebugNativeConstructorNumericCarrier(right)
	}
	return plDebugNativeConstructorScalarType(left) == plDebugNativeConstructorScalarType(right)
}

func plDebugNativeConstructorNumericCarrier(row plDebugNativeMetadataRow) string {
	if row["ATTR_TYPE_OWNER"] != nil || row["ATTR_TYPE_PACKAGE"] != nil {
		return ""
	}
	switch row.text("ATTR_TYPE_NAME") {
	case "NUMBER", "INTEGER":
		return "NUMBER"
	case "PLS_INTEGER", "BINARY_INTEGER", "SIMPLE_INTEGER":
		return "PLS_INTEGER"
	default:
		return ""
	}
}
func plDebugNativeConstructorParameterType(graph plDebugNativeTypeGraph, declaring plDebugNativeTypeRef, p plDebugNativeConstructorParameter) plDebugNativeMetadataRow {
	candidates := plDebugNativeConstructorReferenceCandidates(declaring, p)
	if len(candidates) == 0 && len(p.Type) == 1 && !p.QuotedType {
		name := p.Type[0]
		return plDebugNativeMetadataRow{"ATTR_TYPE_NAME": &name}
	}
	var found *plDebugNativeTypeRef
	for _, candidate := range candidates {
		for _, node := range graph.Nodes {
			if candidate.key() == node.Reference.key() {
				if found != nil {
					return nil
				}
				ref := node.Reference
				found = &ref
			}
		}
	}
	if found == nil {
		return nil
	}
	return plDebugNativeMetadataRow{"ATTR_TYPE_OWNER": &found.Owner, "ATTR_TYPE_PACKAGE": found.PackageName, "ATTR_TYPE_NAME": &found.TypeName}
}
func plDebugNativeObjectCallables(graph plDebugNativeTypeGraph, node plDebugNativeTypeNode) plDebugNativeConstructorCallables {
	unresolved := plDebugNativeConstructorCallables{"constructor_metadata_unresolved", []plDebugNativeConstructorCallable{}}
	if node.Reference.PackageName != nil || node.Definition.text("TYPECODE") != "OBJECT" || node.ConstructorSource == nil || node.ConstructorSource.State != "syntax_parsed" || node.ObjectAccess == nil || node.ObjectAccess.State != "type_only_verified" {
		return unresolved
	}
	if node.Definition.text("INSTANTIABLE") == "NO" {
		return plDebugNativeConstructorCallables{"not_instantiable", []plDebugNativeConstructorCallable{}}
	}
	if node.Definition.text("INSTANTIABLE") != "YES" {
		return unresolved
	}
	users := []plDebugNativeConstructorCallable{}
	for _, constructor := range node.ConstructorSource.Constructors {
		call := plDebugNativeConstructorCallable{constructor.ID, "user", []plDebugNativeConstructorFormal{}}
		for _, p := range constructor.Parameters {
			kind := plDebugNativeConstructorParameterType(graph, node.Reference, p)
			if kind == nil {
				return unresolved
			}
			call.Parameters = append(call.Parameters, plDebugNativeConstructorFormal{p.Name, kind, p.Defaulted})
		}
		users = append(users, call)
	}
	system := plDebugNativeConstructorCallable{"attribute-value", "attribute_value", []plDebugNativeConstructorFormal{}}
	for _, attribute := range node.Attributes {
		if attribute.text("ATTR_NAME") == "" || attribute.text("ATTR_TYPE_NAME") == "" || attribute["ATTR_TYPE_MOD"] != nil {
			return unresolved
		}
		if attribute["ATTR_TYPE_OWNER"] != nil {
			found := false
			for _, child := range graph.Nodes {
				if child.Reference.Owner == attribute.text("ATTR_TYPE_OWNER") && child.Reference.TypeName == attribute.text("ATTR_TYPE_NAME") && ((child.Reference.PackageName == nil && attribute["ATTR_TYPE_PACKAGE"] == nil) || (child.Reference.PackageName != nil && *child.Reference.PackageName == attribute.text("ATTR_TYPE_PACKAGE"))) {
					found = true
				}
			}
			if !found {
				return unresolved
			}
		}
		system.Parameters = append(system.Parameters, plDebugNativeConstructorFormal{attribute.text("ATTR_NAME"), attribute, false})
	}
	hidden := false
	for _, user := range users {
		if len(user.Parameters) != len(system.Parameters) {
			continue
		}
		same := true
		for i, p := range user.Parameters {
			other := system.Parameters[i]
			if p.Name != other.Name || !plDebugNativeConstructorTypeEqual(p.Type, other.Type) {
				same = false
				break
			}
		}
		if same {
			hidden = true
			break
		}
	}
	result := []plDebugNativeConstructorCallable{}
	if !hidden {
		result = append(result, system)
	}
	result = append(result, users...)
	return plDebugNativeConstructorCallables{"resolved", result}
}

func plDebugNativeConstructorReferenceCandidates(declaring plDebugNativeTypeRef, parameter plDebugNativeConstructorParameter) []plDebugNativeTypeRef {
	parts := parameter.Type
	if len(parts) == 1 && !parameter.QuotedType {
		switch parts[0] {
		case "NUMBER", "INTEGER", "PLS_INTEGER", "BINARY_INTEGER", "SIMPLE_INTEGER", "BINARY_FLOAT", "BINARY_DOUBLE", "VARCHAR2", "CHAR", "BOOLEAN", "DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE", "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND", "CLOB", "BLOB", "RAW", "NCHAR", "NVARCHAR2", "NCLOB":
			return nil
		}
	}
	switch len(parts) {
	case 1:
		return []plDebugNativeTypeRef{{Owner: declaring.Owner, TypeName: parts[0]}}
	case 2:
		pack := parts[0]
		return []plDebugNativeTypeRef{{Owner: parts[0], TypeName: parts[1]}, {Owner: declaring.Owner, PackageName: &pack, TypeName: parts[1]}}
	case 3:
		pack := parts[1]
		return []plDebugNativeTypeRef{{Owner: parts[0], PackageName: &pack, TypeName: parts[2]}}
	default:
		return nil
	}
}

func plDebugDescribeNativeConstructors(ref plDebugNativeTypeRef, rows []plDebugNativeMetadataRow) plDebugNativeConstructorDescription {
	var source strings.Builder
	line := 1
	for _, row := range rows {
		if row.text("TYPE") != "TYPE" {
			continue
		}
		number, err := strconv.Atoi(row.text("LINE"))
		if err != nil || number != line || row["TEXT"] == nil {
			return plDebugNativeConstructorDescription{"constructor_metadata_unresolved", []plDebugNativeConstructor{}}
		}
		line++
		source.WriteString(row.text("TEXT"))
	}
	return plDebugReadNativeConstructors(ref, source.String())
}

func plDebugReadNativeConstructors(ref plDebugNativeTypeRef, source string) plDebugNativeConstructorDescription {
	constructors, err := plDebugParseNativeConstructors(ref, source)
	if err != nil {
		return plDebugNativeConstructorDescription{"constructor_metadata_unresolved", []plDebugNativeConstructor{}}
	}
	return plDebugNativeConstructorDescription{"syntax_parsed", constructors}
}

func plDebugConstructorReference(tokens []plDebugNativeSourceToken, index int) ([]string, int, error) {
	if index >= len(tokens) || !tokens[index].Identifier {
		return nil, index, errors.New("constructor type reference is unresolved")
	}
	parts := []string{tokens[index].Text}
	index++
	for index < len(tokens) && tokens[index].word(".") {
		if len(parts) >= 3 || index+1 >= len(tokens) || !tokens[index+1].Identifier {
			return nil, index, errors.New("constructor type reference is unresolved")
		}
		parts = append(parts, tokens[index+1].Text)
		index += 2
	}
	return parts, index, nil
}
func plDebugConstructorMatches(ref plDebugNativeTypeRef, parts []string) bool {
	return len(parts) == 1 && parts[0] == ref.TypeName || len(parts) == 2 && parts[0] == ref.Owner && parts[1] == ref.TypeName
}
func plDebugConstructorAt(tokens []plDebugNativeSourceToken, index int, word string) bool {
	return index >= 0 && index < len(tokens) && tokens[index].word(word)
}
func plDebugConstructorClose(tokens []plDebugNativeSourceToken, open int) (int, error) {
	depth := 0
	for i := open; i < len(tokens); i++ {
		if tokens[i].word("(") {
			depth++
		}
		if tokens[i].word(")") {
			depth--
			if depth == 0 {
				return i, nil
			}
		}
	}
	return 0, errors.New("unterminated constructor declaration")
}
func plDebugConstructorSplit(tokens []plDebugNativeSourceToken) ([][]plDebugNativeSourceToken, error) {
	parts := [][]plDebugNativeSourceToken{}
	if len(tokens) == 0 {
		return parts, nil
	}
	depth, start := 0, 0
	for i, token := range tokens {
		if token.word("(") {
			depth++
		}
		if token.word(")") {
			depth--
			if depth < 0 {
				return nil, errors.New("unbalanced constructor declaration")
			}
		}
		if token.word(",") && depth == 0 {
			if i == start {
				return nil, errors.New("empty constructor declaration")
			}
			parts = append(parts, tokens[start:i])
			start = i + 1
		}
	}
	if depth != 0 || start == len(tokens) {
		return nil, errors.New("incomplete constructor declaration")
	}
	return append(parts, tokens[start:]), nil
}

func plDebugParseNativeConstructors(ref plDebugNativeTypeRef, source string) ([]plDebugNativeConstructor, error) {
	invalid := func() ([]plDebugNativeConstructor, error) {
		return nil, errors.New("unresolved constructor declaration")
	}
	if ref.PackageName != nil || len(source) == 0 || len(source) > 1048576 {
		return invalid()
	}
	lines := []plDebugNativeSourceLine{}
	for i, text := range strings.Split(source, "\n") {
		lines = append(lines, plDebugNativeSourceLine{Number: int64(i + 1), Text: text})
	}
	tokens, err := plDebugNativeSourceTokens(plDebugNativeSource{Lines: lines})
	if err != nil {
		return nil, err
	}
	if len(tokens) > 65536 {
		return invalid()
	}
	index := 0
	for index < len(tokens) && !tokens[index].word("TYPE") {
		if !(tokens[index].word("CREATE") || tokens[index].word("OR") || tokens[index].word("REPLACE") || tokens[index].word("EDITIONABLE") || tokens[index].word("NONEDITIONABLE")) {
			return invalid()
		}
		index++
	}
	index++
	name, next, err := plDebugConstructorReference(tokens, index)
	if err != nil || !plDebugConstructorMatches(ref, name) {
		return invalid()
	}
	index = next
	if plDebugConstructorAt(tokens, index, "IS") || plDebugConstructorAt(tokens, index, "AS") {
		index++
		if !plDebugConstructorAt(tokens, index, "OBJECT") {
			return invalid()
		}
		index++
	} else if plDebugConstructorAt(tokens, index, "UNDER") {
		_, index, err = plDebugConstructorReference(tokens, index+1)
		if err != nil {
			return invalid()
		}
	} else {
		return invalid()
	}
	if !plDebugConstructorAt(tokens, index, "(") {
		return invalid()
	}
	close, err := plDebugConstructorClose(tokens, index)
	if err != nil {
		return nil, err
	}
	members, err := plDebugConstructorSplit(tokens[index+1 : close])
	if err != nil {
		return nil, err
	}
	constructors := []plDebugNativeConstructor{}
	for _, member := range members {
		pos := 0
		for plDebugConstructorAt(member, pos, "FINAL") || plDebugConstructorAt(member, pos, "INSTANTIABLE") || plDebugConstructorAt(member, pos, "NOT") || plDebugConstructorAt(member, pos, "OVERRIDING") {
			pos++
		}
		if !plDebugConstructorAt(member, pos, "CONSTRUCTOR") {
			for _, token := range member {
				if token.word("CONSTRUCTOR") {
					return invalid()
				}
			}
			if len(member) == 0 || !member[0].Identifier {
				return invalid()
			}
			continue
		}
		pos++
		if !plDebugConstructorAt(member, pos, "FUNCTION") {
			return invalid()
		}
		pos++
		if pos >= len(member) || !member[pos].Identifier || member[pos].Text != ref.TypeName {
			return invalid()
		}
		pos++
		declarations := [][]plDebugNativeSourceToken{}
		end := pos - 1
		if plDebugConstructorAt(member, pos, "(") {
			end, err = plDebugConstructorClose(member, pos)
			if err != nil {
				return invalid()
			}
			declarations, err = plDebugConstructorSplit(member[pos+1 : end])
			if err != nil {
				return invalid()
			}
		} else if !plDebugConstructorAt(member, pos, "RETURN") {
			return invalid()
		}
		params := []plDebugNativeConstructorParameter{}
		names := map[string]bool{}
		for parameterIndex, param := range declarations {
			if len(param) == 0 || !param[0].Identifier || names[param[0].Text] {
				return invalid()
			}
			parameterName := param[0].Text
			names[parameterName] = true
			start := 1
			output := false
			if plDebugConstructorAt(param, start, "IN") {
				start++
				if plDebugConstructorAt(param, start, "OUT") {
					output = true
					start++
				}
			} else if plDebugConstructorAt(param, start, "OUT") {
				output = true
				start++
			}
			if plDebugConstructorAt(param, start, "NOCOPY") {
				if !output {
					return invalid()
				}
				start++
			}
			defaultAt, defaultLength := len(param), 0
			for i := start; i < len(param); i++ {
				if param[i].word("DEFAULT") {
					defaultAt, defaultLength = i, 1
					break
				}
				if param[i].word(":") && plDebugConstructorAt(param, i+1, "=") {
					defaultAt, defaultLength = i, 2
					break
				}
			}
			if defaultAt == start || defaultLength > 0 && defaultAt+defaultLength >= len(param) {
				return invalid()
			}
			parts, typeEnd, e := plDebugConstructorReference(param, start)
			if e == nil && typeEnd == start+1 && param[start].word("INTERVAL") {
				if plDebugConstructorAt(param, typeEnd, "YEAR") && plDebugConstructorAt(param, typeEnd+1, "TO") && plDebugConstructorAt(param, typeEnd+2, "MONTH") {
					parts = []string{"INTERVAL YEAR TO MONTH"}
				} else if plDebugConstructorAt(param, typeEnd, "DAY") && plDebugConstructorAt(param, typeEnd+1, "TO") && plDebugConstructorAt(param, typeEnd+2, "SECOND") {
					parts = []string{"INTERVAL DAY TO SECOND"}
				} else {
					return invalid()
				}
				typeEnd += 3
			}
			if e == nil && typeEnd == start+1 && param[start].word("TIMESTAMP") && plDebugConstructorAt(param, typeEnd, "WITH") {
				typeEnd++
				kind := "TIMESTAMP WITH "
				if plDebugConstructorAt(param, typeEnd, "LOCAL") {
					kind += "LOCAL "
					typeEnd++
				}
				if !plDebugConstructorAt(param, typeEnd, "TIME") || !plDebugConstructorAt(param, typeEnd+1, "ZONE") {
					return invalid()
				}
				parts = []string{kind + "TIME ZONE"}
				typeEnd += 2
			}
			if e != nil || typeEnd != defaultAt {
				return invalid()
			}
			if parameterName == "SELF" {
				if parameterIndex != 0 || !output || defaultAt != len(param) || !plDebugConstructorMatches(ref, parts) {
					return invalid()
				}
			} else {
				if output {
					return invalid()
				}
				params = append(params, plDebugNativeConstructorParameter{parameterName, parts, defaultAt < len(param), param[start].Quoted})
			}
		}
		if end+5 != len(member) || !plDebugConstructorAt(member, end+1, "RETURN") || !plDebugConstructorAt(member, end+2, "SELF") || !plDebugConstructorAt(member, end+3, "AS") || !plDebugConstructorAt(member, end+4, "RESULT") {
			return invalid()
		}
		constructors = append(constructors, plDebugNativeConstructor{fmt.Sprintf("user-%d", len(constructors)+1), params})
	}
	for index = close + 1; index < len(tokens); {
		if tokens[index].word("NOT") {
			index++
			if !plDebugConstructorAt(tokens, index, "FINAL") && !plDebugConstructorAt(tokens, index, "INSTANTIABLE") {
				return invalid()
			}
			index++
		} else if tokens[index].word("FINAL") || tokens[index].word("INSTANTIABLE") || tokens[index].word(";") || tokens[index].word("/") {
			index++
		} else {
			return invalid()
		}
	}
	return constructors, nil
}
