package faultproxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"
)

var ErrReadOnly = errors.New("fault injection is disabled; explicitly enable it for a disposable lab")

// Server owns one upstream connection per client, never a pool. All state is
// process-local; closing the server destroys every rule, pause, and connection.
type Server struct {
	cfg      Config
	mu       sync.Mutex
	listener net.Listener
	closed   bool
	next     uint64
	seq      uint64
	sessions map[string]*session
	rules    []Rule
	pauses   map[string]*barrier
	events   []Event
	wg       sync.WaitGroup
}

type barrier struct {
	Pause
	release chan bool
}

func loopback(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("expected a numeric loopback IP:port")
	}
	ip := net.ParseIP(host)
	n, e := strconv.Atoi(port)
	if ip == nil || !ip.IsLoopback() || e != nil || n < 0 || n > 65535 {
		return errors.New("only numeric loopback endpoints are supported")
	}
	return nil
}

func New(cfg Config) (*Server, error) {
	if !cfg.DisposableLab {
		return nil, errors.New("explicit disposableLab acknowledgement required; never use a real database")
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:55433"
	}
	if err := loopback(cfg.Listen); err != nil {
		return nil, err
	}
	if err := loopback(cfg.Upstream); err != nil {
		return nil, err
	}
	upHost, p, _ := net.SplitHostPort(cfg.Upstream)
	upPort, _ := strconv.Atoi(p)
	if upPort == 0 {
		return nil, errors.New("upstream port must be nonzero")
	}
	listenHost, listenPortText, _ := net.SplitHostPort(cfg.Listen)
	listenPort, _ := strconv.Atoi(listenPortText)
	if upPort == listenPort && net.ParseIP(upHost).Equal(net.ParseIP(listenHost)) {
		return nil, errors.New("proxy and upstream endpoints must differ")
	}
	if cfg.PauseTimeout == 0 {
		cfg.PauseTimeout = 15 * time.Second
	}
	if cfg.IOTimeout == 0 {
		cfg.IOTimeout = 30 * time.Second
	}
	if cfg.PauseTimeout < 10*time.Millisecond || cfg.PauseTimeout > 2*time.Minute || cfg.IOTimeout < 100*time.Millisecond || cfg.IOTimeout > 5*time.Minute {
		return nil, errors.New("timeouts outside bounded lab limits")
	}
	if cfg.MaxConnections == 0 {
		cfg.MaxConnections = 16
	}
	if cfg.MaxConnections < 1 || cfg.MaxConnections > 64 {
		return nil, errors.New("maxConnections must be 1..64")
	}
	return &Server{cfg: cfg, sessions: map[string]*session{}, pauses: map[string]*barrier{}}, nil
}

func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.listener != nil {
		return errors.New("server is closed or already started")
	}
	l, err := net.Listen("tcp", s.cfg.Listen)
	if err != nil {
		return errors.New("could not bind loopback proxy")
	}
	s.listener = l
	s.wg.Add(1)
	go s.accept(l)
	return nil
}

func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return ""
	}
	return s.listener.Addr().String()
}

func (s *Server) accept(l net.Listener) {
	defer s.wg.Done()
	for {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed || len(s.sessions) >= s.cfg.MaxConnections {
			s.mu.Unlock()
			conn.Close()
			continue
		}
		s.next++
		id := fmt.Sprintf("c-%d", s.next)
		c := newSession(s, id, conn)
		s.sessions[id] = c
		s.wg.Add(1)
		s.mu.Unlock()
		go func() { defer s.wg.Done(); c.run(); s.mu.Lock(); delete(s.sessions, c.id); s.mu.Unlock() }()
	}
}

func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.wg.Wait()
		return nil
	}
	s.closed = true
	if s.listener != nil {
		s.listener.Close()
	}
	for _, c := range s.sessions {
		c.stop()
	}
	s.rules = nil
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}

func (s *Server) emit(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	e.Sequence = s.seq
	e.Time = time.Now().UTC()
	if len(s.events) == 512 {
		copy(s.events, s.events[1:])
		s.events = s.events[:511]
	}
	s.events = append(s.events, e)
}

func (s *Server) prune() {
	now := time.Now()
	out := s.rules[:0]
	for _, r := range s.rules {
		if r.Hits > 0 && now.Before(r.ExpiresAt) {
			out = append(out, r)
		}
	}
	s.rules = out
}

func (s *Server) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	out := Snapshot{AllowInjection: s.cfg.AllowInjection, Sessions: []Session{}, Rules: append([]Rule{}, s.rules...), Pauses: []Pause{}, Events: append([]Event{}, s.events...)}
	if s.listener != nil {
		out.Address = s.listener.Addr().String()
	}
	for _, c := range s.sessions {
		c.mu.Lock()
		out.Sessions = append(out.Sessions, Session{ID: c.id, Application: c.app, Database: c.db, User: c.user, Transaction: string(c.tx)})
		c.mu.Unlock()
	}
	for _, p := range s.pauses {
		out.Pauses = append(out.Pauses, p.Pause)
	}
	sort.Slice(out.Sessions, func(i, j int) bool { return out.Sessions[i].ID < out.Sessions[j].ID })
	sort.Slice(out.Pauses, func(i, j int) bool { return out.Pauses[i].ID < out.Pauses[j].ID })
	return out
}

func (s *Server) AddRule(r Rule) (Rule, error) {
	if !s.cfg.AllowInjection {
		return Rule{}, ErrReadOnly
	}
	if r.Phase != "execute" && r.Phase != "commit" && r.Phase != "connect" {
		return Rule{}, errors.New("phase must be execute, commit, or connect")
	}
	if r.Action != "pause" && r.Action != "abort" && r.Action != "drop" {
		return Rule{}, errors.New("action must be pause, abort, or drop")
	}
	if r.Phase == "connect" && r.Action != "drop" {
		return Rule{}, errors.New("connect phase only supports drop")
	}
	if r.Hits < 1 || r.Hits > 100 || r.TTLMS < 10 || r.TTLMS > 300000 {
		return Rule{}, errors.New("hits must be 1..100 and ttlMs 10..300000")
	}
	sel := r.Selector
	if sel.Application == "" && sel.Database == "" && sel.User == "" && sel.ConnectionID == "" && sel.SQLHash == "" && sel.Command == "" {
		return Rule{}, errors.New("at least one explicit selector is required")
	}
	if len(sel.Application) > 256 || len(sel.Database) > 63 || len(sel.User) > 63 || len(sel.ConnectionID) > 64 {
		return Rule{}, errors.New("selector exceeds length limit")
	}
	if sel.Command != "" && !supportedCommand(sel.Command) && sel.Command != "SYNC" {
		return Rule{}, errors.New("selector command must be a supported uppercase command")
	}
	if sel.SQLHash != "" && !validHash(sel.SQLHash) {
		return Rule{}, errors.New("sqlHash must be 64 lowercase hex characters")
	}
	if r.Phase == "connect" && (sel.SQLHash != "" || sel.Command != "") {
		return Rule{}, errors.New("connect cannot match SQL selectors")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	if s.closed {
		return Rule{}, errors.New("server is closed")
	}
	if len(s.rules) >= 128 {
		return Rule{}, errors.New("rule limit reached")
	}
	s.next++
	r.ID = fmt.Sprintf("r-%d", s.next)
	r.ExpiresAt = time.Now().UTC().Add(time.Duration(r.TTLMS) * time.Millisecond)
	s.rules = append(s.rules, r)
	return r, nil
}

func (s *Server) DeleteRule(id string) error {
	if !s.cfg.AllowInjection {
		return ErrReadOnly
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.rules {
		if r.ID == id {
			s.rules = append(s.rules[:i], s.rules[i+1:]...)
			return nil
		}
	}
	return errors.New("rule not found")
}

func (s *Server) Resume(id string, abort bool) error {
	if !s.cfg.AllowInjection {
		return ErrReadOnly
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pauses[id]
	if !ok {
		return errors.New("pause not found or already released")
	}
	select {
	case p.release <- abort:
		delete(s.pauses, id)
		return nil
	default:
		return errors.New("pause already released")
	}
}

// gate atomically consumes a rule hit before publishing a uniquely addressable
// barrier. Two concurrent clients cannot both consume the final hit.
func (s *Server) gate(c *session, phase string, q statement) error {
	s.mu.Lock()
	s.prune()
	c.mu.Lock()
	app, db, user := c.app, c.db, c.user
	c.mu.Unlock()
	var chosen *Rule
	for i := range s.rules {
		r := &s.rules[i]
		x := r.Selector
		if r.Phase == phase && (x.Application == "" || x.Application == app) && (x.Database == "" || x.Database == db) && (x.User == "" || x.User == user) && (x.ConnectionID == "" || x.ConnectionID == c.id) && (x.SQLHash == "" || x.SQLHash == q.hash) && (x.Command == "" || x.Command == q.command) {
			r.Hits--
			copy := *r
			chosen = &copy
			break
		}
	}
	if chosen == nil {
		s.mu.Unlock()
		return nil
	}
	e := Event{ConnectionID: c.id, Kind: "injected_" + chosen.Action, Command: q.command, SQLHash: q.hash, RuleID: chosen.ID, Outcome: "not_forwarded"}
	if chosen.Action != "pause" {
		s.mu.Unlock()
		s.emit(e)
		return errors.New("injected connection termination before forwarding")
	}
	s.next++
	p := &barrier{Pause: Pause{ID: fmt.Sprintf("p-%d", s.next), ConnectionID: c.id, RuleID: chosen.ID, Deadline: time.Now().UTC().Add(s.cfg.PauseTimeout)}, release: make(chan bool, 1)}
	s.pauses[p.ID] = p
	s.mu.Unlock()
	e.Kind = "paused"
	e.PauseID = p.ID
	s.emit(e)
	defer func() { s.mu.Lock(); delete(s.pauses, p.ID); s.mu.Unlock() }()
	timer := time.NewTimer(time.Until(p.Deadline))
	defer timer.Stop()
	select {
	case abort := <-p.release:
		e.Kind = "resumed"
		if abort {
			e.Kind = "pause_aborted"
		}
		s.emit(e)
		if abort {
			return errors.New("paused operation aborted before forwarding")
		}
		return nil
	case <-timer.C:
		e.Kind = "pause_timeout"
		s.emit(e)
		return errors.New("pause timed out; connection terminated before forwarding")
	case <-c.ctx.Done():
		e.Kind = "pause_cancelled"
		s.emit(e)
		return context.Canceled
	}
}

// A simple autocommit query has no client-visible pre-commit wire boundary.
// Refuse an applicable commit rule rather than pretending it fired after success.
func (s *Server) hasCommitRule(c *session, q statement) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, r := range s.rules {
		x := r.Selector
		if r.Phase == "commit" && (x.Application == "" || x.Application == c.app) && (x.Database == "" || x.Database == c.db) && (x.User == "" || x.User == c.user) && (x.ConnectionID == "" || x.ConnectionID == c.id) && (x.SQLHash == "" || x.SQLHash == q.hash) && (x.Command == "" || x.Command == q.command || x.Command == "SYNC") {
			return true
		}
	}
	return false
}
