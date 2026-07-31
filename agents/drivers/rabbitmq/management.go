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
	"strconv"
	"strings"
	"time"
)

const (
	defaultManagementPort    = 15672
	defaultManagementTLSPort = 15671
	managementPageSize       = 100
	managementConnectTimeout = 10 * time.Second
	managementRequestTimeout = 20 * time.Second
)

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
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: managementConnectTimeout}).DialContext,
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

func managementBaseURLs(connection jsonObject) ([]string, error) {
	if explicit := stringOrNull(connection, "management_url"); explicit != nil && strings.TrimSpace(*explicit) != "" {
		return []string{normalizeManagementURL(*explicit)}, nil
	}
	tlsEnabled := managementTLS(connection)
	port := managementPort(connection, tlsEnabled)
	addresses, err := resolveAddresses(connection)
	if err != nil {
		return nil, err
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
	if configured, ok := integerProperty(objectOrNil(connection, "properties"), "management_port"); ok {
		return configured
	}
	if tlsEnabled {
		return defaultManagementTLSPort
	}
	return defaultManagementPort
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
