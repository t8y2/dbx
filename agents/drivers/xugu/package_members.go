package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const xuguPackageSpecSQL = `
SELECT COALESCE(TO_CHAR(p.SPEC), '')
FROM ALL_PACKAGES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND p.PACK_NAME = ?`

const xuguPackageSpecCaseFoldedSQL = `
SELECT COALESCE(TO_CHAR(p.SPEC), '')
FROM ALL_PACKAGES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(p.PACK_NAME) = UPPER(?)
ORDER BY CASE WHEN s.SCHEMA_NAME = ? THEN 0 ELSE 1 END,
         CASE WHEN p.PACK_NAME = ? THEN 0 ELSE 1 END`

type xuguPackageMember struct {
	Name       string
	Kind       string
	Signature  string
	ReturnType string
}

func (s *server) completionAssistantSearchPackageMembers(request completionAssistantRequest) (completionAssistantResponse, error) {
	parentName := strings.TrimSpace(request.ParentName)
	if parentName == "" || !xuguCompletionRequestsRoutines(request.ObjectKinds) {
		return completionAssistantResponse{}, errors.New("completion assistant search is not supported for this request")
	}
	parentSchema := strings.TrimSpace(request.ParentSchema)
	if parentSchema == "" {
		parentSchema = strings.TrimSpace(request.Schema)
	}
	if parentSchema == "" {
		return completionAssistantResponse{}, errors.New("parent_schema is required for Xugu package members")
	}

	spec, err := s.xuguPackageSpec(parentSchema, parentName)
	if err != nil {
		return completionAssistantResponse{}, err
	}
	members := parseXuguPackageMembers(spec)
	allowedKinds := xuguCompletionRoutineKinds(request.ObjectKinds)
	filtered := make([]xuguPackageMember, 0, len(members))
	for _, member := range members {
		if !allowedKinds[member.Kind] || !xuguCompletionNameMatches(member.Name, request) {
			continue
		}
		filtered = append(filtered, member)
	}

	limit := request.MaxResults
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	incomplete := len(filtered) > limit
	if incomplete {
		filtered = filtered[:limit]
	}

	database := strings.TrimSpace(request.Database)
	candidates := make([]completionAssistantCandidate, 0, len(filtered))
	for _, member := range filtered {
		candidate := completionAssistantCandidate{
			Name:         member.Name,
			Kind:         strings.ToLower(member.Kind),
			Database:     stringPointerOrNil(database),
			Schema:       stringPointerOrNil(parentSchema),
			ParentSchema: stringPointerOrNil(parentSchema),
			ParentName:   stringPointerOrNil(parentName),
			Signature:    stringPointerOrNil(member.Signature),
		}
		if member.ReturnType != "" {
			candidate.DataType = stringPointerOrNil(member.ReturnType)
		}
		candidates = append(candidates, candidate)
	}
	return completionAssistantResponse{Candidates: candidates, Incomplete: incomplete, FallbackUsed: false}, nil
}

func (s *server) xuguPackageSpec(schema, packageName string) (string, error) {
	query := func(sqlText string, args ...any) (string, bool, error) {
		rows, err := s.queryRows(sqlText, args)
		if err != nil {
			return "", false, err
		}
		defer s.closeRows(rows)
		if !rows.Next() {
			return "", false, rows.Err()
		}
		var spec sql.NullString
		if err := rows.Scan(&spec); err != nil {
			return "", false, err
		}
		return spec.String, true, nil
	}

	if spec, found, err := query(xuguPackageSpecSQL, schema, packageName); err != nil || found {
		return spec, err
	}
	if spec, found, err := query(xuguPackageSpecCaseFoldedSQL, schema, packageName, schema, packageName); err != nil {
		return "", err
	} else if found {
		return spec, nil
	}
	return "", fmt.Errorf("package not found: %s.%s", schema, packageName)
}

func xuguCompletionRequestsRoutines(kinds []string) bool {
	if len(kinds) == 0 {
		return false
	}
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "routine", "procedure", "function":
			return true
		}
	}
	return false
}

func xuguCompletionRoutineKinds(kinds []string) map[string]bool {
	allowed := map[string]bool{}
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "routine":
			allowed["PROCEDURE"] = true
			allowed["FUNCTION"] = true
		case "procedure":
			allowed["PROCEDURE"] = true
		case "function":
			allowed["FUNCTION"] = true
		}
	}
	return allowed
}

func xuguCompletionNameMatches(name string, request completionAssistantRequest) bool {
	mask := strings.TrimSpace(request.Mask)
	if mask == "" {
		return true
	}
	value := name
	if !request.CaseSensitive {
		value = strings.ToUpper(value)
		mask = strings.ToUpper(mask)
	}
	if strings.EqualFold(strings.TrimSpace(request.MatchMode), "contains") {
		return strings.Contains(value, mask)
	}
	return strings.HasPrefix(value, mask)
}

func stringPointerOrNil(value string) *string {
	if value == "" {
		return nil
	}
	result := value
	return &result
}

func parseXuguPackageMembers(spec string) []xuguPackageMember {
	members := make([]xuguPackageMember, 0)
	for index, parenDepth := 0, 0; index < len(spec); {
		if next, ok := skipXuguSQLLiteralOrComment(spec, index); ok {
			index = next
			continue
		}
		current, width := utf8.DecodeRuneInString(spec[index:])
		switch current {
		case '(':
			parenDepth++
			index += width
			continue
		case ')':
			if parenDepth > 0 {
				parenDepth--
			}
			index += width
			continue
		}
		if parenDepth != 0 || !isXuguIdentifierStart(current) {
			index += width
			continue
		}
		wordStart := index
		index = scanXuguIdentifier(spec, index)
		keyword := strings.ToUpper(spec[wordStart:index])
		if keyword != "PROCEDURE" && keyword != "FUNCTION" {
			continue
		}
		member, next, ok := parseXuguPackageMemberDeclaration(spec, index, keyword)
		if !ok {
			continue
		}
		members = append(members, member)
		index = next
	}
	return members
}

func parseXuguPackageMemberDeclaration(spec string, index int, kind string) (xuguPackageMember, int, bool) {
	index = skipXuguSQLSpaceAndComments(spec, index)
	name, next, ok := readXuguSQLIdentifier(spec, index)
	if !ok {
		return xuguPackageMember{}, index, false
	}
	index = skipXuguSQLSpaceAndComments(spec, next)
	signature := ""
	if index < len(spec) && spec[index] == '(' {
		end, ok := findXuguClosingParen(spec, index)
		if !ok {
			return xuguPackageMember{}, index, false
		}
		signature = compactXuguSQLFragment(spec[index+1 : end])
		index = end + 1
	}
	declarationEnd := findXuguDeclarationEnd(spec, index)
	if declarationEnd < 0 {
		return xuguPackageMember{}, index, false
	}
	returnType := ""
	if kind == "FUNCTION" {
		returnType = xuguFunctionReturnType(spec[index:declarationEnd])
	}
	return xuguPackageMember{Name: name, Kind: kind, Signature: signature, ReturnType: returnType}, declarationEnd + 1, true
}

func xuguFunctionReturnType(fragment string) string {
	for index := 0; index < len(fragment); {
		if next, ok := skipXuguSQLLiteralOrComment(fragment, index); ok {
			index = next
			continue
		}
		current, width := utf8.DecodeRuneInString(fragment[index:])
		if !isXuguIdentifierStart(current) {
			index += width
			continue
		}
		start := index
		index = scanXuguIdentifier(fragment, index)
		if !strings.EqualFold(fragment[start:index], "RETURN") {
			continue
		}
		return compactXuguSQLFragment(fragment[skipXuguSQLSpaceAndComments(fragment, index):])
	}
	return ""
}

func findXuguDeclarationEnd(value string, start int) int {
	depth := 0
	for index := start; index < len(value); {
		if next, ok := skipXuguSQLLiteralOrComment(value, index); ok {
			index = next
			continue
		}
		current, width := utf8.DecodeRuneInString(value[index:])
		switch current {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ';':
			if depth == 0 {
				return index
			}
		}
		index += width
	}
	return -1
}

func findXuguClosingParen(value string, open int) (int, bool) {
	depth := 0
	for index := open; index < len(value); {
		if next, ok := skipXuguSQLLiteralOrComment(value, index); ok {
			index = next
			continue
		}
		current, width := utf8.DecodeRuneInString(value[index:])
		switch current {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return index, true
			}
		}
		index += width
	}
	return 0, false
}

func readXuguSQLIdentifier(value string, index int) (string, int, bool) {
	if index >= len(value) {
		return "", index, false
	}
	if value[index] == '"' {
		var builder strings.Builder
		for cursor := index + 1; cursor < len(value); {
			current, width := utf8.DecodeRuneInString(value[cursor:])
			if current != '"' {
				builder.WriteRune(current)
				cursor += width
				continue
			}
			if cursor+1 < len(value) && value[cursor+1] == '"' {
				builder.WriteByte('"')
				cursor += 2
				continue
			}
			return builder.String(), cursor + 1, true
		}
		return "", index, false
	}
	current, _ := utf8.DecodeRuneInString(value[index:])
	if !isXuguIdentifierStart(current) {
		return "", index, false
	}
	next := scanXuguIdentifier(value, index)
	return value[index:next], next, true
}

func scanXuguIdentifier(value string, index int) int {
	for index < len(value) {
		current, width := utf8.DecodeRuneInString(value[index:])
		if !isXuguIdentifierPart(current) {
			break
		}
		index += width
	}
	return index
}

func isXuguIdentifierStart(value rune) bool {
	return value == '_' || unicode.IsLetter(value)
}

func isXuguIdentifierPart(value rune) bool {
	return isXuguIdentifierStart(value) || unicode.IsDigit(value) || value == '$' || value == '#'
}

func skipXuguSQLSpaceAndComments(value string, index int) int {
	for index < len(value) {
		current, width := utf8.DecodeRuneInString(value[index:])
		if unicode.IsSpace(current) {
			index += width
			continue
		}
		if next, ok := skipXuguSQLComment(value, index); ok {
			index = next
			continue
		}
		break
	}
	return index
}

func skipXuguSQLLiteralOrComment(value string, index int) (int, bool) {
	if next, ok := skipXuguSQLComment(value, index); ok {
		return next, true
	}
	if index >= len(value) || (value[index] != '\'' && value[index] != '"') {
		return index, false
	}
	quote := value[index]
	for cursor := index + 1; cursor < len(value); {
		current, width := utf8.DecodeRuneInString(value[cursor:])
		if current != rune(quote) {
			cursor += width
			continue
		}
		if cursor+1 < len(value) && value[cursor+1] == quote {
			cursor += 2
			continue
		}
		return cursor + 1, true
	}
	return len(value), true
}

func skipXuguSQLComment(value string, index int) (int, bool) {
	if index+1 >= len(value) {
		return index, false
	}
	if value[index:index+2] == "--" {
		if end := strings.IndexByte(value[index+2:], '\n'); end >= 0 {
			return index + 2 + end + 1, true
		}
		return len(value), true
	}
	if value[index:index+2] == "/*" {
		if end := strings.Index(value[index+2:], "*/"); end >= 0 {
			return index + 2 + end + 2, true
		}
		return len(value), true
	}
	return index, false
}

func compactXuguSQLFragment(value string) string {
	var builder strings.Builder
	spacePending := false
	for index := 0; index < len(value); {
		if next, ok := skipXuguSQLComment(value, index); ok {
			spacePending = builder.Len() > 0
			index = next
			continue
		}
		current, width := utf8.DecodeRuneInString(value[index:])
		if unicode.IsSpace(current) {
			spacePending = builder.Len() > 0
			index += width
			continue
		}
		if spacePending && builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		spacePending = false
		if next, ok := skipXuguSQLLiteralOrComment(value, index); ok {
			builder.WriteString(value[index:next])
			index = next
			continue
		}
		builder.WriteRune(current)
		index += width
	}
	return strings.TrimSpace(builder.String())
}
