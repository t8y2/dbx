package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

const rocketMQHelperProcessEnv = "DBX_ROCKETMQ_HELPER_PROCESS"

type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *synchronizedBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

func TestRocketMQAgentProcessProtocol(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRocketMQAgentHelperProcess$")
	command.Env = append(os.Environ(), rocketMQHelperProcessEnv+"=1")
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr synchronizedBuffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}

	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != `{"ready":true}` {
		t.Fatalf("unexpected ready line %q: %s", scanner.Text(), stderr.String())
	}

	writeRPCRequest(t, stdin, `{"jsonrpc":"2.0","id":1,"method":"handshake","params":{}}`)
	handshake := readRPCResponse(t, scanner, stderr.String())
	if string(handshake.ID) != "1" || handshake.Error != nil {
		t.Fatalf("unexpected handshake response: %#v", handshake)
	}
	handshakeResult, ok := handshake.Result.(map[string]any)
	if !ok || int(handshakeResult["protocolVersion"].(float64)) != protocolVersion {
		t.Fatalf("unexpected handshake result: %#v", handshake.Result)
	}

	writeRPCRequest(t, stdin, `{`)
	parseFailure := readRPCResponse(t, scanner, stderr.String())
	if string(parseFailure.ID) != "null" || parseFailure.Error == nil || parseFailure.Error.Code != -32700 {
		t.Fatalf("unexpected parse failure response: %#v", parseFailure)
	}

	writeRPCRequest(t, stdin, `{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{}}`)
	shutdown := readRPCResponse(t, scanner, stderr.String())
	if string(shutdown.ID) != "2" || shutdown.Error != nil {
		t.Fatalf("unexpected shutdown response: %#v", shutdown)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("agent process failed: %v: %s", err, stderr.String())
	}
	if ctx.Err() != nil {
		t.Fatalf("agent process timed out: %v", ctx.Err())
	}
}

func TestRocketMQAgentHelperProcess(t *testing.T) {
	if os.Getenv(rocketMQHelperProcessEnv) != "1" {
		return
	}
	main()
	os.Exit(0)
}

func writeRPCRequest(t *testing.T, stdin interface{ Write([]byte) (int, error) }, request string) {
	t.Helper()
	if _, err := fmt.Fprintln(stdin, request); err != nil {
		t.Fatal(err)
	}
}

func readRPCResponse(t *testing.T, scanner *bufio.Scanner, stderr string) rpcResponse {
	t.Helper()
	if !scanner.Scan() {
		t.Fatalf("agent closed stdout: %s", strings.TrimSpace(stderr))
	}
	var response rpcResponse
	if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
		t.Fatalf("decode response %q: %v", scanner.Text(), err)
	}
	return response
}
