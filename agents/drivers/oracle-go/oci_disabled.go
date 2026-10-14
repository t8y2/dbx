//go:build !oci

package main

import (
	"database/sql"
	"errors"
)

// ociBuildEnabled 报告当前二进制是否包含 OCI（thick）支持：
// thin 版本（默认构建，跨平台、CGO_ENABLED=0）不包含。
func ociBuildEnabled() bool { return false }

// openOCIDB 在未带 `oci` 构建标记的二进制里给出明确错误。
//
// 连接级错误会原样回传前端，因此这里说明清楚该装哪个驱动，而不是抛出一个
// 难以理解的驱动缺失错误。
func openOCIDB(params connectParams) (*sql.DB, error) {
	return nil, errors.New(
		"this Oracle agent build does not include OCI support; install the oracle-oci driver (Windows) to use the OCI (thick) mode",
	)
}
