package gohive

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/beltran/gohive/v2/hiveserver"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestBasicAuthRoundTripperAddsCredentialsWithoutMutatingRequest(t *testing.T) {
	var authorization string
	transport := &basicAuthRoundTripper{
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			authorization = request.Header.Get("Authorization")
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("ok")),
				Request:    request,
			}, nil
		}),
		Username: "user@example.com",
		Password: "p@ss:word",
	}
	request, err := http.NewRequest(http.MethodPost, "http://hs2.example.com/cliservice", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if authorization != "Basic dXNlckBleGFtcGxlLmNvbTpwQHNzOndvcmQ=" {
		t.Fatalf("unexpected Authorization header: %q", authorization)
	}
	if request.Header.Get("Authorization") != "" {
		t.Fatal("original request was mutated")
	}
}

func TestHTTPNoSaslUsesBasicAuthLikeHiveJDBC(t *testing.T) {
	for _, auth := range []string{"NONE", "NOSASL", "LDAP", "CUSTOM"} {
		if !usesHTTPBasicAuth(auth) {
			t.Fatalf("HTTP auth mode %q should send Basic credentials", auth)
		}
	}
	for _, auth := range []string{"KERBEROS", "JWT", "BROWSER", "DIGEST-MD5"} {
		if usesHTTPBasicAuth(auth) {
			t.Fatalf("HTTP auth mode %q must not send Basic credentials", auth)
		}
	}
}

func TestBearerAndDelegationAuthRoundTrippers(t *testing.T) {
	for name, transport := range map[string]http.RoundTripper{
		"jwt": &bearerAuthRoundTripper{
			Base:             captureRoundTripper(t, "Authorization", "Bearer signed-token"),
			Token:            "signed-token",
			ClientIdentifier: "browser-client",
		},
		"delegation": &headerAuthRoundTripper{
			Base:  captureRoundTripper(t, "X-Hive-Delegation-Token", "delegation-token"),
			Name:  "X-Hive-Delegation-Token",
			Value: "delegation-token",
		},
	} {
		t.Run(name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, "http://hs2.example.com/cliservice", strings.NewReader("payload"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := transport.RoundTrip(request); err != nil {
				t.Fatal(err)
			}
			if request.Header.Get("Authorization") != "" || request.Header.Get("X-Hive-Delegation-Token") != "" {
				t.Fatal("original request was mutated")
			}
		})
	}
}

func captureRoundTripper(t *testing.T, header, expected string) http.RoundTripper {
	t.Helper()
	return roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if actual := request.Header.Get(header); actual != expected {
			t.Fatalf("%s = %q, expected %q", header, actual, expected)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
	})
}

func TestCustomHTTPRoundTripperAddsHeadersAndCookies(t *testing.T) {
	transport := &customHTTPRoundTripper{
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.Header.Get("X-Trace-ID") != "trace-value" {
				t.Fatalf("custom header missing: %#v", request.Header)
			}
			if request.Header.Get("X-XSRF-HEADER") != "true" || request.Header.Get("X-CSRF-TOKEN") != "true" {
				t.Fatalf("Hive HTTP compatibility headers missing: %#v", request.Header)
			}
			cookie, err := request.Cookie("SessionID")
			if err != nil || cookie.Value != "cookie-value" {
				t.Fatalf("custom cookie missing: cookie=%#v err=%v", cookie, err)
			}
			return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
		}),
		Headers: map[string]string{"X-Trace-ID": "trace-value"},
		Cookies: map[string]string{"SessionID": "cookie-value"},
	}
	request, err := http.NewRequest(http.MethodGet, "http://hs2.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("X-Trace-ID") != "" || request.Header.Get("Cookie") != "" {
		t.Fatal("original request was mutated")
	}
}

func TestCustomHTTPRoundTripperTracksRequestsAcrossOpenSession(t *testing.T) {
	tracker := newHTTPRequestTracker()
	var requestIDs []string
	transport := &customHTTPRoundTripper{
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			requestIDs = append(requestIDs, request.Header.Get("X-Request-ID"))
			return httpResponse(request, http.StatusOK), nil
		}),
		RequestTracker: tracker,
	}
	request, err := http.NewRequest(http.MethodPost, "http://hs2.example.com", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	tracker.setSessionHandle(&hiveserver.TSessionHandle{SessionId: &hiveserver.THandleIdentifier{GUID: []byte{0x01, 0xab}}})
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if len(requestIDs) != 2 || requestIDs[0] != "HIVE_NO_SESSION_00000000000000000001" || requestIDs[1] != "HIVE_01ab_00000000000000000002" {
		t.Fatalf("unexpected request IDs: %v", requestIDs)
	}
	if request.Header.Get("X-Request-ID") != "" {
		t.Fatal("original request was mutated")
	}
}

func TestCookieAuthRoundTripperUsesAuthWithoutCookie(t *testing.T) {
	baseCalls := 0
	authCalls := 0
	transport := &cookieAuthRoundTripper{
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			baseCalls++
			return nil, nil
		}),
		Auth: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			authCalls++
			return httpResponse(request, http.StatusOK), nil
		}),
		CookieName: "hive.server2.auth",
	}
	request, err := http.NewRequest(http.MethodGet, "http://hs2.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if baseCalls != 0 || authCalls != 1 {
		t.Fatalf("unexpected transport calls: base=%d auth=%d", baseCalls, authCalls)
	}
}

func TestCookieAuthRoundTripperUsesCookieWithoutAuth(t *testing.T) {
	baseCalls := 0
	authCalls := 0
	transport := &cookieAuthRoundTripper{
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			baseCalls++
			return httpResponse(request, http.StatusOK), nil
		}),
		Auth: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			authCalls++
			return httpResponse(request, http.StatusOK), nil
		}),
		CookieName: "hive.server2.auth",
	}
	request, err := http.NewRequest(http.MethodGet, "http://hs2.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "hive.server2.auth", Value: "session-token"})
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if baseCalls != 1 || authCalls != 0 {
		t.Fatalf("unexpected transport calls: base=%d auth=%d", baseCalls, authCalls)
	}
}

func TestCookieAuthRoundTripperRetriesWithAuthAfterUnauthorized(t *testing.T) {
	baseCalls := 0
	authCalls := 0
	transport := &cookieAuthRoundTripper{
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			baseCalls++
			payload, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(payload) != "payload" {
				t.Fatalf("unexpected initial payload: %q", payload)
			}
			return httpResponse(request, http.StatusUnauthorized), nil
		}),
		Auth: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			authCalls++
			payload, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			if string(payload) != "payload" {
				t.Fatalf("unexpected retry payload: %q", payload)
			}
			return httpResponse(request, http.StatusOK), nil
		}),
		CookieName: "hive.server2.auth",
	}
	request, err := http.NewRequest(http.MethodPost, "http://hs2.example.com", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Original", "preserved")
	request.AddCookie(&http.Cookie{Name: "hive.server2.auth", Value: "expired-token"})
	originalHeaders := request.Header.Clone()
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if baseCalls != 1 || authCalls != 1 {
		t.Fatalf("unexpected transport calls: base=%d auth=%d", baseCalls, authCalls)
	}
	if request.Header.Get("Authorization") != "" || request.Header.Get("X-Original") != originalHeaders.Get("X-Original") || request.Header.Get("Cookie") != originalHeaders.Get("Cookie") {
		t.Fatalf("original request was mutated: %#v", request.Header)
	}
}

func TestWithCookieAuthenticationDisabledAlwaysUsesAuth(t *testing.T) {
	baseCalls := 0
	authCalls := 0
	base := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		baseCalls++
		return httpResponse(request, http.StatusOK), nil
	})
	auth := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		authCalls++
		return httpResponse(request, http.StatusOK), nil
	})
	transport := withCookieAuthentication(&connectConfiguration{DisableCookieAuth: true}, base, auth)
	request, err := http.NewRequest(http.MethodGet, "http://hs2.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.AddCookie(&http.Cookie{Name: "hive.server2.auth", Value: "session-token"})
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if baseCalls != 0 || authCalls != 1 {
		t.Fatalf("unexpected transport calls: base=%d auth=%d", baseCalls, authCalls)
	}
}

func TestCookieAuthenticationUsesConfiguredAuthenticationCookie(t *testing.T) {
	baseCalls := 0
	authCalls := 0
	base := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		baseCalls++
		return httpResponse(request, http.StatusOK), nil
	})
	auth := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		authCalls++
		return httpResponse(request, http.StatusOK), nil
	})
	transport := withCookieAuthentication(&connectConfiguration{
		CookieName:  "hive.server2.auth",
		HTTPCookies: map[string]string{"hive.server2.auth": "session-token"},
	}, base, auth)
	request, err := http.NewRequest(http.MethodGet, "http://hs2.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if baseCalls != 1 || authCalls != 0 {
		t.Fatalf("unexpected transport calls: base=%d auth=%d", baseCalls, authCalls)
	}
}

func httpResponse(request *http.Request, statusCode int) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Header:     make(http.Header),
		Body:       http.NoBody,
		Request:    request,
	}
}

func TestHiveHTTPURLSupportsIPv6AndEscapesPath(t *testing.T) {
	value := hiveHTTPURL("https", "2001:db8::1", 10001, "/gateway/hive service/")
	if value != "https://[2001:db8::1]:10001/gateway/hive%20service" {
		t.Fatalf("unexpected Hive HTTP URL: %q", value)
	}
}

func TestGetHTTPClientUsesConfiguredDialTimeout(t *testing.T) {
	client, protocol, err := getHTTPClient(&connectConfiguration{ConnectTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if protocol != "http" {
		t.Fatalf("unexpected protocol: %q", protocol)
	}
	deduplicating, ok := client.Transport.(*cookieDedupTransport)
	if !ok {
		t.Fatalf("unexpected transport: %T", client.Transport)
	}
	base, ok := deduplicating.RoundTripper.(*http.Transport)
	if !ok || base.DialContext == nil {
		t.Fatalf("HTTP transport has no dial context: %T", deduplicating.RoundTripper)
	}
}

func TestPrepareHTTPClientHonorsCookieAuth(t *testing.T) {
	enabled, _, err := prepareHTTPClient(&connectConfiguration{})
	if err != nil {
		t.Fatal(err)
	}
	if enabled.Jar == nil {
		t.Fatal("cookie authentication should be enabled by default")
	}
	disabled, _, err := prepareHTTPClient(&connectConfiguration{DisableCookieAuth: true})
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Jar != nil {
		t.Fatal("cookie authentication was not disabled")
	}
}

func TestCookieDedupTransportDoesNotMutateOriginalRequest(t *testing.T) {
	var cookieHeader string
	transport := &cookieDedupTransport{RoundTripper: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		cookieHeader = request.Header.Get("Cookie")
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
	})}
	request, err := http.NewRequest(http.MethodGet, "http://hs2.example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Add("Cookie", "session=first; session=second; route=node-a")
	original := request.Header.Get("Cookie")
	if _, err := transport.RoundTrip(request); err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("Cookie") != original {
		t.Fatalf("original Cookie header was mutated: %q", request.Header.Get("Cookie"))
	}
	if strings.Count(cookieHeader, "session=") != 1 || !strings.Contains(cookieHeader, "session=second") || !strings.Contains(cookieHeader, "route=node-a") {
		t.Fatalf("cookies were not deduplicated: %q", cookieHeader)
	}
}

func TestQuoteHiveIdentifierEscapesBackticks(t *testing.T) {
	if value := quoteHiveIdentifier("analytics`prod"); value != "`analytics``prod`" {
		t.Fatalf("unexpected quoted identifier: %q", value)
	}
}
