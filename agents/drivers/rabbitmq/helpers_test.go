package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func mustObject(t *testing.T, source string) jsonObject {
	t.Helper()
	result := jsonObject{}
	if err := decodeJSON([]byte(source), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestParseAddresses(t *testing.T) {
	tests := []struct {
		name        string
		value       string
		defaultPort int
		want        []address
		wantError   string
	}{
		{name: "pairs", value: "host1:5672,host2:5673", defaultPort: 5672, want: []address{{"host1", 5672}, {"host2", 5673}}},
		{name: "bare host", value: "rabbit", defaultPort: 5679, want: []address{{"rabbit", 5679}}},
		{name: "blank entries", value: " , rabbit:5672, ", defaultPort: 5679, want: []address{{"rabbit", 5672}}},
		{name: "ipv6", value: "[::1]:5672", defaultPort: 5679, want: []address{{"::1", 5672}}},
		{name: "blank", value: " , ", defaultPort: 5672, wantError: "addresses is required"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseAddresses(test.value, test.defaultPort)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("got error %v, want %q", err, test.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(test.want) {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
			for index := range got {
				if got[index] != test.want[index] {
					t.Fatalf("got %#v, want %#v", got, test.want)
				}
			}
		})
	}
}

func TestResolveAddresses(t *testing.T) {
	tests := []struct {
		name      string
		config    jsonObject
		want      []address
		wantError string
	}{
		{name: "explicit port", config: mustObject(t, `{"addresses":"rabbit","port":5679}`), want: []address{{"rabbit", 5679}}},
		{name: "default port", config: mustObject(t, `{"addresses":"rabbit"}`), want: []address{{"rabbit", 5672}}},
		{name: "host fallback", config: mustObject(t, `{"host":"rabbit"}`), want: []address{{"rabbit", 5672}}},
		{name: "missing", config: mustObject(t, `{}`), wantError: "addresses is required"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveAddresses(test.config)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("got error %v, want %q", err, test.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(test.want) || got[0] != test.want[0] {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestPeekNormalizationAndRoutingKey(t *testing.T) {
	if normalizePeekOffset(-1) != 0 || normalizePeekOffset(4) != 4 {
		t.Fatal("unexpected offset normalization")
	}
	if normalizePeekCount(0) != 1 || normalizePeekCount(8) != 8 {
		t.Fatal("unexpected count normalization")
	}
	tests := []struct {
		params jsonObject
		want   string
	}{
		{mustObject(t, `{"routing_key":"explicit","routingKey":"camel","key":"message"}`), "explicit"},
		{mustObject(t, `{"routingKey":"camel","key":"message"}`), "camel"},
		{mustObject(t, `{"key":"message"}`), "message"},
		{mustObject(t, `{"key":"  "}`), "queue"},
		{mustObject(t, `{}`), "queue"},
	}
	for _, test := range tests {
		if got := resolveRoutingKey(test.params, "queue"); got != test.want {
			t.Fatalf("got %q, want %q", got, test.want)
		}
	}
	if got := peekMessageCapacity(10, 3, int(^uint(0)>>1)); got != 7 {
		t.Fatalf("unexpected bounded capacity %d", got)
	}
	if got := peekMessageCapacity(2, 5, 10); got != 0 {
		t.Fatalf("unexpected exhausted capacity %d", got)
	}
}

func TestTLSAndManagementConfiguration(t *testing.T) {
	if tlsSkipVerify(mustObject(t, `{"tls_skip_verify":true}`)) != true {
		t.Fatal("top-level skip verify not detected")
	}
	if tlsSkipVerify(mustObject(t, `{"tls":{"skip_verify":true}}`)) != true {
		t.Fatal("nested skip verify not detected")
	}
	if managementTLS(mustObject(t, `{"tls_skip_verify":true}`)) {
		t.Fatal("skip verify must not enable management TLS")
	}
	if !managementTLS(mustObject(t, `{"tls":{}}`)) || !managementTLS(mustObject(t, `{"properties":{"ssl":true}}`)) {
		t.Fatal("management TLS not detected")
	}
	if managementPort(jsonObject{}, false) != 15672 || managementPort(jsonObject{}, true) != 15671 {
		t.Fatal("unexpected default management ports")
	}
	if managementPort(mustObject(t, `{"properties":{"management_port":55672}}`), false) != 55672 {
		t.Fatal("management port override ignored")
	}
}

func TestCredentialAndAuthHelpers(t *testing.T) {
	config := mustObject(t, `{"username":" ","password":null}`)
	if credentialOrGuest(config, "username") != "guest" || credentialOrGuest(config, "password") != "guest" {
		t.Fatal("blank credentials did not fall back to guest")
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("guest:guest"))
	if got := basicAuthHeader("guest", "guest"); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestPathEncoding(t *testing.T) {
	if got := urlEncodeVhost("/"); got != "%2F" {
		t.Fatalf("got %q", got)
	}
	if got := urlEncodePathSegment("queue one"); got != "queue%20one" {
		t.Fatalf("got %q", got)
	}
	if got := urlEncodeName("127.0.0.1:1 -> 127.0.0.1:2"); !strings.Contains(got, "%20-%3E%20") {
		t.Fatalf("got %q", got)
	}
}

func TestHandshakeAndRequestErrors(t *testing.T) {
	service := newServer()
	response, shutdown := service.handleRequest([]byte(`{"jsonrpc":"2.0","id":1,"method":"handshake","params":{}}`))
	if shutdown || response.Error != nil {
		t.Fatalf("unexpected response: %#v", response)
	}
	result, ok := response.Result.(handshakeResult)
	if !ok || result.ProtocolVersion != 1 || result.AgentProtocolVersion != 1 || len(result.Capabilities) != len(capabilities) {
		t.Fatalf("unexpected handshake: %#v", response.Result)
	}
	response, _ = service.handleRequest([]byte(`{"jsonrpc":"2.0","id":2,"method":"unknown","params":{}}`))
	if response.Error == nil || !strings.Contains(response.Error.Message, "Unknown method") {
		t.Fatalf("unexpected response: %#v", response)
	}
	response, _ = service.handleRequest([]byte(`not json`))
	if response.Error == nil || string(response.ID) != "null" {
		t.Fatalf("unexpected malformed response: %#v", response)
	}
	response, _ = service.handleRequest([]byte(`{"jsonrpc":"2.0","id":7,"params":{}}`))
	if response.Error == nil || string(response.ID) != "7" {
		t.Fatalf("unexpected missing-method response: %#v", response)
	}
	encoded, err := json.Marshal(response)
	if err != nil || !strings.Contains(string(encoded), `"id":7`) {
		t.Fatalf("unexpected JSON: %s, %v", encoded, err)
	}
}

func TestAllVhostsGuardsAndEffectiveVhost(t *testing.T) {
	service := newServer()
	for method := range allVhostsUnsupportedMethods {
		_, _, err := service.dispatch(method, mustObject(t, `{"all_vhosts":true}`))
		if err == nil || err.Error() != "all_vhosts is only supported for list operations" {
			t.Fatalf("%s: %v", method, err)
		}
	}
	connection := mustObject(t, `{"virtual_host":"connected"}`)
	if got := effectiveVhost(mustObject(t, `{"virtual_host":"explicit"}`), connection); got != "explicit" {
		t.Fatalf("got %q", got)
	}
	if got := effectiveVhost(mustObject(t, `{"virtual_host":" "}`), connection); got != "connected" {
		t.Fatalf("got %q", got)
	}
	if got := effectiveVhost(jsonObject{}, nil); got != "/" {
		t.Fatalf("got %q", got)
	}
	if allVhostsRequested(jsonObject{}) {
		t.Fatal("all_vhosts should default false")
	}
	if got := managementListPath(jsonObject{}, connection, "queues"); got != "/api/queues/connected" {
		t.Fatalf("got %q", got)
	}
	if got := managementListPath(mustObject(t, `{"all_vhosts":true,"virtual_host":"ignored"}`), connection, "queues"); got != "/api/queues" {
		t.Fatalf("got %q", got)
	}
	if got := vhostFilter(mustObject(t, `{"all_vhosts":true}`), connection); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestSemanticGuards(t *testing.T) {
	if _, err := queueName(jsonObject{}); err == nil || !strings.Contains(err.Error(), "queue name") {
		t.Fatal(err)
	}
	if _, err := namespaceName(jsonObject{}); err == nil || err.Error() != "namespace is required" {
		t.Fatal(err)
	}
	if _, err := namespaceName(mustObject(t, `{"namespace":"*"}`)); err == nil {
		t.Fatal("all-vhosts namespace accepted")
	}
	if err := assertNamespaceDeletable("/", ""); err == nil {
		t.Fatal("default vhost deletion accepted")
	}
	if err := assertNamespaceDeletable("orders", "orders"); err == nil {
		t.Fatal("connected vhost deletion accepted")
	}
	for _, exchangeType := range []string{"direct", "fanout", "topic", "headers"} {
		if _, err := validateExchangeType(exchangeType); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := validateExchangeType("stream"); err == nil {
		t.Fatal("invalid exchange type accepted")
	}
	for _, name := range []string{"", "amq.direct"} {
		if err := assertExchangeDeletable(name); err == nil {
			t.Fatalf("exchange %q accepted", name)
		}
	}
	if _, err := permissionVhost(jsonObject{}); err == nil {
		t.Fatal("blank permission vhost accepted")
	}
	if _, err := permissionVhost(mustObject(t, `{"virtual_host":"*"}`)); err == nil {
		t.Fatal("all-vhosts permission accepted")
	}
	if err := assertNotConnectedUser("delete", "dbx", "dbx"); err == nil {
		t.Fatal("connected user mutation accepted")
	}
}

func TestPermissionAndUserHelpers(t *testing.T) {
	if permissionPattern(jsonObject{}, "read") != ".*" || permissionPattern(mustObject(t, `{"read":"^q"}`), "read") != "^q" {
		t.Fatal("unexpected permission pattern")
	}
	if got := parseUserTags("administrator, management, ,policymaker"); len(got) != 3 || got[1] != "management" {
		t.Fatalf("got %#v", got)
	}
	if got := userTagsParam(mustObject(t, `{"tags":["management"," policymaker ",""]}`)); got != "management,policymaker" {
		t.Fatalf("got %q", got)
	}
	if got := userTagsParam(mustObject(t, `{"tags":"administrator,management"}`)); got != "administrator,management" {
		t.Fatalf("got %q", got)
	}
}

func TestAMQPErrorMapping(t *testing.T) {
	tests := []struct {
		code int
		text string
		want string
	}{
		{405, "RESOURCE_LOCKED - cannot obtain exclusive access to locked queue 'q1'", "Queue 'q1' is exclusive"},
		{405, "RESOURCE_LOCKED", "The queue is exclusive"},
		{404, "NOT_FOUND - no queue 'q1' in vhost '/'", "Queue 'q1' was not found"},
		{404, "NOT_FOUND - no exchange 'events' in vhost '/'", "Exchange 'events' was not found"},
		{406, "PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'q1' in vhost '/'", "Queue 'q1' already exists"},
		{406, "PRECONDITION_FAILED - inequivalent arg 'type' for exchange 'events' in vhost '/'", "Exchange 'events' already exists"},
		{403, "ACCESS_REFUSED - access to queue 'q1' refused", "Access to 'q1' was refused"},
	}
	for _, test := range tests {
		if got := mapAMQPError(test.code, test.text); !strings.Contains(got, test.want) {
			t.Fatalf("got %q, want substring %q", got, test.want)
		}
	}
	if got := mapAMQPError(320, "CONNECTION_FORCED"); got != "" {
		t.Fatalf("unexpected mapping %q", got)
	}
	if got := extractDeclaredResourceName("inequivalent arg 'durable' for queue 'q1' in vhost '/'"); got != "q1" {
		t.Fatalf("got %q", got)
	}
	if got := extractQuotedName("access to queue 'q1' refused for user 'dbx'"); got != "q1" {
		t.Fatalf("got %q", got)
	}
}
