package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultManagementPort    = 15672
	defaultManagementTLSPort = 15671
	defaultAMQPTLSPort       = 5671
	managementPageSize       = 100
	managementMaxPageSize    = 500
	managementConnectTimeout = 10 * time.Second
	managementRequestTimeout = 20 * time.Second
)

type managementPageRequest struct {
	Page        int
	PageSize    int
	Search      string
	UseRegex    bool
	Sort        string
	SortReverse bool
}

type managementPageResult struct {
	Items      []any
	Page       int
	PageSize   int
	TotalCount int
	HasMore    bool
}

type managementStatusError struct {
	status int
	method string
	path   string
}

func (err *managementStatusError) Error() string {
	return managementErrorMessage(err.status, err.method, err.path)
}

func managementGet(connection jsonObject, path string) (any, error) {
	return managementRequest(connection, http.MethodGet, path, nil)
}

func managementSend(connection jsonObject, method, path string, body jsonObject) (any, error) {
	return managementRequest(connection, method, path, body)
}

func managementRequest(connection jsonObject, method, path string, body jsonObject) (any, error) {
	baseURLs, err := managementBaseURLs(connection)
	if err != nil {
		return nil, err
	}
	var lastConnectionError error
	for _, baseURL := range baseURLs {
		result, requestError := managementRequestOnce(baseURL, connection, method, path, body)
		if requestError == nil {
			return result, nil
		}
		var statusError *managementStatusError
		if errors.As(requestError, &statusError) {
			return nil, requestError
		}
		var networkError net.Error
		if errors.As(requestError, &networkError) {
			lastConnectionError = requestError
			continue
		}
		return nil, requestError
	}
	if lastConnectionError != nil {
		return nil, lastConnectionError
	}
	return nil, errors.New("No management API endpoint candidates")
}

func managementRequestOnce(baseURL string, connection jsonObject, method, path string, body jsonObject) (any, error) {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		requestBody = bytes.NewReader(encoded)
	}
	ctx, cancel := context.WithTimeout(context.Background(), managementRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, baseURL+path, requestBody)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", basicAuthHeader(
		credentialOrGuest(connection, "username"), credentialOrGuest(connection, "password")))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	connectOverride, err := endpointOverride(connection, "management_connect_override")
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: managementConnectTimeout}
	dialContext := dialer.DialContext
	if connectOverride != nil {
		dialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(
				ctx,
				network,
				net.JoinHostPort(connectOverride.Host, strconv.Itoa(connectOverride.Port)),
			)
		}
	}
	transport := &http.Transport{
		DialContext:           dialContext,
		TLSHandshakeTimeout:   managementConnectTimeout,
		ResponseHeaderTimeout: managementConnectTimeout,
		TLSClientConfig:       &tls.Config{InsecureSkipVerify: tlsSkipVerify(connection)},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &managementStatusError{status: response.StatusCode, method: method, path: path}
	}
	if response.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return nil, nil
	}
	var result any
	if err := decodeJSON(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func managementGetAll(connection jsonObject, path string) ([]any, error) {
	all := make([]any, 0)
	for page := 1; ; page++ {
		separator := "?"
		if strings.Contains(path, "?") {
			separator = "&"
		}
		response, err := managementGet(connection,
			path+separator+"page="+strconv.Itoa(page)+"&page_size="+strconv.Itoa(managementPageSize))
		if err != nil {
			return nil, err
		}
		switch typed := response.(type) {
		case []any:
			return append(all, typed...), nil
		case map[string]any:
			items, exists := typed["items"]
			if !exists {
				return nil, fmt.Errorf("Unexpected management API response for list endpoint %s", path)
			}
			if array, ok := items.([]any); ok {
				all = append(all, array...)
			}
			pageCount := integerOrNull(jsonObject(typed), "page_count")
			if pageCount == nil || page >= *pageCount {
				return all, nil
			}
		default:
			return nil, fmt.Errorf("Unexpected management API response for list endpoint %s", path)
		}
	}
}

// managementGetPage requests exactly one RabbitMQ management API page. Queue
// and exchange endpoints in RabbitMQ 3.8.x return a pagination envelope when
// page/page_size are present. The plain-array fallback keeps the agent usable
// with endpoints or older brokers that ignore those parameters, while still
// presenting the same explicit page contract to callers.
func managementGetPage(connection jsonObject, path string, request managementPageRequest) (managementPageResult, error) {
	if err := validateManagementPageRequest(request); err != nil {
		return managementPageResult{}, err
	}
	query := url.Values{}
	query.Set("page", strconv.Itoa(request.Page))
	query.Set("page_size", strconv.Itoa(request.PageSize))
	if request.Search != "" {
		query.Set("name", request.Search)
		query.Set("use_regex", strconv.FormatBool(request.UseRegex))
	}
	if request.Sort != "" {
		query.Set("sort", request.Sort)
	}
	if request.SortReverse {
		query.Set("sort_reverse", "true")
	}

	response, err := managementGet(connection, appendManagementQuery(path, query))
	if err != nil {
		return managementPageResult{}, err
	}
	switch typed := response.(type) {
	case []any:
		return paginateManagementArray(typed, request)
	case map[string]any:
		object := jsonObject(typed)
		items, exists := typed["items"]
		if !exists {
			return managementPageResult{}, fmt.Errorf("Unexpected management API response for list endpoint %s", path)
		}
		array, ok := items.([]any)
		if !ok {
			return managementPageResult{}, fmt.Errorf("Unexpected management API items for list endpoint %s", path)
		}
		page := intOrDefault(object, "page", request.Page)
		pageSize := intOrDefault(object, "page_size", request.PageSize)
		totalCount := integerOrNull(object, "filtered_count")
		if totalCount == nil {
			totalCount = integerOrNull(object, "total_count")
		}
		if totalCount == nil {
			inferred := (page-1)*pageSize + len(array)
			totalCount = &inferred
		}
		pageCount := integerOrNull(object, "page_count")
		hasMore := pageCount != nil && page < *pageCount
		if pageCount == nil {
			hasMore = page*pageSize < *totalCount
		}
		return managementPageResult{
			Items:      array,
			Page:       page,
			PageSize:   pageSize,
			TotalCount: *totalCount,
			HasMore:    hasMore,
		}, nil
	default:
		return managementPageResult{}, fmt.Errorf("Unexpected management API response for list endpoint %s", path)
	}
}

func managementPageRequestFromParams(params jsonObject, allowedSorts ...string) (*managementPageRequest, error) {
	page := integerOrNull(params, "page")
	pageSize := integerOrNull(params, "page_size")
	if page == nil && pageSize == nil {
		return nil, nil
	}
	if page == nil || pageSize == nil {
		return nil, errors.New("page and page_size must be provided together")
	}
	sortName := stringOrDefault(params, "sort", "name")
	allowed := false
	for _, candidate := range allowedSorts {
		if sortName == candidate {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, fmt.Errorf("Unsupported list sort %q", sortName)
	}
	request := managementPageRequest{
		Page:        *page,
		PageSize:    *pageSize,
		Search:      strings.TrimSpace(stringOrEmpty(params, "search")),
		Sort:        sortName,
		SortReverse: boolOrDefault(params, "sort_reverse", false),
	}
	if err := validateManagementPageRequest(request); err != nil {
		return nil, err
	}
	return &request, nil
}

func validateManagementPageRequest(request managementPageRequest) error {
	if request.Page < 1 {
		return errors.New("page must be at least 1")
	}
	if request.PageSize < 1 || request.PageSize > managementMaxPageSize {
		return fmt.Errorf("page_size must be between 1 and %d", managementMaxPageSize)
	}
	maxInt := int(^uint(0) >> 1)
	if request.Page-1 > maxInt/request.PageSize {
		return errors.New("page is too large")
	}
	return nil
}

func appendManagementQuery(path string, values url.Values) string {
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return path + separator + values.Encode()
}

func paginateManagementArray(items []any, request managementPageRequest) (managementPageResult, error) {
	filtered := make([]any, 0, len(items))
	var expression *regexp.Regexp
	if request.Search != "" && request.UseRegex {
		compiled, err := regexp.Compile("(?i)" + request.Search)
		if err != nil {
			return managementPageResult{}, fmt.Errorf("Invalid management list search: %w", err)
		}
		expression = compiled
	}
	search := strings.ToLower(request.Search)
	for _, item := range items {
		if request.Search != "" {
			object, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name := stringOrEmpty(jsonObject(object), "name")
			if expression != nil {
				if !expression.MatchString(name) {
					continue
				}
			} else if !strings.Contains(strings.ToLower(name), search) {
				continue
			}
		}
		filtered = append(filtered, item)
	}
	sort.SliceStable(filtered, func(left, right int) bool {
		leftObject, _ := filtered[left].(map[string]any)
		rightObject, _ := filtered[right].(map[string]any)
		leftJSON := jsonObject(leftObject)
		rightJSON := jsonObject(rightObject)
		comparison := 0
		if request.Sort == "messages_ready" {
			leftCount := longOrDefault(leftJSON, "messages_ready", 0)
			rightCount := longOrDefault(rightJSON, "messages_ready", 0)
			if leftCount < rightCount {
				comparison = -1
			} else if leftCount > rightCount {
				comparison = 1
			}
		}
		if comparison == 0 {
			comparison = strings.Compare(stringOrEmpty(leftJSON, "name"), stringOrEmpty(rightJSON, "name"))
		}
		if request.SortReverse {
			comparison = -comparison
		}
		return comparison < 0
	})

	totalCount := len(filtered)
	start := (request.Page - 1) * request.PageSize
	if start >= totalCount {
		return managementPageResult{
			Items:      []any{},
			Page:       request.Page,
			PageSize:   request.PageSize,
			TotalCount: totalCount,
			HasMore:    false,
		}, nil
	}
	end := start + request.PageSize
	if end > totalCount {
		end = totalCount
	}
	return managementPageResult{
		Items:      filtered[start:end],
		Page:       request.Page,
		PageSize:   request.PageSize,
		TotalCount: totalCount,
		HasMore:    end < totalCount,
	}, nil
}

func managementBaseURLs(connection jsonObject) ([]string, error) {
	if explicit := stringOrNull(connection, "management_url"); explicit != nil && strings.TrimSpace(*explicit) != "" {
		return []string{normalizeManagementURL(*explicit)}, nil
	}
	tlsEnabled := managementTLS(connection)
	addresses, err := resolveAddresses(connection)
	if err != nil {
		return nil, err
	}
	port, configured := configuredManagementPort(connection, tlsEnabled)
	if !configured {
		for _, endpoint := range addresses {
			isDefaultAMQPPort := endpoint.Port == defaultAMQPPort || (tlsEnabled && endpoint.Port == defaultAMQPTLSPort)
			if !isDefaultAMQPPort {
				return nil, fmt.Errorf(
					"RabbitMQ Management API URL is required when AMQP uses non-default port %d because the Management listener port is configured independently",
					endpoint.Port,
				)
			}
		}
	}
	baseURLs := make([]string, 0, len(addresses))
	for _, endpoint := range addresses {
		baseURLs = append(baseURLs, managementBaseURL(endpoint.Host, port, tlsEnabled))
	}
	return baseURLs, nil
}

func managementBaseURL(host string, port int, tlsEnabled bool) string {
	scheme := "http"
	if tlsEnabled {
		scheme = "https"
	}
	return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(port))
}

func normalizeManagementURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func managementTLS(connection jsonObject) bool {
	return objectOrNil(connection, "tls") != nil || boolProperty(connection, "ssl") || boolProperty(connection, "tls")
}

func managementPort(connection jsonObject, tlsEnabled bool) int {
	port, _ := configuredManagementPort(connection, tlsEnabled)
	return port
}

func configuredManagementPort(connection jsonObject, tlsEnabled bool) (int, bool) {
	if configured, ok := integerProperty(objectOrNil(connection, "properties"), "management_port"); ok {
		return configured, true
	}
	if tlsEnabled {
		return defaultManagementTLSPort, false
	}
	return defaultManagementPort, false
}

func credentialOrGuest(connection jsonObject, key string) string {
	value := stringOrNull(connection, key)
	if value == nil || strings.TrimSpace(*value) == "" {
		return "guest"
	}
	return *value
}

func basicAuthHeader(username, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
}

func managementErrorMessage(status int, method, path string) string {
	base := fmt.Sprintf("RabbitMQ management API returned HTTP %d for %s %s.", status, method, path)
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return base + " Hint: check the username/password and that the user has a management permission tag (management, policymaker, monitoring, or administrator)."
	}
	return base + " The rabbitmq_management plugin must be enabled for this operation."
}

func urlEncodeVhost(value string) string {
	return javaFormPathEscape(value)
}

func urlEncodePathSegment(value string) string {
	return javaFormPathEscape(value)
}

func urlEncodeName(value string) string {
	return urlEncodePathSegment(value)
}

func javaFormPathEscape(value string) string {
	const hex = "0123456789ABCDEF"
	var builder strings.Builder
	for _, current := range []byte(value) {
		if (current >= 'a' && current <= 'z') || (current >= 'A' && current <= 'Z') ||
			(current >= '0' && current <= '9') || current == '-' || current == '_' || current == '.' || current == '*' {
			builder.WriteByte(current)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hex[current>>4])
		builder.WriteByte(hex[current&15])
	}
	return builder.String()
}
