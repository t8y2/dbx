package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
	"github.com/gurkankaymak/hocon"
)

const javaDriverConfigPrefix = "datastax-java-driver."

func applyCassandraConfigFile(config *cassandraConfig, rawPath string) error {
	path, err := normalizeLocalFilePath(rawPath)
	if err != nil {
		return fmt.Errorf("invalid Cassandra configfile: %w", err)
	}
	if path == "" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read Cassandra configfile %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Cassandra configfile is not a regular file: %s", path)
	}
	parsed, err := hocon.ParseResource(path)
	if err != nil {
		return fmt.Errorf("parse Cassandra configfile %s: %w", path, err)
	}
	config.configFile = path
	if err := applyJavaDriverHOCON(config, parsed); err != nil {
		return fmt.Errorf("apply Cassandra configfile %s: %w", path, err)
	}
	return nil
}

func applyJavaDriverHOCON(config *cassandraConfig, parsed *hocon.Config) error {
	if value, ok, err := hoconDuration(parsed, javaDriverConfigPrefix+"basic.request.timeout"); err != nil {
		return err
	} else if ok {
		config.requestTimeout = value
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"basic.request.consistency"); err != nil {
		return err
	} else if ok {
		if _, err := gocql.ParseConsistencyWrapper(value); err != nil {
			return err
		}
		config.consistency = value
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"basic.request.serial-consistency"); err != nil {
		return err
	} else if ok {
		consistency, err := gocql.ParseConsistencyWrapper(value)
		if err != nil {
			return err
		}
		if consistency != gocql.Serial && consistency != gocql.LocalSerial {
			return fmt.Errorf("serial consistency must be SERIAL or LOCAL_SERIAL")
		}
		config.serialConsistency = value
	}
	if value, ok, err := hoconInt(parsed, javaDriverConfigPrefix+"basic.request.page-size"); err != nil {
		return err
	} else if ok {
		if value < 1 {
			return fmt.Errorf("page size must be positive")
		}
		config.pageSize = value
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"basic.load-balancing-policy.local-datacenter"); err != nil {
		return err
	} else if ok {
		config.localDatacenter = value
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"basic.load-balancing-policy.class"); err != nil {
		return err
	} else if ok {
		policy, err := normalizeLoadBalancingPolicy(value)
		if err != nil {
			return err
		}
		config.loadBalancingPolicy = policy
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"basic.cloud.secure-connect-bundle"); err != nil {
		return err
	} else if ok {
		config.secureConnectBundle = value
	}
	if value, ok, err := hoconDuration(parsed, javaDriverConfigPrefix+"advanced.connection.connect-timeout"); err != nil {
		return err
	} else if ok {
		config.connectTimeout = value
	}
	if value, ok, err := hoconInt(parsed, javaDriverConfigPrefix+"advanced.connection.pool.local.size"); err != nil {
		return err
	} else if ok {
		if value < 1 || value > 32 {
			return fmt.Errorf("connection pool local size must be between 1 and 32")
		}
		config.numConnections = value
	}
	if value, ok, err := hoconBool(parsed, javaDriverConfigPrefix+"advanced.socket.tcp-no-delay"); err != nil {
		return err
	} else if ok {
		config.tcpNoDelay = value
	}
	if value, ok, err := hoconBool(parsed, javaDriverConfigPrefix+"advanced.socket.keep-alive"); err != nil {
		return err
	} else if ok {
		config.keepAlive = value
	}
	if value, ok, err := hoconProtocolVersion(parsed, javaDriverConfigPrefix+"advanced.protocol.version"); err != nil {
		return err
	} else if ok {
		config.protocolVersion = value
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"advanced.retry-policy.class"); err != nil {
		return err
	} else if ok {
		policy, err := normalizeRetryPolicy(value)
		if err != nil {
			return err
		}
		config.retryPolicy = policy
	}
	if value, ok, err := hoconString(parsed, javaDriverConfigPrefix+"advanced.reconnection-policy.class"); err != nil {
		return err
	} else if ok {
		policy, baseDelay, maxDelay, err := parseReconnectionPolicy(value)
		if err != nil {
			return err
		}
		config.reconnectionPolicy = policy
		config.reconnectionBaseDelay = baseDelay
		config.reconnectionMaxDelay = maxDelay
	}
	if value, ok, err := hoconDuration(parsed, javaDriverConfigPrefix+"advanced.reconnection-policy.base-delay"); err != nil {
		return err
	} else if ok {
		config.reconnectionBaseDelay = value
	}
	if value, ok, err := hoconDuration(parsed, javaDriverConfigPrefix+"advanced.reconnection-policy.max-delay"); err != nil {
		return err
	} else if ok {
		config.reconnectionMaxDelay = value
	}
	if err := applyHOCONAuthentication(config, parsed); err != nil {
		return err
	}
	if err := applyHOCONSSL(config, parsed); err != nil {
		return err
	}
	return applyNativeHOCON(config, parsed)
}

func applyHOCONAuthentication(config *cassandraConfig, parsed *hocon.Config) error {
	prefix := javaDriverConfigPrefix + "advanced.auth-provider."
	if value, ok, err := hoconString(parsed, prefix+"class"); err != nil {
		return err
	} else if ok {
		switch strings.ToLower(simpleClassName(value)) {
		case "plaintextauthprovider", "dseplaintextauthprovider":
			config.kerberos.enabled = false
		case "kerberosauthprovider", "programmatickerberosauthprovider", "dsegssapiauthprovider":
			config.kerberos.enabled = true
		default:
			return fmt.Errorf("unsupported Cassandra auth provider class: %s", value)
		}
	}
	if value, ok, err := hoconString(parsed, prefix+"username"); err != nil {
		return err
	} else if ok {
		config.username = value
	}
	if value, ok, err := hoconString(parsed, prefix+"password"); err != nil {
		return err
	} else if ok {
		config.password = value
	}
	if value, ok, err := hoconString(parsed, prefix+"authorization-id"); err != nil {
		return err
	} else if ok {
		config.kerberos.authorizationID = value
	}
	for _, path := range []string{prefix + "sasl-protocol", prefix + "service"} {
		if value, ok, err := hoconString(parsed, path); err != nil {
			return err
		} else if ok {
			config.kerberos.serviceName = value
		}
	}
	if value, ok, err := hoconStringMap(parsed, prefix+"sasl-properties"); err != nil {
		return err
	} else if ok {
		for key, property := range value {
			if strings.EqualFold(key, "javax.security.sasl.qop") {
				config.kerberos.qop = property
			}
		}
	}
	if value, ok, err := hoconString(parsed, prefix+"server-name-resolver"); err != nil {
		return err
	} else if ok && value != "" {
		return fmt.Errorf("custom Java Kerberos server-name-resolver is not supported; use dbx.cassandra.kerberos.server-name")
	}
	loginPrefix := prefix + "login-configuration."
	if value, ok, err := hoconString(parsed, loginPrefix+"principal"); err != nil {
		return err
	} else if ok {
		config.kerberos.principal = value
	}
	if value, ok, err := firstHOCONString(parsed, loginPrefix+"keyTab", loginPrefix+"keytab"); err != nil {
		return err
	} else if ok {
		config.kerberos.keytabPath = value
	}
	if value, ok, err := firstHOCONString(parsed, loginPrefix+"ticketCache", loginPrefix+"ticket-cache"); err != nil {
		return err
	} else if ok {
		config.kerberos.ccachePath = value
	}
	if value, ok, err := firstHOCONBool(parsed, loginPrefix+"useKeyTab", loginPrefix+"use-keytab"); err != nil {
		return err
	} else if ok {
		config.kerberos.useKeytab = value
		config.kerberos.useKeytabSet = true
	}
	if value, ok, err := firstHOCONBool(parsed, loginPrefix+"useTicketCache", loginPrefix+"use-ticket-cache"); err != nil {
		return err
	} else if ok {
		config.kerberos.useTicketCache = value
		config.kerberos.useTicketCacheSet = true
	}
	return nil
}

func applyHOCONSSL(config *cassandraConfig, parsed *hocon.Config) error {
	prefix := javaDriverConfigPrefix + "advanced.ssl-engine-factory."
	if value, ok, err := hoconString(parsed, prefix+"class"); err != nil {
		return err
	} else if ok {
		if !strings.EqualFold(simpleClassName(value), "DefaultSslEngineFactory") {
			return fmt.Errorf("unsupported Cassandra SSL engine factory class: %s", value)
		}
		config.ssl = true
	}
	if value, ok, err := hoconBool(parsed, prefix+"hostname-validation"); err != nil {
		return err
	} else if ok {
		config.hostVerification = value
		config.ssl = true
	}
	for _, path := range []string{prefix + "truststore-path", prefix + "keystore-path"} {
		if value, ok, err := hoconString(parsed, path); err != nil {
			return err
		} else if ok && value != "" {
			return fmt.Errorf("Java truststore and keystore files are not supported; use dbx.cassandra.tls PEM paths")
		}
	}
	return nil
}

func applyNativeHOCON(config *cassandraConfig, parsed *hocon.Config) error {
	prefix := "dbx.cassandra."
	stringMappings := []struct {
		path   string
		target *string
	}{
		{"tls.ca-cert-path", &config.caCertPath},
		{"tls.client-cert-path", &config.clientCertPath},
		{"tls.client-key-path", &config.clientKeyPath},
		{"kerberos.config", &config.kerberos.configPath},
		{"kerberos.jaas-config", &config.kerberos.jaasConfigPath},
		{"kerberos.principal", &config.kerberos.principal},
		{"kerberos.realm", &config.kerberos.realm},
		{"kerberos.keytab", &config.kerberos.keytabPath},
		{"kerberos.ccache", &config.kerberos.ccachePath},
		{"kerberos.password", &config.kerberos.password},
		{"kerberos.service-name", &config.kerberos.serviceName},
		{"kerberos.server-name", &config.kerberos.serverName},
		{"kerberos.authorization-id", &config.kerberos.authorizationID},
		{"kerberos.qop", &config.kerberos.qop},
	}
	for _, mapping := range stringMappings {
		if value, ok, err := hoconString(parsed, prefix+mapping.path); err != nil {
			return err
		} else if ok {
			*mapping.target = value
		}
	}
	if value, ok, err := hoconBool(parsed, prefix+"tls.enabled"); err != nil {
		return err
	} else if ok {
		config.ssl = value
	}
	if value, ok, err := hoconBool(parsed, prefix+"tls.hostname-verification"); err != nil {
		return err
	} else if ok {
		config.hostVerification = value
	}
	if value, ok, err := hoconBool(parsed, prefix+"kerberos.enabled"); err != nil {
		return err
	} else if ok {
		config.kerberos.enabled = value
	}
	if value, ok, err := hoconBool(parsed, prefix+"kerberos.disable-pafxfast"); err != nil {
		return err
	} else if ok {
		config.kerberos.disablePAFXFAST = value
	}
	if value, ok, err := hoconBool(parsed, prefix+"kerberos.use-keytab"); err != nil {
		return err
	} else if ok {
		config.kerberos.useKeytab = value
		config.kerberos.useKeytabSet = true
	}
	if value, ok, err := hoconBool(parsed, prefix+"kerberos.use-ticket-cache"); err != nil {
		return err
	} else if ok {
		config.kerberos.useTicketCache = value
		config.kerberos.useTicketCacheSet = true
	}
	return nil
}

func normalizeLocalFilePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if strings.Contains(value, "://") || strings.HasPrefix(strings.ToLower(value), "file:") {
		parsed, err := url.Parse(value)
		if err != nil {
			return "", err
		}
		if parsed.Scheme != "file" {
			return "", fmt.Errorf("unsupported file URI scheme: %s", parsed.Scheme)
		}
		if parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost") {
			return "", fmt.Errorf("remote file URI hosts are not supported: %s", parsed.Host)
		}
		value, err = url.PathUnescape(parsed.Path)
		if err != nil {
			return "", err
		}
		if runtime.GOOS == "windows" && len(value) >= 3 && value[0] == '/' && value[2] == ':' {
			value = value[1:]
		}
	}
	return filepath.Clean(filepath.FromSlash(value)), nil
}

func hoconString(config *hocon.Config, path string) (string, bool, error) {
	if config.Get(path) == nil {
		return "", false, nil
	}
	value, err := config.GetStringE(path)
	if err != nil {
		return "", false, fmt.Errorf("invalid %s: %w", path, err)
	}
	return strings.TrimSpace(value), true, nil
}

func firstHOCONString(config *hocon.Config, paths ...string) (string, bool, error) {
	for _, path := range paths {
		value, ok, err := hoconString(config, path)
		if err != nil || ok {
			return value, ok, err
		}
	}
	return "", false, nil
}

func hoconStringMap(config *hocon.Config, path string) (map[string]string, bool, error) {
	if config.Get(path) == nil {
		return nil, false, nil
	}
	value, err := config.GetStringMapStringE(path)
	if err != nil {
		return nil, false, fmt.Errorf("invalid %s: %w", path, err)
	}
	return value, true, nil
}

func hoconDuration(config *hocon.Config, path string) (time.Duration, bool, error) {
	if config.Get(path) == nil {
		return 0, false, nil
	}
	value, err := config.GetDurationE(path)
	if err != nil {
		return 0, false, fmt.Errorf("invalid %s: %w", path, err)
	}
	return value, true, nil
}

func hoconInt(config *hocon.Config, path string) (int, bool, error) {
	if config.Get(path) == nil {
		return 0, false, nil
	}
	value, err := config.GetIntE(path)
	if err != nil {
		return 0, false, fmt.Errorf("invalid %s: %w", path, err)
	}
	return value, true, nil
}

func hoconBool(config *hocon.Config, path string) (bool, bool, error) {
	value := config.Get(path)
	if value == nil {
		return false, false, nil
	}
	switch typed := value.(type) {
	case hocon.Boolean:
		return bool(typed), true, nil
	case hocon.String:
		parsed, err := strconv.ParseBool(string(typed))
		if err != nil {
			return false, false, fmt.Errorf("invalid %s: %w", path, err)
		}
		return parsed, true, nil
	default:
		return false, false, fmt.Errorf("invalid %s: expected boolean", path)
	}
}

func firstHOCONBool(config *hocon.Config, paths ...string) (bool, bool, error) {
	for _, path := range paths {
		value, ok, err := hoconBool(config, path)
		if err != nil || ok {
			return value, ok, err
		}
	}
	return false, false, nil
}

func hoconProtocolVersion(config *hocon.Config, path string) (int, bool, error) {
	value := config.Get(path)
	if value == nil {
		return 0, false, nil
	}
	var raw string
	switch typed := value.(type) {
	case hocon.Int:
		raw = strconv.Itoa(int(typed))
	case hocon.String:
		raw = string(typed)
	default:
		return 0, false, fmt.Errorf("invalid %s: expected V3, V4, or V5", path)
	}
	raw = strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(raw)), "V")
	version, err := strconv.Atoi(raw)
	if err != nil || version < 3 || version > 5 {
		return 0, false, fmt.Errorf("invalid %s: expected V3, V4, or V5", path)
	}
	return version, true, nil
}
