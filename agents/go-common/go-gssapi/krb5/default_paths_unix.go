//go:build !windows

package krb5

import (
	"fmt"
	"os"
)

func defaultKrbConfFile() string {
	return "/etc/krb5.conf"
}

func defaultKrbCCFile() string {
	return fmt.Sprintf("/tmp/krb5cc_%d", os.Getuid())
}

func defaultKrbKTFile() string {
	return fmt.Sprintf("/var/kerberos/krb5/user/%d/client.keytab", os.Getuid())
}
