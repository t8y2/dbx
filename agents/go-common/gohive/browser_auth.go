package gohive

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultBrowserResponseTimeout = 120 * time.Second

type browserSSOResponse struct {
	Successful bool
	Message    string
	Token      string
}

type browserSSOClient struct {
	configuredPort int
	timeout        time.Duration
	openURL        func(string) error
	responses      chan browserSSOResponse

	mu               sync.RWMutex
	server           *http.Server
	listener         net.Listener
	port             int
	redirectURL      *url.URL
	clientIdentifier string
	token            string
}

func newBrowserSSOClient(port int, timeout time.Duration) *browserSSOClient {
	if timeout <= 0 {
		timeout = defaultBrowserResponseTimeout
	}
	return &browserSSOClient{
		configuredPort: port,
		timeout:        timeout,
		openURL:        openBrowserURL,
		responses:      make(chan browserSSOResponse, 1),
	}
}

func (client *browserSSOClient) Start() error {
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(client.configuredPort)))
	if err != nil {
		return fmt.Errorf("start Hive browser SSO callback listener: %w", err)
	}
	server := &http.Server{
		Handler:           client,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       client.timeout,
	}
	client.mu.Lock()
	client.listener = listener
	client.server = server
	client.port = listener.Addr().(*net.TCPAddr).Port
	client.mu.Unlock()
	go func() {
		_ = server.Serve(listener)
	}()
	return nil
}

func (client *browserSSOClient) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(responseWriter, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	request.Body = http.MaxBytesReader(responseWriter, request.Body, 1<<20)
	if err := request.ParseForm(); err != nil {
		http.Error(responseWriter, "invalid SSO response", http.StatusBadRequest)
		return
	}
	response := browserSSOResponse{
		Successful: strings.EqualFold(request.FormValue("status"), "true"),
		Message:    request.FormValue("message"),
		Token:      request.FormValue("token"),
	}
	responseWriter.Header().Set("Content-Type", "text/html; charset=utf-8")
	responseWriter.WriteHeader(http.StatusOK)
	if response.Successful {
		_, _ = responseWriter.Write([]byte("Successfully authenticated. You may close this window."))
	} else {
		_, _ = responseWriter.Write([]byte("Authentication failed. You may close this window."))
	}
	select {
	case client.responses <- response:
	default:
	}
}

func (client *browserSSOClient) Port() int {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.port
}

func (client *browserSSOClient) SetRedirect(rawURL, clientIdentifier string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || !parsed.IsAbs() || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return fmt.Errorf("invalid Hive browser SSO redirect URL %q", rawURL)
	}
	if strings.TrimSpace(clientIdentifier) == "" {
		return errors.New("Hive browser SSO response omitted X-Hive-Client-Identifier")
	}
	client.mu.Lock()
	client.redirectURL = parsed
	client.clientIdentifier = clientIdentifier
	client.mu.Unlock()
	return nil
}

func (client *browserSSOClient) HasRedirect() bool {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.redirectURL != nil
}

func (client *browserSSOClient) Authenticate(ctx context.Context) error {
	client.mu.RLock()
	redirectURL := client.redirectURL
	openURL := client.openURL
	timeout := client.timeout
	client.mu.RUnlock()
	if redirectURL == nil {
		return errors.New("Hive browser SSO did not receive a redirect URL")
	}
	if err := openURL(redirectURL.String()); err != nil {
		return fmt.Errorf("open Hive browser SSO URL: %w", err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("timed out while waiting for Hive browser SSO response")
	case response := <-client.responses:
		if !response.Successful {
			if strings.TrimSpace(response.Message) == "" {
				return errors.New("Hive browser SSO authentication failed")
			}
			return fmt.Errorf("Hive browser SSO authentication failed: %s", response.Message)
		}
		if strings.TrimSpace(response.Token) == "" {
			return errors.New("Hive browser SSO returned an empty token")
		}
		client.mu.Lock()
		client.token = response.Token
		client.mu.Unlock()
		return nil
	}
}

func (client *browserSSOClient) Credentials() (string, string) {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.token, client.clientIdentifier
}

func (client *browserSSOClient) Close() error {
	client.mu.Lock()
	server := client.server
	listener := client.listener
	client.server = nil
	client.listener = nil
	client.mu.Unlock()
	if server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
	if listener != nil {
		return listener.Close()
	}
	return nil
}

type browserAuthRoundTripper struct {
	Base   http.RoundTripper
	Client *browserSSOClient
}

func (transport *browserAuthRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	base := transport.Base
	if base == nil {
		base = http.DefaultTransport
	}
	attempt := request.Clone(request.Context())
	attempt.Header = request.Header.Clone()
	token, clientIdentifier := transport.Client.Credentials()
	if token == "" {
		port := transport.Client.Port()
		if port <= 0 {
			return nil, errors.New("Hive browser SSO callback listener is not running")
		}
		attempt.Header.Set("X-Hive-Token-Response-Port", strconv.Itoa(port))
	} else {
		attempt.Header.Del("X-Hive-Token-Response-Port")
		attempt.Header.Set("Authorization", "Bearer "+token)
		attempt.Header.Set("X-Hive-Client-Identifier", clientIdentifier)
	}
	response, err := base.RoundTrip(attempt)
	if err != nil || response == nil || (response.StatusCode != http.StatusFound && response.StatusCode != http.StatusSeeOther) {
		return response, err
	}
	if err := transport.Client.SetRedirect(response.Header.Get("Location"), response.Header.Get("X-Hive-Client-Identifier")); err != nil {
		if response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, err
	}
	return response, nil
}

func openBrowserURL(rawURL string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", rawURL)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	case "linux":
		command = exec.Command("xdg-open", rawURL)
	default:
		return fmt.Errorf("unsupported operating system %s", runtime.GOOS)
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
