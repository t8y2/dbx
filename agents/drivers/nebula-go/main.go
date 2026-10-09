package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	nebula "github.com/vesoft-inc/nebula-go/v3"
)

const (
	legacySessionID = "__legacy__"
	maxSessions     = 256
)

type request struct {
	ID     json.RawMessage            `json:"id"`
	Method string                     `json:"method"`
	Params map[string]json.RawMessage `json:"params"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type connectParams struct {
	DriverProfile      string `json:"driver_profile"`
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Database           string `json:"database"`
	Username           string `json:"username"`
	Password           string `json:"password"`
	SSL                bool   `json:"ssl"`
	CACertPath         string `json:"ca_cert_path"`
	ClientCertPath     string `json:"client_cert_path"`
	ClientKeyPath      string `json:"client_key_path"`
	ConnectTimeoutSecs int    `json:"connect_timeout_secs"`
}

type agentSession struct {
	mu           sync.Mutex
	pool         *nebula.ConnectionPool
	conn         *nebula.Session
	params       connectParams
	cursors      map[string]*queryCursor
	nextCursorID uint64
	closed       bool
	canceled     atomic.Bool
	closePool    sync.Once
}

type runtimeServer struct {
	mu       sync.RWMutex
	sessions map[string]*agentSession
}

func main() {
	runtime := &runtimeServer{sessions: make(map[string]*agentSession)}
	encoder := json.NewEncoder(os.Stdout)
	var output sync.Mutex
	var running sync.WaitGroup
	fmt.Fprintln(os.Stdout, `{"ready":true}`)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 512*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var envelope request
		if json.Unmarshal([]byte(line), &envelope) == nil && envelope.Method == "shutdown" {
			running.Wait()
			result := runtime.handleLine(line)
			output.Lock()
			_ = encoder.Encode(result)
			output.Unlock()
			return
		}
		running.Add(1)
		go func(line string) {
			defer running.Done()
			result := runtime.handleLine(line)
			output.Lock()
			defer output.Unlock()
			if err := encoder.Encode(result); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
		}(line)
	}
	running.Wait()
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	_ = runtime.closeAll()
}

func (r *runtimeServer) handleLine(line string) response {
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return errorResponse(nil, "", "", err)
	}
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("1")
	}
	result, err := r.dispatch(req.Method, req.Params)
	if err != nil {
		return errorResponse(req.ID, req.Method, stringParam(req.Params, "agentSessionId"), err)
	}
	return response{JSONRPC: "2.0", ID: req.ID, Result: result}
}

func (r *runtimeServer) dispatch(method string, params map[string]json.RawMessage) (any, error) {
	switch method {
	case "handshake":
		return map[string]any{
			"protocolVersion": 2, "agentProtocolVersion": 2,
			"capabilities": []string{"connect", "test_connection", "metadata", "query", "paged_query", "ddl", "multi_session", "structured_error_v1"},
		}, nil
	case "open_session", "connect":
		var options connectParams
		if err := decodeParams(params, &options); err != nil {
			return nil, err
		}
		id := stringParam(params, "agentSessionId")
		if method == "connect" {
			id = legacySessionID
			_ = r.closeSession(id)
		}
		if id == "" {
			return nil, errors.New("agentSessionId is required")
		}
		return map[string]bool{"ok": true}, r.openSession(id, options)
	case "test_connection":
		var options connectParams
		if err := decodeParams(params, &options); err != nil {
			return nil, err
		}
		session, err := newAgentSession(options)
		if err != nil {
			return nil, err
		}
		defer session.close()
		return map[string]bool{"ok": true}, nil
	case "close_session", "disconnect":
		id := stringParam(params, "agentSessionId")
		if method == "disconnect" {
			id = legacySessionID
		}
		return map[string]bool{"ok": true}, r.closeSession(id)
	case "shutdown":
		return map[string]bool{"ok": true}, r.closeAll()
	case "cancel_session":
		session, err := r.session(stringParam(params, "agentSessionId"))
		if err != nil {
			return nil, err
		}
		session.cancel()
		return map[string]bool{"ok": true}, nil
	}

	id := stringParam(params, "agentSessionId")
	if id == "" {
		id = legacySessionID
	}
	session, err := r.session(id)
	if err != nil {
		return nil, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed || session.canceled.Load() {
		return nil, errors.New("agent session is closed")
	}
	if method == "validate_session" || method == "validate_connection" {
		_, err := session.execute("SHOW SPACES", "")
		return map[string]bool{"ok": err == nil}, err
	}
	return session.dispatch(method, params)
}

func (r *runtimeServer) openSession(id string, options connectParams) error {
	r.mu.Lock()
	if _, exists := r.sessions[id]; exists {
		r.mu.Unlock()
		return fmt.Errorf("agent session already exists: %s", id)
	}
	if len(r.sessions) >= maxSessions {
		r.mu.Unlock()
		return errors.New("agent session limit reached")
	}
	r.mu.Unlock()
	session, err := newAgentSession(options)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[id]; exists {
		session.close()
		return fmt.Errorf("agent session already exists: %s", id)
	}
	if len(r.sessions) >= maxSessions {
		session.close()
		return errors.New("agent session limit reached")
	}
	r.sessions[id] = session
	return nil
}

func newAgentSession(options connectParams) (*agentSession, error) {
	if options.DriverProfile != "" && !strings.EqualFold(options.DriverProfile, "nebula") && !strings.EqualFold(options.DriverProfile, "nebula-v3") {
		return nil, fmt.Errorf("unsupported NebulaGraph driver profile %q; only NebulaGraph 3.x is supported", options.DriverProfile)
	}
	if strings.TrimSpace(options.Host) == "" {
		return nil, errors.New("NebulaGraph graphd host is required")
	}
	if options.Port <= 0 || options.Port > 65535 {
		return nil, errors.New("NebulaGraph graphd port is invalid")
	}
	config := nebula.GetDefaultConf()
	config.MaxConnPoolSize = 1
	config.MinConnPoolSize = 1
	if options.ConnectTimeoutSecs > 0 {
		config.TimeOut = time.Duration(options.ConnectTimeoutSecs) * time.Second
	} else {
		config.TimeOut = 15 * time.Second
	}
	hosts := []nebula.HostAddress{{Host: options.Host, Port: options.Port}}
	var pool *nebula.ConnectionPool
	var err error
	if options.SSL {
		if options.CACertPath == "" || options.ClientCertPath == "" || options.ClientKeyPath == "" {
			return nil, errors.New("NebulaGraph TLS requires CA, client certificate and client key paths")
		}
		tlsConfig, tlsErr := nebula.GetDefaultSSLConfig(options.CACertPath, options.ClientCertPath, options.ClientKeyPath)
		if tlsErr != nil {
			return nil, tlsErr
		}
		pool, err = nebula.NewSslConnectionPool(hosts, config, tlsConfig, nebula.DefaultLogger{})
	} else {
		pool, err = nebula.NewConnectionPool(hosts, config, nebula.DefaultLogger{})
	}
	if err != nil {
		return nil, err
	}
	conn, err := pool.GetSession(options.Username, options.Password)
	if err != nil {
		pool.Close()
		return nil, err
	}
	session := &agentSession{pool: pool, conn: conn, params: options, cursors: make(map[string]*queryCursor)}
	if _, err := session.execute("SHOW SPACES", ""); err != nil {
		session.close()
		return nil, err
	}
	return session, nil
}

func (r *runtimeServer) session(id string) (*agentSession, error) {
	r.mu.RLock()
	session := r.sessions[id]
	r.mu.RUnlock()
	if session == nil {
		return nil, fmt.Errorf("agent session not found: %s", id)
	}
	return session, nil
}

func (r *runtimeServer) closeSession(id string) error {
	r.mu.Lock()
	session := r.sessions[id]
	delete(r.sessions, id)
	r.mu.Unlock()
	if session != nil {
		session.mu.Lock()
		session.close()
		session.mu.Unlock()
	}
	return nil
}

func (r *runtimeServer) closeAll() error {
	r.mu.Lock()
	sessions := r.sessions
	r.sessions = make(map[string]*agentSession)
	r.mu.Unlock()
	for _, session := range sessions {
		session.mu.Lock()
		session.close()
		session.mu.Unlock()
	}
	return nil
}

func (s *agentSession) cancel() {
	s.canceled.Store(true)
	s.closePool.Do(func() { s.pool.Close() })
}

func (s *agentSession) close() {
	if s.closed {
		return
	}
	s.closed = true
	s.cursors = nil
	s.closePool.Do(func() {
		if !s.canceled.Load() {
			s.conn.Release()
		}
		s.pool.Close()
	})
}

func decodeParams(params map[string]json.RawMessage, target any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringParam(params map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(params[key], &value)
	return value
}

func intParam(params map[string]json.RawMessage, key string) int {
	var value int
	_ = json.Unmarshal(params[key], &value)
	return value
}

func stringSliceParam(params map[string]json.RawMessage, key string) []string {
	var values []string
	_ = json.Unmarshal(params[key], &values)
	return values
}
