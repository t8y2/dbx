package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestAccessTokenSupportsV2AndV3Responses(t *testing.T) {
	for name, body := range map[string]string{
		"v2": `{"accessToken":"v2-token","tokenTtl":18000}`,
		"v3": `{"code":0,"message":"success","data":{"accessToken":"v3-token","tokenTtl":18000}}`,
	} {
		t.Run(name, func(t *testing.T) {
			token, err := accessToken([]byte(body))
			if err != nil {
				t.Fatal(err)
			}
			if token != name+"-token" {
				t.Fatalf("unexpected token %q", token)
			}
		})
	}
}

func TestOperationResponseErrorRejectsBusinessFailures(t *testing.T) {
	for _, body := range []string{
		`false`,
		`{"code":403,"message":"authorization failed"}`,
		`{"code":0,"message":"failed","data":false}`,
	} {
		if err := operationResponseError([]byte(body)); err == nil {
			t.Fatalf("expected %s to fail", body)
		}
	}
	for _, body := range []string{`true`, `{"code":0,"message":"success","data":true}`, `{"code":200,"data":"ok"}`} {
		if err := operationResponseError([]byte(body)); err != nil {
			t.Fatalf("expected %s to succeed: %v", body, err)
		}
	}
}

func TestSelectedTargetsUseRepositoryPortsAndVersionedAPIs(t *testing.T) {
	opts := options{target: "both", v2URL: "http://127.0.0.1:11000/nacos", v3URL: "http://127.0.0.1:11003/nacos", timeout: 1}
	targets := selectedTargets(opts)
	if len(targets) != 2 {
		t.Fatalf("expected two targets, got %d", len(targets))
	}
	if !strings.Contains(targets[0].servicePath, "/v1/") || targets[0].tokenInHeader {
		t.Fatalf("unexpected V2 target: %+v", targets[0])
	}
	if !strings.Contains(targets[1].servicePath, "/v3/admin/") || !targets[1].tokenInHeader {
		t.Fatalf("unexpected V3 target: %+v", targets[1])
	}
	if !targets[0].supportsHealthUpdate || targets[0].instanceHealthPath != "/v1/ns/instance" || targets[0].instanceListPath != "/v1/ns/catalog/instances" || !targets[0].instanceListCatalog || targets[1].supportsHealthUpdate || targets[1].instanceListPath != "/v3/admin/ns/instance/list" || targets[1].instanceListCatalog {
		t.Fatalf("unexpected instance health-update support: %+v", targets)
	}
}

func TestServiceOwnedBySeedSupportsWrappedAndStringMetadata(t *testing.T) {
	for name, body := range map[string]string{
		"wrapped object":   `{"code":0,"data":{"metadata":{"source":"dbx-nacos-service-seed"}}}`,
		"top-level string": `{"metadata":"{\"source\":\"dbx-nacos-service-seed\"}"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if !serviceOwnedBySeed([]byte(body)) {
				t.Fatalf("expected script ownership for %s", body)
			}
		})
	}
	for _, body := range []string{
		`{"code":0,"data":{"metadata":{"source":"another-tool"}}}`,
		`{"code":0,"data":{"metadata":{}}}`,
		`{"code":0,"data":true}`,
	} {
		if serviceOwnedBySeed([]byte(body)) {
			t.Fatalf("unexpected script ownership for %s", body)
		}
	}
}

func TestSeedRefusesToReplaceUnownedServiceUnlessForced(t *testing.T) {
	test := func(force bool) ([]string, error) {
		var requests []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests = append(requests, r.Method+" "+r.URL.Path)
			if r.Method == http.MethodGet {
				_, _ = w.Write([]byte(`{"code":0,"data":{"metadata":{"source":"another-tool"}}}`))
				return
			}
			_, _ = w.Write([]byte(`{"code":0,"data":true}`))
		}))
		defer server.Close()

		target := &nacosTarget{baseURL: server.URL, servicePath: "/v3/admin/ns/service", instancePath: "/v3/admin/ns/instance", client: server.Client(), tokenInHeader: true}
		opts := options{
			namespace: "public", group: "DEFAULT_GROUP", cluster: "DEFAULT", prefix: "dbx-demo-service",
			serviceCount: 1, instancesPerSvc: 1, instanceIP: "127.0.0.1", instanceBasePort: 28080, forceExisting: force,
		}
		return requests, target.seed(context.Background(), opts)
	}

	requests, err := test(false)
	if err == nil || !strings.Contains(err.Error(), "-force-existing") {
		t.Fatalf("expected ownership error, got %v", err)
	}
	if len(requests) != 1 || requests[0] != "GET /v3/admin/ns/service" {
		t.Fatalf("unowned service was modified: %#v", requests)
	}

	requests, err = test(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 || requests[1] != "PUT /v3/admin/ns/service" || requests[2] != "POST /v3/admin/ns/instance" {
		t.Fatalf("forced seed did not replace and register: %#v", requests)
	}
}

func TestCleanupRefusesToDeleteUnownedServiceUnlessForced(t *testing.T) {
	test := func(force bool) ([]string, error) {
		var requests []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests = append(requests, r.Method+" "+r.URL.Path)
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/v3/admin/ns/service":
				_, _ = w.Write([]byte(`{"code":0,"data":{"metadata":{"source":"another-tool"}}}`))
			case r.Method == http.MethodGet:
				_, _ = w.Write([]byte(`{"code":0,"data":[]}`))
			default:
				_, _ = w.Write([]byte(`{"code":0,"data":true}`))
			}
		}))
		defer server.Close()

		target := &nacosTarget{
			baseURL: server.URL, servicePath: "/v3/admin/ns/service", instancePath: "/v3/admin/ns/instance", instanceListPath: "/v3/admin/ns/instance/list",
			client: server.Client(), tokenInHeader: true,
		}
		opts := options{namespace: "public", group: "DEFAULT_GROUP", cluster: "DEFAULT", prefix: "dbx-demo-service", serviceCount: 1, instancesPerSvc: 1, forceExisting: force}
		return requests, target.cleanup(context.Background(), opts)
	}

	requests, err := test(false)
	if err == nil || !strings.Contains(err.Error(), "-force-existing") {
		t.Fatalf("expected ownership error, got %v", err)
	}
	if len(requests) != 1 || requests[0] != "GET /v3/admin/ns/service" {
		t.Fatalf("unowned service was inspected beyond its ownership marker: %#v", requests)
	}

	requests, err = test(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 || requests[1] != "GET /v3/admin/ns/instance/list" || requests[2] != "DELETE /v3/admin/ns/service" {
		t.Fatalf("forced cleanup did not remove the service: %#v", requests)
	}
}

func TestCleanupUsesActualInstanceIdentities(t *testing.T) {
	type request struct {
		method string
		path   string
		query  url.Values
	}
	var requests []request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, request{method: r.Method, path: r.URL.Path, query: r.URL.Query()})
		if r.Method == http.MethodGet && r.URL.Path == "/v3/admin/ns/service" {
			_, _ = w.Write([]byte(`{"code":0,"data":{"metadata":{"source":"dbx-nacos-service-seed"}}}`))
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v3/admin/ns/instance/list" {
			_, _ = w.Write([]byte(`{"code":0,"data":[{"ip":"10.91.0.99","port":28080,"clusterName":"blue","ephemeral":false}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"code":0,"data":true}`))
	}))
	defer server.Close()

	target := &nacosTarget{
		baseURL: server.URL, servicePath: "/v3/admin/ns/service", instancePath: "/v3/admin/ns/instance", instanceListPath: "/v3/admin/ns/instance/list",
		client: server.Client(), tokenInHeader: true,
	}
	opts := options{namespace: "public", group: "DEFAULT_GROUP", cluster: "DEFAULT", prefix: "dbx-demo-service", serviceCount: 1, instancesPerSvc: 3}
	if err := target.cleanup(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 4 {
		t.Fatalf("expected ownership lookup, list, instance delete, and service delete; got %#v", requests)
	}
	instanceDelete := requests[2]
	if instanceDelete.method != http.MethodDelete || instanceDelete.path != "/v3/admin/ns/instance" || instanceDelete.query.Get("ip") != "10.91.0.99" || instanceDelete.query.Get("port") != "28080" || instanceDelete.query.Get("clusterName") != "blue" {
		t.Fatalf("unexpected instance cleanup request: %#v", instanceDelete)
	}
}

func TestV2CleanupUsesPaginatedCatalogAndIncludesDisabledInstances(t *testing.T) {
	type request struct {
		method string
		path   string
		query  url.Values
	}
	var requests []request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, request{method: r.Method, path: r.URL.Path, query: r.URL.Query()})
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/ns/service":
			_, _ = w.Write([]byte(`{"metadata":{"source":"dbx-nacos-service-seed"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/ns/catalog/instances" && r.URL.Query().Get("pageNo") == "1":
			_, _ = w.Write([]byte(`{"list":[{"ip":"127.0.0.1","port":28080,"clusterName":"manual","enabled":false,"ephemeral":false}],"count":2}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/ns/catalog/instances" && r.URL.Query().Get("pageNo") == "2":
			_, _ = w.Write([]byte(`{"list":[{"ip":"127.0.0.1","port":28081,"clusterName":"manual","enabled":true,"ephemeral":false}],"count":2}`))
		default:
			_, _ = w.Write([]byte("true"))
		}
	}))
	defer server.Close()

	target := &nacosTarget{
		baseURL: server.URL, servicePath: "/v1/ns/service", instancePath: "/v1/ns/instance", instanceListPath: "/v1/ns/catalog/instances",
		instanceListCatalog: true, client: server.Client(),
	}
	opts := options{namespace: "public", group: "DEFAULT_GROUP", cluster: "manual", prefix: "dbx-demo-service", serviceCount: 1, instancesPerSvc: 2}
	if err := target.cleanup(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 6 {
		t.Fatalf("expected ownership lookup, two catalog pages, two instance deletes, and service delete; got %#v", requests)
	}
	for index, pageNo := range []string{"1", "2"} {
		catalog := requests[index+1]
		if catalog.path != "/v1/ns/catalog/instances" || catalog.query.Get("serviceName") != "DEFAULT_GROUP@@dbx-demo-service-01" || catalog.query.Get("groupName") != "" || catalog.query.Get("clusterName") != "manual" || catalog.query.Get("pageNo") != pageNo || catalog.query.Get("pageSize") != "100" {
			t.Fatalf("unexpected catalog request: %#v", catalog)
		}
	}
	deletedPorts := []string{requests[3].query.Get("port"), requests[4].query.Get("port")}
	if strings.Join(deletedPorts, ",") != "28080,28081" {
		t.Fatalf("disabled or paginated instance was not deleted: %#v", requests)
	}
}

func TestSeedMarksPersistentInstancesHealthyAfterRegistration(t *testing.T) {
	type request struct {
		method string
		path   string
		form   url.Values
	}
	var requests []request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(body))
		requests = append(requests, request{method: r.Method, path: r.URL.Path, form: form})
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/ns/service":
			http.NotFound(w, r)
		default:
			_, _ = w.Write([]byte("true"))
		}
	}))
	defer server.Close()

	target := &nacosTarget{
		baseURL: server.URL, servicePath: "/v1/ns/service", instancePath: "/v1/ns/instance", instanceHealthPath: "/v1/ns/instance",
		supportsHealthUpdate: true, client: server.Client(),
	}
	opts := options{
		namespace: "public", group: "DEFAULT_GROUP", cluster: "DEFAULT", prefix: "dbx-demo-service",
		serviceCount: 1, instancesPerSvc: 1, instanceIP: "127.0.0.1", instanceBasePort: 28080,
	}
	if err := target.seed(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 4 {
		t.Fatalf("expected service lookup, creation, registration, and health update; got %#v", requests)
	}
	registration, healthUpdate := requests[2], requests[3]
	if registration.method != http.MethodPost || registration.path != "/v1/ns/instance" || registration.form.Get("ephemeral") != "false" {
		t.Fatalf("unexpected registration request: %#v", registration)
	}
	if healthUpdate.method != http.MethodPut || healthUpdate.path != "/v1/ns/instance" || healthUpdate.form.Get("healthy") != "true" || healthUpdate.form.Get("ephemeral") != "false" {
		t.Fatalf("unexpected health update request: %#v", healthUpdate)
	}
}

func TestV3SeedSetsHealthDuringRegistrationWithoutAHealthUpdate(t *testing.T) {
	type request struct {
		method string
		path   string
		form   url.Values
	}
	var requests []request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(body))
		requests = append(requests, request{method: r.Method, path: r.URL.Path, form: form})
		if r.Method == http.MethodGet && r.URL.Path == "/v3/admin/ns/service" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"code":0,"data":true}`))
	}))
	defer server.Close()

	target := &nacosTarget{
		baseURL: server.URL, servicePath: "/v3/admin/ns/service", instancePath: "/v3/admin/ns/instance",
		client: server.Client(), tokenInHeader: true,
	}
	opts := options{
		namespace: "public", group: "DEFAULT_GROUP", cluster: "DEFAULT", prefix: "dbx-demo-service",
		serviceCount: 1, instancesPerSvc: 1, instanceIP: "127.0.0.1", instanceBasePort: 28080,
	}
	if err := target.seed(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 {
		t.Fatalf("expected service lookup, creation, and registration; got %#v", requests)
	}
	registration := requests[2]
	if registration.method != http.MethodPost || registration.path != "/v3/admin/ns/instance" || registration.form.Get("healthy") != "true" {
		t.Fatalf("unexpected V3 registration request: %#v", registration)
	}
}

func TestServeStartsHTTPServerForEveryGeneratedPort(t *testing.T) {
	opts := options{
		prefix: "dbx-demo-service", serviceCount: 1, instancesPerSvc: 1,
		listenAddress: "127.0.0.1", instanceBasePort: 0,
	}
	servers, err := startDemoServers(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := servers.shutdown(context.Background()); err != nil {
			t.Fatal(err)
		}
	}()
	if len(servers.addresses) != 1 {
		t.Fatalf("expected one listener, got %v", servers.addresses)
	}

	response, err := http.Get("http://" + servers.addresses[0] + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected status: %s", response.Status)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["service"] != "dbx-demo-service-01" || payload["status"] != "healthy" {
		t.Fatalf("unexpected health response: %#v", payload)
	}
}

func TestValidateOptionsRejectsServeDuringCleanup(t *testing.T) {
	err := validateOptions(options{
		target: "v2", action: "cleanup", username: "nacos", password: "123456", namespace: "public", group: "DEFAULT_GROUP", cluster: "DEFAULT", prefix: "dbx-demo-service",
		serviceCount: 1, instancesPerSvc: 1, instanceBasePort: 28080, v2URL: "http://127.0.0.1:11000/nacos", v3URL: "http://127.0.0.1:11003/nacos", serve: true,
	})
	if err == nil || !strings.Contains(err.Error(), "-serve") {
		t.Fatalf("expected -serve validation error, got %v", err)
	}
}
