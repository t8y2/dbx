//go:build !windows

package main

import (
	"fmt"
	"os"
)

func defaultKerberosConfigPath() string {
	return "/etc/krb5.conf"
}

func defaultKerberosCCachePath() string {
	return fmt.Sprintf("/tmp/krb5cc_%d", os.Getuid())
}
