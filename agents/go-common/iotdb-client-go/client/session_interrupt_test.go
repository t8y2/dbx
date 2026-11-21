package client

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/apache/thrift/lib/go/thrift"

	"github.com/apache/iotdb-client-go/v2/common"
	"github.com/apache/iotdb-client-go/v2/rpc"
)

// blockingIoTServer is a minimal real-socket IoTDB endpoint. Handlers can block
// selected RPCs forever, which reproduces the situation the context cannot fix:
// the client is parked inside net.Conn.Read when the query is cancelled.
type blockingIoTServer struct {
	ln        net.Listener
	handler   *blockingIoTDBHandler
	processor thrift.TProcessor
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

type blockingIoTDBHandler struct {
	rpc.IClientRPCService // embedded nil: unimplemented RPCs panic if called

	mu             sync.Mutex
	openSessions   int
	executeCalls   int
	fetchCalls     int
	blockOpenAfter int
	failFirstQuery bool
	blockExecute   bool
	blockFetch     bool

	release          chan struct{}
	releaseOnce      sync.Once
	openBlocked      chan struct{}
	openBlockedOnce  sync.Once
	queryStarted     chan struct{}
	queryStartedOnce sync.Once
	fetchStarted     chan struct{}
	fetchStartedOnce sync.Once
}

func newBlockingIoTDBHandler() *blockingIoTDBHandler {
	return &blockingIoTDBHandler{
		release:      make(chan struct{}),
		openBlocked:  make(chan struct{}),
		queryStarted: make(chan struct{}),
		fetchStarted: make(chan struct{}),
	}
}

func (h *blockingIoTDBHandler) releaseAll() {
	h.releaseOnce.Do(func() { close(h.release) })
}

func (h *blockingIoTDBHandler) counts() (opens, executes, fetches int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.openSessions, h.executeCalls, h.fetchCalls
}

func (h *blockingIoTDBHandler) OpenSession(context.Context, *rpc.TSOpenSessionReq) (*rpc.TSOpenSessionResp, error) {
	h.mu.Lock()
	h.openSessions++
	block := h.blockOpenAfter > 0 && h.openSessions > h.blockOpenAfter
	h.mu.Unlock()
	if block {
		h.openBlockedOnce.Do(func() { close(h.openBlocked) })
		<-h.release
	}
	resp := rpc.NewTSOpenSessionResp()
	resp.Status = &common.TSStatus{Code: SuccessStatus}
	sessionID := int64(7)
	resp.SessionId = &sessionID
	resp.Configuration = map[string]string{}
	return resp, nil
}

func (h *blockingIoTDBHandler) RequestStatementId(context.Context, int64) (int64, error) {
	return 11, nil
}

func (h *blockingIoTDBHandler) CloseSession(context.Context, *rpc.TSCloseSessionReq) (*common.TSStatus, error) {
	return &common.TSStatus{Code: SuccessStatus}, nil
}

func (h *blockingIoTDBHandler) ExecuteQueryStatementV2(context.Context, *rpc.TSExecuteStatementReq) (*rpc.TSExecuteStatementResp, error) {
	h.mu.Lock()
	h.executeCalls++
	call := h.executeCalls
	block := h.blockExecute
	h.mu.Unlock()
	if h.failFirstQuery && call == 1 {
		// Returning an error makes the test server drop the connection, which
		// is what the client sees when a server disappears mid-query.
		return nil, fmt.Errorf("simulated connection loss")
	}
	if block {
		h.queryStartedOnce.Do(func() { close(h.queryStarted) })
		<-h.release
	}
	ignoreTimestamp := false
	moreData := true
	queryID := int64(3)
	resp := rpc.NewTSExecuteStatementResp()
	resp.Status = &common.TSStatus{Code: SuccessStatus}
	resp.QueryId = &queryID
	resp.MoreData = &moreData
	resp.IgnoreTimeStamp = &ignoreTimestamp
	resp.Columns = []string{"v"}
	resp.DataTypeList = []string{"INT64"}
	return resp, nil
}

func (h *blockingIoTDBHandler) FetchResultsV2(context.Context, *rpc.TSFetchResultsReq) (*rpc.TSFetchResultsResp, error) {
	h.mu.Lock()
	h.fetchCalls++
	block := h.blockFetch
	h.mu.Unlock()
	if block {
		h.fetchStartedOnce.Do(func() { close(h.fetchStarted) })
		<-h.release
	}
	status := &common.TSStatus{Code: SuccessStatus}
	return &rpc.TSFetchResultsResp{Status: status, HasResultSet: false, IsAlign: true}, nil
}

func startBlockingIoTServer(t *testing.T, handler *blockingIoTDBHandler) (host string, port string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := &blockingIoTServer{ln: ln, handler: handler, processor: rpc.NewIClientRPCServiceProcessor(handler), cancel: cancel}
	go server.serve(ctx)
	t.Cleanup(func() {
		handler.releaseAll()
		server.stop()
	})
	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), fmt.Sprintf("%d", addr.Port)
}

func (s *blockingIoTServer) serve(ctx context.Context) {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func(conn net.Conn) {
			defer s.wg.Done()
			defer conn.Close()
			conf := &thrift.TConfiguration{}
			trans := thrift.NewTFramedTransportConf(thrift.NewTSocketFromConnConf(conn, conf), conf)
			iprot := thrift.NewTBinaryProtocolFactoryConf(conf).GetProtocol(trans)
			oprot := thrift.NewTBinaryProtocolFactoryConf(conf).GetProtocol(trans)
			for ctx.Err() == nil {
				if _, err := s.processor.Process(ctx, iprot, oprot); err != nil {
					return
				}
			}
		}(conn)
	}
}

func (s *blockingIoTServer) stop() {
	s.cancel()
	_ = s.ln.Close()
	s.wg.Wait()
}

func openBlockingSession(t *testing.T, host, port string) *Session {
	t.Helper()
	session := NewSession(&Config{
		Host:            host,
		Port:            port,
		UserName:        "root",
		Password:        "root",
		FetchSize:       16,
		TimeZone:        DefaultTimeZone,
		ConnectRetryMax: 3,
	})
	if err := session.Open(false, 2000); err != nil {
		t.Fatalf("open session: %v", err)
	}
	return &session
}

// TestQueryDeadlineInterruptsBlockedRpc proves that a deadline aborts an
// ExecuteQueryStatement RPC that is parked in a socket read. Passing the ctx to
// Thrift alone cannot do this; the session must close the transport.
func TestQueryDeadlineInterruptsBlockedRpc(t *testing.T) {
	handler := newBlockingIoTDBHandler()
	handler.blockExecute = true
	host, port := startBlockingIoTServer(t, handler)
	session := openBlockingSession(t, host, port)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := session.ExecuteQueryStatementWithContext(ctx, "select v from root.s", nil)
	elapsed := time.Since(started)

	select {
	case <-handler.queryStarted:
	default:
		t.Fatalf("query RPC was never issued")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context.DeadlineExceeded", err)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("deadline took %s to interrupt the blocked RPC", elapsed)
	}
}

// TestCancelInterruptsBlockedPagedFetch covers the paged read path: the first
// page arrives, the next FetchResultsV2 blocks, and cancelling must unblock it.
func TestCancelInterruptsBlockedPagedFetch(t *testing.T) {
	handler := newBlockingIoTDBHandler()
	handler.blockFetch = true
	host, port := startBlockingIoTServer(t, handler)
	session := openBlockingSession(t, host, port)

	dataset, err := session.ExecuteQueryStatementWithContext(context.Background(), "select v from root.s", nil)
	if err != nil {
		t.Fatalf("initial query: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := dataset.NextWithContext(ctx)
		done <- err
	}()

	select {
	case <-handler.fetchStarted:
	case <-time.After(5 * time.Second):
		t.Fatalf("fetch RPC was never issued")
	}
	started := time.Now()
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
		if elapsed := time.Since(started); elapsed > 5*time.Second {
			t.Fatalf("cancel took %s to interrupt the blocked fetch", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("paged fetch stayed blocked after cancellation")
	}
}

// TestCancelInterruptsReconnectHandshake covers the reconnect path: the first
// query loses its connection, the replacement OpenSession blocks, and cancelling
// must stop both the handshake and further retries.
func TestCancelInterruptsReconnectHandshake(t *testing.T) {
	handler := newBlockingIoTDBHandler()
	handler.blockOpenAfter = 1
	handler.failFirstQuery = true
	host, port := startBlockingIoTServer(t, handler)
	session := openBlockingSession(t, host, port)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := session.ExecuteQueryStatementWithContext(ctx, "select v from root.s", nil)
		done <- err
	}()

	select {
	case <-handler.openBlocked:
	case <-time.After(5 * time.Second):
		t.Fatalf("reconnect OpenSession was never issued")
	}
	started := time.Now()
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
		if elapsed := time.Since(started); elapsed > 5*time.Second {
			t.Fatalf("cancel took %s to interrupt the reconnect handshake", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("reconnect handshake stayed blocked after cancellation")
	}

	time.Sleep(200 * time.Millisecond)
	opens, _, _ := handler.counts()
	if opens != 2 {
		t.Fatalf("OpenSession calls = %d, want 2 (no retry after cancellation)", opens)
	}
}
