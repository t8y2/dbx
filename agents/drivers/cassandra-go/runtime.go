package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	gocql "github.com/apache/cassandra-gocql-driver/v2"
)

const (
	defaultRuntimePoolSize      = 32
	defaultRuntimeMetadataLimit = 8
	operationPermitTimeout      = 30 * time.Second
)

var errOperationCapacity = errors.New("agent operation capacity is temporarily exhausted")

type connectionRuntime struct {
	mu               sync.Mutex
	config           cassandraConfig
	sessions         map[string]*gocql.Session
	retiredSessions  []*gocql.Session
	permits          chan struct{}
	metadataPermits  chan struct{}
	activeOperations int
	references       int
	closed           bool
}

func newConnectionRuntime(cp connectParams) (*connectionRuntime, error) {
	config, err := parseCassandraConfig(cp)
	if err != nil {
		return nil, err
	}
	poolSize := runtimePoolSize()
	return &connectionRuntime{
		config:          config,
		sessions:        map[string]*gocql.Session{},
		permits:         make(chan struct{}, poolSize),
		metadataPermits: make(chan struct{}, runtimeMetadataLimit(poolSize)),
	}, nil
}

func (r *connectionRuntime) sessionFor(keyspace string) (*gocql.Session, error) {
	keyspace = strings.TrimSpace(keyspace)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("Cassandra connection runtime is closed")
	}
	if session := r.sessions[keyspace]; session != nil && !session.Closed() {
		return session, nil
	}
	cluster, err := r.config.clusterConfig(keyspace)
	if err != nil {
		return nil, err
	}
	session, err := cluster.CreateSession()
	if err != nil {
		return nil, err
	}
	r.sessions[keyspace] = session
	return session, nil
}

func (r *connectionRuntime) invalidateMetadataSession() {
	var retiredSession *gocql.Session
	r.mu.Lock()
	if session := r.sessions[""]; session != nil {
		delete(r.sessions, "")
		if r.activeOperations == 0 {
			retiredSession = session
		} else {
			r.retiredSessions = append(r.retiredSessions, session)
		}
	}
	r.mu.Unlock()
	if retiredSession != nil {
		retiredSession.Close()
	}
}

func (r *connectionRuntime) acquire(metadata bool) (func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), operationPermitTimeout)
	defer cancel()
	metadataAcquired := false
	if metadata {
		select {
		case r.metadataPermits <- struct{}{}:
			metadataAcquired = true
		case <-ctx.Done():
			return nil, errOperationCapacity
		}
	}
	select {
	case r.permits <- struct{}{}:
		r.mu.Lock()
		r.activeOperations++
		r.mu.Unlock()
		return func() {
			var retiredSessions []*gocql.Session
			r.mu.Lock()
			r.activeOperations--
			if r.activeOperations == 0 && len(r.retiredSessions) > 0 {
				retiredSessions = r.retiredSessions
				r.retiredSessions = nil
			}
			r.mu.Unlock()
			<-r.permits
			if metadataAcquired {
				<-r.metadataPermits
			}
			for _, session := range retiredSessions {
				session.Close()
			}
		}, nil
	case <-ctx.Done():
		if metadataAcquired {
			<-r.metadataPermits
		}
		return nil, errOperationCapacity
	}
}

func (r *connectionRuntime) close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	sessions := r.sessions
	retiredSessions := r.retiredSessions
	r.sessions = map[string]*gocql.Session{}
	r.retiredSessions = nil
	r.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
	for _, session := range retiredSessions {
		session.Close()
	}
}

func (r *runtimeServer) acquireRuntime(cp connectParams) (*connectionRuntime, string, error) {
	key := connectionRuntimeKey(cp)
	r.runtimesMu.Lock()
	defer r.runtimesMu.Unlock()
	runtime := r.runtimes[key]
	if runtime == nil {
		var err error
		runtime, err = newConnectionRuntime(cp)
		if err != nil {
			return nil, "", err
		}
		r.runtimes[key] = runtime
	}
	runtime.references++
	return runtime, key, nil
}

func (r *runtimeServer) releaseRuntime(key string) {
	if key == "" {
		return
	}
	r.runtimesMu.Lock()
	runtime := r.runtimes[key]
	shouldClose := false
	if runtime != nil && runtime.references > 0 {
		runtime.references--
	}
	if runtime != nil && runtime.references == 0 {
		delete(r.runtimes, key)
		shouldClose = true
	}
	r.runtimesMu.Unlock()
	if shouldClose {
		runtime.close()
	}
}

func connectionRuntimeKey(cp connectParams) string {
	data, _ := json.Marshal(cp)
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:])
}

func runtimePoolSize() int {
	value := defaultRuntimePoolSize
	if raw := os.Getenv("DBX_AGENT_CASSANDRA_MAX_CONCURRENT_OPERATIONS"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= 128 {
			value = parsed
		}
	}
	return value
}

func runtimeMetadataLimit(poolSize int) int {
	value := min(defaultRuntimeMetadataLimit, poolSize)
	if raw := os.Getenv("DBX_AGENT_CASSANDRA_MAX_CONCURRENT_METADATA"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 1 && parsed <= poolSize {
			value = parsed
		}
	}
	return value
}
