// Command nacos-service-seed creates deterministic Nacos services and persistent instances.
//
// The defaults match the local environments started by this repository:
//
//	make db DB=nacos@2.5
//	make db DB=nacos@3.2
//	go run ./scripts/nacos-service-seed.go -target both -serve
//
// Nacos 3 registration intentionally uses the 8848 Admin API. The generated
// instances can then be inspected through a separate 8080 Console API DBX
// connection to verify the reduced Console capability set.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	maxResponseBytes   = 1 << 20
	serviceOwnerSource = "dbx-nacos-service-seed"
	catalogPageSize    = 100
)

type options struct {
	target           string
	action           string
	v2URL            string
	v3URL            string
	username         string
	password         string
	namespace        string
	group            string
	cluster          string
	prefix           string
	serviceCount     int
	instancesPerSvc  int
	instanceIP       string
	instanceBasePort int
	serve            bool
	forceExisting    bool
	listenAddress    string
	timeout          time.Duration
}

type demoServers struct {
	servers     []*http.Server
	addresses   []string
	serveErrors chan error
}

type nacosTarget struct {
	name                 string
	baseURL              string
	loginPath            string
	servicePath          string
	instancePath         string
	instanceListPath     string
	instanceHealthPath   string
	instanceListCatalog  bool
	supportsHealthUpdate bool
	tokenInHeader        bool
	token                string
	client               *http.Client
}

type nacosInstance struct {
	IP          string
	Port        int
	ClusterName string
	Ephemeral   bool
}

func main() {
	opts := parseFlags()
	if err := validateOptions(opts); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var listeners *demoServers
	if opts.serve {
		var err error
		listeners, err = startDemoServers(opts)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := listeners.shutdown(shutdownCtx); err != nil {
				fmt.Fprintln(os.Stderr, "error: stop demo servers:", err)
			}
		}()
		fmt.Printf("[demo] listening on %s\n", strings.Join(listeners.addresses, ", "))
	}

	for _, target := range selectedTargets(opts) {
		fmt.Printf("\n[%s] %s %d services x %d instances at %s\n", target.name, opts.action, opts.serviceCount, opts.instancesPerSvc, target.baseURL)
		if err := target.login(ctx, opts.username, opts.password); err != nil {
			fmt.Fprintf(os.Stderr, "[%s] login failed: %v\n", target.name, err)
			os.Exit(1)
		}
		var err error
		if opts.action == "cleanup" {
			err = target.cleanup(ctx, opts)
		} else {
			err = target.seed(ctx, opts)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "[%s] %s failed: %v\n", target.name, opts.action, err)
			os.Exit(1)
		}
	}
	if listeners != nil {
		fmt.Println("[demo] serving registered instances; press Ctrl+C to stop")
		if err := listeners.wait(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "error: demo server:", err)
			os.Exit(1)
		}
	}
}

func parseFlags() options {
	var opts options
	flag.StringVar(&opts.target, "target", "both", "target environment: v2, v3, or both")
	flag.StringVar(&opts.action, "action", "seed", "action: seed or cleanup")
	flag.StringVar(&opts.v2URL, "v2-url", "http://127.0.0.1:11000/nacos", "Nacos V2 base URL")
	flag.StringVar(&opts.v3URL, "v3-url", "http://127.0.0.1:11003/nacos", "Nacos V3 Admin base URL (8848 mapping, not the 8080 Console URL)")
	flag.StringVar(&opts.username, "username", "nacos", "Nacos username")
	flag.StringVar(&opts.password, "password", "123456", "Nacos password")
	flag.StringVar(&opts.namespace, "namespace", "public", "existing namespace ID")
	flag.StringVar(&opts.group, "group", "DEFAULT_GROUP", "service group")
	flag.StringVar(&opts.cluster, "cluster", "DEFAULT", "instance cluster")
	flag.StringVar(&opts.prefix, "prefix", "dbx-test-service", "generated service name prefix")
	flag.IntVar(&opts.serviceCount, "services", 5, "number of services")
	flag.IntVar(&opts.instancesPerSvc, "instances", 2, "persistent instances per service")
	flag.StringVar(&opts.instanceIP, "ip", "127.0.0.1", "registered instance IP")
	flag.IntVar(&opts.instanceBasePort, "port", 28080, "first registered instance port")
	flag.BoolVar(&opts.serve, "serve", false, "keep an HTTP demo server listening on every registered instance port")
	flag.BoolVar(&opts.forceExisting, "force-existing", false, "allow seed or cleanup to modify matching services not created by this script")
	flag.StringVar(&opts.listenAddress, "listen-address", "127.0.0.1", "address used by -serve listeners")
	flag.DurationVar(&opts.timeout, "timeout", 10*time.Second, "HTTP request timeout")
	flag.Parse()
	return opts
}

func validateOptions(opts options) error {
	if opts.target != "v2" && opts.target != "v3" && opts.target != "both" {
		return fmt.Errorf("invalid -target %q; use v2, v3, or both", opts.target)
	}
	if opts.action != "seed" && opts.action != "cleanup" {
		return fmt.Errorf("invalid -action %q; use seed or cleanup", opts.action)
	}
	if opts.serve && opts.action != "seed" {
		return errors.New("-serve can only be used with -action seed")
	}
	if opts.username == "" || opts.password == "" {
		return errors.New("-username and -password must not be empty")
	}
	if opts.namespace == "" || opts.group == "" || opts.cluster == "" || opts.prefix == "" {
		return errors.New("-namespace, -group, -cluster, and -prefix must not be empty")
	}
	if opts.serviceCount < 1 || opts.instancesPerSvc < 1 {
		return errors.New("-services and -instances must be greater than zero")
	}
	lastPort := opts.instanceBasePort + opts.serviceCount*opts.instancesPerSvc - 1
	if opts.instanceBasePort < 1 || lastPort > 65535 {
		return fmt.Errorf("generated instance port range %d-%d is invalid", opts.instanceBasePort, lastPort)
	}
	for label, rawURL := range map[string]string{"v2-url": opts.v2URL, "v3-url": opts.v3URL} {
		parsed, err := url.ParseRequestURI(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return fmt.Errorf("-%s must be an absolute HTTP URL", label)
		}
	}
	return nil
}

func startDemoServers(opts options) (*demoServers, error) {
	set := &demoServers{serveErrors: make(chan error, opts.serviceCount*opts.instancesPerSvc)}
	for serviceIndex := 0; serviceIndex < opts.serviceCount; serviceIndex++ {
		serviceName := generatedServiceName(opts.prefix, serviceIndex)
		for instanceIndex := 0; instanceIndex < opts.instancesPerSvc; instanceIndex++ {
			port := generatedPort(opts, serviceIndex, instanceIndex)
			listener, err := net.Listen("tcp", net.JoinHostPort(opts.listenAddress, strconv.Itoa(port)))
			if err != nil {
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = set.shutdown(shutdownCtx)
				cancel()
				return nil, fmt.Errorf("listen on %s:%d: %w", opts.listenAddress, port, err)
			}
			server := &http.Server{Handler: demoHandler(serviceName, port)}
			set.servers = append(set.servers, server)
			set.addresses = append(set.addresses, listener.Addr().String())
			go func(server *http.Server, listener net.Listener) {
				if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
					set.serveErrors <- err
				}
			}(server, listener)
		}
	}
	return set, nil
}

func demoHandler(serviceName string, port int) http.Handler {
	payload, _ := json.Marshal(map[string]any{"service": serviceName, "port": port, "status": "healthy"})
	return http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write(payload)
	})
}

func (set *demoServers) wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return nil
	case err := <-set.serveErrors:
		return err
	}
}

func (set *demoServers) shutdown(ctx context.Context) error {
	var failures []string
	for _, server := range set.servers {
		if err := server.Shutdown(ctx); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func selectedTargets(opts options) []*nacosTarget {
	client := &http.Client{Timeout: opts.timeout}
	v2 := &nacosTarget{
		name: "Nacos V2", baseURL: strings.TrimRight(opts.v2URL, "/"), loginPath: "/v1/auth/login",
		servicePath: "/v1/ns/service", instancePath: "/v1/ns/instance", instanceListPath: "/v1/ns/catalog/instances", instanceHealthPath: "/v1/ns/instance", instanceListCatalog: true, supportsHealthUpdate: true, client: client,
	}
	v3 := &nacosTarget{
		name: "Nacos V3 Admin", baseURL: strings.TrimRight(opts.v3URL, "/"), loginPath: "/v3/auth/user/login",
		servicePath: "/v3/admin/ns/service", instancePath: "/v3/admin/ns/instance", instanceListPath: "/v3/admin/ns/instance/list", tokenInHeader: true, client: client,
	}
	switch opts.target {
	case "v2":
		return []*nacosTarget{v2}
	case "v3":
		return []*nacosTarget{v3}
	default:
		return []*nacosTarget{v2, v3}
	}
}

func (target *nacosTarget) login(ctx context.Context, username, password string) error {
	body, _, err := target.rawRequest(ctx, http.MethodPost, target.loginPath, nil, url.Values{
		"username": {username},
		"password": {password},
	}, false)
	if err != nil {
		return err
	}
	token, err := accessToken(body)
	if err != nil {
		return err
	}
	target.token = token
	return nil
}

func (target *nacosTarget) seed(ctx context.Context, opts options) error {
	createdInstances := 0
	for serviceIndex := 0; serviceIndex < opts.serviceCount; serviceIndex++ {
		serviceName := generatedServiceName(opts.prefix, serviceIndex)
		if err := target.ensureService(ctx, opts, serviceName, serviceIndex); err != nil {
			return fmt.Errorf("service %s: %w", serviceName, err)
		}
		for instanceIndex := 0; instanceIndex < opts.instancesPerSvc; instanceIndex++ {
			port := generatedPort(opts, serviceIndex, instanceIndex)
			metadata, _ := json.Marshal(map[string]any{
				"source": serviceOwnerSource, "target": target.name,
				"serviceIndex": serviceIndex + 1, "instanceIndex": instanceIndex + 1,
			})
			form := url.Values{
				"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName},
				"clusterName": {opts.cluster}, "ip": {opts.instanceIP}, "port": {strconv.Itoa(port)},
				"weight":  {strconv.FormatFloat(1+float64(instanceIndex)/10, 'f', 1, 64)},
				"healthy": {"true"}, "enabled": {"true"}, "ephemeral": {"false"}, "metadata": {string(metadata)},
			}
			if err := target.operation(ctx, http.MethodPost, target.instancePath, nil, form, false); err != nil {
				return fmt.Errorf("register %s %s:%d: %w", serviceName, opts.instanceIP, port, err)
			}
			if target.supportsHealthUpdate {
				if err := target.markInstanceHealthy(ctx, opts, serviceName, port); err != nil {
					return fmt.Errorf("mark healthy %s %s:%d: %w", serviceName, opts.instanceIP, port, err)
				}
			}
			createdInstances++
		}
		fmt.Printf("[%s] ready %-28s instances %d-%d\n", target.name, serviceName, generatedPort(opts, serviceIndex, 0), generatedPort(opts, serviceIndex, opts.instancesPerSvc-1))
	}
	fmt.Printf("[%s] complete: %d services, %d persistent instances\n", target.name, opts.serviceCount, createdInstances)
	return nil
}

// markInstanceHealthy is only used by Nacos V2. Nacos V3 has no compatible
// health-update endpoint for persistent instances.
func (target *nacosTarget) markInstanceHealthy(ctx context.Context, opts options, serviceName string, port int) error {
	form := url.Values{
		"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName},
		"clusterName": {opts.cluster}, "ip": {opts.instanceIP}, "port": {strconv.Itoa(port)},
		"healthy": {"true"}, "ephemeral": {"false"},
	}
	return target.operation(ctx, http.MethodPut, target.instanceHealthPath, nil, form, false)
}

func (target *nacosTarget) ensureService(ctx context.Context, opts options, serviceName string, serviceIndex int) error {
	query := url.Values{"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName}}
	exists, owned, err := target.serviceStatus(ctx, query)
	if err != nil {
		return err
	}
	if exists && !owned && !opts.forceExisting {
		return errors.New("matching service already exists without the script ownership marker; choose another -prefix or pass -force-existing to replace it")
	}
	metadata, _ := json.Marshal(map[string]any{
		"source": serviceOwnerSource, "target": target.name, "serviceIndex": serviceIndex + 1,
	})
	form := url.Values{
		"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName},
		"protectThreshold": {"0"}, "ephemeral": {"false"}, "metadata": {string(metadata)},
		"selector": {`{"type":"none","contextType":"NONE"}`},
	}
	method := http.MethodPost
	if exists {
		method = http.MethodPut
	}
	return target.operation(ctx, method, target.servicePath, nil, form, false)
}

func (target *nacosTarget) serviceStatus(ctx context.Context, query url.Values) (bool, bool, error) {
	body, status, err := target.rawRequest(ctx, http.MethodGet, target.servicePath, query, nil, true)
	if err != nil {
		if responseMeansMissing([]byte(err.Error())) {
			return false, false, nil
		}
		return false, false, err
	}
	if status == http.StatusNotFound || responseMeansMissing(body) {
		return false, false, nil
	}
	if err := operationResponseError(body); err != nil {
		if responseMeansMissing([]byte(err.Error())) {
			return false, false, nil
		}
		return false, false, err
	}
	return true, serviceOwnedBySeed(body), nil
}

func serviceOwnedBySeed(body []byte) bool {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	metadata := serviceMetadata(payload)
	return metadata != nil && metadata["source"] == serviceOwnerSource
}

func serviceMetadata(payload any) map[string]any {
	value, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	if metadata, exists := value["metadata"]; exists {
		switch metadata := metadata.(type) {
		case map[string]any:
			return metadata
		case string:
			var parsed map[string]any
			if json.Unmarshal([]byte(metadata), &parsed) == nil {
				return parsed
			}
		}
	}
	return serviceMetadata(value["data"])
}

func (target *nacosTarget) cleanup(ctx context.Context, opts options) error {
	var failures []string
	for serviceIndex := opts.serviceCount - 1; serviceIndex >= 0; serviceIndex-- {
		serviceName := generatedServiceName(opts.prefix, serviceIndex)
		query := url.Values{"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName}}
		exists, owned, err := target.serviceStatus(ctx, query)
		if err != nil {
			failures = append(failures, fmt.Sprintf("inspect %s: %v", serviceName, err))
			continue
		}
		if !exists {
			continue
		}
		if !owned && !opts.forceExisting {
			failures = append(failures, fmt.Sprintf("refusing to remove %s because it does not have the script ownership marker; pass -force-existing to override", serviceName))
			continue
		}
		instances, err := target.listInstances(ctx, opts, serviceName)
		if err != nil {
			failures = append(failures, fmt.Sprintf("list %s: %v", serviceName, err))
			continue
		}
		for _, instance := range instances {
			query := url.Values{
				"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName},
				"clusterName": {instance.ClusterName}, "ip": {instance.IP},
				"port": {strconv.Itoa(instance.Port)}, "ephemeral": {strconv.FormatBool(instance.Ephemeral)},
			}
			if err := target.operation(ctx, http.MethodDelete, target.instancePath, query, nil, true); err != nil {
				failures = append(failures, fmt.Sprintf("remove %s %s:%d: %v", serviceName, instance.IP, instance.Port, err))
			}
		}
		if err := target.operation(ctx, http.MethodDelete, target.servicePath, query, nil, true); err != nil {
			failures = append(failures, err.Error())
		} else {
			fmt.Printf("[%s] removed %s\n", target.name, serviceName)
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("cleanup completed with %d errors: %s", len(failures), strings.Join(failures, "; "))
	}
	return nil
}

func (target *nacosTarget) listInstances(ctx context.Context, opts options, serviceName string) ([]nacosInstance, error) {
	if target.instanceListCatalog {
		return target.listCatalogInstances(ctx, opts, serviceName)
	}
	query := url.Values{
		"namespaceId": {opts.namespace}, "groupName": {opts.group}, "serviceName": {serviceName}, "clusterName": {opts.cluster},
	}
	body, _, err := target.rawRequest(ctx, http.MethodGet, target.instanceListPath, query, nil, true)
	if err != nil {
		if responseMeansMissing([]byte(err.Error())) {
			return nil, nil
		}
		return nil, err
	}
	if err := operationResponseError(body); err != nil {
		if responseMeansMissing([]byte(err.Error())) {
			return nil, nil
		}
		return nil, err
	}
	instances, err := parseInstances(body)
	if err != nil {
		return nil, err
	}
	return instances, nil
}

func (target *nacosTarget) listCatalogInstances(ctx context.Context, opts options, serviceName string) ([]nacosInstance, error) {
	qualifiedServiceName := serviceName
	if !strings.Contains(serviceName, "@@") && opts.group != "" {
		qualifiedServiceName = opts.group + "@@" + serviceName
	}
	instances := make([]nacosInstance, 0)
	seen := make(map[string]struct{})
	for pageNo := 1; ; pageNo++ {
		query := url.Values{
			"namespaceId": {opts.namespace}, "serviceName": {qualifiedServiceName}, "clusterName": {opts.cluster},
			"pageNo": {strconv.Itoa(pageNo)}, "pageSize": {strconv.Itoa(catalogPageSize)},
		}
		body, _, err := target.rawRequest(ctx, http.MethodGet, target.instanceListPath, query, nil, true)
		if err != nil {
			if responseMeansMissing([]byte(err.Error())) {
				return instances, nil
			}
			return nil, err
		}
		if err := operationResponseError(body); err != nil {
			if responseMeansMissing([]byte(err.Error())) {
				return instances, nil
			}
			return nil, err
		}
		page, total, err := parseInstancePage(body)
		if err != nil {
			return nil, err
		}
		added := 0
		for _, instance := range page {
			key := fmt.Sprintf("%s\x00%d\x00%s\x00%t", instance.IP, instance.Port, instance.ClusterName, instance.Ephemeral)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			instances = append(instances, instance)
			added++
		}
		if total != nil {
			if len(instances) >= *total || len(page) == 0 {
				break
			}
		} else if len(page) < catalogPageSize {
			break
		}
		if added == 0 {
			return nil, errors.New("Nacos instance pagination made no progress; the server repeated a page")
		}
	}
	return instances, nil
}

func parseInstances(body []byte) ([]nacosInstance, error) {
	instances, _, err := parseInstancePage(body)
	return instances, err
}

func parseInstancePage(body []byte) ([]nacosInstance, *int, error) {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, nil, fmt.Errorf("invalid instance-list response: %s", compactBody(body))
	}
	items := instanceItems(payload)
	instances := make([]nacosInstance, 0, len(items))
	for _, item := range items {
		ip, _ := item["ip"].(string)
		port := numberValue(item["port"])
		if ip == "" || port < 1 || port > 65535 {
			continue
		}
		clusterName, _ := item["clusterName"].(string)
		if clusterName == "" {
			clusterName = "DEFAULT"
		}
		ephemeral, _ := item["ephemeral"].(bool)
		instances = append(instances, nacosInstance{IP: ip, Port: port, ClusterName: clusterName, Ephemeral: ephemeral})
	}
	total, ok := instanceTotal(payload)
	if !ok {
		return instances, nil, nil
	}
	return instances, &total, nil
}

func instanceItems(payload any) []map[string]any {
	switch value := payload.(type) {
	case []any:
		items := make([]map[string]any, 0, len(value))
		for _, item := range value {
			if instance, ok := item.(map[string]any); ok && instance["ip"] != nil {
				items = append(items, instance)
			}
		}
		return items
	case map[string]any:
		for _, key := range []string{"hosts", "list", "pageItems", "data"} {
			if items := instanceItems(value[key]); len(items) > 0 {
				return items
			}
		}
	}
	return nil
}

func instanceTotal(payload any) (int, bool) {
	value, ok := payload.(map[string]any)
	if !ok {
		return 0, false
	}
	for _, key := range []string{"totalCount", "count"} {
		if raw, exists := value[key]; exists {
			if total, valid := nonnegativeNumberValue(raw); valid {
				return total, true
			}
		}
	}
	return instanceTotal(value["data"])
}

func nonnegativeNumberValue(value any) (int, bool) {
	switch value := value.(type) {
	case float64:
		if value < 0 {
			return 0, false
		}
		return int(value), true
	case string:
		parsed, err := strconv.Atoi(value)
		return parsed, err == nil && parsed >= 0
	default:
		return 0, false
	}
}

func numberValue(value any) int {
	switch value := value.(type) {
	case float64:
		return int(value)
	case string:
		parsed, _ := strconv.Atoi(value)
		return parsed
	default:
		return 0
	}
}

func generatedServiceName(prefix string, index int) string {
	return fmt.Sprintf("%s-%02d", prefix, index+1)
}

func generatedPort(opts options, serviceIndex, instanceIndex int) int {
	return opts.instanceBasePort + serviceIndex*opts.instancesPerSvc + instanceIndex
}

func (target *nacosTarget) operation(ctx context.Context, method, path string, query, form url.Values, allowMissing bool) error {
	body, _, err := target.rawRequest(ctx, method, path, query, form, true)
	if err != nil {
		if allowMissing && responseMeansMissing([]byte(err.Error())) {
			return nil
		}
		return err
	}
	if err := operationResponseError(body); err != nil {
		if allowMissing && responseMeansMissing([]byte(err.Error())) {
			return nil
		}
		return err
	}
	return nil
}

func (target *nacosTarget) rawRequest(ctx context.Context, method, path string, query, form url.Values, authenticate bool) ([]byte, int, error) {
	endpoint, err := url.Parse(target.baseURL + path)
	if err != nil {
		return nil, 0, err
	}
	values := endpoint.Query()
	for key, entries := range query {
		for _, value := range entries {
			values.Add(key, value)
		}
	}
	if authenticate && target.token != "" && !target.tokenInHeader {
		values.Set("accessToken", target.token)
	}
	endpoint.RawQuery = values.Encode()

	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, 0, err
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if authenticate && target.token != "" && target.tokenInHeader {
		req.Header.Set("accessToken", target.token)
	}
	resp, err := target.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseBody, resp.StatusCode, fmt.Errorf("%s %s returned %s: %s", method, path, resp.Status, compactBody(responseBody))
	}
	return responseBody, resp.StatusCode, nil
}

func accessToken(body []byte) (string, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("invalid login response: %s", compactBody(body))
	}
	if data, ok := payload["data"].(map[string]any); ok {
		payload = data
	}
	for _, key := range []string{"accessToken", "access_token", "token"} {
		if token, ok := payload[key].(string); ok && token != "" {
			return token, nil
		}
	}
	return "", fmt.Errorf("login response did not include an access token: %s", compactBody(body))
}

func operationResponseError(body []byte) error {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || strings.EqualFold(trimmed, "true") || strings.EqualFold(trimmed, "ok") {
		return nil
	}
	if strings.EqualFold(trimmed, "false") {
		return errors.New("Nacos returned false")
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil
	}
	message := responseMessage(payload)
	if code, ok := payload["code"]; ok && !successfulCode(code) {
		return fmt.Errorf("Nacos returned code %v: %s", code, message)
	}
	if success, ok := payload["success"].(bool); ok && !success {
		return fmt.Errorf("Nacos operation failed: %s", message)
	}
	if data, ok := payload["data"].(bool); ok && !data {
		return fmt.Errorf("Nacos operation returned false: %s", message)
	}
	return nil
}

func successfulCode(code any) bool {
	switch value := code.(type) {
	case float64:
		return value == 0 || value == 200
	case string:
		return value == "0" || value == "200"
	default:
		return false
	}
}

func responseMessage(payload map[string]any) string {
	for _, key := range []string{"message", "msg", "error"} {
		if value, ok := payload[key].(string); ok && value != "" {
			return value
		}
	}
	return "unknown error"
}

func responseMeansMissing(body []byte) bool {
	lower := strings.ToLower(string(body))
	return strings.Contains(lower, "not found") || strings.Contains(lower, "not exist") || strings.Contains(lower, "doesn't exist")
}

func compactBody(body []byte) string {
	text := strings.TrimSpace(string(body))
	if len(text) > 400 {
		return text[:400] + "..."
	}
	return text
}
