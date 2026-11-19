package main

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
)

func (e *plDebugNativeEntry) nativeVariableNames(ctx context.Context, frame, nativeFrame int, revision int64, types map[string]string) ([]string, string) {
	e.mu.Lock()
	needsStack := e.nativeStack == nil || e.nativeStack.StopRevision != revision
	p := e.session
	e.mu.Unlock()
	if needsStack {
		p.mu.Lock()
		stop := *p.nativeStop
		p.mu.Unlock()
		stack := e.readNativeMappedStack(ctx, stop, revision)
		e.server.plAllocation.mu.Lock()
		unknown := e.server.plAllocation.unknown || e.server.plAllocation.active != nil
		e.server.plAllocation.mu.Unlock()
		e.mu.Lock()
		e.publishNativeStackLocked(stack, unknown)
		e.mu.Unlock()
	}
	e.mu.Lock()
	text, line := "", 0
	signatureText := ""
	packageBody := false
	var native *plDebugNativeStackFrame
	if e.nativeStack != nil && e.nativeStack.StopRevision == revision {
		for _, item := range e.nativeStack.Frames {
			if item.FrameIndex != frame || item.NativeFrameID != int64(nativeFrame) {
				continue
			}
			copy := item
			native = &copy
			packageBody = item.Namespace != nil && *item.Namespace == plDebugNativeNamespacePackageBody
			if packageBody && item.Owner != nil && item.Program != nil && e.targetSignatureSource != nil && e.targetSignatureSource.State == "candidate" && e.targetSignatureSource.Owner == *item.Owner && e.targetSignatureSource.Name == *item.Program {
				for _, row := range e.targetSignatureSource.Lines {
					signatureText += row.Text
				}
			}
			if item.SourceRef != nil && item.SourceRef.StopRevision == revision && item.SourceRef.NativeFrameID == int64(nativeFrame) {
				text = item.SourceRef.Source
				if item.SourceLine != nil {
					line = int(*item.SourceLine)
				}
				break
			}
		}
	}
	// The only frame in a frozen anonymous launch is the launch block itself.
	if text == "" && nativeFrame == 1 && frame == 0 && e.request.ObjectType == "ANONYMOUS" {
		text = e.request.Source
	}
	named := e.namedPlan != nil
	e.mu.Unlock()
	externalPackage := packageBody && signatureText == "" && native != nil && native.IdentityState == "native"
	if text == "" && !externalPackage && native != nil && native.IdentityState == "native" && native.Owner != nil && native.Program != nil && native.Namespace != nil && native.DBLink == nil && native.Line != nil {
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return []string{}, err.Error()
		}
		source, err := plDebugLoadNativeFrameSource(ctx, e.server.plConnection, *native.Owner, *native.Program, *native.Namespace)
		if err != nil {
			return []string{}, err.Error()
		}
		var content strings.Builder
		for _, row := range source.Lines {
			content.WriteString(row.Text)
		}
		text, line = content.String(), int(*native.Line)
	}
	if text == "" && !externalPackage {
		return []string{}, "Variable discovery requires source confirmed for this native frame; explicit watches remain available"
	}
	if named {
		if err := e.nativeEntryCallAllowed(ctx); err != nil {
			return []string{}, err.Error()
		}
		if _, err := e.checkNativeTargetVersion(ctx, "variable discovery"); err != nil {
			return []string{}, err.Error()
		}
	}
	if externalPackage {
		return e.nativeExternalPackageVariableNames(ctx, *native, revision, types)
	}
	if packageBody {
		return plDebugNativePackageDeclarations(text, line, signatureText, types)
	}
	return plDebugNativeDeclarations(text, line, types)
}

func (e *plDebugNativeEntry) loadNativeVariableContainer(ctx context.Context, owner, name, kind string, budget *plDebugNativeSourceBudget) (plDebugNativeSource, error) {
	if err := e.nativeEntryCallAllowed(ctx); err != nil {
		return plDebugNativeSource{}, err
	}
	var targets []plDebugNativeCandidate
	err := plDebugNativeRows(ctx, e.server.plConnection, `SELECT TO_CHAR(o.OBJECT_ID, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), o.STATUS
FROM SYS.ALL_OBJECTS o WHERE o.OWNER = :1 AND o.OBJECT_NAME = :2 AND o.OBJECT_TYPE = :3`, []interface{}{owner, name, kind}, func(rows *sql.Rows) error {
		var id, status sql.NullString
		if err := rows.Scan(&id, &status); err != nil {
			return err
		}
		if !id.Valid || id.String == "" || !status.Valid || status.String != "VALID" {
			return errors.New("Variable source has no exact VALID object identity")
		}
		targets = append(targets, plDebugNativeCandidate{Schema: owner, ObjectName: name, ObjectType: kind, ObjectID: id.String})
		return nil
	})
	if err != nil {
		return plDebugNativeSource{}, err
	}
	if len(targets) != 1 {
		return plDebugNativeSource{}, errors.New("Variable source container is not uniquely visible")
	}
	if err = e.nativeEntryCallAllowed(ctx); err != nil {
		return plDebugNativeSource{}, err
	}
	source, err := plDebugLoadNativeSourceBounded(ctx, e.server.plConnection, targets[0], budget)
	if err != nil {
		return source, err
	}
	if source.State != "candidate" || source.Status == nil || *source.Status != "VALID" {
		return source, errors.New("Variable source is incomplete or not VALID")
	}
	return source, nil
}

func (e *plDebugNativeEntry) nativeExternalPackageVariableNames(ctx context.Context, frame plDebugNativeStackFrame, revision int64, types map[string]string) ([]string, string) {
	if frame.IdentityState != "native" || frame.Owner == nil || frame.Program == nil || frame.Namespace == nil || *frame.Namespace != plDebugNativeNamespacePackageBody || frame.DBLink != nil || frame.Line == nil {
		return []string{}, "External package variables require an exact local native frame"
	}
	ref := frame.SourceRef
	if ref != nil && (ref.StopRevision != revision || ref.NativeFrameID != frame.NativeFrameID || ref.IdentityState != "native" || ref.LineBasis != "all_source" || ref.LineOffset != 0 || ref.ObjectType != "PACKAGE BODY" || ref.Owner == nil || *ref.Owner != *frame.Owner || ref.Name == nil || *ref.Name != *frame.Program || ref.Namespace == nil || *ref.Namespace != *frame.Namespace || ref.ObjectID == nil || *ref.ObjectID == "") {
		return []string{}, "External package source does not match the original native frame"
	}
	budget := &plDebugNativeSourceBudget{bytes: 1048576, lines: 8192}
	body, err := e.loadNativeVariableContainer(ctx, *frame.Owner, *frame.Program, "PACKAGE BODY", budget)
	if err != nil {
		return []string{}, err.Error()
	}
	content := func(source plDebugNativeSource) string {
		var text strings.Builder
		for _, row := range source.Lines {
			text.WriteString(row.Text)
		}
		return text.String()
	}
	text := content(body)
	if ref != nil && (body.ObjectID != *ref.ObjectID || text != ref.Source) {
		return []string{}, "External package body changed from the original frame source"
	}
	localTypes := map[string]string{}
	names, localError := plDebugNativeDeclarations(text, int(*frame.Line), localTypes)
	bodyBytes := 0
	for _, row := range body.Lines {
		bodyBytes += len(row.Text)
	}
	specBudget := plDebugNativeSourceBudget{bytes: budget.bytes - bodyBytes, lines: budget.lines - len(body.Lines)}
	if specBudget.bytes < 0 || specBudget.lines < 0 {
		return []string{}, "Variable source budget cannot confirm the original package body"
	}
	spec, specError := e.loadNativeVariableContainer(ctx, *frame.Owner, *frame.Program, "PACKAGE", &specBudget)
	budget.bytes, budget.lines = specBudget.bytes+bodyBytes, specBudget.lines+len(body.Lines)
	bodyAfter, bodyError := e.loadNativeVariableContainer(ctx, *frame.Owner, *frame.Program, "PACKAGE BODY", budget)
	if bodyError != nil {
		return []string{}, bodyError.Error()
	}
	if !plDebugNativeSourceUnchanged(body, bodyAfter) {
		return []string{}, "External package body changed during variable discovery"
	}
	copyLocal := func() {
		for name, kind := range localTypes {
			if types != nil {
				types[name] = kind
			}
		}
	}
	if specError != nil {
		copyLocal()
		return names, specError.Error()
	}
	specAfter, err := e.loadNativeVariableContainer(ctx, *frame.Owner, *frame.Program, "PACKAGE", budget)
	if err != nil {
		copyLocal()
		return names, err.Error()
	}
	if !plDebugNativeSourceUnchanged(spec, specAfter) {
		copyLocal()
		return names, "External package specification changed during variable discovery"
	}
	if localError != "" {
		copyLocal()
		return names, localError
	}
	return plDebugNativePackageDeclarations(text, int(*frame.Line), content(spec), types)
}

func plDebugNativePackageDeclarations(text string, line int, signature string, types map[string]string) ([]string, string) {
	names, message := plDebugNativeDeclarations(text, line, types)
	if message != "" {
		return names, message
	}
	if signature == "" {
		return names, "Package specification is not confirmed for this native frame"
	}
	publicTypes := map[string]string{}
	publicNames, message := plDebugNativeDeclarations(signature, 0, publicTypes)
	seen := map[string]bool{}
	for _, name := range names {
		seen[name] = true
	}
	for _, name := range publicNames {
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
			if types != nil {
				types[name] = publicTypes[name]
			}
		}
	}
	return names, message
}

func plDebugLoadNativeFrameSource(ctx context.Context, conn *sql.Conn, owner, name string, namespace int64) (plDebugNativeSource, error) {
	condition := ""
	switch namespace {
	case plDebugNativeNamespaceTopLevel:
		condition = "o.OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION', 'PACKAGE')"
	case plDebugNativeNamespacePackageBody:
		condition = "o.OBJECT_TYPE = 'PACKAGE BODY'"
	default:
		return plDebugNativeSource{}, errors.New("Native frame namespace does not identify a source container")
	}
	targets := []plDebugNativeCandidate{}
	err := plDebugNativeRows(ctx, conn, `SELECT TO_CHAR(o.OBJECT_ID, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,'''), o.OBJECT_TYPE
FROM SYS.ALL_OBJECTS o WHERE o.OWNER = :1 AND o.OBJECT_NAME = :2 AND `+condition, []interface{}{owner, name}, func(rows *sql.Rows) error {
		var id, kind sql.NullString
		if err := rows.Scan(&id, &kind); err != nil {
			return err
		}
		if !id.Valid || id.String == "" || !kind.Valid {
			return errors.New("Frame source metadata has no exact object identity")
		}
		targets = append(targets, plDebugNativeCandidate{Schema: owner, ObjectName: name, ObjectType: kind.String, ObjectID: id.String})
		return nil
	})
	if err != nil {
		return plDebugNativeSource{}, err
	}
	if len(targets) != 1 {
		return plDebugNativeSource{}, errors.New("Frame source container is not uniquely visible")
	}
	return plDebugLoadNativeSource(ctx, conn, targets[0])
}

func plDebugNativeDeclarationNames(text string, line int) ([]string, string) {
	return plDebugNativeDeclarations(text, line, nil)
}

func plDebugNativeDeclarations(text string, line int, types map[string]string) ([]string, string) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	anonymous := false
	// Reuse the routine scanner for an anonymous declaration region without
	// changing its physical line numbers or executing the synthetic declaration.
	probe := plDebugNativeSource{Lines: []plDebugNativeSourceLine{}}
	for index, value := range strings.Split(text, "\n") {
		probe.Lines = append(probe.Lines, plDebugNativeSourceLine{Number: int64(index + 1), Text: strings.TrimSuffix(value, "\r")})
	}
	initial, tokenErr := plDebugNativeSourceTokens(probe)
	if tokenErr != nil {
		return []string{}, tokenErr.Error()
	}
	if len(initial) > 0 && initial[0].word("BEGIN") {
		text = "PROCEDURE DBX_ANONYMOUS IS " + text
		anonymous = true
	}
	if len(initial) > 0 && initial[0].word("DECLARE") {
		first := initial[0]
		text = text[:first.Start] + "PROCEDURE DBX_ANONYMOUS IS" + text[first.End:]
		anonymous = true
	}
	source := plDebugNativeSource{}
	if len(initial) > 1 && initial[0].word("PACKAGE") {
		position := 1
		if initial[position].word("BODY") {
			position++
		}
		if position < len(initial) {
			source.Name = initial[position].Text
			if position+2 < len(initial) && initial[position+1].word(".") {
				source.Owner, source.Name = source.Name, initial[position+2].Text
			}
		}
	}
	for index, value := range strings.Split(text, "\n") {
		source.Lines = append(source.Lines, plDebugNativeSourceLine{Number: int64(index + 1), Text: strings.TrimSuffix(value, "\r")})
	}
	scan := plDebugScanNativeRoutinesMode(source, true)
	if scan.Error != "" {
		return []string{}, scan.Error
	}
	tokens := scan.Tokens
	selected := -1
	if line > 0 {
		var certain bool
		selected, certain = scan.ownerAtLine(line)
		if !certain {
			return []string{}, "Native line has ambiguous lexical routine ownership"
		}
	}
	if selected < 0 && anonymous && len(scan.Ranges) > 0 {
		selected = 0
	}
	if line <= 0 {
		for _, scope := range scan.DeclarationScopes {
			if scope.Parent == selected && scope.Start > 0 && tokens[scope.Start-1].word("DECLARE") {
				return []string{}, "Native line is required to resolve nested-block variable shadowing"
			}
		}
	}
	names, seen := []string{}, map[string]bool{}
	add := func(token plDebugNativeSourceToken, declaredType string) {
		name := token.Text
		if token.Quoted {
			name = `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
			if types != nil && declaredType != "" {
				types[name] = declaredType
			}
		}
	}
	ancestors := map[int]bool{-1: true}
	for parent := selected; parent >= 0; parent = scan.Ranges[parent].Parent {
		ancestors[parent] = true
	}
	scopes := []plDebugNativeDeclarationScope{}
	for _, scope := range scan.DeclarationScopes {
		if ancestors[scope.Parent] && (line > 0 && line >= tokens[scope.Start].Line && line <= tokens[scope.End-1].LastLine || line <= 0 && scope.Parent == selected && scope.Start > 0 && (tokens[scope.Start-1].word("IS") || tokens[scope.Start-1].word("AS"))) {
			scopes = append(scopes, scope)
		}
	}
	if len(scopes) == 0 {
		return names, "No declaration scope is confirmed for this native line"
	}
	sort.Slice(scopes, func(i, j int) bool { return scopes[i].Start > scopes[j].Start })
	for _, scope := range scopes {
		if scope.Parent >= 0 && scope.Start > 0 && (tokens[scope.Start-1].word("IS") || tokens[scope.Start-1].word("AS")) {
			node := scan.Ranges[scope.Parent]
			for _, param := range node.Parameters {
				declaredType := param.Type
				if param.TypeEnd > param.TypeStart {
					declaredType = text[param.TypeStart:param.TypeEnd]
				}
				for _, token := range tokens {
					if token.Start >= node.Start && token.End <= tokens[scope.Start-1].End && token.Identifier && token.Text == param.Name {
						add(token, declaredType)
						break
					}
				}
			}
		}
		for start := scope.Start; start < scope.Begin; {
			if tokens[start].word("PROCEDURE") || tokens[start].word("FUNCTION") {
				if _, headerEnd, ok := plDebugNativeRoutineHeaderMode(tokens, start, true); ok && headerEnd < len(tokens) && tokens[headerEnd].word(";") {
					start = headerEnd + 1
					continue
				}
				next := start
				for _, node := range scan.Ranges {
					if node.Start == tokens[start].Start {
						for next < len(tokens) && tokens[next].Start < node.End {
							next++
						}
						break
					}
				}
				if next == start {
					return names, "Nested routine declaration could not be isolated"
				}
				start = next
				continue
			}
			end, depth := start, 0
			for end < len(tokens) {
				if tokens[end].word("(") {
					depth++
				}
				if tokens[end].word(")") {
					depth--
				}
				if tokens[end].word(";") && depth == 0 {
					break
				}
				end++
			}
			if end == len(tokens) {
				return names, "Incomplete variable declaration"
			}
			if end > start+1 && tokens[start].Identifier && !plDebugDeclarationKeyword(tokens[start].Text+" ") && !tokens[start+1].word("EXCEPTION") {
				typeStart := start + 1
				if tokens[typeStart].word("CONSTANT") {
					typeStart++
				}
				typeEnd := typeStart
				for typeEnd < end && !tokens[typeEnd].word("NOT") && !tokens[typeEnd].word("DEFAULT") && !tokens[typeEnd].word(":") {
					typeEnd++
				}
				declaredType := ""
				if typeEnd > typeStart {
					declaredType = strings.TrimSpace(text[tokens[typeStart].Start:tokens[typeEnd-1].End])
				}
				add(tokens[start], declaredType)
			}
			start = end + 1
		}
	}
	return names, ""
}
