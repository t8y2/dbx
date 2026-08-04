package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultRuntimePoolSize       = 32
	defaultRuntimeMetadataLimit  = 8
	defaultValidatorPoolSize     = 8
	connectionRuntimeGracePeriod = 30 * time.Second
	operationPermitTimeout       = 30 * time.Second
)

var errOperationCapacity = errors.New("agent operation capacity is temporarily exhausted")

type connectionRuntime struct {
	mu                  sync.Mutex
	validator           *sql.DB
	listTablesStatement *sql.Stmt
	permits             chan struct{}
	metadataPermits     chan struct{}
	references          int
	lastReleased        time.Time
}

func newConnectionRuntime() *connectionRuntime {
	poolSize := runtimePoolSize()
	return &connectionRuntime{
		permits:         make(chan struct{}, poolSize),
		metadataPermits: make(chan struct{}, runtimeMetadataLimit(poolSize)),
	}
}

func runtimeMetadataLimit(poolSize int) int {
	value := min(defaultRuntimeMetadataLimit, poolSize)
	if raw := os.Getenv("DBX_AGENT_VASTBASE_MAX_CONCURRENT_METADATA"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= poolSize {
			value = parsed
		}
	}
	return value
}

func runtimePoolSize() int {
	value := defaultRuntimePoolSize
	if raw := os.Getenv("DBX_AGENT_VASTBASE_MAX_CONCURRENT_OPERATIONS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 32 {
			value = parsed
		}
	}
	return value
}

func (connectionRuntime *connectionRuntime) validate(cp connectParams, opener agentDBOpener) error {
	connectionRuntime.mu.Lock()
	validator := connectionRuntime.validator
	if validator == nil {
		db, err := openAndPingDB(cp, defaultConnectTimeout, opener)
		if err != nil {
			connectionRuntime.mu.Unlock()
			return err
		}
		poolSize := cap(connectionRuntime.metadataPermits)
		db.SetMaxOpenConns(poolSize)
		db.SetMaxIdleConns(poolSize)
		db.SetConnMaxLifetime(5 * time.Minute)
		connectionRuntime.validator = db
		connectionRuntime.mu.Unlock()
		return nil
	}
	connectionRuntime.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), defaultConnectTimeout)
	defer cancel()
	return validator.PingContext(ctx)
}

func (connectionRuntime *connectionRuntime) acquire(metadata bool) (func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), operationPermitTimeout)
	defer cancel()
	metadataAcquired := false
	if metadata {
		select {
		case connectionRuntime.metadataPermits <- struct{}{}:
			metadataAcquired = true
		case <-ctx.Done():
			return nil, errOperationCapacity
		}
	}
	select {
	case connectionRuntime.permits <- struct{}{}:
		return func() {
			<-connectionRuntime.permits
			if metadataAcquired {
				<-connectionRuntime.metadataPermits
			}
		}, nil
	case <-ctx.Done():
		if metadataAcquired {
			<-connectionRuntime.metadataPermits
		}
		return nil, errOperationCapacity
	}
}

func (connectionRuntime *connectionRuntime) close() error {
	connectionRuntime.mu.Lock()
	validator := connectionRuntime.validator
	listTablesStatement := connectionRuntime.listTablesStatement
	connectionRuntime.validator = nil
	connectionRuntime.listTablesStatement = nil
	connectionRuntime.mu.Unlock()
	if listTablesStatement != nil {
		_ = listTablesStatement.Close()
	}
	if validator == nil {
		return nil
	}
	return validator.Close()
}

func (connectionRuntime *connectionRuntime) database() *sql.DB {
	connectionRuntime.mu.Lock()
	defer connectionRuntime.mu.Unlock()
	return connectionRuntime.validator
}

func (connectionRuntime *connectionRuntime) queryListTables(query, schema string) (*sql.Rows, error) {
	connectionRuntime.mu.Lock()
	statement := connectionRuntime.listTablesStatement
	if statement == nil {
		if connectionRuntime.validator == nil {
			connectionRuntime.mu.Unlock()
			return nil, errors.New("connection runtime is not initialized")
		}
		prepared, err := connectionRuntime.validator.Prepare(query)
		if err != nil {
			connectionRuntime.mu.Unlock()
			return nil, err
		}
		connectionRuntime.listTablesStatement = prepared
		statement = prepared
	}
	connectionRuntime.mu.Unlock()
	return statement.Query(schema)
}

func (s *server) acquireOperationPermit(method string) (func(), error) {
	if s.connectionRuntime == nil {
		return func() {}, nil
	}
	metadata := isMetadataOperation(method) || strings.EqualFold(strings.TrimSpace(s.params.SessionRole), "metadata")
	return s.connectionRuntime.acquire(metadata)
}

func (s *server) metadataDatabase() (*sql.DB, error) {
	if s.connectionRuntime != nil && !s.sessionAffinity {
		if db := s.connectionRuntime.database(); db != nil {
			return db, nil
		}
	}
	return s.requireDB()
}

func isMetadataOperation(method string) bool {
	switch method {
	case "connection_info", "list_databases", "list_schemas", "list_tables", "get_table_comment", "list_objects",
		"list_data_types", "completion_assistant_search_v1", "get_columns", "list_indexes", "list_foreign_keys",
		"list_triggers", "get_object_source", "get_table_ddl", "get_explain_info":
		return true
	default:
		return false
	}
}

func (r *runtimeServer) acquireConnectionRuntime(cp connectParams) (*connectionRuntime, string) {
	key := connectionRuntimeKey(cp)
	r.connectionRuntimeMu.Lock()
	if r.connectionRuntimes == nil {
		r.connectionRuntimes = map[string]*connectionRuntime{}
	}
	r.closeExpiredConnectionRuntimesLocked(time.Now())
	connectionRuntime := r.connectionRuntimes[key]
	if connectionRuntime == nil {
		connectionRuntime = newConnectionRuntime()
		r.connectionRuntimes[key] = connectionRuntime
	}
	connectionRuntime.references++
	r.connectionRuntimeMu.Unlock()

	return connectionRuntime, key
}

func (r *runtimeServer) releaseConnectionRuntime(key string) {
	if key == "" {
		return
	}
	r.connectionRuntimeMu.Lock()
	if connectionRuntime := r.connectionRuntimes[key]; connectionRuntime != nil {
		if connectionRuntime.references > 0 {
			connectionRuntime.references--
		}
		if connectionRuntime.references == 0 {
			connectionRuntime.lastReleased = time.Now()
		}
	}
	r.connectionRuntimeMu.Unlock()
}

func (r *runtimeServer) closeExpiredConnectionRuntimesLocked(now time.Time) {
	for key, connectionRuntime := range r.connectionRuntimes {
		if connectionRuntime.references == 0 && !connectionRuntime.lastReleased.IsZero() && now.Sub(connectionRuntime.lastReleased) >= connectionRuntimeGracePeriod {
			_ = connectionRuntime.close()
			delete(r.connectionRuntimes, key)
		}
	}
}

func (r *runtimeServer) closeConnectionRuntimes() error {
	r.connectionRuntimeMu.Lock()
	runtimes := r.connectionRuntimes
	r.connectionRuntimes = map[string]*connectionRuntime{}
	r.connectionRuntimeMu.Unlock()
	var firstErr error
	for _, connectionRuntime := range runtimes {
		if err := connectionRuntime.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func connectionRuntimeKey(cp connectParams) string {
	identity := fmt.Sprintf("%s\x00mysql=%t", buildDSNWithSSLMode(cp, agentInitialSSLMode(effectiveSSLMode(cp))), cp.MySQLCompatMode)
	digest := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("%x", digest[:])
}
