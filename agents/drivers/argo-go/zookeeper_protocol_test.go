package main

import (
	"bytes"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-zookeeper/zk"
	gsskrb5 "github.com/golang-auth/go-gssapi/v2/krb5"
	"github.com/jcmturner/krb5test"
)

type scriptedZooKeeperSASLClient struct {
	complete bool
	disposed bool
}

func (client *scriptedZooKeeperSASLClient) Start() ([]byte, error) {
	return []byte("client-initial"), nil
}

func (client *scriptedZooKeeperSASLClient) Step(challenge []byte) ([]byte, error) {
	if string(challenge) != "server-challenge" {
		return nil, fmt.Errorf("unexpected challenge %q", challenge)
	}
	client.complete = true
	return []byte("client-final"), nil
}

func (client *scriptedZooKeeperSASLClient) Complete() bool { return client.complete }
func (client *scriptedZooKeeperSASLClient) Dispose()       { client.disposed = true }

func TestProtocolZooKeeperClientAuthenticatesAndReadsDiscoveryData(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()
	serverErrors := make(chan error, 1)
	go func() {
		defer serverConnection.Close()
		serverErrors <- serveZooKeeperProtocolTest(serverConnection)
	}()

	client, err := newProtocolZooKeeperClient(clientConnection, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	saslClient := &scriptedZooKeeperSASLClient{}
	if err := client.authenticateSASL(saslClient); err != nil {
		t.Fatal(err)
	}
	if !saslClient.disposed {
		t.Fatal("SASL credentials were not disposed")
	}
	if err := client.AddAuth("digest", []byte("user:password")); err != nil {
		t.Fatal(err)
	}
	children, stat, err := client.Children("/hiveserver2")
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 1 || children[0] != "server-1" || stat.NumChildren != 1 {
		t.Fatalf("children=%#v stat=%#v", children, stat)
	}
	data, stat, err := client.Get("/hiveserver2/server-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "serverUri=hs2.example.com:10000" || stat.DataLength != int32(len(data)) {
		t.Fatalf("data=%q stat=%#v", data, stat)
	}
	client.Close()
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestProtocolZooKeeperClientMapsRequiredSASLError(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()
	serverErrors := make(chan error, 1)
	go func() {
		defer serverConnection.Close()
		if err := acceptZooKeeperSession(serverConnection); err != nil {
			serverErrors <- err
			return
		}
		request, err := readZooKeeperTestFrame(serverConnection)
		if err != nil {
			serverErrors <- err
			return
		}
		decoder := newZooKeeperDecoder(request)
		xid, _ := decoder.int32()
		opcode, _ := decoder.int32()
		if opcode != zooKeeperOpSASL {
			serverErrors <- fmt.Errorf("opcode=%d", opcode)
			return
		}
		serverErrors <- writeZooKeeperTestResponse(serverConnection, xid, -124, nil)
	}()

	client, err := newProtocolZooKeeperClient(clientConnection, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	saslClient := &scriptedZooKeeperSASLClient{}
	err = client.authenticateSASL(saslClient)
	client.Close()
	if !errors.Is(err, errZooKeeperSessionClosedRequiresSASL) {
		t.Fatalf("unexpected error %v", err)
	}
	if serverErr := <-serverErrors; serverErr != nil {
		t.Fatal(serverErr)
	}
}

func TestZooKeeperGSSAPIOptionsDoNotReuseHiveServerIdentity(t *testing.T) {
	config := connectionConfig{
		Kerberos: kerberosConfig{
			ServerPrincipal:   "hive/_HOST@HIVE.EXAMPLE.COM",
			ClientPrincipal:   "alice@CLIENT.EXAMPLE.COM",
			AuthorizationID:   "hive-proxy",
			QOP:               "auth-conf",
			ConfigPath:        "/etc/krb5.conf",
			CCachePath:        "/tmp/alice.ccache",
			UseTicketCache:    true,
			CanonicalHostname: true,
		},
		ZooKeeperKerberos: zooKeeperKerberosConfig{
			Enabled:           true,
			Service:           "zookeeper",
			Realm:             "ZK.EXAMPLE.COM",
			CanonicalHostname: false,
		},
	}
	service, options := zooKeeperGSSAPIOptions(config)
	if service != "zookeeper" || options.ServerName != "zookeeper/_HOST@ZK.EXAMPLE.COM" {
		t.Fatalf("service=%q options=%#v", service, options)
	}
	if options.QOP != "auth" || options.AuthorizationID != "" || options.CanonicalizeHost || options.Principal != "alice@CLIENT.EXAMPLE.COM" || options.CCachePath != "/tmp/alice.ccache" {
		t.Fatalf("unexpected ZooKeeper GSSAPI options: %#v", options)
	}
}

func TestConnectKerberosZooKeeperFailsOverAndUsesTargetHost(t *testing.T) {
	previousDial := dialZooKeeperConnection
	previousFactory := newZooKeeperSASLClient
	previousShuffle := shuffleZooKeeperServers
	t.Cleanup(func() {
		dialZooKeeperConnection = previousDial
		newZooKeeperSASLClient = previousFactory
		shuffleZooKeeperServers = previousShuffle
	})
	shuffleZooKeeperServers = func([]string) {}

	clientConnection, serverConnection := net.Pipe()
	serverErrors := make(chan error, 1)
	go func() {
		defer serverConnection.Close()
		if err := acceptZooKeeperSession(serverConnection); err != nil {
			serverErrors <- err
			return
		}
		if err := expectZooKeeperSASLRound(serverConnection, "client-initial", []byte("server-challenge")); err != nil {
			serverErrors <- err
			return
		}
		if err := expectZooKeeperSASLRound(serverConnection, "client-final", nil); err != nil {
			serverErrors <- err
			return
		}
		request, err := readZooKeeperTestFrame(serverConnection)
		if err != nil {
			serverErrors <- err
			return
		}
		decoder := newZooKeeperDecoder(request)
		_, _ = decoder.int32()
		opcode, _ := decoder.int32()
		if opcode != zooKeeperOpClose {
			serverErrors <- fmt.Errorf("unexpected close opcode %d", opcode)
			return
		}
		serverErrors <- nil
	}()

	var dialed []string
	dialZooKeeperConnection = func(address string, _ time.Duration, _ *tls.Config) (net.Conn, error) {
		dialed = append(dialed, address)
		if address == "first.example.com:2181" {
			return nil, errors.New("first unavailable")
		}
		return clientConnection, nil
	}
	var targetHost string
	newZooKeeperSASLClient = func(host string, _ connectionConfig) (zooKeeperSASLClient, error) {
		targetHost = host
		return &scriptedZooKeeperSASLClient{}, nil
	}

	config := connectionConfig{
		Kerberos:          kerberosConfig{Enabled: true},
		ZooKeeperKerberos: zooKeeperKerberosConfig{Enabled: true},
	}
	client, events, err := connectKerberosZooKeeper(
		[]string{"first.example.com:2181", "second.example.com:2181"},
		time.Second,
		nil,
		config,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(dialed) != 2 || dialed[0] != "first.example.com:2181" || dialed[1] != "second.example.com:2181" {
		t.Fatalf("dialed = %#v", dialed)
	}
	if targetHost != "second.example.com" {
		t.Fatalf("target host = %q", targetHost)
	}
	event := <-events
	if event.State != zk.StateHasSession || event.Server != "second.example.com:2181" {
		t.Fatalf("event = %#v", event)
	}
	client.Close()
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func TestZooKeeperKerberosSASLWithMiniKDC(t *testing.T) {
	logger := log.New(io.Discard, "", 0)
	kdc, err := krb5test.NewKDC(map[string][]string{
		"alice":               nil,
		"zookeeper/localhost": nil,
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	kdc.KRB5Conf.LibDefaults.UDPPreferenceLimit = 1
	kdc.Start()
	defer kdc.Close()

	directory := t.TempDir()
	configPath := filepath.Join(directory, "krb5.conf")
	keytabPath := filepath.Join(directory, "zookeeper.keytab")
	configContents := fmt.Sprintf(`[libdefaults]
 default_realm = %s
 dns_lookup_realm = false
 dns_lookup_kdc = false
 rdns = false
 udp_preference_limit = 1
 default_tgs_enctypes = aes256-cts-hmac-sha1-96
 default_tkt_enctypes = aes256-cts-hmac-sha1-96
 permitted_enctypes = aes256-cts-hmac-sha1-96

[realms]
 %s = {
  kdc = %s
 }
`, kdc.Realm, kdc.Realm, kdc.TCPListener.Addr().String())
	if err := os.WriteFile(configPath, []byte(configContents), 0o600); err != nil {
		t.Fatal(err)
	}
	keytabBytes, err := kdc.Keytab.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keytabPath, keytabBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KRB5_KTNAME", keytabPath)
	t.Setenv("KRB5_CLIENT_KTNAME", keytabPath)

	clientConnection, serverConnection := net.Pipe()
	serverErrors := make(chan error, 1)
	servicePrincipal := "zookeeper/localhost@" + kdc.Realm
	go func() {
		defer serverConnection.Close()
		serverErrors <- serveKerberosZooKeeperSASL(serverConnection, servicePrincipal)
	}()

	protocolClient, err := newProtocolZooKeeperClient(clientConnection, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	config := connectionConfig{
		Kerberos: kerberosConfig{
			Enabled:         true,
			ClientPrincipal: "alice@" + kdc.Realm,
			ConfigPath:      configPath,
			Password:        kdc.Principals["alice"].Password,
			DisablePAFXFAST: true,
		},
		ZooKeeperKerberos: zooKeeperKerberosConfig{
			Enabled:           true,
			Service:           "zookeeper",
			ServerPrincipal:   servicePrincipal,
			CanonicalHostname: false,
		},
	}
	saslClient, err := newZooKeeperSASLClient("localhost", config)
	if err != nil {
		t.Fatal(err)
	}
	if err := protocolClient.authenticateSASL(saslClient); err != nil {
		t.Fatal(err)
	}
	protocolClient.Close()
	if err := <-serverErrors; err != nil {
		t.Fatal(err)
	}
}

func serveZooKeeperProtocolTest(connection net.Conn) error {
	if err := acceptZooKeeperSession(connection); err != nil {
		return err
	}
	if err := expectZooKeeperSASLRound(connection, "client-initial", []byte("server-challenge")); err != nil {
		return err
	}
	if err := expectZooKeeperSASLRound(connection, "client-final", nil); err != nil {
		return err
	}
	request, err := readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder := newZooKeeperDecoder(request)
	xid, _ := decoder.int32()
	opcode, _ := decoder.int32()
	authType, _ := decoder.int32()
	scheme, _ := decoder.string()
	auth, _ := decoder.bytes()
	if opcode != zooKeeperOpSetAuth || authType != 0 || scheme != "digest" || string(auth) != "user:password" {
		return fmt.Errorf("unexpected auth request opcode=%d type=%d scheme=%q auth=%q", opcode, authType, scheme, auth)
	}
	if err := writeZooKeeperTestResponse(connection, xid, 0, nil); err != nil {
		return err
	}
	request, err = readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder = newZooKeeperDecoder(request)
	xid, _ = decoder.int32()
	opcode, _ = decoder.int32()
	path, _ := decoder.string()
	watch, _ := decoder.take(1)
	if opcode != zooKeeperOpGetChildren2 || path != "/hiveserver2" || !bytes.Equal(watch, []byte{0}) {
		return fmt.Errorf("unexpected children request opcode=%d path=%q watch=%v", opcode, path, watch)
	}
	body := &zooKeeperEncoder{}
	body.int32(1)
	body.string("server-1")
	encodeZooKeeperTestStat(body, 0, 1)
	if err := writeZooKeeperTestResponse(connection, xid, 0, body.data()); err != nil {
		return err
	}
	request, err = readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder = newZooKeeperDecoder(request)
	xid, _ = decoder.int32()
	opcode, _ = decoder.int32()
	path, _ = decoder.string()
	watch, _ = decoder.take(1)
	if opcode != zooKeeperOpGetData || path != "/hiveserver2/server-1" || !bytes.Equal(watch, []byte{0}) {
		return fmt.Errorf("unexpected get request opcode=%d path=%q watch=%v", opcode, path, watch)
	}
	data := []byte("serverUri=hs2.example.com:10000")
	body = &zooKeeperEncoder{}
	body.bytes(data)
	encodeZooKeeperTestStat(body, int32(len(data)), 0)
	if err := writeZooKeeperTestResponse(connection, xid, 0, body.data()); err != nil {
		return err
	}
	request, err = readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder = newZooKeeperDecoder(request)
	_, _ = decoder.int32()
	opcode, _ = decoder.int32()
	if opcode != zooKeeperOpClose {
		return fmt.Errorf("unexpected close opcode %d", opcode)
	}
	return nil
}

func serveKerberosZooKeeperSASL(connection net.Conn, servicePrincipal string) error {
	if err := acceptZooKeeperSession(connection); err != nil {
		return err
	}
	acceptor := gsskrb5.NewKrb5Mech()
	if err := acceptor.Accept(servicePrincipal); err != nil {
		return err
	}
	xid, token, err := readZooKeeperSASLRequest(connection)
	if err != nil {
		return err
	}
	apReply, err := acceptor.Continue(token)
	if err != nil {
		return err
	}
	if !acceptor.IsEstablished() {
		return errors.New("Kerberos acceptor context was not established")
	}
	if err := writeZooKeeperSASLResponse(connection, xid, apReply); err != nil {
		return err
	}
	xid, token, err = readZooKeeperSASLRequest(connection)
	if err != nil {
		return err
	}
	if len(token) != 0 {
		return fmt.Errorf("expected empty post-AP-REP token, got %x", token)
	}
	securityChallenge, err := acceptor.Wrap([]byte{1, 0, 0, 0}, false)
	if err != nil {
		return err
	}
	if err := writeZooKeeperSASLResponse(connection, xid, securityChallenge); err != nil {
		return err
	}
	xid, token, err = readZooKeeperSASLRequest(connection)
	if err != nil {
		return err
	}
	securityResponse, sealed, err := acceptor.Unwrap(token)
	if err != nil {
		return err
	}
	if sealed || len(securityResponse) < 4 || !bytes.Equal(securityResponse[:4], []byte{1, 0, 0, 0}) {
		return fmt.Errorf("invalid GSSAPI security-layer response sealed=%v payload=%x", sealed, securityResponse)
	}
	if len(securityResponse[4:]) == 0 {
		return errors.New("GSSAPI authorization identity is empty")
	}
	if err := writeZooKeeperSASLResponse(connection, xid, nil); err != nil {
		return err
	}
	request, err := readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder := newZooKeeperDecoder(request)
	_, _ = decoder.int32()
	opcode, _ := decoder.int32()
	if opcode != zooKeeperOpClose {
		return fmt.Errorf("unexpected close opcode %d", opcode)
	}
	return nil
}

func readZooKeeperSASLRequest(connection net.Conn) (int32, []byte, error) {
	request, err := readZooKeeperTestFrame(connection)
	if err != nil {
		return 0, nil, err
	}
	decoder := newZooKeeperDecoder(request)
	xid, err := decoder.int32()
	if err != nil {
		return 0, nil, err
	}
	opcode, err := decoder.int32()
	if err != nil {
		return 0, nil, err
	}
	if opcode != zooKeeperOpSASL {
		return 0, nil, fmt.Errorf("unexpected SASL opcode %d", opcode)
	}
	token, err := decoder.bytes()
	return xid, token, err
}

func writeZooKeeperSASLResponse(connection net.Conn, xid int32, token []byte) error {
	body := &zooKeeperEncoder{}
	body.bytes(token)
	return writeZooKeeperTestResponse(connection, xid, 0, body.data())
}

func acceptZooKeeperSession(connection net.Conn) error {
	request, err := readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder := newZooKeeperDecoder(request)
	version, _ := decoder.int32()
	_, _ = decoder.int64()
	timeout, _ := decoder.int32()
	sessionID, _ := decoder.int64()
	password, _ := decoder.bytes()
	if version != 0 || timeout <= 0 || sessionID != 0 || len(password) != 16 {
		return fmt.Errorf("invalid connect request version=%d timeout=%d session=%d password=%d", version, timeout, sessionID, len(password))
	}
	response := &zooKeeperEncoder{}
	response.int32(0)
	response.int32(timeout)
	response.int64(42)
	response.bytes(make([]byte, 16))
	return writeZooKeeperTestFrame(connection, response.data())
}

func expectZooKeeperSASLRound(connection net.Conn, wantToken string, responseToken []byte) error {
	request, err := readZooKeeperTestFrame(connection)
	if err != nil {
		return err
	}
	decoder := newZooKeeperDecoder(request)
	xid, _ := decoder.int32()
	opcode, _ := decoder.int32()
	token, _ := decoder.bytes()
	if opcode != zooKeeperOpSASL || string(token) != wantToken {
		return fmt.Errorf("unexpected SASL request opcode=%d token=%q", opcode, token)
	}
	body := &zooKeeperEncoder{}
	body.bytes(responseToken)
	return writeZooKeeperTestResponse(connection, xid, 0, body.data())
}

func encodeZooKeeperTestStat(encoder *zooKeeperEncoder, dataLength, children int32) {
	encoder.int64(1)
	encoder.int64(2)
	encoder.int64(3)
	encoder.int64(4)
	encoder.int32(5)
	encoder.int32(6)
	encoder.int32(7)
	encoder.int64(8)
	encoder.int32(dataLength)
	encoder.int32(children)
	encoder.int64(9)
}

func writeZooKeeperTestResponse(connection net.Conn, xid, code int32, body []byte) error {
	response := &zooKeeperEncoder{}
	response.int32(xid)
	response.int64(0)
	response.int32(code)
	response.buffer.Write(body)
	return writeZooKeeperTestFrame(connection, response.data())
}

func readZooKeeperTestFrame(connection net.Conn) ([]byte, error) {
	client := &protocolZooKeeperClient{connection: connection, timeout: time.Second}
	return client.readFrame()
}

func writeZooKeeperTestFrame(connection net.Conn, payload []byte) error {
	client := &protocolZooKeeperClient{connection: connection, timeout: time.Second}
	return client.writeFrame(payload)
}

var _ zooKeeperClient = (*protocolZooKeeperClient)(nil)
var _ = zk.StateSaslAuthenticated
