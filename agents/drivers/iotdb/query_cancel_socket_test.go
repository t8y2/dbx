package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/apache/thrift/lib/go/thrift"

	"github.com/apache/iotdb-client-go/v2/client"
	"github.com/apache/iotdb-client-go/v2/common"
	"github.com/apache/iotdb-client-go/v2/rpc"
)

// cancelSocketHandler is a minimal real-socket IoTDB endpoint whose query RPC
// never answers, so the client parks in a Thrift socket read. It exists to
// prove that the agent's cancel_session path (cancelActiveQuery) can interrupt
// that read instead of waiting for the server.
type cancelSocketHandler struct {
	rpc.IClientRPCService

	queryStarted     chan struct{}
	queryStartedOnce sync.Once
	release          chan struct{}
	releaseOnce      sync.Once
}

func newCancelSocketHandler() *cancelSocketHandler {
	return &cancelSocketHandler{queryStarted: make(chan struct{}), release: make(chan struct{})}
}

func (h *cancelSocketHandler) releaseAll() {
	h.releaseOnce.Do(func() { close(h.release) })
}

func (h *cancelSocketHandler) OpenSession(context.Context, *rpc.TSOpenSessionReq) (*rpc.TSOpenSessionResp, error) {
	resp := rpc.NewTSOpenSessionResp()
	resp.Status = &common.TSStatus{Code: client.SuccessStatus}
	sessionID := int64(5)
	resp.SessionId = &sessionID
	resp.Configuration = map[string]string{}
	return resp, nil
}

func (h *cancelSocketHandler) RequestStatementId(context.Context, int64) (int64, error) {
	return 9, nil
}

func (h *cancelSocketHandler) CloseSession(context.Context, *rpc.TSCloseSessionReq) (*common.TSStatus, error) {
	return &common.TSStatus{Code: client.SuccessStatus}, nil
}

func (h *cancelSocketHandler) ExecuteQueryStatementV2(context.Context, *rpc.TSExecuteStatementReq) (*rpc.TSExecuteStatementResp, error) {
	h.queryStartedOnce.Do(func() { close(h.queryStarted) })
	<-h.release
	return nil, fmt.Errorf("query was never answered")
}

func TestCancelActiveQueryInterruptsBlockedSocket(t *testing.T) {
	handler := newCancelSocketHandler()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	processor := rpc.NewIClientRPCServiceProcessor(handler)
	serveCtx, stopServing := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func(conn net.Conn) {
				defer wg.Done()
				defer conn.Close()
				conf := &thrift.TConfiguration{}
				trans := thrift.NewTFramedTransportConf(thrift.NewTSocketFromConnConf(conn, conf), conf)
				iprot := thrift.NewTBinaryProtocolFactoryConf(conf).GetProtocol(trans)
				oprot := thrift.NewTBinaryProtocolFactoryConf(conf).GetProtocol(trans)
				for serveCtx.Err() == nil {
					if _, err := processor.Process(serveCtx, iprot, oprot); err != nil {
						return
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() {
		handler.releaseAll()
		stopServing()
		_ = ln.Close()
		wg.Wait()
	})

	addr := ln.Addr().(*net.TCPAddr)
	session := client.NewSession(&client.Config{
		Host:            addr.IP.String(),
		Port:            fmt.Sprintf("%d", addr.Port),
		UserName:        "root",
		Password:        "root",
		FetchSize:       16,
		TimeZone:        client.DefaultTimeZone,
		ConnectRetryMax: 3,
	})
	if err := session.Open(false, 2000); err != nil {
		t.Fatalf("open session: %v", err)
	}
	connected := &sessionClient{session: &nativeIoTDBSession{session: &session}, dialect: client.TreeSqlDialect}
	server := &server{client: connected}

	done := make(chan error, 1)
	go func() {
		_, err := runCancelable(server, 0, connected, func(ctx context.Context) (struct{}, error) {
			_, err := connected.session.ExecuteQueryStatement(ctx, "select v from root.s", nil)
			return struct{}{}, err
		})
		done <- err
	}()

	select {
	case <-handler.queryStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("query RPC was never issued")
	}
	started := time.Now()
	server.cancelActiveQuery()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("runCancelable() error = %v, want context.Canceled", err)
		}
		if elapsed := time.Since(started); elapsed > 5*time.Second {
			t.Fatalf("cancel_session took %s to interrupt the blocked RPC", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel_session did not interrupt the blocked socket read")
	}
}
