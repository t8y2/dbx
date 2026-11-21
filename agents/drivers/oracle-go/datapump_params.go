package main

import (
	"strings"
)

// oracle_datapump_start RPC 的请求体。
// wire 字段名用驼峰，与宿主侧 serde 契约对齐。
type datapumpStartRequest struct {
	OperationID string `json:"operationId"`
	// Kind 选择 DBMS_DATAPUMP 的操作类型："export"（导出）或 "import"（导入）。
	Kind string `json:"kind"`
	// Mode 选择任务模式："schema"（按模式）或 "table"（按表）；v1 不做 FULL。
	Mode string `json:"mode"`
	// Directory 是 Oracle 的 DIRECTORY 对象名；dump/log 文件由数据库
	// 服务端写进该对象指向的服务器路径。
	Directory string `json:"directory"`
	DumpFile  string `json:"dumpfile"`
	// LogFile 可不填；不填时由 defaultDatapumpLogFile 从 DumpFile 推导。
	LogFile string `json:"logfile"`
	// Schemas 配合 schema 模式、Tables 配合 table 模式；
	// 两个列表只能填一个，且必须与 Mode 匹配。
	Schemas []string `json:"schemas"`
	Tables  []string `json:"tables"`
	// RemapSchemaFrom/To：导入时把 dump 里的源 schema 映射到目标 schema
	// （DBMS_DATAPUMP 的 METADATA_REMAP REMAP_SCHEMA）。仅导入可用。
	RemapSchemaFrom string `json:"remapSchemaFrom"`
	RemapSchemaTo   string `json:"remapSchemaTo"`
	// TableExistsAction 取值 SKIP/TRUNCATE/APPEND/REPLACE。仅导入可用。
	TableExistsAction string `json:"tableExistsAction"`
	// Compression 为 true 时导出启用 COMPRESSION=ALL。
	Compression bool `json:"compression"`
}

const (
	datapumpKindExport = "export"
	datapumpKindImport = "import"

	datapumpModeSchema = "schema"
	datapumpModeTable  = "table"
)

func datapumpTableExistsActionValid(action string) bool {
	switch action {
	case "SKIP", "TRUNCATE", "APPEND", "REPLACE":
		return true
	default:
		return false
	}
}

// validate 对齐 prepareLegacyJob 的原因码风格：返回机器可读的蛇形命名
// 原因码 + 出错字段名，让宿主侧能给出精确报错而不是笼统的 "invalid request"。
func (r datapumpStartRequest) validate() (reason, field string) {
	if r.OperationID == "" || len(r.OperationID) > 128 || strings.ContainsRune(r.OperationID, '\x00') {
		return "datapump_request_invalid", "operationId"
	}
	if r.Kind != datapumpKindExport && r.Kind != datapumpKindImport {
		return "datapump_kind_invalid", "kind"
	}
	if r.Mode != datapumpModeSchema && r.Mode != datapumpModeTable {
		return "datapump_mode_invalid", "mode"
	}
	if reason, field := datapumpValidateName(r.Directory, "directory", 128); reason != "" {
		return reason, field
	}
	if r.DumpFile == "" {
		return "datapump_dumpfile_required", "dumpfile"
	}
	if reason, field := datapumpValidateFilePart(r.DumpFile, "dumpfile"); reason != "" {
		return reason, field
	}
	if r.LogFile != "" {
		if reason, field := datapumpValidateFilePart(r.LogFile, "logfile"); reason != "" {
			return reason, field
		}
	}
	// 对象列表只能填一个，且必须和模式匹配。
	if len(r.Schemas) > 0 && len(r.Tables) > 0 {
		return "datapump_mode_conflict", "schemas"
	}
	if r.Mode == datapumpModeSchema {
		if len(r.Schemas) == 0 {
			return "datapump_schemas_required", "schemas"
		}
		for _, schema := range r.Schemas {
			if reason, field := datapumpValidateName(schema, "schemas", 128); reason != "" {
				return reason, field
			}
		}
	} else {
		if len(r.Tables) == 0 {
			return "datapump_tables_required", "tables"
		}
		for _, table := range r.Tables {
			if reason, field := datapumpValidateTableName(table); reason != "" {
				return reason, field
			}
		}
	}
	// remap 的 from/to 要么都填要么都空。
	if (r.RemapSchemaFrom == "") != (r.RemapSchemaTo == "") {
		return "datapump_remap_incomplete", "remapSchemaFrom"
	}
	if r.RemapSchemaFrom != "" && r.Kind != datapumpKindImport {
		return "datapump_remap_import_only", "remapSchemaFrom"
	}
	if r.RemapSchemaFrom != "" {
		if reason, field := datapumpValidateName(r.RemapSchemaFrom, "remapSchemaFrom", 128); reason != "" {
			return reason, field
		}
		if reason, field := datapumpValidateName(r.RemapSchemaTo, "remapSchemaTo", 128); reason != "" {
			return reason, field
		}
	}
	if r.TableExistsAction != "" {
		if r.Kind != datapumpKindImport {
			return "datapump_table_exists_action_import_only", "tableExistsAction"
		}
		if !datapumpTableExistsActionValid(strings.ToUpper(r.TableExistsAction)) {
			return "datapump_table_exists_action_invalid", "tableExistsAction"
		}
	}
	if r.Compression && r.Kind != datapumpKindExport {
		return "datapump_compression_export_only", "compression"
	}
	return "", ""
}

// datapumpValidateName 校验会被拼进 PL/SQL 表达式字符串的标识符
// （METADATA_FILTER 的值）：绝不允许携带引号、NUL 字节、路径分隔符。
// 长度按 Oracle 标识符上限约束。
func datapumpValidateName(value, field string, maxLen int) (reason, fieldName string) {
	if value == "" {
		return "datapump_name_required", field
	}
	if len(value) > maxLen || strings.ContainsRune(value, '\x00') || strings.ContainsAny(value, "'\"/\\") {
		return "datapump_name_invalid", field
	}
	return "", ""
}

// datapumpValidateFilePart 把 dump/log 文件名限制为"单个文件名"：
// 不许带目录分隔符（路径由 DIRECTORY 对象承担）。
func datapumpValidateFilePart(value, field string) (reason, fieldName string) {
	if len(value) > 255 || strings.ContainsRune(value, '\x00') || strings.ContainsAny(value, "/\\") {
		return "datapump_filename_invalid", field
	}
	return "", ""
}

// datapumpValidateTableName 接受 TABLE 或 SCHEMA.TABLE 两种形式（最多一个点），
// 每一段都按 datapumpValidateName 的标识符规则校验。
func datapumpValidateTableName(value string) (reason, fieldName string) {
	parts := strings.Split(value, ".")
	if len(parts) > 2 {
		return "datapump_table_name_invalid", "tables"
	}
	for _, part := range parts {
		if reason, field := datapumpValidateName(part, "tables", 128); reason != "" {
			return reason, field
		}
	}
	return "", ""
}

// defaultDatapumpLogFile 在请求未填日志文件名时从 dump 文件名推导。
func defaultDatapumpLogFile(dumpFile string) string {
	if strings.HasSuffix(strings.ToLower(dumpFile), ".dmp") {
		return dumpFile[:len(dumpFile)-len(".dmp")] + ".log"
	}
	return dumpFile + ".log"
}

// datapumpJobName 为每个操作生成确定性的 DBMS_DATAPUMP 任务名：
// DBX_EXPORT_<operationId> / DBX_IMPORT_<operationId>，做字符消毒并
// 截断到 Oracle 任务名 30 字节上限。确定性命名的好处：
//  1. 同一 operationId 重试幂等，不会开出第二个任务；
//  2. 服务器上残留的 master table 一眼能认出是 DBX 留下的。
func datapumpJobName(request datapumpStartRequest) string {
	var builder strings.Builder
	builder.WriteString("DBX_")
	builder.WriteString(strings.ToUpper(request.Kind))
	builder.WriteString("_")
	// 非字母数字字符统一替换为 X（Oracle 对象名不允许 - 等字符）。
	for _, r := range request.OperationID {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			builder.WriteRune(r)
		default:
			builder.WriteByte('X')
		}
	}
	name := strings.ToUpper(builder.String())
	if len(name) > 30 {
		name = name[:30]
	}
	return name
}
