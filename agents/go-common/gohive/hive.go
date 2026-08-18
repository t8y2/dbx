package gohive

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os/user"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"database/sql/driver"

	"github.com/apache/thrift/lib/go/thrift"
	"github.com/beltran/gohive/v2/hiveserver"
	"github.com/beltran/gosasl"
	"github.com/pkg/errors"
	"golang.org/x/net/publicsuffix"
)

const defaultFetchSize int64 = 1000
const zookeeperDefaultNamespace = "hiveserver2"
const defaultMaxLength = 16384000

// Cursor states
const (
	_NONE = iota
	_RUNNING
	_FINISHED
	_ERROR
	_CONTEXT_DONE
	_ASYNC_ENDED
)

type dialContextFunc func(ctx context.Context, network, addr string) (net.Conn, error)

type basicAuthRoundTripper struct {
	Base     http.RoundTripper
	Username string
	Password string
}

type bearerAuthRoundTripper struct {
	Base             http.RoundTripper
	Token            string
	ClientIdentifier string
}

func (transport *bearerAuthRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	base := transport.Base
	if base == nil {
		base = http.DefaultTransport
	}
	attempt := request.Clone(request.Context())
	attempt.Header = request.Header.Clone()
	attempt.Header.Set("Authorization", "Bearer "+transport.Token)
	if transport.ClientIdentifier != "" {
		attempt.Header.Set("X-Hive-Client-Identifier", transport.ClientIdentifier)
	}
	return base.RoundTrip(attempt)
}

type headerAuthRoundTripper struct {
	Base  http.RoundTripper
	Name  string
	Value string
}

func (transport *headerAuthRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	base := transport.Base
	if base == nil {
		base = http.DefaultTransport
	}
	attempt := request.Clone(request.Context())
	attempt.Header = request.Header.Clone()
	attempt.Header.Set(transport.Name, transport.Value)
	return base.RoundTrip(attempt)
}

type customHTTPRoundTripper struct {
	Base           http.RoundTripper
	Headers        map[string]string
	Cookies        map[string]string
	RequestTracker *httpRequestTracker
}

type cookieAuthRoundTripper struct {
	Base            http.RoundTripper
	Auth            http.RoundTripper
	CookieName      string
	HasStaticCookie bool
}

func (transport *cookieAuthRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if !transport.HasStaticCookie && !hasNamedCookie(request, transport.CookieName) {
		return transport.Auth.RoundTrip(request)
	}
	if request.Body != nil && request.GetBody == nil {
		return transport.Auth.RoundTrip(request)
	}
	response, err := transport.Base.RoundTrip(request)
	if err != nil || response.StatusCode != http.StatusUnauthorized {
		return response, err
	}
	if response.Body != nil {
		_ = response.Body.Close()
	}
	retry := request.Clone(request.Context())
	retry.Header = request.Header.Clone()
	if request.GetBody != nil {
		retry.Body, err = request.GetBody()
		if err != nil {
			return nil, err
		}
	}
	return transport.Auth.RoundTrip(retry)
}

func hasNamedCookie(request *http.Request, name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	_, err := request.Cookie(name)
	return err == nil
}

func withCookieAuthentication(configuration *connectConfiguration, base, auth http.RoundTripper) http.RoundTripper {
	if configuration.DisableCookieAuth {
		return auth
	}
	return &cookieAuthRoundTripper{
		Base:            base,
		Auth:            auth,
		CookieName:      configuration.CookieName,
		HasStaticCookie: hasConfiguredCookie(configuration.HTTPCookies, configuration.CookieName),
	}
}

func hasConfiguredCookie(cookies map[string]string, name string) bool {
	if strings.TrimSpace(name) == "" {
		return false
	}
	_, exists := cookies[name]
	return exists
}

type httpRequestTracker struct {
	mu        sync.Mutex
	sessionID string
	counter   uint64
}

func newHTTPRequestTracker() *httpRequestTracker {
	return &httpRequestTracker{sessionID: "NO_SESSION"}
}

func (tracker *httpRequestTracker) next() string {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	tracker.counter++
	return fmt.Sprintf("HIVE_%s_%020d", tracker.sessionID, tracker.counter)
}

func (tracker *httpRequestTracker) setSessionHandle(handle *hiveserver.TSessionHandle) {
	if handle == nil || handle.SessionId == nil || len(handle.SessionId.GUID) == 0 {
		return
	}
	tracker.mu.Lock()
	tracker.sessionID = fmt.Sprintf("%x", handle.SessionId.GUID)
	tracker.mu.Unlock()
}

func (transport *customHTTPRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	base := transport.Base
	if base == nil {
		base = http.DefaultTransport
	}
	attempt := request.Clone(request.Context())
	attempt.Header = request.Header.Clone()
	for name, value := range transport.Headers {
		attempt.Header.Add(name, value)
	}
	for name, value := range transport.Cookies {
		attempt.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	attempt.Header.Add("X-XSRF-HEADER", "true")
	attempt.Header.Add("X-CSRF-TOKEN", "true")
	if transport.RequestTracker != nil {
		attempt.Header.Set("X-Request-ID", transport.RequestTracker.next())
	}
	return base.RoundTrip(attempt)
}

func (transport *basicAuthRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	base := transport.Base
	if base == nil {
		base = http.DefaultTransport
	}
	attempt := request.Clone(request.Context())
	attempt.Header = request.Header.Clone()
	attempt.SetBasicAuth(transport.Username, transport.Password)
	return base.RoundTrip(attempt)
}

func hiveHTTPURL(protocol, host string, port int, path string) string {
	return (&url.URL{
		Scheme: protocol,
		Host:   net.JoinHostPort(host, strconv.Itoa(port)),
		Path:   "/" + strings.Trim(path, "/"),
	}).String()
}

// connection holds the information for getting a cursor to hive.
type connection struct {
	host                string
	port                int
	username            string
	database            string
	auth                string
	kerberosServiceName string
	password            string
	sessionHandle       *hiveserver.TSessionHandle
	client              *hiveserver.TCLIServiceClient
	configuration       *connectConfiguration
	transport           thrift.TTransport
	authCloser          interface{ Close() error }
	mu                  sync.Mutex // Mutex to protect connection operations
	clientMu            sync.Mutex // Mutex to protect client operations
}

// connectConfiguration is the configuration for the connection
// The fields have to be filled manually but not all of them are required
// Depends on the auth and kind of connection.
type connectConfiguration struct {
	Username                   string
	Principal                  string
	Password                   string
	Service                    string
	HiveConfiguration          map[string]string
	PollIntervalInMillis       int
	FetchSize                  int64
	TransportMode              string
	HTTPPath                   string
	TLSConfig                  *tls.Config
	ZookeeperNamespace         string
	Database                   string
	ConnectTimeout             time.Duration
	SocketTimeout              time.Duration
	HttpTimeout                time.Duration
	DialContext                dialContextFunc
	DisableKeepAlives          bool
	HTTPKerberosChannelBinding bool
	GSSAPIOptions              gosasl.GSSAPIOptions
	HTTPHeaders                map[string]string
	HTTPCookies                map[string]string
	RequestTracking            bool
	RequestTracker             *httpRequestTracker
	DisableCookieAuth          bool
	CookieName                 string
	JWT                        string
	DelegationToken            string
	BrowserToken               string
	BrowserClientID            string
	BrowserResponsePort        int
	BrowserResponseTimeout     time.Duration
	BrowserDisableSSLCheck     bool
	WaitForNonQueryCompletion  bool
	// Maximum length of the data in bytes. Used for SASL.
	MaxSize        uint32
	MaxMessageSize int32
}

// newConnectConfiguration returns a connect configuration, all with empty fields
func newConnectConfiguration() *connectConfiguration {
	return &connectConfiguration{
		Username:             "",
		Password:             "",
		Service:              "",
		HiveConfiguration:    nil,
		PollIntervalInMillis: 200,
		FetchSize:            defaultFetchSize,
		TransportMode:        "binary",
		HTTPPath:             "cliservice",
		TLSConfig:            nil,
		ZookeeperNamespace:   zookeeperDefaultNamespace,
		CookieName:           "hive.server2.auth",
		MaxSize:              defaultMaxLength,
	}
}

// Error represents an error surfaced from HiveServer2.
type Error struct {
	Err error

	// Simple error message, without the full stack trace. Surfaced from Thrift.
	Message string
	// See https://github.com/apache/hive/blob/master/common/src/java/org/apache/hadoop/hive/ql/ErrorMsg.java for info about error codes.
	ErrorCode int
	SQLState  string
}

func (err *Error) Error() string {
	if err == nil || err.Err == nil {
		return "HiveServer2 error"
	}
	return err.Err.Error()
}

func (err *Error) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.Err
}

// connect to hive server
func connect(ctx context.Context, host string, port int, auth string,
	configuration *connectConfiguration) (conn *connection, err error) {
	return innerConnect(ctx, host, port, auth, configuration)
}

func parseHiveServer2Info(hsInfos []string) []map[string]string {
	results := make([]map[string]string, len(hsInfos))
	actualCount := 0

	for _, hsInfo := range hsInfos {
		validFormat := false
		node := make(map[string]string)

		for _, param := range strings.Split(hsInfo, ";") {
			kvPair := strings.Split(param, "=")
			if len(kvPair) < 2 {
				break
			}
			if kvPair[0] == "serverUri" {
				hostAndPort := strings.Split(kvPair[1], ":")
				if len(hostAndPort) == 2 {
					node["host"] = hostAndPort[0]
					node["port"] = hostAndPort[1]
					validFormat = len(node["host"]) != 0 && len(node["port"]) != 0
				} else {
					break
				}
			} else {
				node[kvPair[0]] = kvPair[1]
			}
		}
		if validFormat {
			results[actualCount] = node
			actualCount++
		}
	}
	return results[0:actualCount]
}

func dial(ctx context.Context, addr string, dialFn dialContextFunc, timeout time.Duration) (net.Conn, error) {
	dctx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		dctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	return dialFn(dctx, "tcp", addr)
}

func innerConnect(ctx context.Context, host string, port int, auth string,
	configuration *connectConfiguration) (conn *connection, err error) {
	if configuration == nil {
		configuration = newConnectConfiguration()
	}
	if auth == "BROWSER" {
		if configuration.TransportMode != "http" {
			return nil, errors.New("Hive browser authentication requires HTTP transport mode")
		}
		if configuration.TLSConfig == nil && !configuration.BrowserDisableSSLCheck {
			return nil, errors.New("Hive browser authentication requires ssl=true unless browserDisableSslCheck=true")
		}
	}
	var authCloser interface{ Close() error }
	var browserClient *browserSSOClient
	var transport thrift.TTransport
	defer func() {
		if err != nil {
			if transport != nil {
				_ = transport.Close()
			}
			if authCloser != nil {
				_ = authCloser.Close()
			}
		}
	}()

	var socket thrift.TTransport
	addr := fmt.Sprintf("%s:%d", host, port)
	if configuration.DialContext != nil {
		var netConn net.Conn
		netConn, err = dial(ctx, addr, configuration.DialContext, configuration.ConnectTimeout)
		if err != nil {
			return
		}
		if configuration.TLSConfig != nil {
			socket = thrift.NewTSSLSocketFromConnConf(netConn, &thrift.TConfiguration{
				ConnectTimeout: configuration.ConnectTimeout,
				SocketTimeout:  configuration.SocketTimeout,
				MaxMessageSize: configuration.MaxMessageSize,
				TLSConfig:      configuration.TLSConfig,
			})
		} else {
			socket = thrift.NewTSocketFromConnConf(netConn, &thrift.TConfiguration{
				ConnectTimeout: configuration.ConnectTimeout,
				SocketTimeout:  configuration.SocketTimeout,
				MaxMessageSize: configuration.MaxMessageSize,
			})
		}
	} else {
		if configuration.TLSConfig != nil {
			socket = thrift.NewTSSLSocketConf(addr, &thrift.TConfiguration{
				ConnectTimeout: configuration.ConnectTimeout,
				SocketTimeout:  configuration.SocketTimeout,
				MaxMessageSize: configuration.MaxMessageSize,
				TLSConfig:      configuration.TLSConfig,
			})
		} else {
			socket = thrift.NewTSocketConf(addr, &thrift.TConfiguration{
				ConnectTimeout: configuration.ConnectTimeout,
				SocketTimeout:  configuration.SocketTimeout,
				MaxMessageSize: configuration.MaxMessageSize,
			})
		}
		if err = socket.Open(); err != nil {
			return
		}
	}

	if configuration.Username == "" {
		_user, err := user.Current()
		if err != nil {
			return nil, errors.New("Can't determine the username")
		}
		configuration.Username = strings.Replace(_user.Name, " ", "", -1)
	}
	// password may not matter but can't be empty
	if configuration.Password == "" {
		configuration.Password = "x"
	}

	if configuration.TransportMode == "http" {
		if usesHTTPBasicAuth(auth) {
			httpClient, protocol, err := prepareHTTPClient(configuration)
			if err != nil {
				return nil, err
			}

			baseTransport := httpClient.Transport
			authTransport := &basicAuthRoundTripper{
				Base:     baseTransport,
				Username: configuration.Username,
				Password: configuration.Password,
			}
			httpClient.Transport = withCookieAuthentication(configuration, baseTransport, authTransport)
			httpOptions := thrift.THttpClientOptions{Client: httpClient}
			transport, err = thrift.NewTHttpClientTransportFactoryWithOptions(hiveHTTPURL(protocol, host, port, configuration.HTTPPath), httpOptions).GetTransport(socket)
			if err != nil {
				return nil, err
			}
		} else if auth == "KERBEROS" {
			httpClient, protocol, err := prepareHTTPClient(configuration)
			if err != nil {
				return nil, err
			}
			baseTransport := httpClient.Transport
			spnegoTransport := gosasl.NewSPNEGORoundTripperWithOptions(
				baseTransport,
				configuration.Service,
				host,
				configuration.HTTPKerberosChannelBinding,
				configuration.GSSAPIOptions,
			)
			httpClient.Transport = withCookieAuthentication(configuration, baseTransport, spnegoTransport)
			authCloser = spnegoTransport
			httpOptions := thrift.THttpClientOptions{
				Client: httpClient,
			}
			transport, err = thrift.NewTHttpClientTransportFactoryWithOptions(hiveHTTPURL(protocol, host, port, configuration.HTTPPath), httpOptions).GetTransport(socket)
			if err != nil {
				return nil, err
			}
		} else if auth == "JWT" {
			if strings.TrimSpace(configuration.JWT) == "" {
				return nil, errors.New("Hive JWT authentication requires a token")
			}
			httpClient, protocol, err := prepareHTTPClient(configuration)
			if err != nil {
				return nil, err
			}
			baseTransport := httpClient.Transport
			authTransport := &bearerAuthRoundTripper{Base: baseTransport, Token: configuration.JWT}
			httpClient.Transport = withCookieAuthentication(configuration, baseTransport, authTransport)
			httpOptions := thrift.THttpClientOptions{Client: httpClient}
			transport, err = thrift.NewTHttpClientTransportFactoryWithOptions(hiveHTTPURL(protocol, host, port, configuration.HTTPPath), httpOptions).GetTransport(socket)
			if err != nil {
				return nil, err
			}
		} else if auth == "BROWSER" {
			httpClient, protocol, err := prepareHTTPClient(configuration)
			if err != nil {
				return nil, err
			}
			baseTransport := httpClient.Transport
			var authTransport http.RoundTripper
			if strings.TrimSpace(configuration.BrowserToken) != "" {
				authTransport = &bearerAuthRoundTripper{
					Base:             baseTransport,
					Token:            configuration.BrowserToken,
					ClientIdentifier: configuration.BrowserClientID,
				}
			} else {
				browserClient = newBrowserSSOClient(configuration.BrowserResponsePort, configuration.BrowserResponseTimeout)
				if err := browserClient.Start(); err != nil {
					return nil, err
				}
				defer browserClient.Close()
				httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
					return http.ErrUseLastResponse
				}
				authTransport = &browserAuthRoundTripper{Base: baseTransport, Client: browserClient}
			}
			httpClient.Transport = withCookieAuthentication(configuration, baseTransport, authTransport)
			httpOptions := thrift.THttpClientOptions{Client: httpClient}
			transport, err = thrift.NewTHttpClientTransportFactoryWithOptions(hiveHTTPURL(protocol, host, port, configuration.HTTPPath), httpOptions).GetTransport(socket)
			if err != nil {
				return nil, err
			}
		} else if auth == "DIGEST-MD5" {
			if strings.TrimSpace(configuration.DelegationToken) == "" {
				return nil, errors.New("Hive HTTP delegation token authentication requires a token")
			}
			httpClient, protocol, err := prepareHTTPClient(configuration)
			if err != nil {
				return nil, err
			}
			baseTransport := httpClient.Transport
			authTransport := &headerAuthRoundTripper{
				Base:  baseTransport,
				Name:  "X-Hive-Delegation-Token",
				Value: configuration.DelegationToken,
			}
			httpClient.Transport = withCookieAuthentication(configuration, baseTransport, authTransport)
			httpOptions := thrift.THttpClientOptions{Client: httpClient}
			transport, err = thrift.NewTHttpClientTransportFactoryWithOptions(hiveHTTPURL(protocol, host, port, configuration.HTTPPath), httpOptions).GetTransport(socket)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, fmt.Errorf("unsupported Hive HTTP authentication %q", auth)
		}
	} else if configuration.TransportMode == "binary" {
		if auth == "NOSASL" {
			transport = thrift.NewTBufferedTransport(socket, 4096)
			if transport == nil {
				return nil, errors.New("BufferedTransport was nil")
			}
		} else if auth == "NONE" || auth == "LDAP" || auth == "CUSTOM" {
			saslConfiguration := map[string]string{"username": configuration.Username, "password": configuration.Password}
			transport, err = NewTSaslTransport(socket, host, "PLAIN", saslConfiguration, configuration.MaxSize)
			if err != nil {
				return
			}
		} else if auth == "KERBEROS" {
			saslConfiguration := map[string]string{"service": configuration.Service}
			transport, err = NewTSaslTransportWithGSSAPIOptions(
				socket,
				host,
				"GSSAPI",
				saslConfiguration,
				configuration.MaxSize,
				configuration.GSSAPIOptions,
			)
			if err != nil {
				return
			}
		} else if auth == "DIGEST-MD5" {
			saslConfiguration := map[string]string{"username": configuration.Username, "password": configuration.Password, "service": configuration.Service}
			transport, err = NewTSaslTransport(socket, host, "DIGEST-MD5", saslConfiguration, configuration.MaxSize)
			if err != nil {
				return
			}
		} else {
			return nil, fmt.Errorf("unsupported Hive binary authentication %q", auth)
		}
		if !transport.IsOpen() {
			if err = transport.Open(); err != nil {
				return
			}
		}
	} else {
		return nil, fmt.Errorf("unsupported Hive transport mode %q", configuration.TransportMode)
	}

	protocolFactory := thrift.NewTBinaryProtocolFactoryConf(&thrift.TConfiguration{MaxMessageSize: configuration.MaxMessageSize})
	client := hiveserver.NewTCLIServiceClientFactory(transport, protocolFactory)

	openSession := newOpenSessionRequest(configuration)
	// Context is ignored
	response, err := client.OpenSession(ctx, openSession)
	if auth == "BROWSER" && browserClient != nil && err != nil && browserClient.HasRedirect() {
		if browserErr := browserClient.Authenticate(ctx); browserErr != nil {
			return nil, browserErr
		}
		response, err = client.OpenSession(ctx, openSession)
	}
	if err != nil {
		return
	}
	if response == nil {
		return nil, errors.New("HiveServer2 OpenSession returned no response")
	}
	if !success(safeStatus(response.GetStatus())) {
		return nil, hiveStatusError("opening session", response.GetStatus())
	}
	if response.SessionHandle == nil {
		return nil, errors.New("HiveServer2 OpenSession returned no session handle")
	}
	if configuration.RequestTracker != nil {
		configuration.RequestTracker.setSessionHandle(response.SessionHandle)
	}

	database := configuration.Database
	if database == "" {
		database = "default"
	}
	conn = &connection{
		host:                host,
		port:                port,
		database:            database,
		auth:                auth,
		kerberosServiceName: "",
		sessionHandle:       response.SessionHandle,
		client:              client,
		configuration:       configuration,
		transport:           transport,
		authCloser:          authCloser,
	}

	if configuration.Database != "" {
		cursor := conn.cursor()
		defer cursor.close(ctx)
		cursor.exec(ctx, "USE "+quoteHiveIdentifier(configuration.Database))
		if cursor.Err != nil {
			return nil, cursor.Err
		}
	}

	return conn, nil
}

func newOpenSessionRequest(configuration *connectConfiguration) *hiveserver.TOpenSessionReq {
	request := hiveserver.NewTOpenSessionReq()
	request.ClientProtocol = hiveserver.TProtocolVersion_HIVE_CLI_SERVICE_PROTOCOL_V6
	request.Configuration = configuration.HiveConfiguration
	request.Username = &configuration.Username
	request.Password = &configuration.Password
	return request
}

type cookieDedupTransport struct {
	http.RoundTripper
}

// RoundTrip removes duplicate cookies (cookies with the same name) from the request
// This is a mitigation for the issue where Hive/Impala cookies get duplicated in the response
func (d *cookieDedupTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	attempt := req.Clone(req.Context())
	attempt.Header = req.Header.Clone()
	cookieMap := map[string]string{}
	for _, cookie := range attempt.Cookies() {
		cookieMap[cookie.Name] = cookie.Value
	}

	attempt.Header.Del("Cookie")

	for key, value := range cookieMap {
		attempt.AddCookie(&http.Cookie{Name: key, Value: value})
	}

	base := d.RoundTripper
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(attempt)

	return resp, err
}

func getHTTPClient(configuration *connectConfiguration) (httpClient *http.Client, protocol string, err error) {
	dialContext := configuration.DialContext
	if dialContext == nil {
		dialContext = (&net.Dialer{Timeout: configuration.ConnectTimeout}).DialContext
	}
	if configuration.TLSConfig != nil {
		httpClient = &http.Client{
			Timeout: configuration.HttpTimeout,
			Transport: &http.Transport{
				TLSClientConfig:   configuration.TLSConfig,
				DialContext:       dialContext,
				DisableKeepAlives: configuration.DisableKeepAlives,
			},
		}
		protocol = "https"
	} else {
		httpClient = &http.Client{
			Timeout: configuration.HttpTimeout,
			Transport: &http.Transport{
				DialContext:       dialContext,
				DisableKeepAlives: configuration.DisableKeepAlives,
			},
		}
		protocol = "http"
	}

	httpClient.Transport = &cookieDedupTransport{httpClient.Transport}

	return
}

func prepareHTTPClient(configuration *connectConfiguration) (*http.Client, string, error) {
	httpClient, protocol, err := getHTTPClient(configuration)
	if err != nil {
		return nil, "", err
	}
	if configuration.RequestTracking && configuration.RequestTracker == nil {
		configuration.RequestTracker = newHTTPRequestTracker()
	}
	httpClient.Transport = &customHTTPRoundTripper{
		Base:           httpClient.Transport,
		Headers:        configuration.HTTPHeaders,
		Cookies:        configuration.HTTPCookies,
		RequestTracker: configuration.RequestTracker,
	}
	if !configuration.DisableCookieAuth {
		httpClient.Jar, err = cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
		if err != nil {
			return nil, "", err
		}
	}
	return httpClient, protocol, nil
}

// cursor is used for fetching the rows after a query
type cursor struct {
	conn            *connection
	operationHandle *hiveserver.TOperationHandle
	fetchSize       int64
	queue           []*hiveserver.TColumn
	response        *hiveserver.TFetchResultsResp
	columnIndex     int
	totalRows       int
	state           int
	newData         bool
	Err             error
	descriptionData [][]string

	// Caller is responsible for managing this channel
	Logs chan<- []string
}

// exec issues a synchronous query.
func (c *cursor) exec(ctx context.Context, query string) {
	c.execute(ctx, query)
}

// execute sends a query to hive for execution with a context
func (c *cursor) execute(ctx context.Context, query string) {
	c.executeSync(ctx, query)
	// We cannot trust in setting executeReq.RunAsync = true
	// because if the context ends the operation can't be cancelled cleanly
	if c.Err != nil {
		if c.state == _CONTEXT_DONE {
			c.handleDoneContext(ctx)
		}
		return
	}

	if c.Err != nil {
		if c.state == _CONTEXT_DONE {
			c.handleDoneContext(ctx)
		} else if c.state == _ERROR {
			c.Err = errors.New("Probably the context was over when passed to execute. This probably resulted in the message being sent but we didn't get an operation handle so it's most likely a bug in thrift")
		}
		return
	}

	// Flush logs after execution is finished
	if c.Logs != nil {
		logs := c.fetchLogs()
		if c.error() != nil {
			c.state = _ASYNC_ENDED
			return
		}
		c.Logs <- logs
	}

	c.state = _ASYNC_ENDED
}

func (c *cursor) handleDoneContext(ctx context.Context) {
	originalError := c.Err
	if c.operationHandle != nil {
		c.cancel()
		if c.Err != nil {
			return
		}
	}
	c.resetState(ctx)
	c.Err = originalError
	c.state = _FINISHED
}

// executeSync sends a query to hive for execution with a context
func (c *cursor) executeSync(ctx context.Context, query string) {
	c.resetState(ctx)

	c.state = _RUNNING
	executeReq := hiveserver.NewTExecuteStatementReq()
	c.conn.clientMu.Lock()
	executeReq.SessionHandle = c.conn.sessionHandle
	executeReq.Statement = query
	executeReq.RunAsync = false
	var responseExecute *hiveserver.TExecuteStatementResp = nil

	responseExecute, c.Err = c.conn.client.ExecuteStatement(ctx, executeReq)
	c.conn.clientMu.Unlock()

	if c.Err != nil {
		if strings.Contains(c.Err.Error(), "context deadline exceeded") {
			c.state = _CONTEXT_DONE
			if responseExecute == nil {
				c.state = _ERROR
			} else if responseExecute != nil {
				// We may need this to cancel the operation
				c.operationHandle = responseExecute.OperationHandle
			}
		}
		return
	}
	if responseExecute == nil {
		c.Err = errors.New("HiveServer2 ExecuteStatement returned no response")
		c.state = _ERROR
		return
	}
	if !success(safeStatus(responseExecute.GetStatus())) {
		status := safeStatus(responseExecute.GetStatus())
		c.Err = &Error{
			Err:       errors.New("Error while executing query: " + status.String()),
			Message:   status.GetErrorMessage(),
			ErrorCode: int(status.GetErrorCode()),
			SQLState:  status.GetSqlState(),
		}
		return
	}

	c.operationHandle = responseExecute.OperationHandle
	if c.operationHandle == nil {
		c.Err = errors.New("HiveServer2 ExecuteStatement returned no operation handle")
		c.state = _ERROR
		return
	}
	if !c.operationHandle.HasResultSet {
		c.state = _FINISHED
	}
}

// fetchLogs returns all the Hive execution logs for the latest query up to the current point
func (c *cursor) fetchLogs() []string {
	logRequest := hiveserver.NewTFetchResultsReq()
	logRequest.OperationHandle = c.operationHandle
	logRequest.Orientation = hiveserver.TFetchOrientation_FETCH_NEXT
	c.conn.clientMu.Lock()
	logRequest.MaxRows = c.conn.configuration.FetchSize
	// FetchType 1 is "logs"
	logRequest.FetchType = 1

	resp, err := c.conn.client.FetchResults(context.Background(), logRequest)
	c.conn.clientMu.Unlock()
	if err != nil || resp == nil || resp.Results == nil {
		c.Err = err
		return nil
	}

	// resp contains 1 row, with a column for each line in the log
	cols := resp.Results.GetColumns()
	var logs []string

	for _, col := range cols {
		logs = append(logs, col.StringVal.Values...)
	}

	return logs
}

func success(status *hiveserver.TStatus) bool {
	statusCode := status.GetStatusCode()
	return statusCode == hiveserver.TStatusCode_SUCCESS_STATUS || statusCode == hiveserver.TStatusCode_SUCCESS_WITH_INFO_STATUS
}

func (c *cursor) fetchIfEmpty(ctx context.Context) {
	c.Err = nil
	if c.totalRows == c.columnIndex {
		c.queue = nil
		if !c.hasMore(ctx) {
			// print stack trace
			c.Err = errors.New("No more rows are left")
			return
		}
		if c.Err != nil {
			return
		}
	}
}

// rowMap returns one row as a map. Advances the cursor one
func (c *cursor) rowMap(ctx context.Context) map[string]interface{} {
	c.Err = nil
	c.fetchIfEmpty(ctx)
	if c.Err != nil {
		return nil
	}

	d := c.description(ctx)
	if c.Err != nil || len(d) != len(c.queue) {
		return nil
	}
	m := make(map[string]interface{}, len(c.queue))
	for i := 0; i < len(c.queue); i++ {
		columnName := d[i][0]
		columnType := d[i][1]
		if columnType == "BOOLEAN_TYPE" {
			if isNull(c.queue[i].BoolVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].BoolVal.Values[c.columnIndex]
			}
		} else if columnType == "TINYINT_TYPE" {
			if isNull(c.queue[i].ByteVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].ByteVal.Values[c.columnIndex]
			}
		} else if columnType == "SMALLINT_TYPE" {
			if isNull(c.queue[i].I16Val.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].I16Val.Values[c.columnIndex]
			}
		} else if columnType == "INT_TYPE" {
			if isNull(c.queue[i].I32Val.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].I32Val.Values[c.columnIndex]
			}
		} else if columnType == "BIGINT_TYPE" {
			if isNull(c.queue[i].I64Val.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].I64Val.Values[c.columnIndex]
			}
		} else if columnType == "FLOAT_TYPE" {
			if isNull(c.queue[i].DoubleVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].DoubleVal.Values[c.columnIndex]
			}
		} else if columnType == "DOUBLE_TYPE" {
			if isNull(c.queue[i].DoubleVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].DoubleVal.Values[c.columnIndex]
			}
		} else if columnType == "STRING_TYPE" || columnType == "VARCHAR_TYPE" || columnType == "CHAR_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "TIMESTAMP_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "DATE_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "BINARY_TYPE" {
			if isNull(c.queue[i].BinaryVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].BinaryVal.Values[c.columnIndex]
			}
		} else if columnType == "ARRAY_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "MAP_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "STRUCT_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "UNION_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if columnType == "DECIMAL_TYPE" {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				m[columnName] = nil
			} else {
				m[columnName] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		}
	}
	if len(m) != len(d) {
		log.Printf("Some columns have the same name as per the description: %v, this makes it impossible to get the values using the RowMap API, please use the FetchOne API", d)
	}
	c.columnIndex++
	return m
}

func (c *cursor) fetchOneDriver(ctx context.Context, dests []driver.Value) {
	c.Err = nil
	c.fetchIfEmpty(ctx)
	if c.Err != nil {
		return
	}

	if len(c.queue) != len(dests) {
		c.Err = errors.Errorf("%d arguments where passed for filling but the number of columns is %d", len(dests), len(c.queue))
		return
	}

	for i := 0; i < len(c.queue); i++ {
		if c.queue[i].IsSetBinaryVal() {
			if isNull(c.queue[i].BinaryVal.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = c.queue[i].BinaryVal.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetByteVal() {
			if isNull(c.queue[i].ByteVal.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = int64(c.queue[i].ByteVal.Values[c.columnIndex])
			}
		} else if c.queue[i].IsSetI16Val() {
			if isNull(c.queue[i].I16Val.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = int64(c.queue[i].I16Val.Values[c.columnIndex])
			}
		} else if c.queue[i].IsSetI32Val() {
			if isNull(c.queue[i].I32Val.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = int64(c.queue[i].I32Val.Values[c.columnIndex])
			}
		} else if c.queue[i].IsSetI64Val() {
			if isNull(c.queue[i].I64Val.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = c.queue[i].I64Val.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetStringVal() {
			if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetDoubleVal() {
			if isNull(c.queue[i].DoubleVal.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = c.queue[i].DoubleVal.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetBoolVal() {
			if isNull(c.queue[i].BoolVal.Nulls, c.columnIndex) {
				dests[i] = nil
			} else {
				dests[i] = c.queue[i].BoolVal.Values[c.columnIndex]
			}
		} else {
			c.Err = errors.Errorf("Empty column %v", c.queue[i])
			return
		}
	}
	c.columnIndex++
}

// fetchOne returns one row and advances the cursor one
func (c *cursor) fetchOne(ctx context.Context, dests ...interface{}) {
	c.Err = nil
	c.fetchIfEmpty(ctx)
	if c.Err != nil {
		return
	}

	if len(c.queue) != len(dests) {
		c.Err = errors.Errorf("%d arguments where passed for filling but the number of columns is %d", len(dests), len(c.queue))
		return
	}
	for i := 0; i < len(c.queue); i++ {
		if c.queue[i].IsSetBinaryVal() {
			if dests[i] == nil {
				dests[i] = c.queue[i].BinaryVal.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*[]byte)
			if !ok {
				c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].BinaryVal.Values[c.columnIndex], c.queue[i].BinaryVal.Values[c.columnIndex], i)
				return
			}
			if isNull(c.queue[i].BinaryVal.Nulls, c.columnIndex) {
				*d = nil
			} else {
				*d = c.queue[i].BinaryVal.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetByteVal() {
			if dests[i] == nil {
				dests[i] = c.queue[i].ByteVal.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*int8)
			if !ok {
				d, ok := dests[i].(**int8)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].ByteVal.Values[c.columnIndex], c.queue[i].ByteVal.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].ByteVal.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(int8)
					}
					**d = c.queue[i].ByteVal.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].ByteVal.Values[c.columnIndex]
			}

		} else if c.queue[i].IsSetI16Val() {
			if dests[i] == nil {
				dests[i] = c.queue[i].I16Val.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*int16)
			if !ok {
				d, ok := dests[i].(**int16)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].I16Val.Values[c.columnIndex], c.queue[i].I16Val.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].I16Val.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(int16)
					}
					**d = c.queue[i].I16Val.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].I16Val.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetI32Val() {
			if dests[i] == nil {
				dests[i] = c.queue[i].I32Val.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*int32)
			if !ok {
				d, ok := dests[i].(**int32)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].I32Val.Values[c.columnIndex], c.queue[i].I32Val.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].I32Val.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(int32)
					}
					**d = c.queue[i].I32Val.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].I32Val.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetI64Val() {
			if dests[i] == nil {
				dests[i] = c.queue[i].I64Val.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*int64)
			if !ok {
				d, ok := dests[i].(**int64)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].I64Val.Values[c.columnIndex], c.queue[i].I64Val.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].I64Val.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(int64)
					}
					**d = c.queue[i].I64Val.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].I64Val.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetStringVal() {
			if dests[i] == nil {
				dests[i] = c.queue[i].StringVal.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*string)
			if !ok {
				d, ok := dests[i].(**string)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].StringVal.Values[c.columnIndex], c.queue[i].StringVal.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].StringVal.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(string)
					}
					**d = c.queue[i].StringVal.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].StringVal.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetDoubleVal() {
			if dests[i] == nil {
				dests[i] = c.queue[i].DoubleVal.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*float64)
			if !ok {
				d, ok := dests[i].(**float64)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].DoubleVal.Values[c.columnIndex], c.queue[i].DoubleVal.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].DoubleVal.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(float64)
					}
					**d = c.queue[i].DoubleVal.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].DoubleVal.Values[c.columnIndex]
			}
		} else if c.queue[i].IsSetBoolVal() {
			if dests[i] == nil {
				dests[i] = c.queue[i].BoolVal.Values[c.columnIndex]
				continue
			}
			d, ok := dests[i].(*bool)
			if !ok {
				d, ok := dests[i].(**bool)
				if !ok {
					c.Err = errors.Errorf("Unexpected data type %T for value %v (should be %T) index is %v", dests[i], c.queue[i].BoolVal.Values[c.columnIndex], c.queue[i].BoolVal.Values[c.columnIndex], i)
					return
				}

				if isNull(c.queue[i].BoolVal.Nulls, c.columnIndex) {
					*d = nil
				} else {
					if *d == nil {
						*d = new(bool)
					}
					**d = c.queue[i].BoolVal.Values[c.columnIndex]
				}
			} else {
				*d = c.queue[i].BoolVal.Values[c.columnIndex]
			}
		} else {
			c.Err = errors.Errorf("Empty column %v", c.queue[i])
			return
		}
	}
	c.columnIndex++
}

func isNull(nulls []byte, position int) bool {
	index := position / 8
	if len(nulls) > index {
		b := nulls[index]
		return (b & (1 << (uint)(position%8))) != 0
	}
	return false
}

// description return a map with the names of the columns and their types
// must be called after a FetchResult request
// a context should be added here but seems to be ignored by thrift
func (c *cursor) description(ctx context.Context) [][]string {
	if c.descriptionData != nil {
		return c.descriptionData
	}
	if c.operationHandle == nil {
		c.Err = errors.Errorf("Description can only be called after after a Poll or after an async request")
		return nil
	}

	metaRequest := hiveserver.NewTGetResultSetMetadataReq()
	metaRequest.OperationHandle = c.operationHandle
	c.conn.clientMu.Lock()
	metaResponse, err := c.conn.client.GetResultSetMetadata(ctx, metaRequest)
	c.conn.clientMu.Unlock()
	if err != nil {
		c.Err = err
		return nil
	}
	if metaResponse == nil {
		c.Err = errors.New("HiveServer2 GetResultSetMetadata returned no response")
		return nil
	}
	if !success(safeStatus(metaResponse.GetStatus())) {
		c.Err = hiveStatusError("retrieving result-set metadata", metaResponse.GetStatus())
		return nil
	}
	if metaResponse.Schema == nil {
		c.Err = errors.New("HiveServer2 GetResultSetMetadata returned no schema")
		return nil
	}
	m := make([][]string, len(metaResponse.Schema.Columns))
	for i, column := range metaResponse.Schema.Columns {
		if column == nil || column.TypeDesc == nil {
			c.Err = fmt.Errorf("HiveServer2 metadata column %d has no type description", i)
			return nil
		}
		for _, typeDesc := range column.TypeDesc.Types {
			if typeDesc == nil || typeDesc.PrimitiveEntry == nil {
				continue
			}
			m[i] = []string{column.ColumnName, typeDesc.PrimitiveEntry.Type.String()}
		}
		if len(m[i]) == 0 {
			c.Err = fmt.Errorf("HiveServer2 metadata column %d has no primitive type", i)
			return nil
		}
	}
	c.descriptionData = m
	return m
}

// hasMore returns whether more rows can be fetched from the server
func (c *cursor) hasMore(ctx context.Context) bool {
	c.Err = nil
	if c.response == nil && c.state != _FINISHED {
		c.Err = c.pollUntilData(ctx, 1)
		return c.state != _FINISHED || c.totalRows != c.columnIndex
	}
	// *c.response.HasMoreRows is always false
	// so it can be checked and another roundtrip has to be done if extra data has been added
	if c.totalRows == c.columnIndex && c.state != _FINISHED {
		c.Err = c.pollUntilData(ctx, 1)
	}

	return c.state != _FINISHED || c.totalRows != c.columnIndex
}

func (c *cursor) waitForCompletion(ctx context.Context) error {
	if c.operationHandle == nil {
		return errors.New("HiveServer2 returned no operation handle")
	}
	for {
		request := hiveserver.NewTGetOperationStatusReq()
		request.OperationHandle = c.operationHandle
		c.conn.clientMu.Lock()
		response, err := c.conn.client.GetOperationStatus(ctx, request)
		c.conn.clientMu.Unlock()
		if err != nil {
			return err
		}
		if response == nil {
			return errors.New("HiveServer2 GetOperationStatus returned no response")
		}
		if !success(safeStatus(response.GetStatus())) {
			return hiveStatusError("checking operation status", response.GetStatus())
		}
		switch response.GetOperationState() {
		case hiveserver.TOperationState_FINISHED_STATE, hiveserver.TOperationState_CLOSED_STATE:
			if response.IsSetNumModifiedRows() {
				modified := float64(response.GetNumModifiedRows())
				c.operationHandle.ModifiedRowCount = &modified
			}
			return nil
		case hiveserver.TOperationState_ERROR_STATE:
			return &Error{
				Err:       errors.New("HiveServer2 operation failed: " + response.GetErrorMessage()),
				Message:   response.GetErrorMessage(),
				ErrorCode: int(response.GetErrorCode()),
				SQLState:  response.GetSqlState(),
			}
		case hiveserver.TOperationState_CANCELED_STATE:
			return errors.New("HiveServer2 operation was canceled")
		case hiveserver.TOperationState_TIMEDOUT_STATE:
			return errors.New("HiveServer2 operation timed out")
		}
		timer := time.NewTimer(time.Duration(c.conn.configuration.PollIntervalInMillis) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *cursor) error() error {
	return c.Err
}

func (c *cursor) effectiveFetchSize() int64 {
	if c.fetchSize > 0 {
		return c.fetchSize
	}
	return c.conn.configuration.FetchSize
}

func (c *cursor) pollUntilData(ctx context.Context, n int) (err error) {
	rowsAvailable := make(chan error)
	var stopLock sync.Mutex
	var done = false
	go func() {
		defer close(rowsAvailable)
		for true {
			stopLock.Lock()
			if done {
				stopLock.Unlock()
				rowsAvailable <- nil
				return
			}
			stopLock.Unlock()

			fetchRequest := hiveserver.NewTFetchResultsReq()
			fetchRequest.OperationHandle = c.operationHandle
			fetchRequest.Orientation = hiveserver.TFetchOrientation_FETCH_NEXT
			c.conn.clientMu.Lock()
			fetchRequest.MaxRows = c.effectiveFetchSize()
			responseFetch, err := c.conn.client.FetchResults(ctx, fetchRequest)
			c.conn.clientMu.Unlock()
			if err != nil {
				rowsAvailable <- err
				return
			}
			if responseFetch == nil {
				rowsAvailable <- errors.New("HiveServer2 FetchResults returned no response")
				return
			}
			c.response = responseFetch

			if !success(safeStatus(responseFetch.GetStatus())) {
				rowsAvailable <- hiveStatusError("fetching results", responseFetch.GetStatus())
				return
			}
			err = c.parseResults(responseFetch)
			if err != nil {
				rowsAvailable <- err
				return
			}

			if len(c.queue) > 0 {
				rowsAvailable <- nil
				return
			}
			time.Sleep(time.Duration(c.conn.configuration.PollIntervalInMillis) * time.Millisecond)
		}
	}()

	select {
	case err = <-rowsAvailable:
	case <-ctx.Done():
		stopLock.Lock()
		done = true
		stopLock.Unlock()
		select {
		// Wait for goroutine to finish
		case <-rowsAvailable:
		}
		err = errors.New("Context is done")
	}

	if err != nil {
		return err
	}

	if len(c.queue) < n {
		return errors.Errorf("Only %d rows where received", len(c.queue))
	}
	return nil
}

// cancel cancels the current operation
func (c *cursor) cancel() {
	c.Err = nil
	cancelRequest := hiveserver.NewTCancelOperationReq()
	cancelRequest.OperationHandle = c.operationHandle
	var responseCancel *hiveserver.TCancelOperationResp
	// This context is simply ignored
	c.conn.clientMu.Lock()
	responseCancel, c.Err = c.conn.client.CancelOperation(context.Background(), cancelRequest)
	c.conn.clientMu.Unlock()
	if c.Err != nil {
		return
	}
	if responseCancel == nil {
		c.Err = errors.New("HiveServer2 CancelOperation returned no response")
		return
	}
	if !success(safeStatus(responseCancel.GetStatus())) {
		c.Err = hiveStatusError("cancelling operation", responseCancel.GetStatus())
	}
}

// close closes the cursor
func (c *cursor) close(ctx context.Context) {
	c.Err = c.resetState(ctx)
}

func (c *cursor) resetState(ctx context.Context) error {
	c.response = nil
	c.Err = nil
	c.queue = nil
	c.columnIndex = 0
	c.totalRows = 0
	c.state = _NONE
	c.descriptionData = nil
	c.newData = false
	if c.operationHandle != nil {
		closeRequest := hiveserver.NewTCloseOperationReq()
		closeRequest.OperationHandle = c.operationHandle

		c.conn.clientMu.Lock()
		responseClose, err := c.conn.client.CloseOperation(ctx, closeRequest)
		c.conn.clientMu.Unlock()
		c.operationHandle = nil
		if err != nil {
			return err
		}
		if responseClose == nil {
			return errors.New("HiveServer2 CloseOperation returned no response")
		}
		if !success(safeStatus(responseClose.GetStatus())) {
			return hiveStatusError("closing operation", responseClose.GetStatus())
		}
		return nil
	}
	return nil
}

func (c *cursor) parseResults(response *hiveserver.TFetchResultsResp) (err error) {
	c.queue = response.Results.GetColumns()
	c.columnIndex = 0
	c.totalRows, err = getTotalRows(c.queue)
	c.newData = c.totalRows > 0
	if !c.newData {
		c.state = _FINISHED
	}
	return
}

func getTotalRows(columns []*hiveserver.TColumn) (int, error) {
	for _, el := range columns {
		if el.IsSetBinaryVal() {
			return len(el.BinaryVal.Values), nil
		} else if el.IsSetByteVal() {
			return len(el.ByteVal.Values), nil
		} else if el.IsSetI16Val() {
			return len(el.I16Val.Values), nil
		} else if el.IsSetI32Val() {
			return len(el.I32Val.Values), nil
		} else if el.IsSetI64Val() {
			return len(el.I64Val.Values), nil
		} else if el.IsSetBoolVal() {
			return len(el.BoolVal.Values), nil
		} else if el.IsSetDoubleVal() {
			return len(el.DoubleVal.Values), nil
		} else if el.IsSetStringVal() {
			return len(el.StringVal.Values), nil
		} else {
			return -1, errors.Errorf("Unrecognized column type %T", el)
		}
	}
	return 0, errors.New("All columns seem empty")
}

func safeStatus(status *hiveserver.TStatus) *hiveserver.TStatus {
	if status == nil {
		return &DEFAULT_STATUS
	}
	return status
}

func hiveStatusError(action string, status *hiveserver.TStatus) error {
	status = safeStatus(status)
	diagnostic := hiveStatusDiagnostic(status)
	return &Error{
		Err:       fmt.Errorf("HiveServer2 error while %s: %s", action, diagnostic),
		Message:   diagnostic,
		ErrorCode: int(status.GetErrorCode()),
		SQLState:  status.GetSqlState(),
	}
}

func hiveStatusDiagnostic(status *hiveserver.TStatus) string {
	messages := make([]string, 0, len(status.GetInfoMessages())+1)
	if message := strings.TrimSpace(status.GetErrorMessage()); message != "" {
		messages = append(messages, message)
	}
	for _, info := range status.GetInfoMessages() {
		message := strings.TrimSpace(info)
		if message == "" || slices.Contains(messages, message) {
			continue
		}
		messages = append(messages, message)
	}
	if len(messages) == 0 {
		messages = append(messages, fmt.Sprintf("server returned %s without error details", status.GetStatusCode()))
	}

	metadata := make([]string, 0, 2)
	if sqlState := strings.TrimSpace(status.GetSqlState()); sqlState != "" {
		metadata = append(metadata, "SQLState "+sqlState)
	}
	if status.IsSetErrorCode() {
		metadata = append(metadata, fmt.Sprintf("error code %d", status.GetErrorCode()))
	}
	diagnostic := strings.Join(messages, "; ")
	if len(metadata) > 0 {
		diagnostic += " (" + strings.Join(metadata, ", ") + ")"
	}
	return diagnostic
}

func usesHTTPBasicAuth(auth string) bool {
	return auth == "NONE" || auth == "NOSASL" || auth == "LDAP" || auth == "CUSTOM"
}

func quoteHiveIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

var DEFAULT_SQL_STATE = ""
var DEFAULT_ERROR_CODE = int32(-1)
var DEFAULT_ERROR_MESSAGE = "unknown error"
var DEFAULT_STATUS = hiveserver.TStatus{
	StatusCode:   hiveserver.TStatusCode_ERROR_STATUS,
	InfoMessages: nil,
	SqlState:     &DEFAULT_SQL_STATE,
	ErrorCode:    &DEFAULT_ERROR_CODE,
	ErrorMessage: &DEFAULT_ERROR_MESSAGE,
}

// cursor creates a cursor from a connection
func (c *connection) cursor() *cursor {
	return &cursor{
		conn: c,
	}
}

// close closes a session
func (c *connection) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	var closeErr error
	if c.transport != nil {
		closeErr = c.transport.Close()
	}
	if c.authCloser != nil {
		if err := c.authCloser.Close(); closeErr == nil {
			closeErr = err
		}
	}
	return closeErr
}

// getTlsConfiguration returns a tls.Config with the provided certificate and key
func getTlsConfiguration(sslPemPath, sslKeyPath string) (tlsConfig *tls.Config, err error) {
	cert, err := tls.LoadX509KeyPair(sslPemPath, sslKeyPath)
	if err != nil {
		return nil, err
	}
	tlsConfig = &tls.Config{
		Certificates:       []tls.Certificate{cert},
		InsecureSkipVerify: true,
	}
	return tlsConfig, nil
}
