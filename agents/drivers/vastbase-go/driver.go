package main

import (
	"database/sql"
	"net/url"
	"strings"

	_ "gitcode.com/opengauss/openGauss-connector-go-pq"
)

const (
	agentKey           = "vastbase"
	agentSQLDriverName = "opengauss"
	agentDefaultPort   = 5432
	agentDriverName    = "openGauss-connector-go-pq"
	agentDriverVersion = "v1.0.8"
)

type nativeURLParameter struct {
	Key   string
	Value string
}

var vastbaseDataTypes = append(append([]string{}, postgresDataTypes...),
	"floatvector", "halfvector", "int8vector", "sparsevector",
)

func agentDataTypes() []string {
	return vastbaseDataTypes
}

func detectAgentMode(_ *sql.DB, configuredMySQL bool) vastbaseMode {
	if configuredMySQL {
		return vastbaseMode{compatibilityMode: "mysql", mysqlCompat: true, postgresCatalog: true}
	}
	return vastbaseMode{compatibilityMode: "postgres", postgresCatalog: true}
}

func agentSSLModeAttempts(sslMode string) []string {
	return []string{sslMode}
}

func agentInitialSSLMode(sslMode string) string {
	return sslMode
}

func agentSSLNotSupported(error) bool {
	return false
}

func isAgentJDBCURL(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(normalized, "jdbc:vastbase://") || strings.HasPrefix(normalized, "jdbc:postgresql://")
}

func isAgentNativeURL(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(normalized, "postgres://") || strings.HasPrefix(normalized, "postgresql://")
}

func normalizeAgentObjectSource(source string) string {
	trimmed := strings.TrimSpace(source)
	if !strings.HasPrefix(trimmed, "(") || !strings.HasSuffix(trimmed, ")") {
		return source
	}
	inner := trimmed[1 : len(trimmed)-1]
	if comma := strings.IndexByte(inner, ','); comma > 0 {
		inner = strings.TrimSpace(inner[comma+1:])
	}
	if len(inner) >= 2 && inner[0] == '"' && inner[len(inner)-1] == '"' {
		inner = strings.ReplaceAll(inner[1:len(inner)-1], `""`, `"`)
	}
	return strings.TrimSpace(inner)
}

func nativeURLParams(raw string) []nativeURLParameter {
	parameters := make([]nativeURLParameter, 0)
	for _, pair := range strings.FieldsFunc(raw, func(r rune) bool { return r == '&' || r == ';' }) {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if decoded, err := url.QueryUnescape(key); err == nil {
			key = decoded
		}
		if decoded, err := url.QueryUnescape(value); err == nil {
			value = decoded
		}
		if !isSafeParamKey(key) {
			continue
		}
		normalizedKey, normalizedValue, include := nativeURLParam(key, value)
		if include {
			parameters = append(parameters, nativeURLParameter{Key: normalizedKey, Value: normalizedValue})
		}
	}
	return parameters
}

func nativeURLParam(key, value string) (string, string, bool) {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "ssl":
		if strings.EqualFold(value, "true") || value == "1" {
			return "sslmode", "require", true
		}
		return "sslmode", "disable", true
	case "sslmode":
		if strings.EqualFold(value, "enable") {
			value = "require"
		}
		return "sslmode", strings.ToLower(value), true
	case "targetservertype":
		switch strings.ToLower(value) {
		case "master", "primary":
			value = "primary"
		case "slave", "secondary":
			value = "standby"
		case "preferslave", "prefersecondary", "prefer-standby":
			value = "prefer-standby"
		default:
			value = "any"
		}
		return "target_session_attrs", value, true
	case "connecttimeout", "logintimeout":
		return "connect_timeout", value, true
	case "applicationname":
		return "application_name", value, true
	case "currentschema":
		return "search_path", value, true
	case "loggerlevel":
		return "loggerLevel", value, true
	case "autosave", "enable_ce", "db_compatibility", "loadbalancehosts", "autobalance",
		"protocolversion", "preparethreshold", "preparedstatementcachequeries",
		"databasemetadatacachefields", "databasemetadatacachefieldsmib", "stringtype",
		"batchmode", "fetchsize", "defaultrowfetchsize", "rewritebatchedinserts", "unknownlength",
		"sockettimeout", "sockettimeoutinconnecting", "socketfactory", "socketfactoryarg",
		"sslfactory", "sslfactoryarg", "sslhostnameverifier", "loggerfile", "loggerdir",
		"tlcp", "sslenccert", "sslenckey", "connectionextrainfo", "nvarchartype":
		return "", "", false
	default:
		return strings.TrimSpace(key), value, true
	}
}
