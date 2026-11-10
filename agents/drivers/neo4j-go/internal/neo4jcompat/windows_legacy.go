//go:build neo4j_legacy_windows

package neo4jcompat

// Driver v5 retains the context-aware API and builds with Go 1.20, the last
// official Go runtime that supports Windows 7/8 and Server 2008 R2/2012.
import (
	driver "github.com/neo4j/neo4j-go-driver/v5/neo4j"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/auth"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/config"
	"github.com/neo4j/neo4j-go-driver/v5/neo4j/db"
)

type (
	AccessMode                = driver.AccessMode
	Config                    = config.Config
	Driver                    = driver.DriverWithContext
	Session                   = driver.SessionWithContext
	SessionConfig             = driver.SessionConfig
	Result                    = driver.ResultWithContext
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
	NewDriver                          = driver.NewDriverWithContext
	NoAuth                             = driver.NoAuth
	BasicAuth                          = driver.BasicAuth
	IsRetryable                        = driver.IsRetryable
	NewStaticClientCertificateProvider = auth.NewStaticClientCertificateProvider
)
