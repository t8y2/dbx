//go:build windows

package krb5

import (
	"os"
	"path/filepath"
)

func defaultKrbConfFile() string {
	if windowsDirectory := os.Getenv("WINDIR"); windowsDirectory != "" {
		return filepath.Join(windowsDirectory, "krb5.ini")
	}
	return `C:\Windows\krb5.ini`
}

func defaultKrbCCFile() string {
	return ""
}

func defaultKrbKTFile() string {
	return ""
}
