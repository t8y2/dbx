package main

import (
	"context"
	"encoding/base64"
	"net"
	"strings"
	"testing"
	"time"

	admin "github.com/amigoer/rocketmq-admin-go"
	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
	"github.com/apache/rocketmq-client-go/v2/primitive"
)

func TestBuildSendMessageCommandCopiesOnlyUserProperties(t *testing.T) {
	command := buildSendMessageCommand("Orders", []byte("payload"), 3, map[string]any{
		"headers": map[string]any{
			primitive.PropertyTags:           "tag-a",
			primitive.PropertyKeys:           "key-a",
			primitive.PropertyDelayTimeLevel: "18",
			"Region":                         "Hangzhou",
			"color":                          "blue",
			"empty":                          " ",
			"nil":                            nil,
		},
	}, 1234)
	if command.Code != sendMessageRequestCode || command.ExtFields["queueId"] != "3" {
		t.Fatalf("unexpected send command: %#v", command)
	}
	properties := command.ExtFields["properties"]
	for _, expected := range []string{"TAGS\x01tag-a\x02", "KEYS\x01key-a\x02", "Region\x01Hangzhou\x02", "color\x01blue\x02"} {
		if !strings.Contains(properties, expected) {
			t.Fatalf("missing property %q in %q", expected, properties)
		}
	}
	for _, forbidden := range []string{"DELAY\x01", "empty\x01", "nil\x01"} {
		if strings.Contains(properties, forbidden) {
			t.Fatalf("reserved/empty property %q leaked into %q", forbidden, properties)
		}
	}
}

func TestBuildQueryMessageCommandUsesBrokerHeaderNames(t *testing.T) {
	command := buildQueryMessageCommand("Orders", "order-1", 32, 100, 200)
	if command.ExtFields["beginTimestamp"] != "100" || command.ExtFields["endTimestamp"] != "200" {
		t.Fatalf("unexpected query fields: %#v", command.ExtFields)
	}
	if _, exists := command.ExtFields["begin"]; exists {
		t.Fatalf("legacy begin field leaked into query: %#v", command.ExtFields)
	}
	if _, exists := command.ExtFields["end"]; exists {
		t.Fatalf("legacy end field leaked into query: %#v", command.ExtFields)
	}
}

func TestInvokeRemotingAllowCodes(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		defer connection.Close()
		frame, readErr := readRemotingFrame(connection)
		if readErr != nil {
			done <- readErr
			return
		}
		request, decodeErr := remoting.Decode(frame[4:])
		if decodeErr != nil {
			done <- decodeErr
			return
		}
		response := &remoting.RemotingCommand{Code: 11, Opaque: request.Opaque, Flag: 1, ExtFields: map[string]string{}}
		encoded, encodeErr := response.Encode()
		if encodeErr == nil {
			_, encodeErr = connection.Write(encoded)
		}
		done <- encodeErr
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := invokeRemotingAllowCodes(ctx, listener.Addr().String(), time.Second,
		remoting.NewRequest(sendMessageRequestCode, nil), 0, 10, 11, 12); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestMessageMapPreservesBinaryAndTextPayloads(t *testing.T) {
	text := &admin.MessageExt{
		QueueId: 2, QueueOffset: 7, MsgId: "msg-1", Body: []byte("hello"),
		StoreTimestamp: 123, Properties: map[string]string{primitive.PropertyKeys: "key-a", primitive.PropertyTags: "tag-a"},
	}
	row := messageMap("Orders", text)
	if row["payloadText"] != "hello" || row["payloadBase64"] != base64.StdEncoding.EncodeToString([]byte("hello")) {
		t.Fatalf("unexpected text message row: %#v", row)
	}
	if row["key"] != "key-a" || row["tag"] != "tag-a" || row["partition"] != 2 {
		t.Fatalf("unexpected message metadata: %#v", row)
	}
	binary := &admin.MessageExt{Body: []byte{0xff, 0xfe}, Properties: map[string]string{}}
	binaryRow := messageMap("Binary", binary)
	if _, ok := binaryRow["payloadText"]; ok {
		t.Fatalf("binary payload exposed as text: %#v", binaryRow)
	}
}
