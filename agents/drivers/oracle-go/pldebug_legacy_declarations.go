package main

import (
	"errors"
	"strconv"
	"strings"
)

type plDebugLegacyCollectionDeclaration struct {
	kind            string
	indexType       string
	indexLength     string
	indexLengthUnit string
	upperBound      string
	element         []plDebugNativeSourceToken
	elementNotNull  bool
}

func plDebugLegacyPackageDeclarations(source plDebugNativeSource) (map[string][]plDebugNativeSourceToken, error) {
	tokens, err := plDebugNativeSourceTokens(source)
	if err != nil {
		return nil, err
	}
	start := -1
	for i, token := range tokens {
		if token.word("PACKAGE") {
			if i+1 >= len(tokens) || !tokens[i+1].Identifier || tokens[i+1].word("BODY") || tokens[i+1].Text != source.Name {
				return nil, errors.New("compiled package source identity is incomplete")
			}
			for j := i + 2; j < len(tokens); j++ {
				if tokens[j].word("IS") || tokens[j].word("AS") {
					start = j + 1
					break
				}
			}
			break
		}
	}
	if start < 0 {
		return nil, errors.New("compiled package declaration is not visible")
	}
	declarations := map[string][]plDebugNativeSourceToken{}
	depth := 0
	first := start
	for i := start; i < len(tokens); i++ {
		token := tokens[i]
		if token.word("(") {
			depth++
		}
		if token.word(")") {
			depth--
		}
		if depth < 0 {
			return nil, errors.New("compiled package parentheses are inconsistent")
		}
		if !token.word(";") || depth != 0 {
			continue
		}
		part := tokens[first:i]
		first = i + 1
		if len(part) == 0 || !part[0].word("TYPE") && !part[0].word("SUBTYPE") {
			continue
		}
		if len(part) < 4 || !part[1].Identifier || !part[2].word("IS") {
			return nil, errors.New("compiled type declaration is incomplete")
		}
		name := part[1].Text
		if _, duplicate := declarations[name]; duplicate {
			return nil, errors.New("duplicate compiled type declaration")
		}
		declarations[name] = part
	}
	if depth != 0 {
		return nil, errors.New("compiled package declaration is unclosed")
	}
	return declarations, nil
}

func plDebugLegacyLiteralBound(tokens []plDebugNativeSourceToken) (string, error) {
	value := ""
	for _, token := range tokens {
		if token.Identifier || token.Literal || token.Quoted || len(token.Text) != 1 || token.Text[0] < '0' || token.Text[0] > '9' {
			return "", errors.New("legacy collection bound needs a confirmed positive integer literal")
		}
		value += token.Text
	}
	bound, err := strconv.ParseUint(value, 10, 32)
	if err != nil || bound == 0 {
		return "", errors.New("legacy collection bound is invalid")
	}
	return strconv.FormatUint(bound, 10), nil
}

func plDebugLegacyIndexType(tokens []plDebugNativeSourceToken, declarations map[string][]plDebugNativeSourceToken, seen map[string]bool, result *plDebugLegacyCollectionDeclaration) (string, error) {
	if len(tokens) == 0 || !tokens[0].Identifier {
		return "", errors.New("legacy collection index declaration is incomplete")
	}
	name := tokens[0].Text
	if !tokens[0].Quoted && (name == "PLS_INTEGER" || name == "BINARY_INTEGER") && len(tokens) == 1 {
		return name, nil
	}
	if !tokens[0].Quoted && name == "VARCHAR2" && len(tokens) >= 4 && tokens[1].word("(") && tokens[len(tokens)-1].word(")") {
		boundTokens := tokens[2 : len(tokens)-1]
		if len(boundTokens) > 0 && (boundTokens[len(boundTokens)-1].word("CHAR") || boundTokens[len(boundTokens)-1].word("BYTE")) {
			result.indexLengthUnit = boundTokens[len(boundTokens)-1].Text
			boundTokens = boundTokens[:len(boundTokens)-1]
		}
		bound, err := plDebugLegacyLiteralBound(boundTokens)
		if err != nil {
			return "", err
		}
		result.indexLength = bound
		return "VARCHAR2", nil
	}
	if len(tokens) != 1 || seen[name] || len(seen) >= 16 {
		return "", errors.New("legacy collection index subtype is unresolved")
	}
	declaration, ok := declarations[name]
	if !ok || !declaration[0].word("SUBTYPE") {
		return "", errors.New("legacy collection index subtype is not visible")
	}
	seen[name] = true
	return plDebugLegacyIndexType(declaration[3:], declarations, seen, result)
}

func plDebugLegacyCollectionFromSource(source plDebugNativeSource, name string) (plDebugLegacyCollectionDeclaration, error) {
	var result plDebugLegacyCollectionDeclaration
	declarations, err := plDebugLegacyPackageDeclarations(source)
	if err != nil {
		return result, err
	}
	declaration, ok := declarations[name]
	if !ok || !declaration[0].word("TYPE") {
		return result, errors.New("legacy collection type declaration is not visible")
	}
	definition := declaration[3:]
	if len(definition) < 3 {
		return result, errors.New("legacy collection declaration is incomplete")
	}
	position := 0
	if definition[0].word("TABLE") {
		result.kind = "TABLE"
		position = 1
	} else {
		if definition[0].word("VARRAY") {
			position = 1
		} else if len(definition) > 1 && definition[0].word("VARYING") && definition[1].word("ARRAY") {
			position = 2
		} else {
			return result, errors.New("legacy collection declaration kind is unresolved")
		}
		result.kind = "VARRAY"
		if position >= len(definition) || !definition[position].word("(") {
			return result, errors.New("legacy varray bound is missing")
		}
		end := position + 1
		for end < len(definition) && !definition[end].word(")") {
			end++
		}
		if end == len(definition) {
			return result, errors.New("legacy varray bound is unclosed")
		}
		result.upperBound, err = plDebugLegacyLiteralBound(definition[position+1 : end])
		if err != nil {
			return result, err
		}
		position = end + 1
	}
	if position >= len(definition) || !definition[position].word("OF") {
		return result, errors.New("legacy collection element declaration is missing")
	}
	position++
	end, depth := len(definition), 0
	for i := position; i < len(definition); i++ {
		if definition[i].word("(") {
			depth++
		}
		if definition[i].word(")") {
			depth--
		}
		if depth == 0 && definition[i].word("INDEX") && i+1 < len(definition) && definition[i+1].word("BY") {
			if result.kind != "TABLE" {
				return result, errors.New("legacy varray has an index declaration")
			}
			result.indexType, err = plDebugLegacyIndexType(definition[i+2:], declarations, map[string]bool{}, &result)
			if err != nil {
				return result, err
			}
			result.kind, end = "PL/SQL INDEX TABLE", i
			break
		}
	}
	result.element = definition[position:end]
	if len(result.element) >= 2 && result.element[len(result.element)-2].word("NOT") && result.element[len(result.element)-1].word("NULL") {
		result.elementNotNull = true
		result.element = result.element[:len(result.element)-2]
	}
	if len(result.element) == 0 || !result.element[0].Identifier || strings.TrimSpace(result.element[0].Text) == "" {
		return result, errors.New("legacy collection element identity is unresolved")
	}
	return result, nil
}
