package gohive

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBrowserSSOClientAuthenticatesThroughLoopbackCallback(t *testing.T) {
	client := newBrowserSSOClient(0, time.Second)
	if err := client.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err := client.SetRedirect("https://identity.example.com/sso?RelayState=test", "browser-client"); err != nil {
		t.Fatal(err)
	}
	client.openURL = func(rawURL string) error {
		if rawURL != "https://identity.example.com/sso?RelayState=test" {
			t.Fatalf("unexpected browser URL: %q", rawURL)
		}
		response, err := http.PostForm(
			"http://127.0.0.1:"+strconv.Itoa(client.Port())+"/",
			url.Values{"status": {"true"}, "token": {"signed-browser-token"}},
		)
		if err != nil {
			return err
		}
		return response.Body.Close()
	}
	if err := client.Authenticate(context.Background()); err != nil {
		t.Fatal(err)
	}
	token, clientIdentifier := client.Credentials()
	if token != "signed-browser-token" || clientIdentifier != "browser-client" {
		t.Fatalf("unexpected browser credentials: token=%q client=%q", token, clientIdentifier)
	}
}

func TestBrowserAuthRoundTripperCompletesRedirectAndBearerFlow(t *testing.T) {
	client := newBrowserSSOClient(0, time.Second)
	if err := client.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	calls := 0
	transport := &browserAuthRoundTripper{
		Client: client,
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				if request.Header.Get("X-Hive-Token-Response-Port") != strconv.Itoa(client.Port()) || request.Header.Get("Authorization") != "" {
					t.Fatalf("unexpected initial browser headers: %#v", request.Header)
				}
				response := httpResponse(request, http.StatusFound)
				response.Header.Set("Location", "https://identity.example.com/sso")
				response.Header.Set("X-Hive-Client-Identifier", "browser-client")
				return response, nil
			}
			if request.Header.Get("Authorization") != "Bearer signed-browser-token" || request.Header.Get("X-Hive-Client-Identifier") != "browser-client" || request.Header.Get("X-Hive-Token-Response-Port") != "" {
				t.Fatalf("unexpected authenticated browser headers: %#v", request.Header)
			}
			return httpResponse(request, http.StatusOK), nil
		}),
	}
	request, err := http.NewRequest(http.MethodPost, "https://hs2.example.com/cliservice", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if !client.HasRedirect() {
		t.Fatal("browser redirect was not captured")
	}
	client.openURL = func(string) error {
		client.responses <- browserSSOResponse{Successful: true, Token: "signed-browser-token"}
		return nil
	}
	if err := client.Authenticate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || request.Header.Get("Authorization") != "" || request.Header.Get("X-Hive-Token-Response-Port") != "" {
		t.Fatalf("browser transport mutated request or skipped a call: calls=%d headers=%#v", calls, request.Header)
	}
}

func TestBrowserSSORedirectValidation(t *testing.T) {
	client := newBrowserSSOClient(0, time.Second)
	for _, rawURL := range []string{"", "/relative", "file:///tmp/token"} {
		if err := client.SetRedirect(rawURL, "browser-client"); err == nil {
			t.Fatalf("expected redirect %q to be rejected", rawURL)
		}
	}
	if err := client.SetRedirect("https://identity.example.com/sso", ""); err == nil {
		t.Fatal("expected missing client identifier to be rejected")
	}
}

func TestBrowserAuthenticationRequiresHTTPAndTLS(t *testing.T) {
	_, err := innerConnect(context.Background(), "127.0.0.1", 1, "BROWSER", &connectConfiguration{})
	if err == nil || !strings.Contains(err.Error(), "HTTP transport") {
		t.Fatalf("unexpected binary browser error: %v", err)
	}
	_, err = innerConnect(context.Background(), "127.0.0.1", 1, "BROWSER", &connectConfiguration{TransportMode: "http"})
	if err == nil || !strings.Contains(err.Error(), "ssl=true") {
		t.Fatalf("unexpected insecure browser error: %v", err)
	}
}
