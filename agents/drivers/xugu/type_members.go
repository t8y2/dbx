package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// DBeaver exposes object type members through ALL_TYPE_ATTRS,
// ALL_TYPE_METHODS, and ALL_METHOD_PARAMS. Prefer that catalogue-based model:
// it retains overload numbers, parameter modes, and type modifiers. A source
// fallback is used only on server versions that do not expose those views.
const xuguObjectTypeSQL = `
SELECT u.UDT_TYPE, COALESCE(TO_CHAR(u.SPEC), '')
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND u.TYPE_NAME = ?`

const xuguObjectTypeCaseFoldedSQL = `
SELECT u.UDT_TYPE, COALESCE(TO_CHAR(u.SPEC), '')
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(u.TYPE_NAME) = UPPER(?)
ORDER BY CASE WHEN s.SCHEMA_NAME = ? THEN 0 ELSE 1 END,
         CASE WHEN u.TYPE_NAME = ? THEN 0 ELSE 1 END`

const xuguTypeAttributesSQL = `
SELECT ATTR_NAME, ATTR_NO, ATTR_TYPE_OWNER, ATTR_TYPE_NAME, ATTR_TYPE_MOD
FROM ALL_TYPE_ATTRS
WHERE OWNER = ?
  AND TYPE_NAME = ?
ORDER BY ATTR_NO`

const xuguTypeAttributesCaseFoldedSQL = `
SELECT ATTR_NAME, ATTR_NO, ATTR_TYPE_OWNER, ATTR_TYPE_NAME, ATTR_TYPE_MOD
FROM ALL_TYPE_ATTRS
WHERE UPPER(OWNER) = UPPER(?)
  AND UPPER(TYPE_NAME) = UPPER(?)
ORDER BY CASE WHEN OWNER = ? THEN 0 ELSE 1 END,
         CASE WHEN TYPE_NAME = ? THEN 0 ELSE 1 END,
         ATTR_NO`

const xuguTypeMethodsSQL = `
SELECT M.METHOD_NAME, M.METHOD_NO, M.METHOD_TYPE,
       R.RESULT_TYPE_OWNER, R.RESULT_TYPE_NAME, R.RESULT_TYPE_MOD
FROM ALL_TYPE_METHODS M
LEFT OUTER JOIN ALL_METHOD_RESULTS R
  ON R.OWNER = M.OWNER
 AND R.TYPE_NAME = M.TYPE_NAME
 AND R.METHOD_NAME = M.METHOD_NAME
 AND R.METHOD_NO = M.METHOD_NO
WHERE M.OWNER = ?
  AND M.TYPE_NAME = ?
ORDER BY M.METHOD_NO`

const xuguTypeMethodsCaseFoldedSQL = `
SELECT M.METHOD_NAME, M.METHOD_NO, M.METHOD_TYPE,
       R.RESULT_TYPE_OWNER, R.RESULT_TYPE_NAME, R.RESULT_TYPE_MOD
FROM ALL_TYPE_METHODS M
LEFT OUTER JOIN ALL_METHOD_RESULTS R
  ON R.OWNER = M.OWNER
 AND R.TYPE_NAME = M.TYPE_NAME
 AND R.METHOD_NAME = M.METHOD_NAME
 AND R.METHOD_NO = M.METHOD_NO
WHERE UPPER(M.OWNER) = UPPER(?)
  AND UPPER(M.TYPE_NAME) = UPPER(?)
ORDER BY CASE WHEN M.OWNER = ? THEN 0 ELSE 1 END,
         CASE WHEN M.TYPE_NAME = ? THEN 0 ELSE 1 END,
         M.METHOD_NO`

const xuguTypeMethodParametersSQL = `
SELECT PARAM_NAME, PARAM_NO, PARAM_MODE, PARAM_TYPE_OWNER, PARAM_TYPE_NAME, PARAM_TYPE_MOD
FROM ALL_METHOD_PARAMS
WHERE OWNER = ?
  AND TYPE_NAME = ?
  AND METHOD_NAME = ?
  AND METHOD_NO = ?
ORDER BY PARAM_NO`

const xuguTypeMethodParametersCaseFoldedSQL = `
SELECT PARAM_NAME, PARAM_NO, PARAM_MODE, PARAM_TYPE_OWNER, PARAM_TYPE_NAME, PARAM_TYPE_MOD
FROM ALL_METHOD_PARAMS
WHERE UPPER(OWNER) = UPPER(?)
  AND UPPER(TYPE_NAME) = UPPER(?)
  AND UPPER(METHOD_NAME) = UPPER(?)
  AND METHOD_NO = ?
ORDER BY CASE WHEN OWNER = ? THEN 0 ELSE 1 END,
         CASE WHEN TYPE_NAME = ? THEN 0 ELSE 1 END,
         CASE WHEN METHOD_NAME = ? THEN 0 ELSE 1 END,
         PARAM_NO`

const xuguObjectTypeKind = 1001

type completionAssistantRequest struct {
	ConnectionID  string   `json:"connection_id"`
	Database      string   `json:"database"`
	Schema        string   `json:"schema"`
	ObjectKinds   []string `json:"object_kinds"`
	Mask          string   `json:"mask"`
	CaseSensitive bool     `json:"case_sensitive"`
	GlobalSearch  bool     `json:"global_search"`
	MaxResults    int      `json:"max_results"`
	ParentSchema  string   `json:"parent_schema"`
	ParentName    string   `json:"parent_name"`
	ParentType    string   `json:"parent_type"`
	MatchMode     string   `json:"match_mode"`
}

type completionAssistantCandidate struct {
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	Database     *string `json:"database"`
	Schema       *string `json:"schema"`
	ParentSchema *string `json:"parent_schema"`
	ParentName   *string `json:"parent_name"`
	Comment      *string `json:"comment"`
	DataType     *string `json:"data_type"`
	Signature    *string `json:"signature"`
}

type completionAssistantResponse struct {
	Candidates   []completionAssistantCandidate `json:"candidates"`
	Incomplete   bool                           `json:"incomplete"`
	FallbackUsed bool                           `json:"fallback_used"`
}

type xuguTypeAttribute struct {
	Name     string
	Number   int
	DataType string
}

type xuguTypeMethod struct {
	Name       string
	Number     int
	Kind       string
	Signature  string
	ReturnType string
}

type xuguTypeDefinition struct {
	Kind int
	Spec string
}

func (s *server) completionAssistantSearch(request completionAssistantRequest) (completionAssistantResponse, error) {
	switch strings.ToLower(strings.TrimSpace(request.ParentType)) {
	case "type":
		return s.completionAssistantSearchTypeMembers(request)
	case "package":
		return s.completionAssistantSearchPackageMembers(request)
	}
	// Package members shipped before type members. Keep that request shape
	// working for already-running desktop clients that do not send parent_type.
	return s.completionAssistantSearchPackageMembers(request)
}

func (s *server) completionAssistantSearchTypeMembers(request completionAssistantRequest) (completionAssistantResponse, error) {
	parentName := strings.TrimSpace(request.ParentName)
	if parentName == "" || !xuguCompletionRequestsTypeMembers(request.ObjectKinds) {
		return completionAssistantResponse{}, errors.New("completion assistant search is not supported for this request")
	}
	parentSchema := strings.TrimSpace(request.ParentSchema)
	if parentSchema == "" {
		parentSchema = strings.TrimSpace(request.Schema)
	}
	if parentSchema == "" {
		return completionAssistantResponse{}, errors.New("parent_schema is required for Xugu type members")
	}

	typeDefinition, err := s.xuguTypeDefinition(parentSchema, parentName)
	if err != nil {
		return completionAssistantResponse{}, err
	}
	if typeDefinition.Kind != xuguObjectTypeKind {
		return completionAssistantResponse{Candidates: []completionAssistantCandidate{}, FallbackUsed: false}, nil
	}

	limit := request.MaxResults
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}

	candidates := make([]completionAssistantCandidate, 0)
	if xuguCompletionRequestsTypeAttributes(request.ObjectKinds) {
		attributes, err := s.xuguTypeAttributes(parentSchema, parentName)
		if err != nil || len(attributes) == 0 {
			attributes = parseXuguObjectTypeAttributes(typeDefinition.Spec)
		}
		for _, attribute := range attributes {
			if !xuguCompletionNameMatches(attribute.Name, request) {
				continue
			}
			candidates = append(candidates, xuguTypeAttributeCandidate(request.Database, parentSchema, parentName, attribute))
		}
	}
	if xuguCompletionRequestsTypeMethods(request.ObjectKinds) {
		methods, err := s.xuguTypeMethods(parentSchema, parentName)
		if err != nil || len(methods) == 0 {
			methods = parseXuguObjectTypeMethods(typeDefinition.Spec)
		}
		for _, method := range methods {
			if !xuguCompletionMethodKindRequested(method.Kind, request.ObjectKinds) || !xuguCompletionNameMatches(method.Name, request) {
				continue
			}
			candidates = append(candidates, xuguTypeMethodCandidate(request.Database, parentSchema, parentName, method))
		}
	}

	incomplete := len(candidates) > limit
	if incomplete {
		candidates = candidates[:limit]
	}
	return completionAssistantResponse{Candidates: candidates, Incomplete: incomplete, FallbackUsed: false}, nil
}

func (s *server) xuguTypeDefinition(schema, typeName string) (xuguTypeDefinition, error) {
	query := func(sqlText string, args ...any) (xuguTypeDefinition, bool, error) {
		rows, err := s.queryRows(sqlText, args)
		if err != nil {
			return xuguTypeDefinition{}, false, err
		}
		defer s.closeRows(rows)
		if !rows.Next() {
			return xuguTypeDefinition{}, false, rows.Err()
		}
		var kind sql.NullInt64
		var spec sql.NullString
		if err := rows.Scan(&kind, &spec); err != nil {
			return xuguTypeDefinition{}, false, err
		}
		return xuguTypeDefinition{Kind: int(kind.Int64), Spec: spec.String}, true, nil
	}
	if definition, found, err := query(xuguObjectTypeSQL, schema, typeName); err != nil || found {
		return definition, err
	}
	definition, found, err := query(xuguObjectTypeCaseFoldedSQL, schema, typeName, schema, typeName)
	if err != nil {
		return xuguTypeDefinition{}, err
	}
	if found {
		return definition, nil
	}
	return xuguTypeDefinition{}, fmt.Errorf("type not found: %s.%s", schema, typeName)
}

// Some current XuguDB builds expose ALL_TYPES but do not publish the auxiliary
// ALL_TYPE_ATTRS / ALL_TYPE_METHODS views that older DBeaver integrations use.
// In that case the type specification is still authoritative and is the only
// low-privilege metadata source available. Parse only its top-level object
// declaration; this fallback never inspects or guesses from a TYPE BODY.
func parseXuguObjectTypeAttributes(spec string) []xuguTypeAttribute {
	attributes, _ := parseXuguObjectTypeMembers(spec)
	return attributes
}

func parseXuguObjectTypeMethods(spec string) []xuguTypeMethod {
	_, methods := parseXuguObjectTypeMembers(spec)
	return methods
}

func parseXuguObjectTypeMembers(spec string) ([]xuguTypeAttribute, []xuguTypeMethod) {
	body, ok := xuguObjectTypeMemberBody(spec)
	if !ok {
		return nil, nil
	}
	attributes := make([]xuguTypeAttribute, 0)
	methods := make([]xuguTypeMethod, 0)
	for index, declaration := range splitXuguTypeTopLevel(body, ',') {
		declaration = strings.TrimSpace(declaration)
		if declaration == "" {
			continue
		}
		if method, ok := parseXuguObjectTypeMethod(declaration, index+1); ok {
			methods = append(methods, method)
			continue
		}
		if attribute, ok := parseXuguObjectTypeAttribute(declaration, index+1); ok {
			attributes = append(attributes, attribute)
		}
	}
	return attributes, methods
}

func xuguObjectTypeMemberBody(spec string) (string, bool) {
	index := xuguIndexKeywordOutsideSQL(spec, "OBJECT")
	if index < 0 {
		return "", false
	}
	start := index + len("OBJECT")
	for start < len(spec) && isXuguTypeSpace(spec[start]) {
		start++
	}
	if start >= len(spec) || spec[start] != '(' {
		return "", false
	}
	end, ok := xuguTypeClosingParen(spec, start)
	if !ok {
		return "", false
	}
	return spec[start+1 : end], true
}

func parseXuguObjectTypeAttribute(declaration string, number int) (xuguTypeAttribute, bool) {
	name, next, ok := readXuguTypeIdentifier(declaration, 0)
	if !ok {
		return xuguTypeAttribute{}, false
	}
	dataType := strings.TrimSpace(declaration[next:])
	if dataType == "" {
		return xuguTypeAttribute{}, false
	}
	return xuguTypeAttribute{Name: name, Number: number, DataType: compactXuguTypeFragment(dataType)}, true
}

func parseXuguObjectTypeMethod(declaration string, number int) (xuguTypeMethod, bool) {
	keywordStart := 0
	for {
		word, next, ok := readXuguTypeIdentifier(declaration, keywordStart)
		if !ok {
			return xuguTypeMethod{}, false
		}
		upper := strings.ToUpper(word)
		if upper == "STATIC" || upper == "MEMBER" || upper == "FINAL" || upper == "INSTANTIABLE" || upper == "OVERRIDING" || upper == "NOT" {
			keywordStart = next
			continue
		}
		if upper == "CONSTRUCTOR" {
			procedure, afterProcedure, ok := readXuguTypeIdentifier(declaration, next)
			if !ok || !strings.EqualFold(procedure, "PROCEDURE") {
				return xuguTypeMethod{}, false
			}
			upper = "PROCEDURE"
			next = afterProcedure
		}
		if upper != "FUNCTION" && upper != "PROCEDURE" {
			return xuguTypeMethod{}, false
		}
		name, afterName, ok := readXuguTypeIdentifier(declaration, next)
		if !ok {
			return xuguTypeMethod{}, false
		}
		remainder := strings.TrimSpace(declaration[afterName:])
		signature := ""
		if strings.HasPrefix(remainder, "(") {
			end, ok := xuguTypeClosingParen(remainder, 0)
			if !ok {
				return xuguTypeMethod{}, false
			}
			signature = xuguTypeParameterSignature(remainder[1:end])
			remainder = strings.TrimSpace(remainder[end+1:])
		}
		returnType := ""
		if upper == "FUNCTION" {
			if returnIndex := xuguIndexKeywordOutsideSQL(remainder, "RETURN"); returnIndex >= 0 {
				returnType = xuguTypeReturnType(remainder[returnIndex+len("RETURN"):])
			}
		}
		return xuguTypeMethod{Name: name, Number: number, Kind: upper, Signature: signature, ReturnType: returnType}, true
	}
}

func xuguTypeReturnType(value string) string {
	end := len(value)
	for _, keyword := range []string{"PIPELINED", "DETERMINISTIC", "PARALLEL_ENABLE", "RESULT_CACHE", "AUTHID"} {
		if index := xuguIndexKeywordOutsideSQL(value, keyword); index >= 0 && index < end {
			end = index
		}
	}
	return compactXuguTypeFragment(value[:end])
}

func xuguTypeParameterSignature(value string) string {
	parameters := splitXuguTypeTopLevel(value, ',')
	result := make([]string, 0, len(parameters))
	for _, parameter := range parameters {
		parameter = strings.TrimSpace(parameter)
		if parameter == "" {
			continue
		}
		// DBeaver suppresses the implicit IN mode in routine signatures. Keep OUT
		// and IN OUT visible because they change call semantics.
		if _, afterName, ok := readXuguTypeIdentifier(parameter, 0); ok {
			remainder := strings.TrimSpace(parameter[afterName:])
			upper := strings.ToUpper(remainder)
			if strings.HasPrefix(upper, "IN ") && !strings.HasPrefix(upper, "IN OUT ") {
				parameter = strings.TrimSpace(parameter[:afterName] + " " + remainder[len("IN "):])
			}
		}
		result = append(result, compactXuguTypeFragment(parameter))
	}
	return strings.Join(result, ", ")
}

func compactXuguTypeFragment(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func readXuguTypeIdentifier(value string, start int) (string, int, bool) {
	start = skipXuguTypeSpaceAndComments(value, start)
	if start >= len(value) {
		return "", start, false
	}
	if value[start] == '"' {
		return readXuguQuotedIdentifier(value, start)
	}
	if !isXuguTypeIdentifierStart(value[start]) {
		return "", start, false
	}
	end := start + 1
	for end < len(value) && isXuguTypeIdentifierPart(value[end]) {
		end++
	}
	return value[start:end], end, true
}

func skipXuguTypeSpaceAndComments(value string, start int) int {
	for start < len(value) {
		if isXuguTypeSpace(value[start]) {
			start++
			continue
		}
		next, skipped := skipXuguTypeQuotedOrComment(value, start)
		if !skipped || value[start] == '\'' || value[start] == '"' {
			return start
		}
		start = next
	}
	return start
}

func isXuguTypeIdentifierStart(value byte) bool {
	return value == '_' || value == '$' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func isXuguTypeIdentifierPart(value byte) bool {
	return isXuguTypeIdentifierStart(value) || value >= '0' && value <= '9' || value == '#'
}

func isXuguTypeSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\n' || value == '\r'
}

func xuguTypeClosingParen(value string, start int) (int, bool) {
	depth := 0
	for index := start; index < len(value); index++ {
		next, skipped := skipXuguTypeQuotedOrComment(value, index)
		if skipped {
			index = next - 1
			continue
		}
		switch value[index] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return index, true
			}
		}
	}
	return 0, false
}

func splitXuguTypeTopLevel(value string, separator byte) []string {
	result := make([]string, 0)
	start, depth := 0, 0
	for index := 0; index < len(value); index++ {
		next, skipped := skipXuguTypeQuotedOrComment(value, index)
		if skipped {
			index = next - 1
			continue
		}
		switch value[index] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if value[index] == separator && depth == 0 {
				result = append(result, value[start:index])
				start = index + 1
			}
		}
	}
	return append(result, value[start:])
}

func xuguIndexKeywordOutsideSQL(value, keyword string) int {
	upperKeyword := strings.ToUpper(keyword)
	for index := 0; index < len(value); {
		next, skipped := skipXuguTypeQuotedOrComment(value, index)
		if skipped {
			index = next
			continue
		}
		if isXuguTypeSpace(value[index]) {
			index++
			continue
		}
		word, next, ok := readXuguTypeIdentifier(value, index)
		if !ok {
			index++
			continue
		}
		if strings.ToUpper(word) == upperKeyword {
			return index
		}
		index = next
	}
	return -1
}

func skipXuguTypeQuotedOrComment(value string, start int) (int, bool) {
	if start >= len(value) {
		return start, false
	}
	switch value[start] {
	case '\'', '"':
		quote := value[start]
		for index := start + 1; index < len(value); index++ {
			if value[index] != quote {
				continue
			}
			if index+1 < len(value) && value[index+1] == quote {
				index++
				continue
			}
			return index + 1, true
		}
		return len(value), true
	case '-':
		if start+1 < len(value) && value[start+1] == '-' {
			index := strings.IndexByte(value[start+2:], '\n')
			if index < 0 {
				return len(value), true
			}
			return start + index + 3, true
		}
	case '/':
		if start+1 < len(value) && value[start+1] == '*' {
			index := strings.Index(value[start+2:], "*/")
			if index < 0 {
				return len(value), true
			}
			return start + index + 4, true
		}
	}
	return start, false
}

func (s *server) xuguTypeAttributes(schema, typeName string) ([]xuguTypeAttribute, error) {
	load := func(sqlText string, args ...any) ([]xuguTypeAttribute, error) {
		rows, err := s.queryRows(sqlText, args)
		if err != nil {
			return nil, err
		}
		defer s.closeRows(rows)
		attributes := make([]xuguTypeAttribute, 0)
		for rows.Next() {
			var name, owner, dataType, modifier sql.NullString
			var number sql.NullInt64
			if err := rows.Scan(&name, &number, &owner, &dataType, &modifier); err != nil {
				return nil, err
			}
			attributes = append(attributes, xuguTypeAttribute{Name: name.String, Number: int(number.Int64), DataType: xuguQualifiedTypeName(owner.String, dataType.String, modifier.String)})
		}
		return attributes, rows.Err()
	}
	attributes, err := load(xuguTypeAttributesSQL, schema, typeName)
	if err != nil || len(attributes) > 0 {
		return attributes, err
	}
	return load(xuguTypeAttributesCaseFoldedSQL, schema, typeName, schema, typeName)
}

func (s *server) xuguTypeMethods(schema, typeName string) ([]xuguTypeMethod, error) {
	load := func(sqlText string, args ...any) ([]xuguTypeMethod, error) {
		rows, err := s.queryRows(sqlText, args)
		if err != nil {
			return nil, err
		}
		defer s.closeRows(rows)
		methods := make([]xuguTypeMethod, 0)
		for rows.Next() {
			var name, methodType, resultOwner, resultType, resultModifier sql.NullString
			var number sql.NullInt64
			if err := rows.Scan(&name, &number, &methodType, &resultOwner, &resultType, &resultModifier); err != nil {
				return nil, err
			}
			kind := strings.ToUpper(strings.TrimSpace(methodType.String))
			if kind != "FUNCTION" && kind != "PROCEDURE" {
				continue
			}
			parameters, err := s.xuguTypeMethodParameters(schema, typeName, name.String, int(number.Int64))
			if err != nil {
				return nil, err
			}
			methods = append(methods, xuguTypeMethod{
				Name:       name.String,
				Number:     int(number.Int64),
				Kind:       kind,
				Signature:  strings.Join(parameters, ", "),
				ReturnType: xuguQualifiedTypeName(resultOwner.String, resultType.String, resultModifier.String),
			})
		}
		return methods, rows.Err()
	}
	methods, err := load(xuguTypeMethodsSQL, schema, typeName)
	if err != nil || len(methods) > 0 {
		return methods, err
	}
	return load(xuguTypeMethodsCaseFoldedSQL, schema, typeName, schema, typeName)
}

func (s *server) xuguTypeMethodParameters(schema, typeName, methodName string, methodNumber int) ([]string, error) {
	load := func(sqlText string, args ...any) ([]string, error) {
		rows, err := s.queryRows(sqlText, args)
		if err != nil {
			return nil, err
		}
		defer s.closeRows(rows)
		parameters := make([]string, 0)
		for rows.Next() {
			var name, mode, owner, dataType, modifier sql.NullString
			var number sql.NullInt64
			if err := rows.Scan(&name, &number, &mode, &owner, &dataType, &modifier); err != nil {
				return nil, err
			}
			parts := make([]string, 0, 3)
			if value := strings.TrimSpace(mode.String); value != "" && !strings.EqualFold(value, "IN") {
				parts = append(parts, strings.ToUpper(value))
			}
			if value := strings.TrimSpace(name.String); value != "" {
				parts = append(parts, value)
			}
			if value := xuguQualifiedTypeName(owner.String, dataType.String, modifier.String); value != "" {
				parts = append(parts, value)
			}
			parameters = append(parameters, strings.Join(parts, " "))
		}
		return parameters, rows.Err()
	}
	parameters, err := load(xuguTypeMethodParametersSQL, schema, typeName, methodName, methodNumber)
	if err != nil || len(parameters) > 0 {
		return parameters, err
	}
	return load(xuguTypeMethodParametersCaseFoldedSQL, schema, typeName, methodName, methodNumber, schema, typeName, methodName)
}

func xuguCompletionRequestsTypeMembers(kinds []string) bool {
	return xuguCompletionRequestsTypeAttributes(kinds) || xuguCompletionRequestsTypeMethods(kinds)
}

func xuguCompletionRequestsTypeAttributes(kinds []string) bool {
	for _, kind := range kinds {
		if strings.EqualFold(strings.TrimSpace(kind), "column") {
			return true
		}
	}
	return false
}

func xuguCompletionRequestsTypeMethods(kinds []string) bool {
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "routine", "procedure", "function":
			return true
		}
	}
	return false
}

func xuguCompletionMethodKindRequested(methodKind string, kinds []string) bool {
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "routine":
			return true
		case "procedure":
			if methodKind == "PROCEDURE" {
				return true
			}
		case "function":
			if methodKind == "FUNCTION" {
				return true
			}
		}
	}
	return false
}

func xuguQualifiedTypeName(owner, name, modifier string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	owner = strings.TrimSpace(owner)
	modifier = strings.TrimSpace(modifier)
	if owner != "" {
		name = owner + "." + name
	}
	if modifier != "" {
		if strings.HasPrefix(modifier, "(") {
			name += modifier
		} else {
			name += " " + modifier
		}
	}
	return name
}

func xuguTypeAttributeCandidate(database, schema, typeName string, attribute xuguTypeAttribute) completionAssistantCandidate {
	return completionAssistantCandidate{
		Name:         attribute.Name,
		Kind:         "column",
		Database:     xuguStringPointerOrNil(database),
		Schema:       xuguStringPointerOrNil(schema),
		ParentSchema: xuguStringPointerOrNil(schema),
		ParentName:   xuguStringPointerOrNil(typeName),
		DataType:     xuguStringPointerOrNil(attribute.DataType),
	}
}

func xuguTypeMethodCandidate(database, schema, typeName string, method xuguTypeMethod) completionAssistantCandidate {
	return completionAssistantCandidate{
		Name:         method.Name,
		Kind:         strings.ToLower(method.Kind),
		Database:     xuguStringPointerOrNil(database),
		Schema:       xuguStringPointerOrNil(schema),
		ParentSchema: xuguStringPointerOrNil(schema),
		ParentName:   xuguStringPointerOrNil(typeName),
		DataType:     xuguStringPointerOrNil(method.ReturnType),
		Signature:    xuguStringPointerOrNil(method.Signature),
	}
}

func xuguStringPointerOrNil(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
