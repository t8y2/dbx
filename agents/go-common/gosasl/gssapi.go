package gosasl

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
)

const maxSASLBufferLength = 1<<24 - 1

type gssapiBackend interface {
	Initiate(serviceName string, channelBinding []byte) error
	Continue(token []byte) ([]byte, error)
	IsEstablished() bool
	InitiatorName() string
	SupportsIntegrity() bool
	SupportsConfidentiality() bool
	Wrap(payload []byte, confidentiality bool) ([]byte, error)
	Unwrap(token []byte) ([]byte, error)
	Dispose() error
}

var gssapiBackendFactory = newPlatformGSSAPIBackend
var gssapiBackendFactoryWithOptions = newPlatformGSSAPIBackendWithOptions
var lookupCanonicalHostname = net.LookupCNAME

// GSSAPIOptions contains connection-scoped Kerberos and SPN settings.
type GSSAPIOptions struct {
	ConfigPath       string
	CCachePath       string
	KeytabPath       string
	Principal        string
	Password         string
	QOP              string
	AuthorizationID  string
	ServerName       string
	ServiceHost      string
	UseCCache        bool
	UseKeytab        bool
	UseSSPI          bool
	CanonicalizeHost bool
	DisablePAFXFAST  bool
}

// GSSAPIMechanism corresponds to the GSSAPI SASL mechanism described by RFC 4752.
type GSSAPIMechanism struct {
	config          *MechanismConfig
	host            string
	service         string
	context         gssapiBackend
	contextStarted  bool
	securityLayer   bool
	qop             byte
	supportedQop    byte
	serverMaxLength int
	UserSelectQop   byte
	MaxLength       int
	options         GSSAPIOptions
}

// NewGSSAPIMechanism returns a GSSAPI mechanism backed by pure Go Kerberos, or
// Windows SSPI when DBX_KRB5_USE_SSPI is enabled.
func NewGSSAPIMechanism(service string) (*GSSAPIMechanism, error) {
	context, err := gssapiBackendFactory()
	return newGSSAPIMechanism(service, gssapiOptionsFromEnvironment(), context, err)
}

// NewGSSAPIMechanismWithOptions creates a GSSAPI mechanism without reading
// connection credentials from process-global environment variables.
func NewGSSAPIMechanismWithOptions(service string, options GSSAPIOptions) (*GSSAPIMechanism, error) {
	context, err := gssapiBackendFactoryWithOptions(options)
	return newGSSAPIMechanism(service, options, context, err)
}

func newGSSAPIMechanism(service string, options GSSAPIOptions, context gssapiBackend, err error) (*GSSAPIMechanism, error) {
	if err != nil {
		return nil, err
	}
	userSelectQop, err := configuredQOPMask(options.QOP)
	if err != nil {
		_ = context.Dispose()
		return nil, err
	}
	return &GSSAPIMechanism{
		config:        newDefaultConfig("GSSAPI"),
		service:       service,
		context:       context,
		UserSelectQop: userSelectQop,
		MaxLength:     DEFAULT_MAX_LENGTH,
		options:       options,
	}, nil
}

func (mechanism *GSSAPIMechanism) start() ([]byte, error) {
	if mechanism.contextStarted {
		return nil, errors.New("GSSAPI negotiation already started")
	}
	serviceName := qualifiedServiceNameWithOptions(mechanism.service, mechanism.host, mechanism.options)
	if err := mechanism.context.Initiate(serviceName, nil); err != nil {
		return nil, fmt.Errorf("initiating GSSAPI context for %q: %w", serviceName, err)
	}
	mechanism.contextStarted = true
	token, err := mechanism.context.Continue(nil)
	if err != nil {
		return nil, fmt.Errorf("creating initial GSSAPI token: %w", err)
	}
	return token, nil
}

func (mechanism *GSSAPIMechanism) step(challenge []byte) ([]byte, error) {
	if !mechanism.contextStarted {
		return nil, errors.New("GSSAPI negotiation has not started")
	}
	if mechanism.config.complete {
		return nil, errors.New("GSSAPI negotiation is already complete")
	}
	if !mechanism.context.IsEstablished() {
		token, err := mechanism.context.Continue(challenge)
		if err != nil {
			return nil, fmt.Errorf("continuing GSSAPI context: %w", err)
		}
		return token, nil
	}
	if mechanism.securityLayer {
		return nil, errors.New("GSSAPI security layer negotiation is already complete")
	}
	return mechanism.negotiateSecurityLayer(challenge)
}

func (mechanism *GSSAPIMechanism) negotiateSecurityLayer(challenge []byte) ([]byte, error) {
	if !mechanism.context.SupportsIntegrity() {
		return nil, errors.New("GSSAPI context does not provide integrity required by SASL negotiation")
	}
	data, err := mechanism.context.Unwrap(challenge)
	if err != nil {
		return nil, fmt.Errorf("unwrapping GSSAPI security-layer challenge: %w", err)
	}
	if len(data) != 4 {
		return nil, fmt.Errorf("invalid GSSAPI security-layer challenge length %d, expected 4", len(data))
	}

	mechanism.supportedQop = QOP_TO_FLAG[AUTH]
	if mechanism.context.SupportsIntegrity() {
		mechanism.supportedQop |= QOP_TO_FLAG[AUTH_INT]
	}
	if mechanism.context.SupportsConfidentiality() {
		mechanism.supportedQop |= QOP_TO_FLAG[AUTH_CONF]
	}
	mechanism.serverMaxLength = int(data[1])<<16 | int(data[2])<<8 | int(data[3])
	mechanism.qop, err = mechanism.selectQop(data[0])
	if err != nil {
		return nil, err
	}

	maxLength := 0
	if mechanism.qop != QOP_TO_FLAG[AUTH] {
		maxLength = mechanism.MaxLength
		if maxLength < 0 {
			maxLength = 0
		}
		if maxLength > maxSASLBufferLength {
			maxLength = maxSASLBufferLength
		}
		if mechanism.serverMaxLength > 0 && maxLength > mechanism.serverMaxLength {
			maxLength = mechanism.serverMaxLength
		}
	}
	header := []byte{
		mechanism.qop,
		byte(maxLength >> 16),
		byte(maxLength >> 8),
		byte(maxLength),
	}
	authorizationID := mechanism.config.AuthorizationID
	if authorizationID == "" {
		authorizationID = strings.TrimSpace(mechanism.options.AuthorizationID)
	}
	if authorizationID == "" {
		authorizationID = mechanism.context.InitiatorName()
	}
	payload := append(header, []byte(authorizationID)...)
	response, err := mechanism.context.Wrap(payload, false)
	if err != nil {
		return nil, fmt.Errorf("wrapping GSSAPI security-layer response: %w", err)
	}
	mechanism.securityLayer = true
	mechanism.config.complete = true
	return response, nil
}

func qualifiedServiceName(service, host string) string {
	return qualifiedServiceNameWithOptions(service, host, gssapiOptionsFromEnvironment())
}

func qualifiedServiceNameWithOptions(service, host string, options GSSAPIOptions) string {
	if configuredHost := strings.TrimSpace(options.ServiceHost); configuredHost != "" {
		host = configuredHost
	} else if options.CanonicalizeHost {
		host = canonicalKerberosHost(host)
	}
	if configuredService := strings.TrimSpace(options.ServerName); configuredService != "" {
		service = configuredService
	}
	service = replaceSPNHostWildcard(service, host)
	if strings.Contains(service, "/") || strings.Contains(service, "@") {
		return service
	}
	return service + "/" + host
}

func canonicalKerberosHost(host string) string {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if host == "" || net.ParseIP(host) != nil {
		return host
	}
	canonical, err := lookupCanonicalHostname(host)
	if err != nil || strings.TrimSpace(canonical) == "" {
		return host
	}
	return strings.TrimSuffix(strings.TrimSpace(canonical), ".")
}

func configuredEnvironmentBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func gssapiOptionsFromEnvironment() GSSAPIOptions {
	return GSSAPIOptions{
		ConfigPath:       os.Getenv("KRB5_CONFIG"),
		CCachePath:       os.Getenv("KRB5CCNAME"),
		KeytabPath:       firstConfiguredEnvironment("KRB5_CLIENT_KTNAME", "KRB5_KTNAME"),
		Principal:        os.Getenv("DBX_KRB5_PRINCIPAL"),
		Password:         os.Getenv("DBX_KRB5_PASSWORD"),
		QOP:              os.Getenv("DBX_KRB5_QOP"),
		AuthorizationID:  os.Getenv("DBX_KRB5_AUTHORIZATION_ID"),
		ServerName:       os.Getenv("DBX_KRB5_SERVER_NAME"),
		ServiceHost:      os.Getenv("SERVICE_HOST_QUALIFIED"),
		UseCCache:        configuredEnvironmentBool("DBX_KRB5_USE_CCACHE"),
		UseKeytab:        configuredEnvironmentBool("DBX_KRB5_USE_KEYTAB"),
		UseSSPI:          configuredEnvironmentBool("DBX_KRB5_USE_SSPI"),
		CanonicalizeHost: configuredEnvironmentBool("DBX_KRB5_CANONICALIZE_HOST"),
		DisablePAFXFAST:  configuredEnvironmentBool("DBX_KRB5_DISABLE_PAFXFAST"),
	}
}

func firstConfiguredEnvironment(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

// GSSAPIContextClient exposes the reusable authentication context used by
// non-SASL protocols such as HTTP Negotiate/SPNEGO.
type GSSAPIContextClient struct {
	context gssapiBackend
	service string
	host    string
	options GSSAPIOptions
	started bool
}

// NewGSSAPIContextClient creates a raw GSSAPI initiator for service/host.
func NewGSSAPIContextClient(service, host string) (*GSSAPIContextClient, error) {
	context, err := gssapiBackendFactory()
	if err != nil {
		return nil, err
	}
	return &GSSAPIContextClient{context: context, service: service, host: host, options: gssapiOptionsFromEnvironment()}, nil
}

// NewGSSAPIContextClientWithOptions creates a raw GSSAPI initiator with
// connection-scoped credentials.
func NewGSSAPIContextClientWithOptions(service, host string, options GSSAPIOptions) (*GSSAPIContextClient, error) {
	context, err := gssapiBackendFactoryWithOptions(options)
	if err != nil {
		return nil, err
	}
	return &GSSAPIContextClient{context: context, service: service, host: host, options: options}, nil
}

// Start initiates the context and returns the first token. channelBinding is
// optional application data, such as a tls-server-end-point binding.
func (client *GSSAPIContextClient) Start(channelBinding []byte) ([]byte, error) {
	if client.started {
		return nil, errors.New("GSSAPI context already started")
	}
	serviceName := qualifiedServiceNameWithOptions(client.service, client.host, client.options)
	if err := client.context.Initiate(serviceName, append([]byte(nil), channelBinding...)); err != nil {
		return nil, fmt.Errorf("initiating GSSAPI context for %q: %w", serviceName, err)
	}
	client.started = true
	return client.context.Continue(nil)
}

// Continue consumes a peer token and returns the next initiator token.
func (client *GSSAPIContextClient) Continue(challenge []byte) ([]byte, error) {
	if !client.started {
		return nil, errors.New("GSSAPI context has not started")
	}
	return client.context.Continue(challenge)
}

// Complete reports whether mutual authentication has completed.
func (client *GSSAPIContextClient) Complete() bool {
	return client.context.IsEstablished()
}

// Dispose releases credentials and context state.
func (client *GSSAPIContextClient) Dispose() error {
	if client.context == nil {
		return nil
	}
	return client.context.Dispose()
}

func (mechanism *GSSAPIMechanism) selectQop(serverQop byte) (byte, error) {
	availableQops := mechanism.UserSelectQop & mechanism.supportedQop & serverQop
	for _, qop := range []byte{QOP_TO_FLAG[AUTH_CONF], QOP_TO_FLAG[AUTH_INT], QOP_TO_FLAG[AUTH]} {
		if qop&availableQops != 0 {
			return qop, nil
		}
	}
	return 0, fmt.Errorf(
		"server GSSAPI QOP mask %#02x does not satisfy requested mask %#02x and client-supported mask %#02x",
		serverQop,
		mechanism.UserSelectQop,
		mechanism.supportedQop,
	)
}

func configuredQOPMask(value string) (byte, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return QOP_TO_FLAG[AUTH] | QOP_TO_FLAG[AUTH_INT] | QOP_TO_FLAG[AUTH_CONF], nil
	case AUTH:
		return QOP_TO_FLAG[AUTH], nil
	case AUTH_INT:
		return QOP_TO_FLAG[AUTH_INT], nil
	case AUTH_CONF:
		return QOP_TO_FLAG[AUTH_CONF], nil
	default:
		return 0, fmt.Errorf("unsupported Kerberos SASL QOP %q", value)
	}
}

// replaceSPNHostWildcard substitutes _HOST in a service principal name.
func replaceSPNHostWildcard(spn, host string) string {
	match := krbSPNHost.FindStringSubmatchIndex(spn)
	if match == nil || match[2] == -1 {
		return spn
	}
	return spn[:match[2]] + host + spn[match[3]:]
}

func (mechanism *GSSAPIMechanism) encode(outgoing []byte) ([]byte, error) {
	if !mechanism.config.complete {
		return nil, errors.New("GSSAPI negotiation is not complete")
	}
	switch mechanism.qop {
	case QOP_TO_FLAG[AUTH]:
		return append([]byte(nil), outgoing...), nil
	case QOP_TO_FLAG[AUTH_INT]:
		return mechanism.context.Wrap(append([]byte(nil), outgoing...), false)
	case QOP_TO_FLAG[AUTH_CONF]:
		return mechanism.context.Wrap(append([]byte(nil), outgoing...), true)
	default:
		return nil, fmt.Errorf("unsupported negotiated GSSAPI QOP %#02x", mechanism.qop)
	}
}

func (mechanism *GSSAPIMechanism) decode(incoming []byte) ([]byte, error) {
	if !mechanism.config.complete {
		return nil, errors.New("GSSAPI negotiation is not complete")
	}
	if mechanism.qop == QOP_TO_FLAG[AUTH] {
		return append([]byte(nil), incoming...), nil
	}
	return mechanism.context.Unwrap(append([]byte(nil), incoming...))
}

func (mechanism *GSSAPIMechanism) dispose() {
	if mechanism.context != nil {
		_ = mechanism.context.Dispose()
	}
}

func (mechanism *GSSAPIMechanism) getConfig() *MechanismConfig {
	return mechanism.config
}
