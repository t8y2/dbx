package gosasl

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
)

type scriptedRoundTripper struct {
	responses []*http.Response
	requests  []*http.Request
	bodies    [][]byte
}

func (transport *scriptedRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	transport.requests = append(transport.requests, request)
	transport.bodies = append(transport.bodies, body)
	response := transport.responses[len(transport.requests)-1]
	response.Request = request
	return response, nil
}

func spnegoResponse(status int, challenge string) *http.Response {
	header := make(http.Header)
	if challenge != "" {
		header.Set("WWW-Authenticate", challenge)
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader("response")),
	}
}

func TestSPNEGORoundTripperPerformsMutualAuthentication(t *testing.T) {
	backend := &fakeGSSAPIBackend{
		establishAfter:  2,
		continueOutputs: [][]byte{[]byte("initial-token"), nil},
	}
	installFakeGSSAPIBackend(t, backend)
	base := &scriptedRoundTripper{responses: []*http.Response{
		spnegoResponse(http.StatusUnauthorized, "Basic realm=ignored, Negotiate"),
		spnegoResponse(http.StatusOK, "Negotiate "+base64.StdEncoding.EncodeToString([]byte("mutual-token"))),
	}}
	transport := NewSPNEGORoundTripper(base, "HTTP", "hs2.example.com", false)
	request, err := http.NewRequest(http.MethodPost, "http://hs2.example.com/cliservice", bytes.NewBufferString("thrift-request"))
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if len(base.requests) != 2 {
		t.Fatalf("expected 2 HTTP attempts, got %d", len(base.requests))
	}
	if got := base.requests[0].Header.Get("Authorization"); got != "" {
		t.Fatalf("first request should await the challenge, got %q", got)
	}
	wantAuthorization := "Negotiate " + base64.StdEncoding.EncodeToString([]byte("initial-token"))
	if got := base.requests[1].Header.Get("Authorization"); got != wantAuthorization {
		t.Fatalf("unexpected authorization header %q", got)
	}
	for index, body := range base.bodies {
		if string(body) != "thrift-request" {
			t.Fatalf("attempt %d changed the request body to %q", index, body)
		}
	}
	if len(backend.continueInputs) != 2 || string(backend.continueInputs[1]) != "mutual-token" {
		t.Fatalf("unexpected GSSAPI tokens %q", backend.continueInputs)
	}
	if !transport.client.Complete() {
		t.Fatal("GSSAPI context should be complete")
	}
}

func TestSPNEGORoundTripperSupportsMultiple401Rounds(t *testing.T) {
	backend := &fakeGSSAPIBackend{
		establishAfter:  3,
		continueOutputs: [][]byte{[]byte("token-1"), []byte("token-2"), nil},
	}
	installFakeGSSAPIBackend(t, backend)
	base := &scriptedRoundTripper{responses: []*http.Response{
		spnegoResponse(http.StatusUnauthorized, "Negotiate"),
		spnegoResponse(http.StatusUnauthorized, "Negotiate "+base64.StdEncoding.EncodeToString([]byte("challenge-2"))),
		spnegoResponse(http.StatusOK, "Negotiate "+base64.StdEncoding.EncodeToString([]byte("challenge-3"))),
	}}
	transport := NewSPNEGORoundTripper(base, "HTTP", "host", false)
	request, _ := http.NewRequest(http.MethodPost, "http://host/cliservice", strings.NewReader("body"))
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(base.requests) != 3 {
		t.Fatalf("expected 3 attempts, got %d", len(base.requests))
	}
	if got := base.requests[2].Header.Get("Authorization"); got != "Negotiate "+base64.StdEncoding.EncodeToString([]byte("token-2")) {
		t.Fatalf("unexpected final authorization %q", got)
	}
}

func TestSPNEGORoundTripperLeavesNonNegotiate401Untouched(t *testing.T) {
	base := &scriptedRoundTripper{responses: []*http.Response{
		spnegoResponse(http.StatusUnauthorized, `Basic realm="hive"`),
	}}
	transport := NewSPNEGORoundTripper(base, "HTTP", "host", false)
	request, _ := http.NewRequest(http.MethodPost, "http://host/cliservice", strings.NewReader("body"))
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized || transport.client != nil {
		t.Fatalf("unexpected response=%d client=%v", response.StatusCode, transport.client)
	}
}

func TestSPNEGORoundTripperRejectsMissingMutualToken(t *testing.T) {
	backend := &fakeGSSAPIBackend{
		establishAfter:  2,
		continueOutputs: [][]byte{[]byte("initial-token")},
	}
	installFakeGSSAPIBackend(t, backend)
	base := &scriptedRoundTripper{responses: []*http.Response{
		spnegoResponse(http.StatusUnauthorized, "Negotiate"),
		spnegoResponse(http.StatusOK, ""),
	}}
	transport := NewSPNEGORoundTripper(base, "HTTP", "host", false)
	request, _ := http.NewRequest(http.MethodPost, "http://host/cliservice", strings.NewReader("body"))
	if _, err := transport.RoundTrip(request); err == nil {
		t.Fatal("expected missing mutual-authentication token error")
	}
}

func TestSPNEGORoundTripperUsesTLSChannelBinding(t *testing.T) {
	certificate := &x509.Certificate{Raw: []byte("certificate"), SignatureAlgorithm: x509.SHA1WithRSA}
	unauthorized := spnegoResponse(http.StatusUnauthorized, "Negotiate")
	unauthorized.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{certificate}}
	backend := &fakeGSSAPIBackend{
		establishAfter:  1,
		continueOutputs: [][]byte{[]byte("initial-token")},
	}
	installFakeGSSAPIBackend(t, backend)
	base := &scriptedRoundTripper{responses: []*http.Response{
		unauthorized,
		spnegoResponse(http.StatusOK, ""),
	}}
	transport := NewSPNEGORoundTripper(base, "HTTP", "host", true)
	request, _ := http.NewRequest(http.MethodPost, "https://host/cliservice", strings.NewReader("body"))
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	digest := sha256.Sum256(certificate.Raw)
	want := append([]byte("tls-server-end-point:"), digest[:]...)
	if !bytes.Equal(backend.channelBinding, want) {
		t.Fatalf("unexpected channel binding %x", backend.channelBinding)
	}
}

func TestNegotiateTokenParsing(t *testing.T) {
	token, offered, err := negotiateToken([]string{"Basic realm=x", "Negotiate " + base64.StdEncoding.EncodeToString([]byte("token"))})
	if err != nil || !offered || string(token) != "token" {
		t.Fatalf("token=%q offered=%v err=%v", token, offered, err)
	}
	if _, _, err := negotiateToken([]string{"Negotiate !!!"}); err == nil {
		t.Fatal("expected invalid base64 error")
	}
}
