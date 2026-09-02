package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

const (
	protocolVersion      = 2
	legacyAgentSessionID = "__legacy__"
	maxAgentSessions     = 256
	rpcTimeoutSeconds    = 30
)

var capabilities = []string{
	"connect", "test_connection", "kv", "kv_ttl", "kv_cas", "kv_list_values", "kv_status",
	"kv_history", "etcd_compaction", "etcd_defrag", "etcd_watch", "etcd_lease", "etcd_auth",
	"multi_session",
}

type request struct {
	ID     json.RawMessage            `json:"id"`
	Method string                     `json:"method"`
	Params map[string]json.RawMessage `json:"params"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// etcdSession carries the per-connection etcd client and its derived state.
// Requests for one session are serialized by agentSession.mu; watch callbacks
// reach the maps through watchesMu instead so buffering never blocks dispatch.
type etcdSession struct {
	clientMu           sync.Mutex
	client             *clientv3.Client
	connectedEndpoints []string

	watchesMu          sync.Mutex
	watches            map[string]*watchState
	knownLeases        map[uint64]struct{}
	watchBufferedBytes int64

	activeCancelMu sync.Mutex
	activeCancel   context.CancelFunc
}

func (s *etcdSession) reserveWatchBuffer(bytes int64) bool {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	if bytes < 0 || s.watchBufferedBytes+bytes > maxSessionWatchBufferBytes {
		return false
	}
	s.watchBufferedBytes += bytes
	return true
}

func (s *etcdSession) releaseWatchBuffer(bytes int64) {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	s.watchBufferedBytes -= bytes
	if s.watchBufferedBytes < 0 {
		s.watchBufferedBytes = 0
	}
}

func (s *etcdSession) rememberLease(id uint64) {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	s.knownLeases[id] = struct{}{}
}

func (s *etcdSession) forgetLease(id uint64) {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	delete(s.knownLeases, id)
}

func (s *etcdSession) knownLeaseIDs() []uint64 {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	ids := make([]uint64, 0, len(s.knownLeases))
	for id := range s.knownLeases {
		ids = append(ids, id)
	}
	return ids
}

type agentSession struct {
	state *etcdSession
	mu    sync.Mutex
}

func (a *agentSession) cancelActive() {
	a.state.activeCancelMu.Lock()
	cancel := a.state.activeCancel
	a.state.activeCancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

type runtimeServer struct {
	mu       sync.RWMutex
	sessions map[string]*agentSession
}

func main() {
	configureRuntimeParallelism()
	server := newRuntimeServer()
	encoder := json.NewEncoder(os.Stdout)
	var encoderMu sync.Mutex
	var requests sync.WaitGroup
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
			requests.Wait()
			result, _ := server.handleLine(line)
			encoderMu.Lock()
			_ = encoder.Encode(result)
			encoderMu.Unlock()
			server.closeAll()
			return
		}
		requests.Add(1)
		go func(line string) {
			defer requests.Done()
			result, _ := server.handleLine(line)
			encoderMu.Lock()
			defer encoderMu.Unlock()
			if err := encoder.Encode(result); err != nil {
				fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
			}
		}(line)
	}
	requests.Wait()
	server.closeAll()
}

func configureRuntimeParallelism() {
	if raw := strings.TrimSpace(os.Getenv("DBX_AGENT_ETCD_GOMAXPROCS")); raw != "" {
		if configured, err := strconv.Atoi(raw); err == nil && configured > 0 {
			runtime.GOMAXPROCS(configured)
			return
		}
	}
	if strings.TrimSpace(os.Getenv("GOMAXPROCS")) != "" {
		return
	}
	runtime.GOMAXPROCS(min(runtime.NumCPU(), 4))
}

func newRuntimeServer() *runtimeServer {
	return &runtimeServer{sessions: map[string]*agentSession{}}
}

func (r *runtimeServer) handleLine(line string) (response, bool) {
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return errorResponse(nil, "", "", err), false
	}
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("1")
	}
	result, shutdown, err := r.dispatch(req.Method, req.Params)
	if err != nil {
		return errorResponse(req.ID, req.Method, stringParam(req.Params, "agentSessionId"), err), false
	}
	return response{JSONRPC: "2.0", ID: req.ID, Result: result}, shutdown
}

func (r *runtimeServer) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return handshakeResult(), false, nil
	case "open_session":
		id := requiredSessionID(params)
		if id == "" {
			return nil, false, errors.New("agentSessionId is required")
		}
		return r.openSession(id, params)
	case "close_session":
		return r.closeSession(stringParam(params, "agentSessionId")), false, nil
	case "validate_session":
		session, err := r.session(requiredSessionID(params))
		if err != nil {
			return nil, false, err
		}
		session.mu.Lock()
		defer session.mu.Unlock()
		result, err := session.state.validateConnection()
		return result, false, err
	case "cancel_session":
		session, err := r.session(requiredSessionID(params))
		if err != nil {
			return nil, false, err
		}
		session.cancelActive()
		return map[string]bool{"ok": true}, false, nil
	case "test_connection":
		return r.testConnection(params)
	case "connect":
		_ = r.closeSession(legacyAgentSessionID)
		return r.openSession(legacyAgentSessionID, params)
	case "disconnect":
		return r.closeSession(legacyAgentSessionID), false, nil
	case "shutdown":
		return map[string]bool{"ok": true}, true, r.closeAll()
	default:
		id := stringParam(params, "agentSessionId")
		if id == "" {
			id = legacyAgentSessionID
		}
		session, err := r.session(id)
		if err != nil {
			return nil, false, err
		}
		session.mu.Lock()
		defer session.mu.Unlock()
		result, err := session.state.handle(method, params)
		return result, false, err
	}
}

func requiredSessionID(params map[string]json.RawMessage) string {
	return strings.TrimSpace(stringParam(params, "agentSessionId"))
}

func (r *runtimeServer) openSession(id string, params map[string]json.RawMessage) (any, bool, error) {
	r.mu.Lock()
	if _, exists := r.sessions[id]; exists {
		r.mu.Unlock()
		return nil, false, fmt.Errorf("Agent session already exists: %s", id)
	}
	if len(r.sessions) >= maxAgentSessions {
		r.mu.Unlock()
		return nil, false, fmt.Errorf("Agent session limit reached: %d", maxAgentSessions)
	}
	session := &agentSession{state: newEtcdSession()}
	r.sessions[id] = session
	r.mu.Unlock()

	if _, err := session.state.connect(params); err != nil {
		r.mu.Lock()
		delete(r.sessions, id)
		r.mu.Unlock()
		session.state.close()
		return nil, false, err
	}
	return map[string]bool{"ok": true}, false, nil
}

func (r *runtimeServer) session(id string) (*agentSession, error) {
	r.mu.RLock()
	session := r.sessions[id]
	r.mu.RUnlock()
	if session == nil {
		return nil, fmt.Errorf("Agent session not found: %s", id)
	}
	return session, nil
}

func (r *runtimeServer) closeSession(id string) any {
	r.mu.Lock()
	session := r.sessions[id]
	delete(r.sessions, id)
	r.mu.Unlock()
	if session != nil {
		session.cancelActive()
		session.mu.Lock()
		session.state.close()
		session.mu.Unlock()
	}
	return map[string]bool{"ok": true}
}

func (r *runtimeServer) closeAll() error {
	r.mu.Lock()
	sessions := r.sessions
	r.sessions = map[string]*agentSession{}
	r.mu.Unlock()
	var firstErr error
	for _, session := range sessions {
		session.cancelActive()
		if err := session.state.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (r *runtimeServer) testConnection(params map[string]json.RawMessage) (any, bool, error) {
	state := newEtcdSession()
	defer state.close()
	if _, err := state.connect(params); err != nil {
		return nil, false, err
	}
	return map[string]bool{"ok": true}, false, nil
}

func newEtcdSession() *etcdSession {
	return &etcdSession{
		watches:     map[string]*watchState{},
		knownLeases: map[uint64]struct{}{},
	}
}

func handshakeResult() map[string]any {
	return map[string]any{
		"protocolVersion":      protocolVersion,
		"agentProtocolVersion": protocolVersion,
		"capabilities":         capabilities,
	}
}

func (s *etcdSession) beginOperation() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeoutSeconds*time.Second)
	s.activeCancelMu.Lock()
	s.activeCancel = cancel
	s.activeCancelMu.Unlock()
	return ctx, cancel
}

func (s *etcdSession) endOperation(cancel context.CancelFunc) {
	cancel()
	s.activeCancelMu.Lock()
	s.activeCancel = nil
	s.activeCancelMu.Unlock()
}

func (s *etcdSession) handle(method string, params map[string]json.RawMessage) (any, error) {
	switch method {
	case "handshake":
		return handshakeResult(), nil
	case "connect", "test_connection":
		return s.connectMap(params)
	case "validate_connection":
		return s.validateConnection()
	case "kv_list_prefix":
		return s.listPrefix(params)
	case "kv_get":
		return s.get(params)
	case "kv_put":
		return s.put(params)
	case "kv_delete":
		return s.delete(params)
	case "kv_rename":
		return s.rename(params)
	case "kv_history":
		return s.history(params)
	case "kv_status":
		return s.status(params)
	case "etcd_compact":
		return s.compact(params)
	case "etcd_defrag":
		return s.defrag(params)
	case "etcd_watch_start":
		return s.watchStart(params)
	case "etcd_watch_poll":
		return s.watchPoll(params)
	case "etcd_watch_stop":
		return s.watchStop(params)
	case "etcd_lease_list":
		return s.leaseList(params)
	case "etcd_lease_get":
		return s.leaseGet(params)
	case "etcd_lease_grant":
		return s.leaseGrant(params)
	case "etcd_lease_keepalive_once":
		return s.leaseKeepAlive(params)
	case "etcd_lease_revoke":
		return s.leaseRevoke(params)
	case "etcd_auth_user_list":
		return s.authUserList(params)
	case "etcd_auth_user_get":
		return s.authUserGet(params)
	case "etcd_auth_user_add":
		return s.authUserAdd(params)
	case "etcd_auth_user_delete":
		return s.authUserDelete(params)
	case "etcd_auth_user_change_password":
		return s.authUserChangePassword(params)
	case "etcd_auth_user_grant_role":
		return s.authUserGrantRevokeRole(params, true)
	case "etcd_auth_user_revoke_role":
		return s.authUserGrantRevokeRole(params, false)
	case "etcd_auth_role_list":
		return s.authRoleList(params)
	case "etcd_auth_role_get":
		return s.authRoleGet(params)
	case "etcd_auth_role_add":
		return s.authRoleAdd(params)
	case "etcd_auth_role_delete":
		return s.authRoleDelete(params)
	case "etcd_auth_role_grant_permission":
		return s.authRolePermission(params, true)
	case "etcd_auth_role_revoke_permission":
		return s.authRolePermission(params, false)
	case "disconnect":
		s.close()
		return map[string]bool{"ok": true}, nil
	case "shutdown":
		s.close()
		return map[string]bool{"ok": true}, nil
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}

func decodeParams(params map[string]json.RawMessage, target any) error {
	if params == nil {
		params = map[string]json.RawMessage{}
	}
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringParam(params map[string]json.RawMessage, key string) string {
	if params == nil {
		return ""
	}
	var result string
	_ = json.Unmarshal(params[key], &result)
	return result
}

func intParam(params map[string]json.RawMessage, key string) int {
	if params == nil {
		return 0
	}
	var result int
	_ = json.Unmarshal(params[key], &result)
	return result
}

func boolParam(params map[string]json.RawMessage, key string) bool {
	if params == nil {
		return false
	}
	var result bool
	_ = json.Unmarshal(params[key], &result)
	return result
}
