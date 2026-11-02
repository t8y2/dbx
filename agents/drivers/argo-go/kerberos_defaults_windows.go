//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func defaultKerberosConfigPath() string {
	if windowsDirectory := os.Getenv("WINDIR"); windowsDirectory != "" {
		return filepath.Join(windowsDirectory, "krb5.ini")
	}
	return `C:\Windows\krb5.ini`
}

func defaultKerberosCCachePath() string {
	return ""
}
