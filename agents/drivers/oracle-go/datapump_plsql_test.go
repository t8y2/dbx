package main

import (
	"database/sql"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

func TestBuildDatapumpOpenScriptExport(t *testing.T) {
	request := datapumpStartRequest{
		OperationID: "op-1",
		Kind:        datapumpKindExport,
		Mode:        datapumpModeSchema,
		Directory:   "DATA_PUMP_DIR",
		DumpFile:    "export.dmp",
		Schemas:     []string{"SCOTT", "HR"},
		Compression: true,
	}
	script := buildDatapumpOpenScript(request, defaultDatapumpLogFile(request.DumpFile))

	for _, marker := range []string{
		"h := SYS.DBMS_DATAPUMP.OPEN(:operation, :job_mode, NULL, :job_name, 'COMPATIBLE')",
		"KU$_FILE_TYPE_DUMP_FILE",
		"KU$_FILE_TYPE_LOG_FILE",
		"METADATA_FILTER(handle => h, name => 'SCHEMA_EXPR', value => 'IN (''SCOTT'',''HR'')')",
		"SET_PARAMETER(handle => h, name => 'COMPRESSION', value => 'ALL')",
		"DBMS_DATAPUMP.START_JOB(handle => h)",
		":handle := h",
	} {
		if !strings.Contains(script.SQL, marker) {
			t.Errorf("open script missing marker %q\nscript:\n%s", marker, script.SQL)
		}
	}
	for _, forbidden := range []string{"REMAP_SCHEMA", "TABLE_EXISTS_ACTION"} {
		if strings.Contains(script.SQL, forbidden) {
			t.Errorf("export script must not contain %q", forbidden)
		}
	}

	var handle float64
	args := script.bindArgs(&handle, false)
	if len(args) != 7 {
		t.Fatalf("expected 7 bind args (6 inputs + handle out; compression is inline), got %d", len(args))
	}
	out, ok := args[len(args)-1].(sql.NamedArg)
	if !ok || out.Name != "handle" {
		t.Fatalf("last arg must be the handle OUT bind, got %#v", args[len(args)-1])
	}
	if _, ok := out.Value.(go_ora.Out); !ok {
		t.Errorf("thin profile must wrap the handle OUT in go_ora.Out, got %T", out.Value)
	}
}

func TestBuildDatapumpOpenScriptImport(t *testing.T) {
	request := datapumpStartRequest{
		OperationID:       "op-2",
		Kind:              datapumpKindImport,
		Mode:              datapumpModeTable,
		Directory:         "DATA_PUMP_DIR",
		DumpFile:          "export.dmp",
		Tables:            []string{"SCOTT.EMP", "SCOTT.DEPT"},
		RemapSchemaFrom:   "SCOTT",
		RemapSchemaTo:     "SCOTT2",
		TableExistsAction: "truncate",
	}
	script := buildDatapumpOpenScript(request, "import.log")

	for _, marker := range []string{
		"METADATA_FILTER(handle => h, name => 'NAME_EXPR', value => 'IN (''EMP'',''DEPT'')')",
		"METADATA_FILTER(handle => h, name => 'SCHEMA_EXPR', value => 'IN (''SCOTT'')')",
		"METADATA_REMAP(handle => h, name => 'REMAP_SCHEMA', old_value => :remap_from, value => :remap_to)",
		"SET_PARAMETER(handle => h, name => 'TABLE_EXISTS_ACTION', value => :table_exists_action)",
	} {
		if !strings.Contains(script.SQL, marker) {
			t.Errorf("import script missing marker %q\nscript:\n%s", marker, script.SQL)
		}
	}
	var foundAction bool
	var handle float64
	for _, arg := range script.bindArgs(&handle, true) {
		if named, ok := arg.(sql.NamedArg); ok && named.Name == "table_exists_action" {
			foundAction = true
			// 小写输入必须归一化成 Oracle 期望的值.
			if named.Value != "TRUNCATE" {
				t.Errorf("table_exists_action must normalize to TRUNCATE, got %v", named.Value)
			}
		}
	}
	if !foundAction {
		t.Error("import script must bind table_exists_action")
	}
}

func TestDatapumpSQLLiteralEscaping(t *testing.T) {
	if got := datapumpSQLLiteral("SCOTT"); got != "'SCOTT'" {
		t.Errorf("plain literal = %q", got)
	}
	// 校验层已拒绝内嵌引号，但构建器仍要做转义——
	// 漏掉校验时也不能演变成 PL/SQL 注入。
	if got := datapumpSQLLiteral("E'X"); got != "'E''X'" {
		t.Errorf("escaped literal = %q", got)
	}
}

func TestBuildDatapumpStatusScriptBinds(t *testing.T) {
	script, bindArgs := buildDatapumpStatusScript(5)
	for _, marker := range []string{
		"GET_STATUS(handle => h, mask => SYS.DBMS_DATAPUMP.KU$_STATUS_JOB_DESC + SYS.DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS, timeout => :timeout_secs",
		":job_state := js",
		":percent   := NVL(st.job_status.percent_done, 0);",
		"LEAST(st.error.COUNT, 20)",
		":error_text  := err_text",
	} {
		if !strings.Contains(script, marker) {
			t.Errorf("status script missing marker %q\nscript:\n%s", marker, script)
		}
	}

	values := &datapumpStatusValues{}
	args := bindArgs(values, 42.5, false)
	if len(args) != 7 {
		t.Fatalf("expected 7 bind args, got %d", len(args))
	}
	if named, ok := args[0].(sql.NamedArg); !ok || named.Name != "handle" || named.Value != 42.5 {
		t.Errorf("handle must bind as plain input value, got %#v", args[0])
	}
	if named, ok := args[1].(sql.NamedArg); !ok || named.Name != "timeout_secs" || named.Value != 5 {
		t.Errorf("timeout must bind as plain input value, got %#v", args[1])
	}
	ociArgs := bindArgs(&datapumpStatusValues{}, 1, true)
	for i, arg := range ociArgs {
		named, ok := arg.(sql.NamedArg)
		if !ok {
			t.Fatalf("arg %d is not a named arg", i)
		}
		if _, isThin := named.Value.(go_ora.Out); isThin {
			t.Errorf("OCI profile arg %q must not use go_ora.Out", named.Name)
		}
	}
}
