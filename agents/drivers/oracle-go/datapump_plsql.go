// 本文件约定：Go 注释用中文；但所有"会发往数据库的字符串字面量"（PL/SQL
// 块及其内部的 -- 注释）必须保持英文——仓库守卫测试
// TestPLDebugUserFacingStringsAreEnglish 禁止 CJK 出现在用户可见诊断里。

package main

import (
	"database/sql"
	"fmt"
	"strings"

	go_ora "github.com/sijms/go-ora/v2"
)

// OUT 参数绑定的双驱动适配（对齐 native_jobs.go 的做法）：
// OUT 参数（数据库往里写值的参数）两种驱动注册方式不同——
// thin 连接（go-ora）要声明缓冲区大小，OCI 连接（godror）走标准 sql.Out。
// dest 传"盒子的地址"，驱动执行后把数据库返回值写进盒子。
func datapumpNumberOut(dest *float64, oci bool) any {
	if oci {
		return sql.Out{Dest: dest}
	}
	return go_ora.Out{Dest: dest}
}

func datapumpStringOut(dest *string, size int, oci bool) any {
	if oci {
		return sql.Out{Dest: dest}
	}
	return go_ora.Out{Dest: dest, Size: size}
}

// datapumpSQLLiteral 把校验过的标识符渲染成 SQL 字符串字面量（含 '' 转义）。
// METADATA_FILTER 的 value 是 SQL 表达式文本，没法用绑定参数只能拼——
// 所以校验层已拒绝引号，这里仍然做转义（纵深防御，防注入不押单点）。
func datapumpSQLLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// datapumpNameListExpr 把多个名字拼成 IN ('A','B') 表达式。
func datapumpNameListExpr(values []string) string {
	literals := make([]string, len(values))
	for i, value := range values {
		literals[i] = datapumpSQLLiteral(value)
	}
	return "IN (" + strings.Join(literals, ",") + ")"
}

// datapumpOpenScript 携带"从 OPEN 到 START_JOB"的匿名 PL/SQL 块和配套的
// 参数组装器。为什么捆在一起：SQL 里有多少个 :占位符就得有多少个绑定值，
// 捆在一个 struct 里返回就不可能配错（防呆设计）。
// bindArgs 字段的类型是"函数"（≈ Java 的 BiFunction 字段）：基础参数构建时
// 由闭包固定，handle OUT 绑定留到执行时追加。
type datapumpOpenScript struct {
	SQL string
	// bindArgs 组装具名参数；handle 接收任务句柄（OUT 参数）。
	bindArgs func(handle *float64, oci bool) []any
}

// buildDatapumpOpenScript 构建启动块。整块跑在 pinned 连接上；
// :handle 是唯一的 OUT 参数（任务名是我们传进去的，不需要读回来）。
func buildDatapumpOpenScript(request datapumpStartRequest, logFile string) datapumpOpenScript {
	var b strings.Builder
	// 具名参数 ≈ MyBatis 的 #{param}
	args := []any{
		sql.Named("operation", request.Kind),
		sql.Named("job_mode", request.Mode),
		sql.Named("job_name", datapumpJobName(request)),
		sql.Named("directory", request.Directory),
		sql.Named("dumpfile", request.DumpFile),
		sql.Named("logfile", logFile),
	}

	// 注意：PL/SQL 字符串字面量内部的 -- 注释必须是英文——
	// TestPLDebugUserFacingStringsAreEnglish 禁止中文进入用户可见诊断。
	b.WriteString(`DECLARE
  h NUMBER;
BEGIN
  -- deterministic job name supplied by the caller (see datapumpJobName).
  -- OPEN uses POSITIONAL arguments: MODE is a PL/SQL reserved word and cannot
  -- appear as a named parameter (ORA-06550 / PLS-00103), so the signature is
  -- OPEN(operation, mode, remote_link, job_name, version).
  h := SYS.DBMS_DATAPUMP.OPEN(:operation, :job_mode, NULL, :job_name, 'COMPATIBLE');
  -- dump file inside the DIRECTORY object
  SYS.DBMS_DATAPUMP.ADD_FILE(handle => h, filename => :dumpfile, directory => :directory, filetype => SYS.DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE);
  -- log file inside the same DIRECTORY object
  SYS.DBMS_DATAPUMP.ADD_FILE(handle => h, filename => :logfile, directory => :directory, filetype => SYS.DBMS_DATAPUMP.KU$_FILE_TYPE_LOG_FILE);
`)
	// 按模式生成过滤条件：schema 模式选 schema，table 模式按表名。
	if request.Mode == datapumpModeSchema {
		expr := datapumpNameListExpr(request.Schemas)
		b.WriteString("  SYS.DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'SCHEMA_EXPR', value => " + datapumpSQLLiteral(expr) + ");\n")
	} else {
		// Oracle 标准做法：表模式拆成两个过滤器（NAME_EXPR 只放表名，
		// SCHEMA_EXPR 放 schema），直接用 NAME_EXPR='IN(CMS.EMP)' 部分版本不认。
		tableSchemas, tableNames := datapumpSplitTableNames(request.Tables)
		nameExpr := datapumpNameListExpr(tableNames)
		b.WriteString("  SYS.DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'NAME_EXPR', value => " + datapumpSQLLiteral(nameExpr) + ");\n")
		if len(tableSchemas) > 0 {
			schemaExpr := datapumpNameListExpr(tableSchemas)
			b.WriteString("  SYS.DBMS_DATAPUMP.METADATA_FILTER(handle => h, name => 'SCHEMA_EXPR', value => " + datapumpSQLLiteral(schemaExpr) + ");\n")
		}
	}
	// 导入专属：schema 重映射（如 SCOTT → SCOTT2）。
	if request.RemapSchemaFrom != "" {
		args = append(args, sql.Named("remap_from", request.RemapSchemaFrom), sql.Named("remap_to", request.RemapSchemaTo))
		b.WriteString("  SYS.DBMS_DATAPUMP.METADATA_REMAP(handle => h, name => 'REMAP_SCHEMA', old_value => :remap_from, value => :remap_to);\n")
	}
	// 导入专属：表已存在时的处理策略（先统一转大写再绑定）。
	if request.TableExistsAction != "" {
		args = append(args, sql.Named("table_exists_action", strings.ToUpper(request.TableExistsAction)))
		b.WriteString("  SYS.DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'TABLE_EXISTS_ACTION', value => :table_exists_action);\n")
	}
	// 导出专属：压缩。
	if request.Compression {
		b.WriteString("  SYS.DBMS_DATAPUMP.SET_PARAMETER(handle => h, name => 'COMPRESSION', value => 'ALL');\n")
	}
	b.WriteString(`  -- start the job (runs in server background; this session polls progress)
  SYS.DBMS_DATAPUMP.START_JOB(handle => h);
  -- hand the handle back to Go via the OUT bind
  :handle := h;
END;`)

	return datapumpOpenScript{
		SQL: b.String(),
		// 闭包 ≈ Java lambda：捕获上面的 args，执行时才追加 handle OUT 绑定。
		bindArgs: func(handle *float64, oci bool) []any {
			return append(args, sql.Named("handle", datapumpNumberOut(handle, oci)))
		},
	}
}

// oracle_datapump_status RPC 返回给宿主的状态快照。
// 数值字段用 float64：它们来自 Oracle NUMBER 类型的 OUT 绑定。
type datapumpStatusValues struct {
	JobState  string  `json:"jobState"`
	Percent   float64 `json:"percent"`
	PhaseCode float64 `json:"phaseCode"`
	// ErrorText 最多拼 datapumpStatusErrorLimit 条错误日志行（换行分隔）；
	// ErrorCount 携带服务器端的完整错误条数（可能大于截断值）。
	ErrorText  string  `json:"errorText"`
	ErrorCount float64 `json:"errorCount"`
}

const (
	datapumpStatusErrorLimit = 20
	// 32767 是 PL/SQL 里 VARCHAR2 的上限；OUT 绑定的大小在两种驱动上都不能超。
	datapumpErrorTextMaxLen = 32767
)

// buildDatapumpStatusScript 构建状态轮询块——整个方案最核心的技巧。
//
// GET_STATUS 的 OUT 参数 st 是 KU$_STATUS1020 复杂对象类型，go-ora 绑不了
// Oracle 对象类型 → 让对象只活在 PL/SQL 块内部，块里把对象拆成标量
// （百分比、阶段码、错误文本）再塞进绑定变量。跨驱动边界的全是标量。
//
// GET_STATUS 的 timeout 语义是"等到状态变化或超时"：长时间导出中状态
// 不变时它返回的 status 对象是空的（percent 变 NULL）。因此引擎侧把
// timeout 绑定为 0（立即返回当前状态），轮询节奏由 Go 侧的 sleep 控制。
//
// 字段名已于 2026-11-14 在 19c 真机核对（dba_source 的类型定义）：
//   ku$_Status1020.job_status → ku$_JobStatus1020{percent_done, phase, state, ...}
//   ku$_Status1020.error      → ku$_LogEntry1010 = TABLE OF ku$_LogLine1010{LogText, ...}
// 注意是 percent_done（不是 percent），别"顺手"改回去。
func buildDatapumpStatusScript(timeoutSecs int) (string, func(values *datapumpStatusValues, handle float64, oci bool) []any) {
	// fmt.Sprintf ≈ String.format：把条数上限和长度上限填进 %d 占位符。
	// （块内 -- 注释保持英文：见文件顶部说明）
	script := fmt.Sprintf(`DECLARE
  h         NUMBER        := :handle;      -- handle supplied by the Go side
  st        SYS.KU$_STATUS1020;           -- complex object, block-local only
  js        VARCHAR2(35);
  err_text  VARCHAR2(32767);
  err_count PLS_INTEGER;
BEGIN
  SYS.DBMS_DATAPUMP.GET_STATUS(handle => h, mask => SYS.DBMS_DATAPUMP.KU$_STATUS_JOB_DESC + SYS.DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS, timeout => :timeout_secs, job_state => js, status => st);
  :job_state := js;                       -- destructure the object into scalars
  -- NVL guards: with a nonzero GET_STATUS timeout and no state change, the
  -- returned status object can be empty (job_status NULL) and the binds would
  -- receive NULL. timeout is bound as 0 by the engine, but stay defensive.
  :percent   := NVL(st.job_status.percent_done, 0); -- progress 0-100
  :phase     := NVL(st.job_status.phase, 0);        -- phase code
  err_count := 0;
  IF st.error IS NOT NULL THEN
    err_count := st.error.COUNT;          -- full server-side error count
    FOR i IN 1 .. LEAST(st.error.COUNT, %d) LOOP   -- first N entries only
      -- SUBSTR caps the length; NULL || x = x in Oracle, so concat starts empty
      err_text := SUBSTR(err_text || st.error(i).logText || CHR(10), 1, %d);
    END LOOP;
  END IF;
  :error_count := err_count;
  :error_text  := err_text;
END;`, datapumpStatusErrorLimit, datapumpErrorTextMaxLen)

	// 返回的第二个值是个装配器函数：拿着快照对象的指针和句柄，
	// 按驱动形态组装 7 个绑定参数（入参原样传，出参传地址）。
	bindArgs := func(values *datapumpStatusValues, handle float64, oci bool) []any {
		return []any{
			sql.Named("handle", handle),
			sql.Named("timeout_secs", timeoutSecs),
			sql.Named("job_state", datapumpStringOut(&values.JobState, 64, oci)),
			sql.Named("percent", datapumpNumberOut(&values.Percent, oci)),
			sql.Named("phase", datapumpNumberOut(&values.PhaseCode, oci)),
			sql.Named("error_count", datapumpNumberOut(&values.ErrorCount, oci)),
			sql.Named("error_text", datapumpStringOut(&values.ErrorText, datapumpErrorTextMaxLen, oci)),
		}
	}
	return script, bindArgs
}

// 取消：STOP_JOB 立即停（immediate=1），keep_master=0 顺带删掉 master table，
// 服务器端干干净净无残留（对比路线 A 的 kill 进程）。
const datapumpStopScript = `BEGIN
  SYS.DBMS_DATAPUMP.STOP_JOB(handle => :handle, immediate => 1, keep_master => 0);
END;`

// 收尾脱离：本会话和任务脱钩（任务正常完成时用）。
const datapumpDetachScript = `BEGIN
  SYS.DBMS_DATAPUMP.DETACH(handle => :handle);
END;`

// 预检查询（方案 §3.2.1）：OPEN 之前在 pinned 连接上跑的普通 SELECT，
// 每条一个往返，把"跑几分钟后才炸"的问题提前到"点开始后 1 秒内报"。
const (
	// 查 DIRECTORY 对象对应的服务器路径（查不到 = 对象不存在）。
	datapumpPreflightDirectorySQL = `SELECT DIRECTORY_PATH FROM SYS.ALL_DIRECTORIES WHERE DIRECTORY_NAME = UPPER(:directory)`

	// 当前用户对该目录的 READ/WRITE 权限数（直接授予 + 授予 PUBLIC + 经角色授予，合计 = 2 才算齐）。
	// GRANTEE 过滤不可省：USER_TAB_PRIVS 也会列出"我作为授权人/属主授出去的"记录，
	// 不过滤会把别人拿到的权限误算成自己的。
	datapumpPreflightDirectoryPrivSQL = `SELECT
  (SELECT COUNT(DISTINCT PRIVILEGE) FROM SYS.USER_TAB_PRIVS WHERE TABLE_NAME = UPPER(:directory) AND PRIVILEGE IN ('READ','WRITE') AND GRANTEE IN (USER, 'PUBLIC')) +
  (SELECT COUNT(DISTINCT PRIVILEGE) FROM SYS.ROLE_TAB_PRIVS WHERE TABLE_NAME = UPPER(:directory) AND PRIVILEGE IN ('READ','WRITE') AND ROLE IN (SELECT GRANTED_ROLE FROM SYS.USER_ROLE_PRIVS))
FROM SYS.DUAL`

	// 是否持有导出/导入对应的 full 角色（跨 schema 操作需要），按操作类型分开查。
	datapumpPreflightExportRoleSQL = `SELECT COUNT(*) FROM SYS.USER_ROLE_PRIVS WHERE GRANTED_ROLE = 'EXP_FULL_DATABASE'`
	datapumpPreflightImportRoleSQL = `SELECT COUNT(*) FROM SYS.USER_ROLE_PRIVS WHERE GRANTED_ROLE = 'IMP_FULL_DATABASE'`

	// 数据库版本（如 "19.0.0.0.0"），v1 要求 ≥ 11g。
	datapumpPreflightVersionSQL = `SELECT VERSION FROM SYS.PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle Database%'`

	// 当前登录用户（跨 schema 权限判断用）。
	datapumpPreflightUserSQL = `SELECT SYS_CONTEXT('USERENV','SESSION_USER') FROM SYS.DUAL`

	// 写探针：往目录里写一个临时文件再删掉。19c 的 ADD_FILE 对"数据库进程
	// 实际写不进去"的路径只会抛误导性的 ORA-39001；这里提前用 UTL_FILE
	// 探出真正原因（路径不存在 / oracle 系统用户无写权限）。
	datapumpPreflightProbeWriteSQL = `DECLARE
  f UTL_FILE.FILE_TYPE;
BEGIN
  f := UTL_FILE.FOPEN(UPPER(:directory), 'dbx_dp_probe.tmp', 'W', 128);
  UTL_FILE.PUT_LINE(f, 'dbx data pump preflight probe');
  UTL_FILE.FCLOSE(f);
  UTL_FILE.FREMOVE(UPPER(:directory), 'dbx_dp_probe.tmp');
END;`
)

// datapumpSplitTableNames 拆解 SCHEMA.TABLE 列表为两个去重列表。
// 有前缀的取前缀，无前缀的跳过 schema 列表（由外部补）。
func datapumpSplitTableNames(tables []string) (schemas, names []string) {
	seen := map[string]bool{}
	for _, table := range tables {
		parts := strings.SplitN(table, ".", 2)
		if len(parts) == 2 {
			if !seen[parts[0]] {
				seen[parts[0]] = true
				schemas = append(schemas, parts[0])
			}
			names = append(names, parts[1])
		} else {
			names = append(names, table)
		}
	}
	return schemas, names
}
