//go:build windows

package main

import "testing"

func TestSystemLocaleNameReportsWindowsLocale(t *testing.T) {
	if name := systemLocaleName(); name == "" {
		t.Fatal("systemLocaleName() = \"\", want the Windows user locale")
	}
}
