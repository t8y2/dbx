package gohive

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// DSN represents a parsed Data Source Name
type DSN struct {
	Username          string
	Password          string
	Host              string
	Port              int
	Database          string
	Auth              string
	TransportMode     string
	Service           string
	SSLCertFile       string
	SSLKeyFile        string
	SSLInsecureSkip   bool
	HiveConfiguration map[string]string
}

// ParseDSN parses a DSN string into a DSN struct
func ParseDSN(dsn string) (*DSN, error) {
	// Check if the DSN starts with "hive://"
	if !strings.HasPrefix(dsn, "hive://") {
		return nil, fmt.Errorf("DSN must start with 'hive://'")
	}

	// Do NOT remove the "hive://" prefix; let url.Parse handle it
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid DSN format: %v", err)
	}

	// Create a new DSN struct
	parsedDSN := &DSN{
		Database:          strings.TrimPrefix(u.Path, "/"),
		Auth:              "NONE",
		TransportMode:     "binary", // Default transport mode
		Service:           "hive",   // Default service
		HiveConfiguration: make(map[string]string),
	}

	// Parse username and password if present
	if u.User != nil {
		parsedDSN.Username = u.User.Username()
		if password, ok := u.User.Password(); ok {
			parsedDSN.Password = password
		}
	}

	// Parse host and port
	parsedDSN.Host = u.Hostname()
	if portStr := u.Port(); portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return nil, fmt.Errorf("invalid port number: %v", err)
		}
		parsedDSN.Port = port
	} else {
		parsedDSN.Port = 10000 // Default port
	}

	// Parse query parameters
	query := u.Query()
	if auth := query.Get("auth"); auth != "" {
		parsedDSN.Auth = auth
	}
	if transport := query.Get("transport"); transport != "" {
		parsedDSN.TransportMode = transport
	}
	if service := query.Get("service"); service != "" {
		parsedDSN.Service = service
	}
	if sslCert := query.Get("sslcert"); sslCert != "" {
		parsedDSN.SSLCertFile = sslCert
	}
	if sslKey := query.Get("sslkey"); sslKey != "" {
		parsedDSN.SSLKeyFile = sslKey
	}
	if sslInsecureSkip := query.Get("sslinsecureskipverify"); sslInsecureSkip != "" {
		parsedDSN.SSLInsecureSkip = sslInsecureSkip == "true"
	}

	// Collect all other query parameters as Hive configuration properties
	for key, values := range query {
		// Skip standard parameters
		if key == "auth" || key == "transport" || key == "service" ||
			key == "sslcert" || key == "sslkey" || key == "sslinsecureskipverify" {
			continue
		}
		if len(values) > 0 {
			parsedDSN.HiveConfiguration[key] = values[0]
		}
	}

	// Validate required fields
	if parsedDSN.Database == "" {
		return nil, fmt.Errorf("database name is required")
	}

	return parsedDSN, nil
}
