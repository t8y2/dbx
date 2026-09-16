package main

import (
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
	"github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/v8/asn1tools"
	krb5client "github.com/jcmturner/gokrb5/v8/client"
	krb5config "github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/credentials"
	"github.com/jcmturner/gokrb5/v8/gssapi"
	"github.com/jcmturner/gokrb5/v8/iana/chksumtype"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/types"
)

const (
	kerberosAPRequestTokenID = 0x0100
	kerberosGSSAPITag        = 0x60
	kerberosSecurityNone     = 0x01
)

type kerberosCredentialMode int

const (
	kerberosCredentialNone kerberosCredentialMode = iota
	kerberosCredentialPassword
	kerberosCredentialKeytab
	kerberosCredentialCCache
)

type kerberosConfig struct {
	enabled           bool
	configPath        string
	jaasConfigPath    string
	principal         string
	realm             string
	keytabPath        string
	ccachePath        string
	password          string
	serviceName       string
	serverName        string
	authorizationID   string
	qop               string
	disablePAFXFAST   bool
	useKeytab         bool
	useKeytabSet      bool
	useTicketCache    bool
	useTicketCacheSet bool
	credentialMode    kerberosCredentialMode
	credentialUser    string
	credentialRealm   string
}

type kerberosAuthenticator struct {
	domain          string
	clientName      types.PrincipalName
	ticket          messages.Ticket
	sessionKey      types.EncryptionKey
	authorizationID string
	step            int
}

var (
	jaasBlockPattern  = regexp.MustCompile(`(?is)\bCassandraJavaClient\s*\{(.*?)\}\s*;`)
	jaasModulePattern = regexp.MustCompile(`(?is)\bcom\.sun\.security\.auth\.module\.Krb5LoginModule\b(.*?);`)
	jaasOptionPattern = regexp.MustCompile(`(?is)([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))`)
)

func defaultKerberosConfig() kerberosConfig {
	return kerberosConfig{
		serviceName: "cassandra",
		qop:         "auth",
	}
}

func (config *kerberosConfig) finalize(username, password string) error {
	config.applyJavaSystemProperties()
	if config.jaasConfigPath != "" {
		path, err := normalizeLocalFilePath(config.jaasConfigPath)
		if err != nil {
			return fmt.Errorf("invalid Cassandra JAAS config path: %w", err)
		}
		config.jaasConfigPath = path
		if err := config.applyJAASConfig(path); err != nil {
			return err
		}
	}
	config.applyKerberosConfigEnvironment()
	if config.configPath == "" {
		config.configPath = defaultKerberosConfigPath()
	}
	path, err := normalizeLocalFilePath(firstPathListEntry(config.configPath))
	if err != nil {
		return fmt.Errorf("invalid Kerberos config path: %w", err)
	}
	config.configPath = path
	if err := requireRegularFile("Kerberos config", config.configPath); err != nil {
		return err
	}
	krbConfig, err := krb5config.Load(config.configPath)
	if err != nil {
		return fmt.Errorf("load Kerberos config %s: %w", config.configPath, err)
	}
	if config.serviceName == "" {
		config.serviceName = "cassandra"
	}
	if !kerberosQOPIncludesAuth(config.qop) {
		return fmt.Errorf("Cassandra Kerberos currently supports SASL QOP auth only, got %s", config.qop)
	}
	config.qop = "auth"
	if config.principal == "" {
		config.principal = strings.TrimSpace(username)
	}
	if config.password == "" {
		config.password = password
	}
	if config.useTicketCache {
		return config.selectCCacheCredential()
	}
	if config.useKeytab {
		return config.selectKeytabCredential(krbConfig)
	}
	if config.ccachePath != "" && !config.useTicketCacheSet {
		return config.selectCCacheCredential()
	}
	if config.keytabPath != "" && !config.useKeytabSet {
		return config.selectKeytabCredential(krbConfig)
	}
	if config.principal != "" && config.password != "" {
		config.credentialUser, config.credentialRealm, err = splitKerberosPrincipal(
			config.principal,
			config.realm,
			krbConfig.LibDefaults.DefaultRealm,
		)
		if err != nil {
			return err
		}
		config.credentialMode = kerberosCredentialPassword
		return nil
	}
	if !config.useTicketCacheSet {
		config.ccachePath = os.Getenv("KRB5CCNAME")
		if config.ccachePath == "" {
			defaultCache := defaultKerberosCCachePath()
			if path, normalizeErr := normalizeKerberosCachePath(defaultCache); normalizeErr == nil {
				if info, statErr := os.Stat(path); statErr == nil && info.Mode().IsRegular() {
					config.ccachePath = defaultCache
				}
			}
		}
		if config.ccachePath != "" {
			return config.selectCCacheCredential()
		}
	}
	if !config.useKeytabSet {
		config.keytabPath = firstNonEmpty(os.Getenv("KRB5_CLIENT_KTNAME"), os.Getenv("KRB5_KTNAME"))
		if config.keytabPath != "" {
			return config.selectKeytabCredential(krbConfig)
		}
	}
	return fmt.Errorf("Kerberos authentication requires a credential cache, keytab, or principal and password")
}

func (config *kerberosConfig) selectCCacheCredential() error {
	var err error
	if config.ccachePath == "" {
		config.ccachePath = defaultKerberosCCachePath()
	}
	config.ccachePath, err = normalizeKerberosCachePath(config.ccachePath)
	if err != nil {
		return err
	}
	if err := requireRegularFile("Kerberos credential cache", config.ccachePath); err != nil {
		return err
	}
	config.credentialMode = kerberosCredentialCCache
	return nil
}

func (config *kerberosConfig) selectKeytabCredential(krbConfig *krb5config.Config) error {
	var err error
	if config.keytabPath == "" {
		config.keytabPath = firstNonEmpty(os.Getenv("KRB5_CLIENT_KTNAME"), os.Getenv("KRB5_KTNAME"))
		if config.keytabPath == "" {
			return fmt.Errorf("Kerberos keytab authentication requires a keytab path")
		}
	}
	config.keytabPath, err = normalizeKerberosFileReference(config.keytabPath)
	if err != nil {
		return err
	}
	if err := requireRegularFile("Kerberos keytab", config.keytabPath); err != nil {
		return err
	}
	if config.principal == "" {
		config.principal, err = principalFromKeytab(config.keytabPath)
		if err != nil {
			return err
		}
	}
	config.credentialUser, config.credentialRealm, err = splitKerberosPrincipal(
		config.principal,
		config.realm,
		krbConfig.LibDefaults.DefaultRealm,
	)
	if err != nil {
		return err
	}
	config.credentialMode = kerberosCredentialKeytab
	return nil
}

func newKerberosAuthProvider(
	config kerberosConfig,
	username string,
	password string,
) (func(*gocql.HostInfo) (gocql.Authenticator, error), error) {
	if !config.enabled {
		return nil, fmt.Errorf("Kerberos authentication is not enabled")
	}
	if config.credentialMode == kerberosCredentialNone {
		if err := config.finalize(username, password); err != nil {
			return nil, err
		}
	}
	krbConfig, err := krb5config.Load(config.configPath)
	if err != nil {
		return nil, fmt.Errorf("load Kerberos config %s: %w", config.configPath, err)
	}
	return func(host *gocql.HostInfo) (gocql.Authenticator, error) {
		return newKerberosAuthenticator(config, krbConfig, host)
	}, nil
}

func newKerberosAuthenticator(
	config kerberosConfig,
	krbConfig *krb5config.Config,
	host *gocql.HostInfo,
) (gocql.Authenticator, error) {
	client, err := newKerberosClient(config, krbConfig)
	if err != nil {
		return nil, err
	}
	if err := client.Login(); err != nil {
		client.Destroy()
		return nil, fmt.Errorf("Kerberos login failed: %w", err)
	}
	serverName, err := kerberosServerName(config, host)
	if err != nil {
		client.Destroy()
		return nil, err
	}
	servicePrincipal := config.serviceName + "/" + serverName
	ticket, sessionKey, err := client.GetServiceTicket(servicePrincipal)
	if err != nil {
		client.Destroy()
		return nil, fmt.Errorf("get Kerberos service ticket for %s: %w", servicePrincipal, err)
	}
	clientName := client.Credentials.CName()
	clientName.NameString = append([]string(nil), clientName.NameString...)
	authenticator := &kerberosAuthenticator{
		domain:          strings.Clone(client.Credentials.Domain()),
		clientName:      clientName,
		ticket:          ticket,
		sessionKey:      sessionKey,
		authorizationID: config.authorizationID,
	}
	client.Destroy()
	return authenticator, nil
}

func newKerberosClient(config kerberosConfig, krbConfig *krb5config.Config) (*krb5client.Client, error) {
	settings := []func(*krb5client.Settings){krb5client.DisablePAFXFAST(config.disablePAFXFAST)}
	switch config.credentialMode {
	case kerberosCredentialCCache:
		cache, err := credentials.LoadCCache(config.ccachePath)
		if err != nil {
			return nil, fmt.Errorf("load Kerberos credential cache %s: %w", config.ccachePath, err)
		}
		client, err := krb5client.NewFromCCache(cache, krbConfig, settings...)
		if err != nil {
			return nil, fmt.Errorf("create Kerberos client from credential cache: %w", err)
		}
		return client, nil
	case kerberosCredentialKeytab:
		loadedKeytab, err := keytab.Load(config.keytabPath)
		if err != nil {
			return nil, fmt.Errorf("load Kerberos keytab %s: %w", config.keytabPath, err)
		}
		return krb5client.NewWithKeytab(
			config.credentialUser,
			config.credentialRealm,
			loadedKeytab,
			krbConfig,
			settings...,
		), nil
	case kerberosCredentialPassword:
		return krb5client.NewWithPassword(
			config.credentialUser,
			config.credentialRealm,
			config.password,
			krbConfig,
			settings...,
		), nil
	default:
		return nil, fmt.Errorf("Kerberos credentials are not configured")
	}
}

func (authenticator *kerberosAuthenticator) Challenge(request []byte) ([]byte, gocql.Authenticator, error) {
	switch authenticator.step {
	case 0:
		token, err := authenticator.initialToken()
		if err != nil {
			return nil, nil, err
		}
		authenticator.step = 1
		return token, authenticator, nil
	case 1:
		token, err := authenticator.securityLayerResponse(request)
		if err != nil {
			return nil, nil, err
		}
		authenticator.step = 2
		return token, authenticator, nil
	default:
		return nil, nil, fmt.Errorf("unexpected Cassandra Kerberos authentication challenge")
	}
}

func (authenticator *kerberosAuthenticator) Success(_ []byte) error {
	if authenticator.step != 2 {
		return fmt.Errorf("Cassandra reported Kerberos success before SASL negotiation completed")
	}
	return nil
}

func (authenticator *kerberosAuthenticator) initialToken() ([]byte, error) {
	value, err := types.NewAuthenticator(authenticator.domain, authenticator.clientName)
	if err != nil {
		return nil, err
	}
	value.Cksum = types.Checksum{
		CksumType: chksumtype.GSSAPI,
		Checksum:  kerberosAuthenticatorChecksum(),
	}
	request, err := messages.NewAPReq(authenticator.ticket, authenticator.sessionKey, value)
	if err != nil {
		return nil, err
	}
	payload := make([]byte, 2)
	binary.BigEndian.PutUint16(payload, kerberosAPRequestTokenID)
	encodedRequest, err := request.Marshal()
	if err != nil {
		return nil, err
	}
	payload = append(payload, encodedRequest...)
	encodedOID, err := asn1.Marshal(gssapi.OIDKRB5.OID())
	if err != nil {
		return nil, err
	}
	header := append([]byte{kerberosGSSAPITag}, asn1tools.MarshalLengthBytes(len(encodedOID)+len(payload))...)
	header = append(header, encodedOID...)
	return append(header, payload...), nil
}

func (authenticator *kerberosAuthenticator) securityLayerResponse(challenge []byte) ([]byte, error) {
	var request gssapi.WrapToken
	if err := request.Unmarshal(challenge, true); err != nil {
		return nil, fmt.Errorf("decode Kerberos SASL security-layer challenge: %w", err)
	}
	valid, err := request.Verify(authenticator.sessionKey, keyusage.GSSAPI_ACCEPTOR_SEAL)
	if err != nil {
		return nil, fmt.Errorf("verify Kerberos SASL security-layer challenge: %w", err)
	}
	if !valid {
		return nil, fmt.Errorf("invalid Kerberos SASL security-layer challenge")
	}
	if len(request.Payload) < 4 || request.Payload[0]&kerberosSecurityNone == 0 {
		return nil, fmt.Errorf("Cassandra Kerberos server does not allow SASL QOP auth")
	}
	payload := []byte{kerberosSecurityNone, 0, 0, 0}
	payload = append(payload, authenticator.authorizationID...)
	response, err := gssapi.NewInitiatorWrapToken(payload, authenticator.sessionKey)
	if err != nil {
		return nil, err
	}
	return response.Marshal()
}

func kerberosAuthenticatorChecksum() []byte {
	checksum := make([]byte, 24)
	binary.LittleEndian.PutUint32(checksum[:4], 16)
	flags := uint32(gssapi.ContextFlagInteg | gssapi.ContextFlagConf)
	binary.LittleEndian.PutUint32(checksum[20:24], flags)
	return checksum
}

func kerberosQOPIncludesAuth(value string) bool {
	for _, qop := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(qop), "auth") {
			return true
		}
	}
	return false
}

func kerberosServerName(config kerberosConfig, host *gocql.HostInfo) (string, error) {
	if config.serverName != "" {
		return strings.TrimSuffix(strings.TrimSpace(config.serverName), "."), nil
	}
	if host == nil {
		return "", fmt.Errorf("resolve Kerberos server name: Cassandra host is unavailable")
	}
	address := host.ConnectAddress()
	if address != nil {
		names, err := net.LookupAddr(address.String())
		if err == nil && len(names) > 0 {
			return strings.TrimSuffix(strings.TrimSpace(names[0]), "."), nil
		}
	}
	hostname, _, err := net.SplitHostPort(host.HostnameAndPort())
	if err == nil && hostname != "" && net.ParseIP(hostname) == nil {
		return strings.TrimSuffix(hostname, "."), nil
	}
	return "", fmt.Errorf("resolve Kerberos server name for Cassandra host %s; configure kerberosservername explicitly", host.ConnectAddressAndPort())
}

func (config *kerberosConfig) applyJavaSystemProperties() {
	if config.jaasConfigPath == "" {
		config.jaasConfigPath = javaSystemProperty("java.security.auth.login.config")
	}
	if config.configPath == "" {
		config.configPath = javaSystemProperty("java.security.krb5.conf")
	}
}

func (config *kerberosConfig) applyKerberosConfigEnvironment() {
	if config.configPath == "" {
		config.configPath = os.Getenv("KRB5_CONFIG")
	}
}

func (config *kerberosConfig) applyJAASConfig(path string) error {
	contents, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read Cassandra JAAS config %s: %w", path, err)
	}
	block := jaasBlockPattern.FindSubmatch(contents)
	if len(block) != 2 {
		return fmt.Errorf("Cassandra JAAS config %s does not contain CassandraJavaClient", path)
	}
	module := jaasModulePattern.FindSubmatch(block[1])
	if len(module) != 2 {
		return fmt.Errorf("CassandraJavaClient in %s does not configure Krb5LoginModule", path)
	}
	options := map[string]string{}
	for _, match := range jaasOptionPattern.FindAllSubmatch(module[1], -1) {
		value := firstNonEmpty(string(match[2]), string(match[3]), string(match[4]))
		options[strings.ToLower(string(match[1]))] = value
	}
	if config.principal == "" {
		config.principal = options["principal"]
	}
	if config.keytabPath == "" {
		config.keytabPath = options["keytab"]
	}
	if config.ccachePath == "" {
		config.ccachePath = options["ticketcache"]
	}
	if value, ok := options["usekeytab"]; ok {
		config.useKeytab, err = strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("invalid useKeyTab in Cassandra JAAS config: %w", err)
		}
		config.useKeytabSet = true
	}
	if value, ok := options["useticketcache"]; ok {
		config.useTicketCache, err = strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("invalid useTicketCache in Cassandra JAAS config: %w", err)
		}
		config.useTicketCacheSet = true
	}
	return nil
}

func javaSystemProperty(name string) string {
	pattern := regexp.MustCompile(`(?:^|\s)-D` + regexp.QuoteMeta(name) + `=(?:"([^"]*)"|'([^']*)'|(\S+))`)
	for _, environmentName := range []string{"JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS"} {
		match := pattern.FindStringSubmatch(os.Getenv(environmentName))
		if len(match) == 4 {
			return firstNonEmpty(match[1], match[2], match[3])
		}
	}
	return ""
}

func normalizeKerberosCachePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("Kerberos ticket cache path is empty")
	}
	if separator := strings.IndexByte(value, ':'); separator > 0 && !isWindowsDrivePath(value) {
		cacheType := strings.ToUpper(value[:separator])
		if cacheType != "FILE" {
			return "", fmt.Errorf("Kerberos credential cache type %s is not supported; use a FILE cache or keytab", cacheType)
		}
		value = value[separator+1:]
	}
	path, err := normalizeLocalFilePath(value)
	if err != nil {
		return "", fmt.Errorf("invalid Kerberos credential cache path: %w", err)
	}
	return path, nil
}

func isWindowsDrivePath(value string) bool {
	return len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) &&
		value[1] == ':' && (value[2] == '\\' || value[2] == '/')
}

func normalizeKerberosFileReference(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToUpper(value), "FILE:") {
		value = value[5:]
	}
	path, err := normalizeLocalFilePath(value)
	if err != nil {
		return "", fmt.Errorf("invalid Kerberos file path: %w", err)
	}
	return path, nil
}

func splitKerberosPrincipal(principal, configuredRealm, defaultRealm string) (string, string, error) {
	value := strings.TrimSpace(principal)
	realm := strings.TrimSpace(configuredRealm)
	if separator := strings.LastIndexByte(value, '@'); separator >= 0 {
		realm = value[separator+1:]
		value = value[:separator]
	}
	if value == "" {
		return "", "", fmt.Errorf("Kerberos principal is empty")
	}
	if realm == "" {
		realm = strings.TrimSpace(defaultRealm)
	}
	if realm == "" {
		return "", "", fmt.Errorf("Kerberos realm is required for principal %s", principal)
	}
	return value, realm, nil
}

func principalFromKeytab(path string) (string, error) {
	loadedKeytab, err := keytab.Load(path)
	if err != nil {
		return "", fmt.Errorf("load Kerberos keytab %s: %w", path, err)
	}
	principals := map[string]struct{}{}
	for _, entry := range loadedKeytab.Entries {
		principals[entry.Principal.String()] = struct{}{}
	}
	if len(principals) != 1 {
		return "", fmt.Errorf("Kerberos keytab %s contains %d principals; configure kerberosprincipal explicitly", path, len(principals))
	}
	for principal := range principals {
		return principal, nil
	}
	return "", fmt.Errorf("Kerberos keytab %s contains no principals", path)
}

func defaultKerberosConfigPath() string {
	if runtime.GOOS == "windows" {
		if windowsDirectory := os.Getenv("WINDIR"); windowsDirectory != "" {
			return filepath.Join(windowsDirectory, "krb5.ini")
		}
	}
	return "/etc/krb5.conf"
}

func defaultKerberosCCachePath() string {
	if value := os.Getenv("KRB5CCNAME"); value != "" {
		return value
	}
	currentUser, err := user.Current()
	if err == nil && currentUser.Uid != "" {
		return filepath.Join(os.TempDir(), "krb5cc_"+currentUser.Uid)
	}
	return ""
}

func firstPathListEntry(value string) string {
	entries := filepath.SplitList(value)
	if len(entries) == 0 {
		return value
	}
	return entries[0]
}

func requireRegularFile(label, path string) error {
	if path == "" {
		return fmt.Errorf("%s path is empty", label)
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("read %s %s: %w", label, path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file: %s", label, path)
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
