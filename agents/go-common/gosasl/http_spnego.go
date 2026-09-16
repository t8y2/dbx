package gosasl

import (
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

const defaultSPNEGOMaxRounds = 5

// SPNEGORoundTripper performs HTTP Negotiate authentication using the same
// pure-Go Kerberos and Windows SSPI backends as the SASL mechanism.
type SPNEGORoundTripper struct {
	Base                 http.RoundTripper
	Service              string
	Host                 string
	UseTLSChannelBinding bool
	MaxRounds            int
	Options              GSSAPIOptions
	useEnvironment       bool

	mutex  sync.Mutex
	client *GSSAPIContextClient
}

// NewSPNEGORoundTripper creates an HTTP Negotiate transport.
func NewSPNEGORoundTripper(base http.RoundTripper, service, host string, useTLSChannelBinding bool) *SPNEGORoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &SPNEGORoundTripper{
		Base:                 base,
		Service:              service,
		Host:                 host,
		UseTLSChannelBinding: useTLSChannelBinding,
		MaxRounds:            defaultSPNEGOMaxRounds,
		useEnvironment:       true,
	}
}

// NewSPNEGORoundTripperWithOptions creates an HTTP Negotiate transport with
// connection-scoped Kerberos configuration.
func NewSPNEGORoundTripperWithOptions(
	base http.RoundTripper,
	service string,
	host string,
	useTLSChannelBinding bool,
	options GSSAPIOptions,
) *SPNEGORoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &SPNEGORoundTripper{
		Base:                 base,
		Service:              service,
		Host:                 host,
		UseTLSChannelBinding: useTLSChannelBinding,
		MaxRounds:            defaultSPNEGOMaxRounds,
		Options:              options,
	}
}

// RoundTrip implements http.RoundTripper. It serializes authentication because
// GSSAPI contexts carry sequence state and are not safe for concurrent use.
func (transport *SPNEGORoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	transport.mutex.Lock()
	defer transport.mutex.Unlock()

	body, err := replayableRequestBody(request)
	if err != nil {
		return nil, err
	}
	maxRounds := transport.MaxRounds
	if maxRounds <= 0 {
		maxRounds = defaultSPNEGOMaxRounds
	}
	var authorization string
	for round := 0; round < maxRounds; round++ {
		attempt, err := cloneRequestForSPNEGO(request, body)
		if err != nil {
			return nil, err
		}
		if authorization != "" {
			attempt.Header.Set("Authorization", authorization)
		}
		response, err := transport.Base.RoundTrip(attempt)
		if err != nil {
			return nil, err
		}

		challenge, offered, err := negotiateToken(response.Header.Values("WWW-Authenticate"))
		if err != nil {
			closeHTTPResponse(response)
			return nil, err
		}
		if response.StatusCode != http.StatusUnauthorized {
			if !offered || len(challenge) == 0 {
				if transport.client != nil && !transport.client.Complete() {
					closeHTTPResponse(response)
					return nil, errors.New("HTTP Negotiate server did not return a mutual-authentication token")
				}
				return response, nil
			}
			if transport.client == nil {
				closeHTTPResponse(response)
				return nil, errors.New("HTTP Negotiate server returned a token before authentication started")
			}
			output, continueErr := transport.client.Continue(challenge)
			if continueErr != nil {
				closeHTTPResponse(response)
				return nil, fmt.Errorf("processing HTTP Negotiate mutual-authentication token: %w", continueErr)
			}
			if len(output) != 0 || !transport.client.Complete() {
				closeHTTPResponse(response)
				return nil, errors.New("HTTP Negotiate mutual authentication did not complete in the success response")
			}
			return response, nil
		}
		if !offered {
			return response, nil
		}

		channelBinding := []byte(nil)
		if transport.UseTLSChannelBinding {
			channelBinding, err = tlsServerEndpointBinding(response.TLS)
			if err != nil {
				closeHTTPResponse(response)
				return nil, err
			}
		}
		closeHTTPResponse(response)

		if transport.client == nil || transport.client.Complete() {
			if transport.client != nil {
				_ = transport.client.Dispose()
			}
			if transport.useEnvironment {
				transport.client, err = NewGSSAPIContextClient(transport.Service, transport.Host)
			} else {
				transport.client, err = NewGSSAPIContextClientWithOptions(transport.Service, transport.Host, transport.Options)
			}
			if err != nil {
				return nil, err
			}
			var token []byte
			token, err = transport.client.Start(channelBinding)
			if err != nil {
				return nil, err
			}
			if len(challenge) > 0 {
				return nil, errors.New("HTTP Negotiate acceptor-first tokens are not supported")
			}
			authorization = "Negotiate " + base64.StdEncoding.EncodeToString(token)
			continue
		}

		token, continueErr := transport.client.Continue(challenge)
		if continueErr != nil {
			return nil, fmt.Errorf("continuing HTTP Negotiate authentication: %w", continueErr)
		}
		authorization = "Negotiate " + base64.StdEncoding.EncodeToString(token)
	}
	return nil, fmt.Errorf("HTTP Negotiate authentication exceeded %d rounds", maxRounds)
}

// Close releases any active GSSAPI context.
func (transport *SPNEGORoundTripper) Close() error {
	transport.mutex.Lock()
	defer transport.mutex.Unlock()
	if transport.client == nil {
		return nil
	}
	err := transport.client.Dispose()
	transport.client = nil
	return err
}

func replayableRequestBody(request *http.Request) ([]byte, error) {
	if request.Body == nil || request.Body == http.NoBody {
		return nil, nil
	}
	if request.GetBody != nil {
		body, err := request.GetBody()
		if err != nil {
			return nil, fmt.Errorf("reopening HTTP Negotiate request body: %w", err)
		}
		defer body.Close()
		return io.ReadAll(body)
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, fmt.Errorf("buffering HTTP Negotiate request body: %w", err)
	}
	_ = request.Body.Close()
	request.Body = io.NopCloser(strings.NewReader(string(body)))
	return body, nil
}

func cloneRequestForSPNEGO(request *http.Request, body []byte) (*http.Request, error) {
	attempt := request.Clone(request.Context())
	attempt.Header = request.Header.Clone()
	if body == nil {
		attempt.Body = nil
		attempt.GetBody = nil
		return attempt, nil
	}
	attempt.Body = io.NopCloser(strings.NewReader(string(body)))
	attempt.ContentLength = int64(len(body))
	attempt.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(strings.NewReader(string(body))), nil
	}
	return attempt, nil
}

func negotiateToken(headers []string) ([]byte, bool, error) {
	for _, header := range headers {
		for _, value := range strings.Split(header, ",") {
			parts := strings.Fields(strings.TrimSpace(value))
			if len(parts) == 0 || !strings.EqualFold(parts[0], "Negotiate") {
				continue
			}
			if len(parts) == 1 {
				return nil, true, nil
			}
			if len(parts) != 2 {
				return nil, true, fmt.Errorf("invalid HTTP Negotiate challenge %q", value)
			}
			token, err := base64.StdEncoding.DecodeString(parts[1])
			if err != nil {
				return nil, true, fmt.Errorf("decoding HTTP Negotiate challenge: %w", err)
			}
			return token, true, nil
		}
	}
	return nil, false, nil
}

func closeHTTPResponse(response *http.Response) {
	if response == nil || response.Body == nil {
		return
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
}

func tlsServerEndpointBinding(state *tls.ConnectionState) ([]byte, error) {
	if state == nil || len(state.PeerCertificates) == 0 {
		return nil, errors.New("TLS channel binding requested but no peer certificate is available")
	}
	certificate := state.PeerCertificates[0]
	var digest []byte
	switch certificate.SignatureAlgorithm {
	case x509.SHA384WithRSA, x509.ECDSAWithSHA384:
		value := sha512.Sum384(certificate.Raw)
		digest = value[:]
	case x509.SHA512WithRSA, x509.ECDSAWithSHA512:
		value := sha512.Sum512(certificate.Raw)
		digest = value[:]
	default:
		value := sha256.Sum256(certificate.Raw)
		digest = value[:]
	}
	return append([]byte("tls-server-end-point:"), digest...), nil
}
