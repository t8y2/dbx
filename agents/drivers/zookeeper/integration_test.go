package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-zookeeper/zk"
)

const integrationConnectStringEnv = "DBX_ZOOKEEPER_TEST_CONNECT_STRING"

func TestZooKeeperIntegration(t *testing.T) {
	connectString := os.Getenv(integrationConnectStringEnv)
	if connectString == "" {
		t.Skip(integrationConnectStringEnv + " is not set")
	}
	service := &server{statLookupConcurrency: 4}
	connection := map[string]any{"zookeeper_connect_string": connectString}
	if authScheme := os.Getenv("DBX_ZOOKEEPER_TEST_AUTH_SCHEME"); authScheme != "" {
		connection["auth_scheme"] = authScheme
		connection["username"] = os.Getenv("DBX_ZOOKEEPER_TEST_USERNAME")
		connection["password"] = os.Getenv("DBX_ZOOKEEPER_TEST_PASSWORD")
	}
	params := mustJSON(map[string]any{"connection": connection})
	if _, err := service.connect(params); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.closeClient)
	root := fmt.Sprintf("/dbx-go-integration-%d", time.Now().UnixNano())
	if _, err := service.put(mustJSON(map[string]any{"key": root + "/parent/value", "value": map[string]string{"encoding": "utf8", "data": "first"}})); err != nil {
		t.Fatal(err)
	}
	result, err := service.get(mustJSON(map[string]any{"key": root + "/parent/value"}))
	if err != nil || result["found"] != true {
		t.Fatalf("get=%#v err=%v", result, err)
	}
	badConnection := mustJSON(map[string]any{"connection": map[string]any{"zookeeper_connect_string": "127.0.0.1:1", "connection_timeout_ms": 50}})
	if _, err := service.testConnection(badConnection); err == nil {
		t.Fatal("unreachable test connection unexpectedly succeeded")
	}
	if _, err := service.connect(badConnection); err == nil {
		t.Fatal("unreachable replacement connection unexpectedly succeeded")
	}
	result, err = service.get(mustJSON(map[string]any{"key": root + "/parent/value"}))
	if err != nil || result["found"] != true {
		t.Fatalf("active connection was replaced after failed probe: get=%#v err=%v", result, err)
	}
	if _, err := service.put(mustJSON(map[string]any{"key": root + "/ephemeral-", "value": map[string]string{"data": "e"}, "writeMode": "create", "createMode": "ephemeral_sequential"})); err != nil {
		t.Fatal(err)
	}
	listed, err := service.listPrefix(mustJSON(map[string]any{"prefix": root, "recursive": true, "limit": 100}))
	if err != nil || len(listed.Keys) < 3 {
		t.Fatalf("list=%#v err=%v", listed, err)
	}
	deleted, err := service.delete(mustJSON(map[string]any{"key": root, "recursive": true}))
	if err != nil || deleted["deleted"].(int) < 4 {
		t.Fatalf("delete=%#v err=%v", deleted, err)
	}
}

func TestZooKeeperLargeChildrenIntegration(t *testing.T) {
	connectString := os.Getenv(integrationConnectStringEnv)
	if connectString == "" {
		t.Skip(integrationConnectStringEnv + " is not set")
	}
	const (
		childCount    = 1600
		childNameSize = 800
		workerCount   = 32
		listLimit     = 100
	)
	if childCount*(childNameSize+4) <= 1024*1024 {
		t.Fatal("large children fixture must exceed the Java client's default 1 MiB receive limit")
	}

	service := &server{statLookupConcurrency: 16}
	connection := map[string]any{"zookeeper_connect_string": connectString}
	if _, err := service.connect(mustJSON(map[string]any{"connection": connection})); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.closeClient)
	root := fmt.Sprintf("/dbx-go-large-children-%d", time.Now().UnixNano())
	if _, err := service.activeClient.Create(root, nil, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = service.delete(mustJSON(map[string]any{"key": root, "recursive": true})) })

	jobs := make(chan int, childCount)
	for index := 0; index < childCount; index++ {
		jobs <- index
	}
	close(jobs)
	errors := make(chan error, workerCount)
	var waitGroup sync.WaitGroup
	suffix := strings.Repeat("x", childNameSize-7)
	for worker := 0; worker < workerCount; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for index := range jobs {
				name := fmt.Sprintf("%06d-%s", index, suffix)
				if _, err := service.activeClient.Create(root+"/"+name, nil, 0); err != nil && err != zk.ErrNodeExists {
					errors <- err
					return
				}
			}
		}()
	}
	waitGroup.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}

	recursive := false
	listed, err := service.listPrefix(mustJSON(listRequest{Prefix: root, Recursive: &recursive, Limit: listLimit}))
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Keys) != listLimit || listed.Continuation == nil {
		t.Fatalf("list keys=%d continuation=%t", len(listed.Keys), listed.Continuation != nil)
	}
}

func BenchmarkZooKeeperOperations(b *testing.B) {
	connectString := os.Getenv(integrationConnectStringEnv)
	if connectString == "" {
		b.Skip(integrationConnectStringEnv + " is not set")
	}
	service := &server{statLookupConcurrency: 16}
	if _, err := service.connect(mustJSON(map[string]any{"connection": map[string]any{"zookeeper_connect_string": connectString}})); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(service.closeClient)
	root := fmt.Sprintf("/dbx-go-benchmark-%d", time.Now().UnixNano())
	if _, err := service.put(mustJSON(map[string]any{"key": root + "/value", "value": map[string]string{"data": "warmup"}})); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _, _ = service.delete(mustJSON(map[string]any{"key": root, "recursive": true})) })

	b.Run("get", func(b *testing.B) {
		params := json.RawMessage(fmt.Sprintf(`{"key":%q}`, root+"/value"))
		b.ResetTimer()
		for index := 0; index < b.N; index++ {
			if _, err := service.get(params); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("put", func(b *testing.B) {
		params := json.RawMessage(fmt.Sprintf(`{"key":%q,"value":{"data":"updated"}}`, root+"/value"))
		b.ResetTimer()
		for index := 0; index < b.N; index++ {
			if _, err := service.put(params); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("list", func(b *testing.B) {
		params := json.RawMessage(fmt.Sprintf(`{"prefix":%q,"recursive":true,"limit":100}`, root))
		b.ResetTimer()
		for index := 0; index < b.N; index++ {
			if _, err := service.listPrefix(params); err != nil {
				b.Fatal(err)
			}
		}
	})
}
