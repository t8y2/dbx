package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/amigoer/rocketmq-admin-go/protocol/remoting"
)

func TestProxyRoutesPrivateBrokersAndFailsClosedOnCollision(t *testing.T) {
	manager := newProxyManager(connectionConfig{NameServers: []string{"127.0.0.1:9876"}})
	defer manager.Close()

	firstLocal, err := manager.ProxyFor("172.18.0.2:10911", proxyTargetBroker)
	if err != nil {
		t.Fatal(err)
	}
	secondLocal, err := manager.ProxyFor("172.18.0.3:10911", proxyTargetBroker)
	if err != nil {
		t.Fatal(err)
	}
	first := manager.byOriginal["172.18.0.2:10911"]
	second := manager.byOriginal["172.18.0.3:10911"]
	if !reflect.DeepEqual(first.targets, []string{"127.0.0.1:10911", "172.18.0.2:10911"}) {
		t.Fatalf("unexpected first targets: %#v", first.targets)
	}
	if !reflect.DeepEqual(second.targets, []string{"172.18.0.3:10911"}) || !second.fallback {
		t.Fatalf("collision must keep only original target: %#v", second)
	}
	if manager.OriginalForLocal(firstLocal) != "172.18.0.2:10911" || manager.OriginalForLocal(secondLocal) != "172.18.0.3:10911" {
		t.Fatal("local endpoint did not round-trip to original address")
	}
	if !manager.IsCollisionFallback(secondLocal) {
		t.Fatal("second private broker should be marked as collision fallback")
	}
}

func TestProxyRoutingHonorsSocksAndExplicitBroker(t *testing.T) {
	socksManager := newProxyManager(connectionConfig{
		NameServers: []string{"127.0.0.1:9876"},
		SocksProxy:  &socksProxyConfig{Host: "127.0.0.1", Port: 1080},
	})
	defer socksManager.Close()
	local, err := socksManager.ProxyFor("172.18.0.2:10911", proxyTargetBroker)
	if err != nil {
		t.Fatal(err)
	}
	if targets := socksManager.byOriginal[socksManager.OriginalForLocal(local)].targets; !reflect.DeepEqual(targets, []string{"172.18.0.2:10911"}) {
		t.Fatalf("SOCKS route changed logical broker: %#v", targets)
	}

	explicitManager := newProxyManager(connectionConfig{
		NameServers: []string{"127.0.0.1:9876"}, BrokerAddr: "broker.example.com:10911",
	})
	defer explicitManager.Close()
	local, err = explicitManager.ProxyFor("172.18.0.2:10911", proxyTargetBroker)
	if err != nil {
		t.Fatal(err)
	}
	if targets := explicitManager.byOriginal[explicitManager.OriginalForLocal(local)].targets; !reflect.DeepEqual(targets, []string{"broker.example.com:10911"}) {
		t.Fatalf("explicit broker was not honored: %#v", targets)
	}
}

func TestSignCommandMatchesRocketMQACLAlgorithm(t *testing.T) {
	command := remoting.NewRequest(17, map[string]string{"topic": "Orders", "perm": "6"})
	command.Body = []byte("payload")
	signCommand(command, "access", "secret")

	keys := make([]string, 0, len(command.ExtFields))
	for key := range command.ExtFields {
		if key != "Signature" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var content strings.Builder
	for _, key := range keys {
		content.WriteString(command.ExtFields[key])
	}
	mac := hmac.New(sha1.New, []byte("secret"))
	_, _ = mac.Write(append([]byte(content.String()), command.Body...))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if command.ExtFields["AccessKey"] != "access" || command.ExtFields["Signature"] != want {
		t.Fatalf("unexpected signed fields: %#v", command.ExtFields)
	}
}

func TestRepairRocketMQJSONQuotesNonStandardKeys(t *testing.T) {
	body := repairRocketMQJSON([]byte(`{"offsetTable":{{"brokerName":"broker-a","queueId":0,"topic":"Order-Events"}:{"brokerOffset":10}},brokerAddrs:{0:"127.0.0.1:10911"}}`))
	if !json.Valid(body) {
		t.Fatalf("repaired body is invalid JSON: %s", body)
	}
	if !bytes.Contains(body, []byte(`"0":`)) || !bytes.Contains(body, []byte(`"{\"brokerName\":\"broker-a\"`)) {
		t.Fatalf("missing repaired keys: %s", body)
	}
}

func TestRewriteResponseProxiesBrokerAddresses(t *testing.T) {
	manager := newProxyManager(connectionConfig{NameServers: []string{"127.0.0.1:9876"}})
	defer manager.Close()
	command := &remoting.RemotingCommand{Body: []byte(`{
		"brokerDatas":[{"brokerAddrs":{"0":"172.18.0.2:10911"}}],
		"brokerAddr":"172.18.0.3:10912",
		"filterServerTable":{"172.18.0.4:12000":[]}
	}`)}
	if err := manager.rewriteResponse(command); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(command.Body, &value); err != nil {
		t.Fatal(err)
	}
	brokerDatas := value["brokerDatas"].([]any)
	brokerLocal := brokerDatas[0].(map[string]any)["brokerAddrs"].(map[string]any)["0"].(string)
	if manager.OriginalForLocal(brokerLocal) != "172.18.0.2:10911" {
		t.Fatalf("broker address not proxied: %s", brokerLocal)
	}
	directLocal := value["brokerAddr"].(string)
	if manager.OriginalForLocal(directLocal) != "172.18.0.3:10912" {
		t.Fatalf("direct broker address not proxied: %s", directLocal)
	}
	filterTable := value["filterServerTable"].(map[string]any)
	for local := range filterTable {
		if manager.OriginalForLocal(local) != "172.18.0.4:12000" {
			t.Fatalf("filter server address not proxied: %s", local)
		}
	}
}
