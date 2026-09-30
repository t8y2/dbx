package main

import (
	"errors"
	"fmt"
	"strings"
)

// OCI（thick）连接的 DSN 构造。
//
// 这里不导入 godror、也没有构建标记：除字符串拼装外没有任何依赖，因此
// thin 构建与 CI 的常规 `go test` 都能覆盖这些规则。真正加载 Oracle
// 客户端的部分在 oci.go（构建标记 oci）。

// buildOCIDSN 把 DBX 传来的连接信息归一成 godror 的连接串。
//
// 采用 godror 的 logfmt 形式（含 `connectString=` 即按参数串解析）：
// 只有 URL 与 logfmt 形式会解析参数，旧式的 `user/pass@connectString` 不会，
// 而我们需要下传 timezone（godror 要求显式声明连接时区，否则取 TIMESTAMP
// WITH LOCAL TIME ZONE 时无法判断换算基准）与 prefetchRows（与 thin 路径对齐）。
//
// 进程级设置仍由 DBX 注入的启动环境提供：Instant Client 目录在 PATH 上，
// TNS_ADMIN 指向 tnsnames.ora 所在目录 —— 两者都在 agent 进程启动时确定，
// 连接建立之后无法更改。
func buildOCIDSN(params connectParams) (string, error) {
	target := ociConnectTarget(params)
	if target == "" {
		return "", errors.New("OCI connection requires a host with a service name, or a TNS alias")
	}
	fields := []string{
		"connectString=" + ociLogfmtValue(target),
		"user=" + ociLogfmtValue(params.Username),
		"password=" + ociLogfmtValue(params.Password),
	}
	// 取数批量：OCI 需要同时给服务端预取提示与客户端取数数组大小。只设
	// prefetchRows 时 godror 仍按默认的 100 行一组取回，在高延迟链路上会明显变慢。
	fetchRows := ociFetchRows(params)
	fields = append(fields, "prefetchRows="+fetchRows, "fetchArraySize="+fetchRows)
	// 会话时区由客户端（OCI/NLS）确定，显式告知 godror 以本地时区换算，
	// 消除 “SESSIONTIMEZONE 与 SYSTIMESTAMP 不一致” 的告警。
	fields = append(fields, "timezone="+ociLogfmtValue("Local"))
	if params.SysDBA {
		fields = append(fields, "sysdba=1")
	}
	return strings.Join(fields, " "), nil
}

// ociFetchRows 返回每次往返取回的行数。
//
// 与 thin 路径共用连接参数里的 PREFETCH_ROWS（大小写不敏感），未配置时取
// oracleDefaultPrefetchRows，保持两种驱动的默认行为一致。
func ociFetchRows(params connectParams) string {
	for key, value := range parseURLParams(params.URLParams) {
		if strings.EqualFold(strings.TrimSpace(key), "PREFETCH_ROWS") {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return oracleDefaultPrefetchRows
}

// ociConnectTarget 返回 OCI 连接目标：完整连接描述符或 TNS 别名。
//
// 优先使用 DBX 下发的连接串（oci8 或 thin 形式，两种都按同一套规则解析），
// 没有连接串时退回 host + port + 服务名，保证手工构造的连接也能用。
func ociConnectTarget(params connectParams) string {
	info := parseOracleJDBCURL(params.ConnectionString)
	switch info.Kind {
	case "descriptor":
		return info.Descriptor
	case "tns":
		return info.Database
	case "service":
		return ociDescriptor(info.Host, info.Port, "SERVICE_NAME", info.Database)
	case "sid":
		return ociDescriptor(info.Host, info.Port, "SID", info.Database)
	}
	host := strings.TrimSpace(params.Host)
	database := strings.TrimSpace(params.Database)
	if host == "" || database == "" {
		return ""
	}
	port := params.Port
	if port <= 0 {
		port = 1521
	}
	return ociDescriptor(host, port, "SERVICE_NAME", database)
}

func ociDescriptor(host string, port int, key, value string) string {
	return fmt.Sprintf(
		"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=%s)(PORT=%d))(CONNECT_DATA=(%s=%s)))",
		host, port, key, value,
	)
}

// ociLogfmtValue 按 logfmt 规则给值加引号并转义反斜杠、引号与换行/制表符。
// 只做这些可预测的转义（不用 strconv.Quote 的 \xNN/\uNNNN 形式），
// 因为 godror 侧的解码器只认常见的反斜杠转义。
func ociLogfmtValue(value string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\r", `\r`,
		"\t", `\t`,
	)
	return `"` + replacer.Replace(value) + `"`
}
