//go:build !windows

package main

import "testing"

func TestSystemLocaleNamePrefersDateCategory(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_TIME", "zh_CN.UTF-8")
	t.Setenv("LANG", "en_US.UTF-8")
	t.Setenv("LC_MESSAGES", "de_DE.UTF-8")
	if actual := systemLocaleName(); actual != "zh_CN.UTF-8" {
		t.Fatalf("systemLocaleName() = %q, want the LC_TIME value", actual)
	}

	t.Setenv("LC_ALL", "ja_JP.UTF-8")
	if actual := systemLocaleName(); actual != "ja_JP.UTF-8" {
		t.Fatalf("systemLocaleName() = %q, want the LC_ALL value", actual)
	}

	t.Setenv("LC_ALL", "")
	t.Setenv("LC_TIME", "")
	if actual := systemLocaleName(); actual != "en_US.UTF-8" {
		t.Fatalf("systemLocaleName() = %q, want the LANG value", actual)
	}
}
