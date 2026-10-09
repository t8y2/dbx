package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestManagementBaseURLs(t *testing.T) {
	explicit, err := managementBaseURLs(mustObject(t, `{"management_url":" https://proxy:8443/rmq/ "}`))
	if err != nil || len(explicit) != 1 || explicit[0] != "https://proxy:8443/rmq" {
		t.Fatalf("unexpected explicit URLs %#v, %v", explicit, err)
	}
	withoutAddresses, err := managementBaseURLs(mustObject(t, `{"management_url":"http://mgmt:15672"}`))
	if err != nil || withoutAddresses[0] != "http://mgmt:15672" {
		t.Fatalf("unexpected URL %#v, %v", withoutAddresses, err)
	}
	derived, err := managementBaseURLs(mustObject(t, `{"addresses":"mq1:5672,mq2:5672"}`))
	if err != nil || len(derived) != 2 || derived[0] != "http://mq1:15672" || derived[1] != "http://mq2:15672" {
		t.Fatalf("unexpected derived URLs %#v, %v", derived, err)
	}
	_, err = managementBaseURLs(mustObject(t, `{"addresses":"mq1:5673"}`))
	if err == nil || !strings.Contains(err.Error(), "Management API URL is required") || !strings.Contains(err.Error(), "5673") {
		t.Fatalf("unexpected custom AMQP port error %v", err)
	}
	customPort, err := managementBaseURLs(mustObject(t, `{"addresses":"mq1:5673","properties":{"management_port":15673}}`))
	if err != nil || len(customPort) != 1 || customPort[0] != "http://mq1:15673" {
		t.Fatalf("unexpected custom management URL %#v, %v", customPort, err)
	}
	tlsDerived, err := managementBaseURLs(mustObject(t, `{"addresses":"mq1","tls":{}}`))
	if err != nil || tlsDerived[0] != "https://mq1:15671" {
		t.Fatalf("unexpected TLS URLs %#v, %v", tlsDerived, err)
	}
	skipVerify, err := managementBaseURLs(mustObject(t, `{"addresses":"mq1","tls_skip_verify":true}`))
	if err != nil || skipVerify[0] != "http://mq1:15672" {
		t.Fatalf("unexpected skip-verify URLs %#v, %v", skipVerify, err)
	}
}

func TestManagementRequestUsesConnectOverride(t *testing.T) {
	var observedHost string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		observedHost = request.Host
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"items":[]}`))
	}))
	defer server.Close()

	localAddress := strings.TrimPrefix(server.URL, "http://")
	localHost, localPortText, err := net.SplitHostPort(localAddress)
	if err != nil {
		t.Fatal(err)
	}
	localPort, err := strconv.Atoi(localPortText)
	if err != nil {
		t.Fatal(err)
	}
	managementURL := "http://rabbit.internal:" + localPortText
	connection := jsonObject{
		"management_url": managementURL,
		"management_connect_override": jsonObject{
			"host": localHost,
			"port": localPort,
		},
	}
	if _, err := managementGet(connection, "/api/queues"); err != nil {
		t.Fatal(err)
	}
	if observedHost != "rabbit.internal:"+localPortText {
		t.Fatalf("management Host header changed to %q", observedHost)
	}
}

func TestManagementErrorMessages(t *testing.T) {
	for _, status := range []int{401, 403} {
		message := managementErrorMessage(status, http.MethodGet, "/api/queues")
		if !strings.Contains(message, "management permission tag") || strings.Contains(message, "plugin must be enabled") {
			t.Fatalf("unexpected message %q", message)
		}
	}
	message := managementErrorMessage(404, http.MethodGet, "/api/queues/%2F/gone")
	if !strings.Contains(message, "plugin must be enabled") || strings.Contains(message, "management permission tag") {
		t.Fatalf("unexpected message %q", message)
	}
}

func TestManagementRequestSurfacesCredentialError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	connection := jsonObject{"management_url": server.URL}
	_, err := managementGet(connection, "/api/queues")
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") || !strings.Contains(err.Error(), "management permission tag") {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestManagementGetAllPagination(t *testing.T) {
	var mutex sync.Mutex
	requestedPages := make([]int, 0)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		page, _ := strconv.Atoi(request.URL.Query().Get("page"))
		mutex.Lock()
		requestedPages = append(requestedPages, page)
		mutex.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"items":[{"name":"q`+strconv.Itoa(page)+`"}],"page":`+strconv.Itoa(page)+`,"page_count":3,"total_count":3}`)
	}))
	defer server.Close()
	items, err := managementGetAll(jsonObject{"management_url": server.URL}, "/api/queues")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 || len(requestedPages) != 3 || requestedPages[0] != 1 || requestedPages[2] != 3 {
		t.Fatalf("unexpected items %#v pages %#v", items, requestedPages)
	}
}

func TestManagementGetAllPlainArray(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `[{"name":"guest"}]`)
	}))
	defer server.Close()
	items, err := managementGetAll(jsonObject{"management_url": server.URL}, "/api/users")
	if err != nil || len(items) != 1 {
		t.Fatalf("unexpected items %#v, %v", items, err)
	}
}

func TestManagementGetPageRequestsOnlyOneRabbitMqPage(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestCount++
		query := request.URL.Query()
		if query.Get("page") != "2" || query.Get("page_size") != "100" {
			t.Fatalf("unexpected pagination query %q", request.URL.RawQuery)
		}
		if query.Get("name") != "orders & paid" || query.Get("use_regex") != "false" {
			t.Fatalf("unexpected search query %q", request.URL.RawQuery)
		}
		if query.Get("sort") != "messages_ready" || query.Get("sort_reverse") != "true" {
			t.Fatalf("unexpected sort query %q", request.URL.RawQuery)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"items":[{"name":"orders.paid"}],"page":2,"page_size":100,"page_count":3,"total_count":10000,"filtered_count":250}`)
	}))
	defer server.Close()

	page, err := managementGetPage(jsonObject{"management_url": server.URL}, "/api/queues?columns=name", managementPageRequest{
		Page: 2, PageSize: 100, Search: "orders & paid", Sort: "messages_ready", SortReverse: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if requestCount != 1 {
		t.Fatalf("expected one management request, got %d", requestCount)
	}
	if len(page.Items) != 1 || page.Page != 2 || page.PageSize != 100 || page.TotalCount != 250 || !page.HasMore {
		t.Fatalf("unexpected page %#v", page)
	}
}

func TestManagementGetPageFallsBackForPlainArrayResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `[{"name":"alpha","messages_ready":1},{"name":"beta","messages_ready":9},{"name":"gamma","messages_ready":4}]`)
	}))
	defer server.Close()

	page, err := managementGetPage(jsonObject{"management_url": server.URL}, "/api/queues", managementPageRequest{
		Page: 1, PageSize: 2, Search: "a", Sort: "messages_ready", SortReverse: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.TotalCount != 3 || !page.HasMore || len(page.Items) != 2 {
		t.Fatalf("unexpected page %#v", page)
	}
	first, _ := page.Items[0].(map[string]any)
	second, _ := page.Items[1].(map[string]any)
	if stringOrEmpty(jsonObject(first), "name") != "beta" || stringOrEmpty(jsonObject(second), "name") != "gamma" {
		t.Fatalf("unexpected sorted items %#v", page.Items)
	}
}

func TestManagementPageRequestValidation(t *testing.T) {
	for _, params := range []jsonObject{
		{"page": 0, "page_size": 100, "sort": "name"},
		{"page": 1, "page_size": managementMaxPageSize + 1, "sort": "name"},
		{"page": 1},
		{"page": 1, "page_size": 100, "sort": "unsupported"},
	} {
		if _, err := managementPageRequestFromParams(params, "name"); err == nil {
			t.Fatalf("expected invalid page request %#v to fail", params)
		}
	}
	if page, err := managementPageRequestFromParams(jsonObject{}, "name"); err != nil || page != nil {
		t.Fatalf("legacy unpaged request changed: %#v, %v", page, err)
	}
}

func TestListTopicsPagePreservesAllVhostIdentityWithoutDrainingPages(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestCount++
		if request.URL.Path != "/api/queues" {
			t.Fatalf("unexpected all-vhosts path %q", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"items":[{"name":"orders","vhost":"staging","durable":true}],"page":1,"page_size":100,"page_count":100,"total_count":10000,"filtered_count":10000}`)
	}))
	defer server.Close()
	service := newServer()
	service.cachedConnection = jsonObject{"management_url": server.URL}

	listed, err := service.listTopics(jsonObject{
		"all_vhosts": true, "page": 1, "page_size": 100, "sort": "name",
	})
	if err != nil {
		t.Fatal(err)
	}
	result := listed.(jsonObject)
	topics := result["topics"].([]jsonObject)
	if requestCount != 1 || len(topics) != 1 || stringOrEmpty(topics[0], "vhost") != "staging" {
		t.Fatalf("unexpected paged topics %#v after %d requests", result, requestCount)
	}
	if intOrDefault(result, "totalCount", 0) != 10000 || !boolOrDefault(result, "hasMore", false) {
		t.Fatalf("unexpected page metadata %#v", result)
	}
}

func TestListExchangesPageSearchIncludesDisplayedDefaultExchange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		query := request.URL.Query()
		if query.Get("use_regex") != "true" || !strings.Contains(query.Get("name"), "^$") {
			t.Fatalf("default exchange search was not translated to a regex: %q", request.URL.RawQuery)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"items":[{"name":"","type":"direct","durable":true}],"page":1,"page_size":100,"page_count":1,"total_count":8,"filtered_count":1}`)
	}))
	defer server.Close()
	service := newServer()
	service.cachedConnection = jsonObject{"management_url": server.URL}

	listed, err := service.listExchanges(jsonObject{
		"virtual_host": "/", "page": 1, "page_size": 100, "search": "default", "sort": "name",
	})
	if err != nil {
		t.Fatal(err)
	}
	result := listed.(jsonObject)
	exchanges := result["exchanges"].([]jsonObject)
	if len(exchanges) != 1 || stringOrEmpty(exchanges[0], "name") != "" || intOrDefault(result, "totalCount", 0) != 1 {
		t.Fatalf("unexpected exchange page %#v", result)
	}
}

func TestManagementRequestFailsOverConnectionErrors(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.2:0")
	if err != nil {
		t.Skipf("secondary loopback address unavailable: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `[]`)
	})}
	defer server.Close()
	go server.Serve(listener)
	connection := mustObject(t, `{"addresses":"127.0.0.1,127.0.0.2","properties":{"management_port":`+strconv.Itoa(port)+`}}`)
	response, err := managementGet(connection, "/api/queues")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.([]any); !ok {
		t.Fatalf("unexpected response %#v", response)
	}
}

func TestManagementHTTPErrorDoesNotFailOver(t *testing.T) {
	first, second, port := pairedLoopbackServers(t,
		http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.WriteHeader(http.StatusNotFound)
		}),
		http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `[]`)
		}),
	)
	defer first.Close()
	defer second.Close()
	connection := mustObject(t, `{"addresses":"127.0.0.1,127.0.0.2","properties":{"management_port":`+strconv.Itoa(port)+`}}`)
	_, err := managementGet(connection, "/api/queues")
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("unexpected error %v", err)
	}
}

func TestManagementURLPathPrefix(t *testing.T) {
	requestedPath := ""
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestedPath = request.URL.Path
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `[]`)
	}))
	defer server.Close()
	_, err := managementGet(jsonObject{"management_url": server.URL + "/rmq/"}, "/api/queues")
	if err != nil {
		t.Fatal(err)
	}
	if requestedPath != "/rmq/api/queues" {
		t.Fatalf("got path %q", requestedPath)
	}
}

func TestPolicyManagementOperations(t *testing.T) {
	type capturedRequest struct {
		Method string
		Path   string
		Body   jsonObject
	}
	requests := make([]capturedRequest, 0)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		captured := capturedRequest{Method: request.Method, Path: request.URL.Path}
		if request.Body != nil {
			data, _ := io.ReadAll(request.Body)
			if len(data) > 0 {
				_ = decodeJSON(data, &captured.Body)
			}
		}
		requests = append(requests, captured)
		writer.Header().Set("Content-Type", "application/json")
		switch request.Method {
		case http.MethodGet:
			_, _ = io.WriteString(writer, `[{"name":"ha","vhost":"/","pattern":"^ha","apply-to":"queues","priority":0,"definition":{"ha-mode":"all"}}]`)
		default:
			writer.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	service := newServer()
	service.cachedConnection = jsonObject{"management_url": server.URL, "username": "guest", "password": "guest"}
	listed, err := service.listPolicies(jsonObject{"virtual_host": "/"})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.(jsonObject)["policies"].([]jsonObject)) != 1 {
		t.Fatalf("unexpected policies %#v", listed)
	}
	_, err = service.setPolicy(mustObject(t, `{"virtual_host":"/","name":"ha","pattern":"^ha","definition":{"ha-mode":"all"}}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.deletePolicy(mustObject(t, `{"virtual_host":"/","name":"ha"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 || requests[1].Method != http.MethodPut || requests[2].Method != http.MethodDelete {
		t.Fatalf("unexpected requests %#v", requests)
	}
	if requests[1].Body["apply-to"] != "queues" || requests[1].Body["priority"] != json.Number("0") {
		t.Fatalf("unexpected body %#v", requests[1].Body)
	}
}

func pairedLoopbackServers(t *testing.T, firstHandler, secondHandler http.Handler) (*http.Server, *http.Server, int) {
	t.Helper()
	firstListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := firstListener.Addr().(*net.TCPAddr).Port
	secondListener, err := net.Listen("tcp", "127.0.0.2:"+strconv.Itoa(port))
	if err != nil {
		firstListener.Close()
		t.Skipf("secondary loopback address unavailable: %v", err)
	}
	first := &http.Server{Handler: firstHandler}
	second := &http.Server{Handler: secondHandler}
	go first.Serve(firstListener)
	go second.Serve(secondListener)
	return first, second, port
}
