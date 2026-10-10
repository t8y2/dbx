package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The helper package DBX_PL_DEBUG_PACKAGE is shared with the Java agent
// (agents/drivers/oceanbase-oracle): the Go side defines the DDL, the Java side renders
// the same text, and each agent recognises the other's body by the same literal markers.
// A wording drift on one side is invisible to both sides' own unit tests -- each pins its
// own copy -- and it only surfaces on a real server, as a version check that says
// "stale" forever or, worse, as a body compiled against a head with different signatures.
// This test is the in-repo gate: it parses the Java source tolerantly (string constants,
// their concatenations and identifier references), renders what each side would install
// and compares the results.
//
// The Java agent lags the Go side's newest marker until it is synced, so after a version
// bump this test is expected to fail with the *missing* V6.x anchors named -- that
// failure is the work item for the other side, not a defect of this one. A missing Java
// file or a renamed anchor fails as well: the gate must never pass by finding nothing.

// The tests run with the package directory as their working directory, so the Java agent
// is one level up: agents/drivers/{oracle-go,oceanbase-oracle}.
const javaHelperPackagePath = "../oceanbase-oracle/src/main/java/com/dbx/agent/oceanbaseoracle/DbxPlDebugPackage.java"

// javaStringConstantPattern matches `static final String NAME = <expression>;` where the
// expression is only string literals, identifiers and `+`. Constants built with a method
// call (List.of ...) deliberately do not match: this evaluator never runs Java code.
var javaStringConstantPattern = regexp.MustCompile(
	`(?s)static\s+final\s+String\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*((?:\s*(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|\+)\s*)+);`)

// javaHelperConstants evaluates every String constant of the Java file in source order,
// resolving identifier references against the constants already evaluated (a later
// constant may refer to an earlier one). A declaration the evaluator cannot understand
// is skipped rather than guessed at.
func javaHelperConstants(source string) map[string]string {
	constants := map[string]string{}
	for _, match := range javaStringConstantPattern.FindAllStringSubmatch(source, -1) {
		name, expression := match[1], match[2]
		if _, exists := constants[name]; exists {
			continue
		}
		if value, ok := javaStringExpression(expression, constants); ok {
			constants[name] = value
		}
	}
	return constants
}

// javaStringExpression renders one Java string concatenation; ok is false when it names
// something the evaluator does not know.
func javaStringExpression(expression string, constants map[string]string) (string, bool) {
	var builder strings.Builder
	for index := 0; index < len(expression); {
		switch char := expression[index]; {
		case char == ' ' || char == '\t' || char == '\n' || char == '\r' || char == '+':
			index++
		case char == '"':
			value, next, ok := javaStringLiteral(expression, index)
			if !ok {
				return "", false
			}
			builder.WriteString(value)
			index = next
		case char == '_' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z'):
			end := index + 1
			for end < len(expression) && (expression[end] == '_' || expression[end] == '$' ||
				(expression[end] >= 'A' && expression[end] <= 'Z') ||
				(expression[end] >= 'a' && expression[end] <= 'z') ||
				(expression[end] >= '0' && expression[end] <= '9')) {
				end++
			}
			value, ok := constants[expression[index:end]]
			if !ok {
				return "", false
			}
			builder.WriteString(value)
			index = end
		default:
			return "", false
		}
	}
	return builder.String(), true
}

// javaStringLiteral decodes the Java string literal starting at start (a quote) and
// reports the index just past its closing quote.
func javaStringLiteral(expression string, start int) (string, int, bool) {
	var builder strings.Builder
	for index := start + 1; index < len(expression); index++ {
		switch expression[index] {
		case '\\':
			if index+1 >= len(expression) {
				return "", 0, false
			}
			switch escaped := expression[index+1]; escaped {
			case 'n':
				builder.WriteByte('\n')
			case 't':
				builder.WriteByte('\t')
			case 'r':
				builder.WriteByte('\r')
			case '"':
				builder.WriteByte('"')
			case '\\':
				builder.WriteByte('\\')
			case '\'':
				builder.WriteByte('\'')
			default:
				builder.WriteByte(escaped)
			}
			index++
		case '"':
			return builder.String(), index + 1, true
		default:
			builder.WriteByte(expression[index])
		}
	}
	return "", 0, false
}

// javaConstantContaining finds the *shortest* evaluated constant whose value contains the
// needle. The shortest one is the routine constant itself: the assembled body constant
// contains it too, and so does the head template for a declaration.
func javaConstantContaining(constants map[string]string, needle string) (string, string, bool) {
	name, value, found := "", "", false
	for candidate, candidateValue := range constants {
		if !strings.Contains(candidateValue, needle) {
			continue
		}
		if !found || len(candidateValue) < len(value) {
			name, value, found = candidate, candidateValue, true
		}
	}
	return name, value, found
}

// nonEmptyRightTrimmedLines is the line comparison unit: right-trimmed, blank lines
// dropped, order preserved -- the same normalization the V6.3/V6.4 parity scripts used.
func nonEmptyRightTrimmedLines(text string) []string {
	lines := make([]string, 0, 64)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, " \t\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

// assertSameLines reports the first line that differs, which is what a reader needs to
// see exactly where the two languages drifted apart.
func assertSameLines(t *testing.T, label string, goLines, javaLines []string) {
	t.Helper()
	if strings.Join(goLines, "\n") == strings.Join(javaLines, "\n") {
		return
	}
	limit := len(goLines)
	if len(javaLines) < limit {
		limit = len(javaLines)
	}
	index := 0
	for index < limit && goLines[index] == javaLines[index] {
		index++
	}
	switch {
	case index < limit:
		t.Errorf("%s diverged at line %d:\n  go  : %q\n  java: %q", label, index+1, goLines[index], javaLines[index])
	case len(goLines) > len(javaLines):
		t.Errorf("%s has %d extra Go line(s) from line %d: %q", label, len(goLines)-len(javaLines), index+1, goLines[index])
	default:
		t.Errorf("%s has %d extra Java line(s) from line %d: %q", label, len(javaLines)-len(goLines), index+1, javaLines[index])
	}
}

// goRenderedBodyRegion extracts one routine's rendered region -- its history comment plus
// the routine itself -- from the body the Go template produces. endMarker must name the
// text that follows the routine in the template.
func goRenderedBodyRegion(body, startMarker, endMarker string) (string, bool) {
	start := strings.Index(body, startMarker)
	if start < 0 {
		return "", false
	}
	rest := body[start:]
	if end := strings.Index(rest, endMarker); end >= 0 {
		rest = rest[:end]
	}
	return strings.TrimRight(rest, "\n"), true
}

// javaRoutineConstant returns the Java constant that renders one routine, located by its
// declaration so a renamed constant cannot hide a missing routine.
func javaRoutineConstant(t *testing.T, constants map[string]string, routine string) (string, bool) {
	t.Helper()
	for _, needle := range []string{
		"PROCEDURE " + routine + "(",
		"FUNCTION " + routine + "(",
	} {
		if _, value, ok := javaConstantContaining(constants, needle); ok {
			return strings.Trim(value, "\n"), true
		}
	}
	return "", false
}

// headDeclaration extracts the declaration of one routine from a rendered package head.
// The `[^;]*;` tail keeps a FUNCTION's RETURN clause inside the matched declaration.
func headDeclaration(head, routine string) string {
	pattern := regexp.MustCompile(`(?i)(PROCEDURE|FUNCTION)\s+` + regexp.QuoteMeta(routine) + `\s*\([^;]*\)[^;]*;`)
	return pattern.FindString(head)
}

func TestPLDebugHelperPackageMatchesTheJavaAgent(t *testing.T) {
	path := filepath.Clean(javaHelperPackagePath)
	sourceBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the Java helper package cannot be read (%s): %v\n"+
			"this test is the cross-language consistency gate; a missing Java file must fail it", path, err)
	}
	source := string(sourceBytes)
	constants := javaHelperConstants(source)
	if len(constants) == 0 {
		t.Fatalf("no String constants could be evaluated from %s; the parser or the file changed", path)
	}

	// ---- 1. the two markers both agents compare -------------------------------------
	if value, ok := constants["VERSION_NOTE"]; !ok {
		t.Errorf("the Java VERSION_NOTE constant is missing; the Go side writes %q", plDebugVersionNote)
	} else if value != plDebugVersionNote {
		t.Errorf("the shared V6 identity note differs:\n  go  : %q\n  java: %q", plDebugVersionNote, value)
	}
	if value, ok := constants["BODY_FIX_NOTE"]; !ok {
		t.Errorf("the Java BODY_FIX_NOTE constant is missing; the Go side writes %q", plDebugBodyFixNote)
	} else if value != plDebugBodyFixNote {
		t.Errorf("the fix note differs (the Java agent has not been synced to the Go side's V6.x marker yet):\n  go  : %q\n  java: %q",
			plDebugBodyFixNote, value)
	}

	// ---- 2. the three routine bodies + their history comments -----------------------
	goBody := plDebugPackageBody("DBX_TEST", plDebugProgramInfoFields{})
	for _, testCase := range []struct {
		label       string
		routine     string
		goStart     string
		goEnd       string
		javaMissing string
	}{
		{
			label:       "V6.3 DBX_FETCH_OUTPUT",
			routine:     procFetchOutput,
			goStart:     "-- V6.3 (real Oracle 19c EE verified): DBX_FETCH_OUTPUT added",
			goEnd:       "\n\n-- V6.4 (real Oracle 19c EE verified):",
			javaMissing: "the Java side has no DBX_FETCH_OUTPUT routine constant",
		},
		{
			label:       "V6.4 DBX_CNT_EXCEPTION",
			routine:     procCntException,
			goStart:     "-- V6.4 (real Oracle 19c EE verified): DBX_CNT_EXCEPTION added",
			goEnd:       "\n\nEND " + plDebugPackageName + ";",
			javaMissing: "the Java side has no DBX_CNT_EXCEPTION routine constant",
		},
		{
			label:       "V6.5 DBX_FETCH_BACKTRACE",
			routine:     procFetchBacktrace,
			goStart:     "-- V6.5 (real Oracle 19c EE verified): DBX_FETCH_BACKTRACE added",
			goEnd:       "\n\nPROCEDURE ",
			javaMissing: "the Java side has no DBX_FETCH_BACKTRACE routine constant; the Java agent has not been synced to V6.5",
		},
	} {
		testCase := testCase
		t.Run(testCase.label, func(t *testing.T) {
			goRegion, ok := goRenderedBodyRegion(goBody, testCase.goStart, testCase.goEnd)
			if !ok {
				t.Fatalf("the Go template no longer renders %q; the region boundary in this test is stale",
					testCase.goStart)
			}
			javaRegion, ok := javaRoutineConstant(t, constants, testCase.routine)
			if !ok {
				t.Fatalf("%s (looking for a constant rendering %q)", testCase.javaMissing, testCase.routine)
			}
			assertSameLines(t, testCase.label+" routine (with its history comment)",
				nonEmptyRightTrimmedLines(goRegion), nonEmptyRightTrimmedLines(javaRegion))
		})
	}

	// ---- 3. the head declarations ---------------------------------------------------
	goHead := fmt.Sprintf(plDebugPackageHeadDDL, "DBX_TEST")
	javaHeadValue, ok := constants["WRAPPED_PACKAGE_HEAD"]
	if !ok {
		t.Fatalf("the Java WRAPPED_PACKAGE_HEAD constant is missing")
	}
	javaHead := strings.Replace(javaHeadValue, "%s", `"DBX_TEST".`, 1)
	for _, routine := range []string{procFetchOutput, procCntException, procFetchBacktrace} {
		routine := routine
		t.Run("head declaration "+routine, func(t *testing.T) {
			goDeclaration := headDeclaration(goHead, routine)
			if goDeclaration == "" {
				t.Fatalf("the Go head template does not declare %s", routine)
			}
			javaDeclaration := headDeclaration(javaHead, routine)
			if javaDeclaration == "" {
				t.Fatalf("the Java head does not declare %s (the Java agent has not been synced to V6.5); the Go declaration is %q",
					routine, goDeclaration)
			}
			if collapseWhitespace(goDeclaration) != collapseWhitespace(javaDeclaration) {
				t.Errorf("the %s declaration differs:\n  go  : %q\n  java: %q", routine, goDeclaration, javaDeclaration)
			}
		})
	}

	// ---- 4. the pending-line declaration --------------------------------------------
	pendingDeclaration := plDebugPackageName + "_PENDING_LINE VARCHAR2(32767) := NULL;"
	if !strings.Contains(goBody, pendingDeclaration) {
		t.Errorf("the Go body no longer declares %q", pendingDeclaration)
	}
	if value, ok := constants["PENDING_LINE_DECLARATION"]; !ok {
		t.Errorf("the Java PENDING_LINE_DECLARATION constant is missing")
	} else if strings.TrimSpace(value) != pendingDeclaration {
		t.Errorf("the pending-line declaration differs:\n  go  : %q\n  java: %q", pendingDeclaration, strings.TrimSpace(value))
	}
}

func collapseWhitespace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}
