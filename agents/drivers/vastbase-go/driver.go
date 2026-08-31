package main

import (
	"context"
	"database/sql"
	"net/url"
	"strings"
	"time"

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

type vastbaseCompatibility struct {
	mode                      string
	raw                       string
	mysqlCompat               bool
	sqlServer                 bool
	supportsDisableConstraint bool
}

func normalizeVastbaseCompatibility(raw string) vastbaseCompatibility {
	normalizedRaw := strings.ToUpper(strings.TrimSpace(raw))
	compact := strings.NewReplacer("_", "", "-", "", " ", "").Replace(normalizedRaw)
	result := vastbaseCompatibility{mode: "postgres", raw: normalizedRaw}
	switch compact {
	case "A":
		result.mode = "oracle"
	case "O", "ORA", "ORACLE":
		result.mode = "oracle"
		result.supportsDisableConstraint = true
	case "B", "M", "MYSQL":
		result.mode = "mysql"
		result.mysqlCompat = true
	case "MSSQL", "SQLSERVER":
		result.mode = "sqlserver"
		result.sqlServer = true
	case "", "P", "PG", "POSTGRES", "POSTGRESQL":
		result.mode = "postgres"
	default:
		result.mode = strings.ToLower(strings.TrimSpace(raw))
	}
	return result
}

func detectAgentMode(db *sql.DB, configuredMySQL bool) vastbaseMode {
	raw := "PG"
	if db != nil {
		var detected string
		if err := db.QueryRow("SELECT datcompatibility FROM pg_catalog.pg_database WHERE datname = current_database()").Scan(&detected); err == nil && strings.TrimSpace(detected) != "" {
			raw = detected
		}
	}
	compatibility := normalizeVastbaseCompatibility(raw)
	if configuredMySQL {
		compatibility = normalizeVastbaseCompatibility("MYSQL")
	}
	mode := vastbaseMode{
		compatibilityMode:         compatibility.mode,
		compatibilityModeRaw:      compatibility.raw,
		mysqlCompat:               compatibility.mysqlCompat,
		sqlServerIdentity:         compatibility.sqlServer,
		supportsDisableConstraint: compatibility.supportsDisableConstraint,
	}
	if db == nil {
		mode.postgresCatalog = true
		return mode
	}
	postgresCatalog := catalogExists(db, "pg_catalog.pg_namespace")
	systemCatalog := catalogExists(db, "sys_catalog.sys_namespace")
	mode.postgresCatalog = postgresCatalog || !systemCatalog
	return mode
}

func catalogExists(db *sql.DB, catalog string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rows, err := db.QueryContext(ctx, "SELECT 1 FROM "+catalog+" WHERE 1 = 0")
	if err != nil {
		return false
	}
	return rows.Close() == nil
}

func vastbaseSupportsDisableConstraint(mode vastbaseMode) bool {
	return mode.supportsDisableConstraint
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
