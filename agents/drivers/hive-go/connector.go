package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/beltran/gosasl"
	gohive "github.com/t8y2/dbx/agents/go-common/gohive"
)

type connectorFactory func(endpoint) driver.Connector

type discoveryConnector struct {
	discovery     endpointDiscovery
	factory       connectorFactory
	driver        driver.Driver
	retries       int
	retryInterval time.Duration
}

func newDiscoveryConnector(config connectionConfig) *discoveryConnector {
	return &discoveryConnector{
		discovery: newEndpointDiscovery(config),
		factory: func(target endpoint) driver.Connector {
			tlsConfig := config.TLSConfig
			if target.SSL && tlsConfig == nil && !config.TLSExplicit {
				tlsConfig = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: target.Host}
			}
			if tlsConfig != nil {
				tlsConfig = tlsConfig.Clone()
				if tlsConfig.ServerName == "" || tlsConfig.ServerName == config.Endpoints[0].Host {
					tlsConfig.ServerName = target.Host
				}
			}
			hiveConfiguration := make(map[string]string, len(config.HiveConfiguration)+1)
			for key, value := range config.HiveConfiguration {
				hiveConfiguration[key] = value
			}
			if config.Kerberos.Enabled {
				hiveConfiguration["hive.server2.thrift.sasl.qop"] = config.Kerberos.QOP
			}
			transportMode := config.TransportMode
			if target.TransportMode != "" && !config.TransportModeExplicit {
				transportMode = target.TransportMode
			}
			httpPath := config.HTTPPath
			if target.HTTPPath != "" && !config.HTTPPathExplicit {
				httpPath = target.HTTPPath
			}
			auth := config.Auth
			if target.Auth != "" && !config.AuthExplicit {
				auth = target.Auth
			}
			service := kerberosServiceForEndpoint(config, target)
			return gohive.NewConnector(gohive.Config{
				Host:                       target.Host,
				Port:                       target.Port,
				Auth:                       normalizeHiveAuth(auth),
				Username:                   config.Username,
				Password:                   config.Password,
				Database:                   config.Database,
				TransportMode:              transportMode,
				HTTPPath:                   httpPath,
				Service:                    service,
				HTTPKerberosChannelBinding: config.Kerberos.ChannelBinding,
				GSSAPIOptions:              gssapiOptionsFromKerberos(config.Kerberos),
				TLSConfig:                  tlsConfig,
				HiveConfiguration:          hiveConfiguration,
				ConnectTimeout:             config.ConnectTimeout,
				SocketTimeout:              config.SocketTimeout,
				HTTPTimeout:                config.SocketTimeout,
				FetchSize:                  int64(config.FetchSize),
				MaxMessageSize:             config.MaxMessageSize,
				HTTPHeaders:                config.HTTPHeaders,
				HTTPCookies:                config.HTTPCookies,
				RequestTracking:            config.RequestTracking,
				DisableCookieAuth:          !config.CookieAuth,
				CookieName:                 config.CookieName,
				JWT:                        config.JWT,
				DelegationToken:            config.DelegationToken,
				BrowserToken:               config.BrowserToken,
				BrowserClientID:            config.BrowserClientID,
				BrowserResponsePort:        config.BrowserResponsePort,
				BrowserResponseTimeout:     config.BrowserResponseTimeout,
				BrowserDisableSSLCheck:     config.BrowserDisableSSLCheck,
			})
		},
		driver:        &gohive.Driver{},
		retries:       max(config.Retries, 1),
		retryInterval: config.RetryInterval,
	}
}

func gssapiOptionsFromKerberos(config kerberosConfig) gosasl.GSSAPIOptions {
	return gosasl.GSSAPIOptions{
		ConfigPath:       config.ConfigPath,
		CCachePath:       config.CCachePath,
		KeytabPath:       config.KeytabPath,
		Principal:        config.ClientPrincipal,
		Password:         config.Password,
		QOP:              config.QOP,
		AuthorizationID:  config.AuthorizationID,
		ServiceHost:      config.ServerName,
		UseCCache:        config.UseTicketCache,
		UseKeytab:        config.UseKeytab,
		UseSSPI:          config.UseSSPI,
		CanonicalizeHost: config.CanonicalHostname,
		DisablePAFXFAST:  config.DisablePAFXFAST,
	}
}

func kerberosServiceForEndpoint(config connectionConfig, target endpoint) string {
	service := firstNonEmpty(config.Kerberos.ServerPrincipal, config.Kerberos.Service)
	if target.Principal != "" && !config.Kerberos.ServerPrincipalExplicit {
		service = target.Principal
	}
	return service
}

func (connector *discoveryConnector) Connect(ctx context.Context) (driver.Conn, error) {
	var failures []string
	for attempt := 0; attempt < max(connector.retries, 1); attempt++ {
		rejected := map[string]bool{}
		for {
			endpoints, err := connector.discovery.Endpoints(ctx, rejected)
			if err != nil {
				failures = append(failures, fmt.Sprintf("discovery attempt %d: %v", attempt+1, err))
				break
			}
			if len(endpoints) == 0 {
				break
			}
			for _, target := range endpoints {
				connection, connectErr := connector.factory(target).Connect(ctx)
				if connectErr == nil {
					return connection, nil
				}
				rejected[target.address()] = true
				failures = append(failures, fmt.Sprintf("attempt %d %s: %v", attempt+1, target.address(), connectErr))
			}
			break
		}
		if attempt+1 < connector.retries && connector.retryInterval > 0 {
			timer := time.NewTimer(connector.retryInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
	}
	if len(failures) == 0 {
		return nil, errors.New("Hive discovery returned no endpoints")
	}
	return nil, fmt.Errorf("all HiveServer2 endpoints failed: %s", strings.Join(failures, "; "))
}

func (connector *discoveryConnector) Driver() driver.Driver {
	return connector.driver
}

func openHiveDatabase(config connectionConfig) *sql.DB {
	database := sql.OpenDB(newDiscoveryConnector(config))
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	return database
}

func normalizeHiveAuth(value string) string {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	switch normalized {
	case "":
		return "NONE"
	case "NOSASL", "NO_SASL":
		return "NOSASL"
	case "KERBEROS", "GSSAPI":
		return "KERBEROS"
	case "LDAP":
		return "LDAP"
	case "CUSTOM":
		return "CUSTOM"
	case "DIGEST-MD5", "DELEGATIONTOKEN", "DELEGATION_TOKEN":
		return "DIGEST-MD5"
	default:
		return normalized
	}
}
