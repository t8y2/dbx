package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/jcmturner/krb5test"
)

type fixtureInfo struct {
	Realm              string `json:"realm"`
	Address            string `json:"address"`
	ConfigPath         string `json:"config_path"`
	KeytabPath         string `json:"keytab_path"`
	ClientPrincipal    string `json:"client_principal"`
	ServicePrincipal   string `json:"service_principal"`
	ZooKeeperPrincipal string `json:"zookeeper_principal"`
}

func main() {
	directory := flag.String("dir", "", "directory for generated Kerberos fixture files")
	flag.Parse()
	if *directory == "" {
		log.Fatal("-dir is required")
	}
	if err := os.MkdirAll(*directory, 0o700); err != nil {
		log.Fatal(err)
	}

	logger := log.New(os.Stderr, "kdc: ", log.LstdFlags)
	kdc, err := krb5test.NewKDC(map[string][]string{
		"alice":               nil,
		"hive/localhost":      nil,
		"zookeeper/localhost": nil,
	}, logger)
	if err != nil {
		log.Fatal(err)
	}
	kdc.KRB5Conf.LibDefaults.UDPPreferenceLimit = 1
	kdc.Start()
	defer kdc.Close()

	configPath := filepath.Join(*directory, "krb5.conf")
	keytabPath := filepath.Join(*directory, "fixture.keytab")
	config := fmt.Sprintf(`[libdefaults]
 default_realm = %s
 dns_lookup_realm = false
 dns_lookup_kdc = false
 rdns = false
 udp_preference_limit = 1
 default_tgs_enctypes = aes256-cts-hmac-sha1-96
 default_tkt_enctypes = aes256-cts-hmac-sha1-96
 permitted_enctypes = aes256-cts-hmac-sha1-96

[realms]
 %s = {
  kdc = %s
 }

[domain_realm]
 .localhost = %s
 localhost = %s
`, kdc.Realm, kdc.Realm, kdc.TCPListener.Addr().String(), kdc.Realm, kdc.Realm)
	if err := os.WriteFile(configPath, []byte(config), 0o644); err != nil {
		log.Fatal(err)
	}
	keytab, err := kdc.Keytab.Marshal()
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(keytabPath, keytab, 0o600); err != nil {
		log.Fatal(err)
	}
	info := fixtureInfo{
		Realm:              kdc.Realm,
		Address:            kdc.TCPListener.Addr().String(),
		ConfigPath:         configPath,
		KeytabPath:         keytabPath,
		ClientPrincipal:    "alice@" + kdc.Realm,
		ServicePrincipal:   "hive/localhost@" + kdc.Realm,
		ZooKeeperPrincipal: "zookeeper/localhost@" + kdc.Realm,
	}
	if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
		log.Fatal(err)
	}
	if err := os.Stdout.Sync(); err != nil {
		log.Fatal(err)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
}
