//go:build !neo4j_legacy_windows

// Package neo4jcompat exposes the context-aware driver API used by the agent.
package neo4jcompat

import (
	driver "github.com/neo4j/neo4j-go-driver/v6/neo4j"
	"github.com/neo4j/neo4j-go-driver/v6/neo4j/auth"
	"github.com/neo4j/neo4j-go-driver/v6/neo4j/config"
	"github.com/neo4j/neo4j-go-driver/v6/neo4j/db"
)

type (
	AccessMode                = driver.AccessMode
	Config                    = config.Config
	Driver                    = driver.Driver
	Session                   = driver.Session
	SessionConfig             = driver.SessionConfig
	Result                    = driver.Result
	Record                    = driver.Record
	Node                      = driver.Node
	Relationship              = driver.Relationship
	Path                      = driver.Path
	Point2D                   = driver.Point2D
	Point3D                   = driver.Point3D
	Date                      = driver.Date
	Duration                  = driver.Duration
	LocalDateTime             = driver.LocalDateTime
	LocalTime                 = driver.LocalTime
	Time                      = driver.Time
	ClientCertificate         = auth.ClientCertificate
	ClientCertificateProvider = auth.ClientCertificateProvider
	FeatureNotSupportedError  = db.FeatureNotSupportedError
	Neo4jError                = db.Neo4jError
)

const (
	AccessModeRead  = driver.AccessModeRead
	AccessModeWrite = driver.AccessModeWrite
	FetchAll        = driver.FetchAll
	FetchDefault    = driver.FetchDefault
)

var (
	NewDriver                          = driver.NewDriver
	NoAuth                             = driver.NoAuth
	BasicAuth                          = driver.BasicAuth
	IsRetryable                        = driver.IsRetryable
	NewStaticClientCertificateProvider = auth.NewStaticClientCertificateProvider
)
