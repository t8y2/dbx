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
	"bytes"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/godror/godror"
)

// ociBuildEnabled 报告当前二进制是否包含 OCI（thick）支持。
func ociBuildEnabled() bool { return true }

func plDebugNativeOCINumber(text string) (interface{}, error) { return godror.Number(text), nil }

func plDebugNativeOCILobInput(value plDebugLobInput, binary bool) (interface{}, error) {
	if binary {
		return godror.Lob{Reader: bytes.NewReader(value.binary)}, nil
	}
	return godror.Lob{Reader: strings.NewReader(value.text), IsClob: true}, nil
}

func newPLDebugOCILobOutput(binary bool) (*plDebugLobOutput, error) {
	value := &godror.Lob{IsClob: !binary}
	return &plDebugLobOutput{bind: sql.Out{Dest: value}, read: func(limit int) ([]byte, error) {
		if value.Reader == nil {
			return nil, errors.New("non-NULL LOB reader missing")
		}
		data, err := io.ReadAll(io.LimitReader(value.Reader, int64(limit)+1))
		if len(data) > limit {
			if binary {
				return data[:limit], errPLDebugLobBudget
			}
			return []byte(plDebugOutputPrefix(string(data), limit)), errPLDebugLobBudget
		}
		return data, err
	}, release: func() error {
		if value.Reader == nil {
			return nil
		}
		closer, ok := value.Reader.(io.Closer)
		if !ok {
			return errors.New("LOB reader cannot confirm release")
		}
		return closer.Close()
	}}, nil
}

func newPLDebugOCIClobOutput() (*plDebugClobOutput, error) {
	value := new(godror.Lob)
	value.IsClob = true
	return &plDebugClobOutput{bind: sql.Out{Dest: value}, read: func() (string, error) {
		if value.Reader == nil {
			return "", errors.New("no CLOB capture was returned")
		}
		data, err := io.ReadAll(io.LimitReader(value.Reader, plDebugNativeOutputBytes+1))
		if len(data) > plDebugNativeOutputBytes {
			return plDebugOutputPrefix(string(data), plDebugNativeOutputBytes), errPLDebugOutputLimit
		}
		return string(data), err
	}, release: func() error {
		if closer, ok := value.Reader.(io.Closer); ok {
			return closer.Close()
		}
		return nil
	}}, nil
}

func configurePLDebugOCIStatement(stmt driver.Stmt) error {
	checker, ok := stmt.(driver.NamedValueChecker)
	if !ok {
		return errors.New("OCI statement cannot apply NoRetry")
	}
	err := checker.CheckNamedValue(&driver.NamedValue{Value: godror.NoRetry()})
	if errors.Is(err, driver.ErrRemoveArgument) {
		return nil
	}
	if err == nil {
		return errors.New("OCI statement did not consume NoRetry")
	}
	return err
}

func newPLDebugOCIConnector(params connectParams) (driver.Connector, error) {
	dsn, err := buildOCIDSN(params)
	if err != nil {
		return nil, err
	}
	config, err := godror.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	config.StandaloneConnection = sql.NullBool{Bool: true, Valid: true}
	config.NoBreakOnContextCancel = true
	return godror.NewConnector(config), nil
}

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
