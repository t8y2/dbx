package faultproxy

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
)

type session struct {
	s        *Server
	id       string
	down, up net.Conn
	client   *pgproto3.Backend
	upstream *pgproto3.Frontend
	ctx      context.Context
	cancel   context.CancelFunc

	// Shared metadata and socket shutdown are protected by mu.
	mu            sync.Mutex
	app, db, user string
	tx            byte
	pid           uint32
	key           []byte

	// The protocol loop alone owns all fields below.
	statements, portals map[string]statement
	operationDeadline   time.Time
	implicitHash        string
	discard             bool
	cycleExecuted       bool
	implicitPending     bool
	commitInFlight      bool
	cycleFailed         bool
}

func newSession(s *Server, id string, conn net.Conn) *session {
	ctx, cancel := context.WithCancel(context.Background())
	c := &session{s: s, id: id, down: conn, ctx: ctx, cancel: cancel, tx: 'I', statements: map[string]statement{}, portals: map[string]statement{}}
	c.client = pgproto3.NewBackend(conn, conn)
	c.client.SetMaxBodyLen(1 << 20)
	return c
}
func (c *session) stop() {
	c.cancel()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.down.Close()
	if c.up != nil {
		c.up.Close()
	}
}
func (c *session) txStatus() byte { c.mu.Lock(); defer c.mu.Unlock(); return c.tx }
func (c *session) setTx(tx byte)  { c.mu.Lock(); c.tx = tx; c.mu.Unlock() }
func (c *session) event(kind string, q statement, outcome string) {
	c.s.emit(Event{ConnectionID: c.id, Kind: kind, Command: q.command, SQLHash: q.hash, Outcome: outcome})
}
func (c *session) sendClient(msg pgproto3.BackendMessage) error {
	c.down.SetWriteDeadline(time.Now().Add(c.s.cfg.IOTimeout))
	c.client.Send(msg)
	return c.client.Flush()
}
func (c *session) sendUp(msg pgproto3.FrontendMessage, flush bool) error {
	c.up.SetWriteDeadline(time.Now().Add(c.s.cfg.IOTimeout))
	c.upstream.Send(msg)
	if flush {
		c.upstream.Send(&pgproto3.Flush{})
	}
	return c.upstream.Flush()
}
func (c *session) receiveUp() (pgproto3.BackendMessage, error) {
	c.up.SetReadDeadline(c.operationDeadline)
	return c.upstream.Receive()
}
func (c *session) fatal(message string) {
	_ = c.sendClient(&pgproto3.ErrorResponse{Severity: "FATAL", SeverityUnlocalized: "FATAL", Code: "08006", Message: message})
}
func (c *session) run() {
	defer func() {
		if recover() != nil {
			c.event("protocol_rejected", statement{}, "connection_closed")
		}
		outcome := "closed"
		if c.commitInFlight {
			outcome = "unknown"
		} else if c.txStatus() != 'I' || c.implicitPending {
			outcome = "uncommitted_connection_closed"
		}
		c.stop()
		c.event("disconnected", statement{}, outcome)
	}()
	if err := c.startup(); err != nil {
		c.fatal("fault lab connection rejected: PostgreSQL 17, wire 3.0, loopback and non-TLS only")
		return
	}
	if c.upstream == nil {
		return
	}
	c.event("connected", statement{}, "")
	for {
		c.down.SetReadDeadline(time.Now().Add(c.s.cfg.IOTimeout))
		msg, err := c.client.Receive()
		if err != nil {
			return
		}
		if _, ok := msg.(*pgproto3.Terminate); ok {
			return
		}
		if c.discard {
			if _, ok := msg.(*pgproto3.Sync); !ok {
				continue
			}
		}
		if err = c.handle(msg); err != nil {
			c.fatal(err.Error())
			return
		}
	}
}
func (c *session) startup() error {
	c.operationDeadline = time.Now().Add(c.s.cfg.IOTimeout)
	c.down.SetDeadline(c.operationDeadline)
	var start *pgproto3.StartupMessage
	for attempts := 0; attempts < 3; attempts++ {
		msg, err := c.client.ReceiveStartupMessage()
		if err != nil {
			return err
		}
		switch m := msg.(type) {
		case *pgproto3.SSLRequest, *pgproto3.GSSEncRequest:
			if _, err = c.down.Write([]byte{'N'}); err != nil {
				return err
			}
		case *pgproto3.CancelRequest:
			return c.s.cancelRequest(m)
		case *pgproto3.StartupMessage:
			start = m
		default:
			return errors.New("unsupported startup")
		}
		if start != nil {
			break
		}
	}
	if start != nil && start.ProtocolVersion != pgproto3.ProtocolVersion30 {
		return errors.New("only protocol 3.0 supported")
	}
	if start == nil {
		return errors.New("startup negotiation limit")
	}
	if _, ok := start.Parameters["replication"]; ok {
		return errors.New("replication unsupported")
	}
	if start.Parameters["options"] != "" {
		return errors.New("startup options unsupported")
	}
	c.mu.Lock()
	c.app = start.Parameters["application_name"]
	c.db = start.Parameters["database"]
	c.user = start.Parameters["user"]
	if c.db == "" {
		c.db = c.user
	}
	c.mu.Unlock()
	if len(c.app) > 256 || len(c.db) > 63 || len(c.user) > 63 {
		return errors.New("startup metadata limit")
	}
	if err := c.s.gate(c, "connect", statement{}); err != nil {
		return err
	}
	up, err := (&net.Dialer{Timeout: c.s.cfg.IOTimeout}).DialContext(c.ctx, "tcp", c.s.cfg.Upstream)
	if err != nil {
		return errors.New("synthetic upstream unavailable")
	}
	c.mu.Lock()
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		up.Close()
		return c.ctx.Err()
	}
	c.up = up
	c.mu.Unlock()
	c.upstream = pgproto3.NewFrontend(up, up)
	c.upstream.SetMaxBodyLen(1 << 20)
	if err = c.sendUp(start, false); err != nil {
		return errors.New("startup write failed")
	}
	versionSeen := false
	for {
		msg, err := c.receiveUp()
		if err != nil {
			return errors.New("upstream startup failed")
		}
		auth := uint32(0)
		password := false
		switch m := msg.(type) {
		case *pgproto3.AuthenticationCleartextPassword:
			auth = pgproto3.AuthTypeCleartextPassword
			password = true
		case *pgproto3.AuthenticationMD5Password:
			auth = pgproto3.AuthTypeMD5Password
			password = true
		case *pgproto3.AuthenticationSASL:
			auth = pgproto3.AuthTypeSASL
			password = true
		case *pgproto3.AuthenticationSASLContinue:
			auth = pgproto3.AuthTypeSASLContinue
			password = true
		case *pgproto3.AuthenticationOk, *pgproto3.AuthenticationSASLFinal:
		case *pgproto3.BackendKeyData:
			c.mu.Lock()
			c.pid = m.ProcessID
			if len(m.SecretKey) != 4 {
				c.mu.Unlock()
				return errors.New("only protocol 3.0 cancel keys supported")
			}
			c.key = append([]byte(nil), m.SecretKey...)
			c.mu.Unlock()
		case *pgproto3.ParameterStatus:
			if m.Name == "server_version" {
				versionSeen = true
				major, _ := strconv.Atoi(strings.Split(m.Value, ".")[0])
				if major != 17 {
					return errors.New("PostgreSQL 17 required")
				}
			}
			if m.Name == "standard_conforming_strings" && m.Value != "on" {
				return errors.New("standard_conforming_strings must be on")
			}
		case *pgproto3.ReadyForQuery:
			if !versionSeen {
				return errors.New("upstream omitted server version")
			}
			c.setTx(m.TxStatus)
		case *pgproto3.ErrorResponse:
			return errors.New("upstream rejected authentication")
		default:
			return errors.New("unsupported startup response")
		}
		if err = c.sendClient(msg); err != nil {
			return err
		}
		if password {
			if err = c.client.SetAuthType(auth); err != nil {
				return err
			}
			response, err := c.client.Receive()
			if err != nil {
				return err
			}
			switch response.(type) {
			case *pgproto3.PasswordMessage, *pgproto3.SASLInitialResponse, *pgproto3.SASLResponse:
			default:
				return errors.New("expected authentication response")
			}
			if err = c.sendUp(response, false); err != nil {
				return err
			}
		}
		if _, ok := msg.(*pgproto3.ReadyForQuery); ok {
			c.down.SetDeadline(time.Time{})
			return nil
		}
	}
}
func (s *Server) cancelRequest(req *pgproto3.CancelRequest) error {
	s.mu.Lock()
	var target *session
	paused := false
	for _, c := range s.sessions {
		c.mu.Lock()
		matches := c.pid != 0 && c.pid == req.ProcessID && subtle.ConstantTimeCompare(c.key, req.SecretKey) == 1
		c.mu.Unlock()
		if matches {
			target = c
			break
		}
	}
	if target != nil {
		for _, p := range s.pauses {
			if p.ConnectionID == target.id {
				paused = true
				break
			}
		}
	}
	s.mu.Unlock()
	if target == nil {
		return nil
	}
	if paused {
		target.stop()
		return nil
	}
	conn, err := net.DialTimeout("tcp", s.cfg.Upstream, s.cfg.IOTimeout)
	if err != nil {
		return errors.New("cancel upstream unavailable")
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(s.cfg.IOTimeout))
	wire, err := req.Encode(nil)
	if err != nil {
		return err
	}
	if _, err = conn.Write(wire); err != nil {
		return err
	}
	var b [1]byte
	_, _ = conn.Read(b[:])
	return nil
}
func (c *session) before(q statement) error {
	if q.commit() {
		if err := c.s.gate(c, "commit", q); err != nil {
			return err
		}
	}
	if err := c.s.gate(c, "execute", q); err != nil {
		return err
	}
	if q.commit() {
		c.commitInFlight = true
	}
	c.event("forwarding", q, "")
	return nil
}
func (c *session) handle(msg pgproto3.FrontendMessage) error {
	var q statement
	var err error
	mode := ""
	switch m := msg.(type) {
	case *pgproto3.Query:
		if c.cycleExecuted {
			return errors.New("simple query before Sync unsupported")
		}
		q, err = classify(m.String)
		if err != nil {
			return err
		}
		if c.txStatus() == 'I' && !q.commit() && q.command != "BEGIN" && q.command != "START" && q.command != "EMPTY" {
			if c.s.hasCommitRule(c, q) {
				return errors.New("simple autocommit cannot pause between execution and commit; use an explicit transaction or extended protocol")
			}
			c.commitInFlight = true
		}
		if err = c.before(q); err != nil {
			c.commitInFlight = false
			return err
		}
		mode = "query"
	case *pgproto3.Parse:
		if len(m.Name) > 128 {
			return errors.New("prepared statement name exceeds limit")
		}
		if m.Name == "" {
			delete(c.statements, "")
		}
		if c.cycleExecuted {
			return errors.New("pipelining multiple executions before Sync unsupported")
		}
		if len(c.statements) >= 256 {
			if _, ok := c.statements[m.Name]; !ok {
				return errors.New("prepared statement limit")
			}
		}
		q, err = classify(m.Query)
		if err != nil {
			return err
		}
		mode = "parse"
	case *pgproto3.Bind:
		if len(m.PreparedStatement) > 128 || len(m.DestinationPortal) > 128 {
			return errors.New("portal name exceeds limit")
		}
		if m.DestinationPortal == "" {
			delete(c.portals, "")
		}
		if c.cycleExecuted {
			return errors.New("pipelining multiple executions before Sync unsupported")
		}
		var ok bool
		q, ok = c.statements[m.PreparedStatement]
		if !ok {
			return errors.New("unknown prepared statement")
		}
		if len(c.portals) >= 256 {
			if _, ok := c.portals[m.DestinationPortal]; !ok {
				return errors.New("portal limit")
			}
		}
		mode = "bind"
	case *pgproto3.Describe:
		if m.ObjectType != 'S' && m.ObjectType != 'P' {
			return errors.New("unsupported Describe target")
		}
		mode = "describe"
	case *pgproto3.Close:
		if m.ObjectType != 'S' && m.ObjectType != 'P' {
			return errors.New("unsupported Close target")
		}
		mode = "close"
	case *pgproto3.Execute:
		if c.cycleExecuted || m.MaxRows != 0 {
			return errors.New("pipeline or suspended portal execution unsupported")
		}
		var ok bool
		q, ok = c.portals[m.Portal]
		if !ok {
			return errors.New("unknown portal")
		}
		if err = c.before(q); err != nil {
			return err
		}
		mode = "execute"
		c.cycleExecuted = true
	case *pgproto3.Sync:
		if c.implicitPending {
			q = statement{command: "SYNC", hash: c.implicitHash}
			if err = c.s.gate(c, "commit", q); err != nil {
				return err
			}
			c.commitInFlight = true
		}
		mode = "sync"
	case *pgproto3.Flush:
		return c.sendUp(m, false)
	default:
		return errors.New("unsupported frontend message; COPY, replication and fast-path disabled")
	}
	c.operationDeadline = time.Now().Add(c.s.cfg.IOTimeout)
	if err = c.sendUp(msg, mode != "query" && mode != "sync"); err != nil {
		return errors.New("upstream send failed; transaction outcome may be unknown")
	}
	failed, err := c.responses(mode, q)
	if err != nil {
		return err
	}
	if failed || c.cycleFailed {
		return nil
	}
	switch m := msg.(type) {
	case *pgproto3.Parse:
		c.statements[m.Name] = q
	case *pgproto3.Bind:
		c.portals[m.DestinationPortal] = q
	case *pgproto3.Close:
		if m.ObjectType == 'S' {
			delete(c.statements, m.Name)
		} else {
			delete(c.portals, m.Name)
		}
	}
	return nil
}
func (c *session) responses(mode string, q statement) (bool, error) {
	failed := false
	for {
		msg, err := c.receiveUp()
		if err != nil {
			return failed, errors.New("upstream response lost; inspect transaction outcome event")
		}
		terminal := false
		switch m := msg.(type) {
		case *pgproto3.ErrorResponse:
			failed = true
			c.cycleFailed = true
			c.s.emit(Event{ConnectionID: c.id, Kind: "upstream_error", Command: q.command, SQLHash: q.hash, SQLState: m.Code})
			if mode != "query" && mode != "sync" {
				c.discard = true
				terminal = true
			}
		case *pgproto3.ReadyForQuery:
			if mode != "query" && mode != "sync" {
				return failed, errors.New("unexpected ReadyForQuery")
			}
			c.setTx(m.TxStatus)
			c.discard = false
			c.cycleExecuted = false
			if m.TxStatus == 'I' {
				c.portals = map[string]statement{}
			}
			if c.commitInFlight {
				if failed || c.cycleFailed {
					c.event("transaction_result", q, "rejected")
				} else {
					c.event("transaction_result", q, "committed")
				}
				c.commitInFlight = false
			}
			c.implicitPending = false
			c.implicitHash = ""
			c.cycleFailed = false
			terminal = true
		case *pgproto3.CommandComplete:
			tag := string(m.CommandTag)
			c.event("upstream_success", q, "")
			if tag == "BEGIN" {
				c.setTx('T')
			}
			if (tag == "COMMIT" || tag == "ROLLBACK") && !q.rollbackTo {
				c.setTx('I')
				outcome := "committed"
				if tag == "ROLLBACK" {
					outcome = "rolled_back"
				}
				c.event("transaction_result", q, outcome)
				c.commitInFlight = false
			}
			if mode == "execute" {
				if c.txStatus() == 'I' && !q.commit() && q.command != "ROLLBACK" && q.command != "ABORT" {
					c.implicitPending = true
					c.implicitHash = q.hash
				}
				terminal = true
			}
		case *pgproto3.EmptyQueryResponse:
			if mode == "execute" {
				terminal = true
			}
		case *pgproto3.ParseComplete:
			if mode != "parse" {
				return failed, errors.New("unexpected ParseComplete")
			}
			terminal = true
		case *pgproto3.BindComplete:
			if mode != "bind" {
				return failed, errors.New("unexpected BindComplete")
			}
			terminal = true
		case *pgproto3.CloseComplete:
			if mode != "close" {
				return failed, errors.New("unexpected CloseComplete")
			}
			terminal = true
		case *pgproto3.RowDescription, *pgproto3.NoData:
			if mode == "describe" {
				terminal = true
			}
		case *pgproto3.DataRow, *pgproto3.ParameterDescription, *pgproto3.NoticeResponse, *pgproto3.NotificationResponse:
		case *pgproto3.ParameterStatus:
			if m.Name == "standard_conforming_strings" && m.Value != "on" {
				return failed, errors.New("unsupported string escape mode")
			}
		default:
			return failed, errors.New("unsupported upstream protocol response")
		}
		if err = c.sendClient(msg); err != nil {
			return failed, errors.New("client response delivery failed")
		}
		if terminal {
			return failed, nil
		}
	}
}
