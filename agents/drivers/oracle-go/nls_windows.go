//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// LOCALE_NAME_MAX_LENGTH from winnls.h, including the terminating null.
const localeNameMaxLength = 85

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	getUserDefaultLocaleName = kernel32.NewProc("GetUserDefaultLocaleName")
)

func systemLocaleName() string {
	buffer := make([]uint16, localeNameMaxLength)
	length, _, _ := getUserDefaultLocaleName.Call(
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)
	if length == 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer[:length-1])
}
