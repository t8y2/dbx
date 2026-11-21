package main

import (
	"strings"
	"testing"
)

func TestDatapumpStartRequestValidate(t *testing.T) {
	valid := datapumpStartRequest{
		OperationID: "op-1",
		Kind:        datapumpKindExport,
		Mode:        datapumpModeSchema,
		Directory:   "DATA_PUMP_DIR",
		DumpFile:    "export.dmp",
		Schemas:     []string{"SCOTT"},
	}
	if reason, field := valid.validate(); reason != "" {
		t.Fatalf("expected valid request, got reason=%q field=%q", reason, field)
	}

	tests := []struct {
		name       string
		mutate     func(*datapumpStartRequest)
		wantReason string
		wantField  string
	}{
		{"missing operation id", func(r *datapumpStartRequest) { r.OperationID = "" }, "datapump_request_invalid", "operationId"},
		{"nul in operation id", func(r *datapumpStartRequest) { r.OperationID = "a\x00b" }, "datapump_request_invalid", "operationId"},
		{"unknown kind", func(r *datapumpStartRequest) { r.Kind = "copy" }, "datapump_kind_invalid", "kind"},
		{"full mode out of scope", func(r *datapumpStartRequest) { r.Mode = "full" }, "datapump_mode_invalid", "mode"},
		{"missing directory", func(r *datapumpStartRequest) { r.Directory = "" }, "datapump_name_required", "directory"},
		{"quote in directory", func(r *datapumpStartRequest) { r.Directory = "EV'IL" }, "datapump_name_invalid", "directory"},
		{"missing dumpfile", func(r *datapumpStartRequest) { r.DumpFile = "" }, "datapump_dumpfile_required", "dumpfile"},
		{"path separator in dumpfile", func(r *datapumpStartRequest) { r.DumpFile = "../etc/passwd" }, "datapump_filename_invalid", "dumpfile"},
		{"windows path in dumpfile", func(r *datapumpStartRequest) { r.DumpFile = `C:\temp\a.dmp` }, "datapump_filename_invalid", "dumpfile"},
		{"path in logfile", func(r *datapumpStartRequest) { r.LogFile = "sub/exp.log" }, "datapump_filename_invalid", "logfile"},
		{"schema mode without schemas", func(r *datapumpStartRequest) { r.Schemas = nil }, "datapump_schemas_required", "schemas"},
		{"table mode without tables", func(r *datapumpStartRequest) {
			r.Mode = datapumpModeTable
			r.Schemas = nil
			r.Tables = nil
		}, "datapump_tables_required", "tables"},
		{"both lists populated", func(r *datapumpStartRequest) {
			r.Tables = []string{"EMP"}
		}, "datapump_mode_conflict", "schemas"},
		{"table list on schema mode", func(r *datapumpStartRequest) {
			r.Mode = datapumpModeTable
		}, "datapump_tables_required", "tables"},
		{"malformed table name", func(r *datapumpStartRequest) {
			r.Mode = datapumpModeTable
			r.Schemas = nil
			r.Tables = []string{"A.B.C"}
		}, "datapump_table_name_invalid", "tables"},
		{"schema qualified table accepted", func(r *datapumpStartRequest) {
			r.Mode = datapumpModeTable
			r.Schemas = nil
			r.Tables = []string{"SCOTT.EMP"}
		}, "", ""},
		{"half remap", func(r *datapumpStartRequest) { r.RemapSchemaFrom = "SCOTT" }, "datapump_remap_incomplete", "remapSchemaFrom"},
		{"remap on export", func(r *datapumpStartRequest) {
			r.RemapSchemaFrom = "SCOTT"
			r.RemapSchemaTo = "SCOTT2"
		}, "datapump_remap_import_only", "remapSchemaFrom"},
		{"table exists action on export", func(r *datapumpStartRequest) { r.TableExistsAction = "TRUNCATE" }, "datapump_table_exists_action_import_only", "tableExistsAction"},
		{"unknown table exists action", func(r *datapumpStartRequest) {
			r.Kind = datapumpKindImport
			r.TableExistsAction = "DROP"
		}, "datapump_table_exists_action_invalid", "tableExistsAction"},
		{"valid import with extras", func(r *datapumpStartRequest) {
			r.Kind = datapumpKindImport
			r.RemapSchemaFrom = "SCOTT"
			r.RemapSchemaTo = "SCOTT2"
			r.TableExistsAction = "truncate"
		}, "", ""},
		{"compression on import", func(r *datapumpStartRequest) {
			r.Kind = datapumpKindImport
			r.Compression = true
		}, "datapump_compression_export_only", "compression"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := valid
			tt.mutate(&request)
			reason, field := request.validate()
			if reason != tt.wantReason || field != tt.wantField {
				t.Fatalf("validate() = (%q, %q), want (%q, %q)", reason, field, tt.wantReason, tt.wantField)
			}
		})
	}
}

func TestDefaultDatapumpLogFile(t *testing.T) {
	tests := []struct {
		dumpFile string
		want     string
	}{
		{"export.dmp", "export.log"},
		{"export.DMP", "export.log"},
		{"backup", "backup.log"},
		{"a.b.dmp", "a.b.log"},
	}
	for _, tt := range tests {
		if got := defaultDatapumpLogFile(tt.dumpFile); got != tt.want {
			t.Errorf("defaultDatapumpLogFile(%q) = %q, want %q", tt.dumpFile, got, tt.want)
		}
	}
}

func TestDatapumpJobName(t *testing.T) {
	tests := []struct {
		name      string
		operation string
		kind      string
		want      string
	}{
		{"export prefix", "abc123", datapumpKindExport, "DBX_EXPORT_ABC123"},
		{"import prefix", "abc123", datapumpKindImport, "DBX_IMPORT_ABC123"},
		{"sanitized separators", "task-42_x", datapumpKindExport, "DBX_EXPORT_TASKX42XX"},
		{"truncated to 30 bytes", strings.Repeat("a", 40), datapumpKindExport, "DBX_EXPORT_" + strings.Repeat("A", 19)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := datapumpStartRequest{OperationID: tt.operation, Kind: tt.kind}
			got := datapumpJobName(request)
			if got != tt.want {
				t.Fatalf("datapumpJobName() = %q, want %q", got, tt.want)
			}
			if len(got) > 30 {
				t.Fatalf("job name %q exceeds Oracle's 30-byte limit", got)
			}
		})
	}
}
