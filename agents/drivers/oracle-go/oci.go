//go:build oci

// Oracle OCI（thick）支持。
//
// 这个文件只在带上 `oci` 构建标记时参与编译（目前只发布 Windows 版）：
// godror 通过 CGO 调用 Oracle 客户端，构建期需要 Instant Client 的 SDK
// （头文件 + 导入库），运行期只需要 oci.dll —— 由 DBX 注入的 PATH 定位。
// thin 版本（CGO_ENABLED=0，跨平台）不包含这个文件，也不会引入任何原生依赖。
//
// 连接串构造在 oci_dsn.go（无构建标记，CI 的常规测试会覆盖）。

package main

import (
	"database/sql"
	"time"

	_ "github.com/godror/godror"
)

// ociBuildEnabled 报告当前二进制是否包含 OCI（thick）支持。
func ociBuildEnabled() bool { return true }

// openOCIDB 用 godror（OCI thick 模式）建立连接。
//
// 连接池参数与 thin 路径保持一致，避免两种驱动在会话数上出现差异。
func openOCIDB(params connectParams) (*sql.DB, error) {
	dsn, err := buildOCIDSN(params)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("godror", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	return db, nil
}
