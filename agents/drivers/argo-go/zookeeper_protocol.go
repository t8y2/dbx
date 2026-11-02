package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/beltran/gosasl"
	"github.com/go-zookeeper/zk"
)

const (
	zooKeeperProtocolVersion = int32(0)
	zooKeeperOpGetData       = int32(4)
	zooKeeperOpGetChildren2  = int32(12)
	zooKeeperOpClose         = int32(-11)
	zooKeeperOpSetAuth       = int32(100)
	zooKeeperOpSASL          = int32(102)
	zooKeeperMaxFrameSize    = 16 << 20
	zooKeeperMaxSASLRounds   = 8
)

var errZooKeeperSessionClosedRequiresSASL = errors.New("ZooKeeper session closed because SASL authentication is required")

type zooKeeperSASLClient interface {
	Start() ([]byte, error)
	Step([]byte) ([]byte, error)
	Complete() bool
	Dispose()
}

var newZooKeeperSASLClient = func(host string, config connectionConfig) (zooKeeperSASLClient, error) {
	service, options := zooKeeperGSSAPIOptions(config)
	mechanism, err := gosasl.NewGSSAPIMechanismWithOptions(service, options)
	if err != nil {
		return nil, err
	}
	return gosasl.NewSaslClient(host, mechanism), nil
}

var dialZooKeeperConnection = func(address string, timeout time.Duration, tlsConfig *tls.Config) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout}
	if tlsConfig == nil {
		return dialer.Dial("tcp", address)
	}
	config := tlsConfig.Clone()
	if config.ServerName == "" {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("parse ZooKeeper TLS address %q: %w", address, err)
		}
		config.ServerName = host
	}
	return tls.DialWithDialer(dialer, "tcp", address, config)
}

var shuffleZooKeeperServers = func(servers []string) {
	rand.Shuffle(len(servers), func(first, second int) {
		servers[first], servers[second] = servers[second], servers[first]
	})
}

func zooKeeperGSSAPIOptions(config connectionConfig) (string, gosasl.GSSAPIOptions) {
	service := firstNonEmpty(config.ZooKeeperKerberos.Service, "zookeeper")
	options := gssapiOptionsFromKerberos(config.Kerberos)
	options.QOP = "auth"
	options.AuthorizationID = ""
	options.ServiceHost = ""
	options.CanonicalizeHost = config.ZooKeeperKerberos.CanonicalHostname
	options.ServerName = config.ZooKeeperKerberos.ServerPrincipal
	if options.ServerName == "" && config.ZooKeeperKerberos.Realm != "" {
		options.ServerName = service + "/_HOST@" + config.ZooKeeperKerberos.Realm
	}
	return service, options
}

func connectKerberosZooKeeper(
	servers []string,
	timeout time.Duration,
	tlsConfig *tls.Config,
	config connectionConfig,
) (zooKeeperClient, <-chan zk.Event, error) {
	if len(servers) == 0 {
		return nil, nil, errors.New("ZooKeeper server list is empty")
	}
	if !config.Kerberos.Enabled {
		return nil, nil, errors.New("ZooKeeper Kerberos SASL requires Hive Kerberos credentials")
	}
	ordered := append([]string(nil), servers...)
	shuffleZooKeeperServers(ordered)
	var failures []string
	for _, address := range ordered {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", address, err))
			continue
		}
		connection, err := dialZooKeeperConnection(address, timeout, tlsConfig)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", address, err))
			continue
		}
		client, err := newProtocolZooKeeperClient(connection, timeout)
		if err == nil {
			var saslClient zooKeeperSASLClient
			saslClient, err = newZooKeeperSASLClient(host, config)
			if err == nil {
				err = client.authenticateSASL(saslClient)
			}
		}
		if err != nil {
			connection.Close()
			failures = append(failures, fmt.Sprintf("%s: %v", address, err))
			continue
		}
		events := make(chan zk.Event, 1)
		events <- zk.Event{State: zk.StateHasSession, Server: address}
		close(events)
		return client, events, nil
	}
	return nil, nil, fmt.Errorf("connect and authenticate to ZooKeeper: %s", strings.Join(failures, "; "))
}

type protocolZooKeeperClient struct {
	connection net.Conn
	timeout    time.Duration
	xid        int32
	mutex      sync.Mutex
	closed     bool
}

func newProtocolZooKeeperClient(connection net.Conn, timeout time.Duration) (*protocolZooKeeperClient, error) {
	if connection == nil {
		return nil, errors.New("ZooKeeper connection is nil")
	}
	if timeout <= 0 {
		timeout = defaultConnectTimeout
	}
	client := &protocolZooKeeperClient{connection: connection, timeout: timeout}
	request := &zooKeeperEncoder{}
	request.int32(zooKeeperProtocolVersion)
	request.int64(0)
	request.int32(zooKeeperTimeoutMillis(timeout))
	request.int64(0)
	request.bytes(make([]byte, 16))
	if err := client.writeFrame(request.data()); err != nil {
		return nil, fmt.Errorf("send ZooKeeper connect request: %w", err)
	}
	response, err := client.readFrame()
	if err != nil {
		return nil, fmt.Errorf("read ZooKeeper connect response: %w", err)
	}
	decoder := newZooKeeperDecoder(response)
	if _, err := decoder.int32(); err != nil {
		return nil, fmt.Errorf("decode ZooKeeper protocol version: %w", err)
	}
	if _, err := decoder.int32(); err != nil {
		return nil, fmt.Errorf("decode ZooKeeper session timeout: %w", err)
	}
	sessionID, err := decoder.int64()
	if err != nil {
		return nil, fmt.Errorf("decode ZooKeeper session ID: %w", err)
	}
	if _, err := decoder.bytes(); err != nil {
		return nil, fmt.Errorf("decode ZooKeeper session password: %w", err)
	}
	if sessionID == 0 {
		return nil, zk.ErrSessionExpired
	}
	return client, nil
}

func zooKeeperTimeoutMillis(timeout time.Duration) int32 {
	milliseconds := timeout.Milliseconds()
	if milliseconds < 1 {
		return 1
	}
	if milliseconds > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(milliseconds)
}

func (client *protocolZooKeeperClient) authenticateSASL(saslClient zooKeeperSASLClient) error {
	if saslClient == nil {
		return errors.New("ZooKeeper SASL client is nil")
	}
	defer saslClient.Dispose()
	token, err := saslClient.Start()
	if err != nil {
		return fmt.Errorf("start ZooKeeper GSSAPI negotiation: %w", err)
	}
	for round := 0; round < zooKeeperMaxSASLRounds; round++ {
		response, requestErr := client.request(zooKeeperOpSASL, func(encoder *zooKeeperEncoder) {
			if token == nil {
				encoder.bytes([]byte{})
				return
			}
			encoder.bytes(token)
		})
		if requestErr != nil {
			return fmt.Errorf("ZooKeeper SASL round %d: %w", round+1, requestErr)
		}
		decoder := newZooKeeperDecoder(response)
		challenge, decodeErr := decoder.bytes()
		if decodeErr != nil {
			return fmt.Errorf("decode ZooKeeper SASL round %d: %w", round+1, decodeErr)
		}
		if saslClient.Complete() {
			if len(challenge) != 0 {
				return errors.New("ZooKeeper sent an unexpected token after GSSAPI completion")
			}
			return nil
		}
		token, err = saslClient.Step(challenge)
		if err != nil {
			return fmt.Errorf("continue ZooKeeper GSSAPI negotiation at round %d: %w", round+1, err)
		}
	}
	return fmt.Errorf("ZooKeeper GSSAPI negotiation exceeded %d rounds", zooKeeperMaxSASLRounds)
}

func (client *protocolZooKeeperClient) AddAuth(scheme string, auth []byte) error {
	_, err := client.request(zooKeeperOpSetAuth, func(encoder *zooKeeperEncoder) {
		encoder.int32(0)
		encoder.string(scheme)
		encoder.bytes(auth)
	})
	return err
}

func (client *protocolZooKeeperClient) Children(path string) ([]string, *zk.Stat, error) {
	response, err := client.request(zooKeeperOpGetChildren2, func(encoder *zooKeeperEncoder) {
		encoder.string(path)
		encoder.boolean(false)
	})
	if err != nil {
		return nil, nil, err
	}
	decoder := newZooKeeperDecoder(response)
	children, err := decoder.strings()
	if err != nil {
		return nil, nil, err
	}
	stat, err := decoder.stat()
	if err != nil {
		return nil, nil, err
	}
	return children, stat, nil
}

func (client *protocolZooKeeperClient) Get(path string) ([]byte, *zk.Stat, error) {
	response, err := client.request(zooKeeperOpGetData, func(encoder *zooKeeperEncoder) {
		encoder.string(path)
		encoder.boolean(false)
	})
	if err != nil {
		return nil, nil, err
	}
	decoder := newZooKeeperDecoder(response)
	data, err := decoder.bytes()
	if err != nil {
		return nil, nil, err
	}
	stat, err := decoder.stat()
	if err != nil {
		return nil, nil, err
	}
	return data, stat, nil
}

func (client *protocolZooKeeperClient) Close() {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	if client.closed {
		return
	}
	client.closed = true
	_ = client.connection.SetDeadline(time.Now().Add(client.timeout))
	client.xid++
	request := &zooKeeperEncoder{}
	request.int32(client.xid)
	request.int32(zooKeeperOpClose)
	_ = client.writeFrame(request.data())
	_ = client.connection.Close()
}

func (client *protocolZooKeeperClient) request(opcode int32, encodeBody func(*zooKeeperEncoder)) ([]byte, error) {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	if client.closed {
		return nil, zk.ErrConnectionClosed
	}
	client.xid++
	request := &zooKeeperEncoder{}
	request.int32(client.xid)
	request.int32(opcode)
	if encodeBody != nil {
		encodeBody(request)
	}
	if err := client.writeFrame(request.data()); err != nil {
		return nil, err
	}
	response, err := client.readFrame()
	if err != nil {
		return nil, err
	}
	decoder := newZooKeeperDecoder(response)
	xid, err := decoder.int32()
	if err != nil {
		return nil, err
	}
	if xid != client.xid {
		return nil, fmt.Errorf("ZooKeeper response XID %d does not match request XID %d", xid, client.xid)
	}
	if _, err := decoder.int64(); err != nil {
		return nil, err
	}
	code, err := decoder.int32()
	if err != nil {
		return nil, err
	}
	if err := zooKeeperError(code); err != nil {
		return nil, err
	}
	return decoder.remaining(), nil
}

func (client *protocolZooKeeperClient) writeFrame(payload []byte) error {
	if len(payload) > zooKeeperMaxFrameSize {
		return fmt.Errorf("ZooKeeper request frame is %d bytes, maximum is %d", len(payload), zooKeeperMaxFrameSize)
	}
	if err := client.connection.SetWriteDeadline(time.Now().Add(client.timeout)); err != nil {
		return err
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if err := writeAll(client.connection, header); err != nil {
		return err
	}
	return writeAll(client.connection, payload)
}

func (client *protocolZooKeeperClient) readFrame() ([]byte, error) {
	if err := client.connection.SetReadDeadline(time.Now().Add(client.timeout)); err != nil {
		return nil, err
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(client.connection, header); err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint32(header))
	if length < 0 || length > zooKeeperMaxFrameSize {
		return nil, fmt.Errorf("ZooKeeper response frame is %d bytes, maximum is %d", length, zooKeeperMaxFrameSize)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(client.connection, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeAll(writer io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := writer.Write(payload)
		if err != nil {
			return err
		}
		if written <= 0 {
			return io.ErrShortWrite
		}
		payload = payload[written:]
	}
	return nil
}

func zooKeeperError(code int32) error {
	switch code {
	case 0:
		return nil
	case -4:
		return zk.ErrConnectionClosed
	case -101:
		return zk.ErrNoNode
	case -102:
		return zk.ErrNoAuth
	case -112:
		return zk.ErrSessionExpired
	case -115:
		return zk.ErrAuthFailed
	case -124:
		return errZooKeeperSessionClosedRequiresSASL
	default:
		return fmt.Errorf("ZooKeeper request failed with error code %d", code)
	}
}

type zooKeeperEncoder struct {
	buffer bytes.Buffer
}

func (encoder *zooKeeperEncoder) int32(value int32) {
	var data [4]byte
	binary.BigEndian.PutUint32(data[:], uint32(value))
	encoder.buffer.Write(data[:])
}

func (encoder *zooKeeperEncoder) int64(value int64) {
	var data [8]byte
	binary.BigEndian.PutUint64(data[:], uint64(value))
	encoder.buffer.Write(data[:])
}

func (encoder *zooKeeperEncoder) boolean(value bool) {
	if value {
		encoder.buffer.WriteByte(1)
		return
	}
	encoder.buffer.WriteByte(0)
}

func (encoder *zooKeeperEncoder) string(value string) {
	encoder.bytes([]byte(value))
}

func (encoder *zooKeeperEncoder) bytes(value []byte) {
	if value == nil {
		encoder.int32(-1)
		return
	}
	encoder.int32(int32(len(value)))
	encoder.buffer.Write(value)
}

func (encoder *zooKeeperEncoder) data() []byte {
	return encoder.buffer.Bytes()
}

type zooKeeperDecoder struct {
	data   []byte
	offset int
}

func newZooKeeperDecoder(data []byte) *zooKeeperDecoder {
	return &zooKeeperDecoder{data: data}
}

func (decoder *zooKeeperDecoder) take(length int) ([]byte, error) {
	if length < 0 || decoder.offset > len(decoder.data)-length {
		return nil, io.ErrUnexpectedEOF
	}
	value := decoder.data[decoder.offset : decoder.offset+length]
	decoder.offset += length
	return value, nil
}

func (decoder *zooKeeperDecoder) int32() (int32, error) {
	value, err := decoder.take(4)
	if err != nil {
		return 0, err
	}
	return int32(binary.BigEndian.Uint32(value)), nil
}

func (decoder *zooKeeperDecoder) int64() (int64, error) {
	value, err := decoder.take(8)
	if err != nil {
		return 0, err
	}
	return int64(binary.BigEndian.Uint64(value)), nil
}

func (decoder *zooKeeperDecoder) bytes() ([]byte, error) {
	length, err := decoder.int32()
	if err != nil {
		return nil, err
	}
	if length == -1 {
		return nil, nil
	}
	if length < -1 {
		return nil, fmt.Errorf("invalid ZooKeeper buffer length %d", length)
	}
	value, err := decoder.take(int(length))
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), value...), nil
}

func (decoder *zooKeeperDecoder) string() (string, error) {
	value, err := decoder.bytes()
	return string(value), err
}

func (decoder *zooKeeperDecoder) strings() ([]string, error) {
	length, err := decoder.int32()
	if err != nil {
		return nil, err
	}
	if length == -1 {
		return nil, nil
	}
	if length < -1 || length > zooKeeperMaxFrameSize/4 {
		return nil, fmt.Errorf("invalid ZooKeeper string vector length %d", length)
	}
	values := make([]string, 0, length)
	for index := int32(0); index < length; index++ {
		value, valueErr := decoder.string()
		if valueErr != nil {
			return nil, valueErr
		}
		values = append(values, value)
	}
	return values, nil
}

func (decoder *zooKeeperDecoder) stat() (*zk.Stat, error) {
	stat := &zk.Stat{}
	var err error
	if stat.Czxid, err = decoder.int64(); err != nil {
		return nil, err
	}
	if stat.Mzxid, err = decoder.int64(); err != nil {
		return nil, err
	}
	if stat.Ctime, err = decoder.int64(); err != nil {
		return nil, err
	}
	if stat.Mtime, err = decoder.int64(); err != nil {
		return nil, err
	}
	if stat.Version, err = decoder.int32(); err != nil {
		return nil, err
	}
	if stat.Cversion, err = decoder.int32(); err != nil {
		return nil, err
	}
	if stat.Aversion, err = decoder.int32(); err != nil {
		return nil, err
	}
	if stat.EphemeralOwner, err = decoder.int64(); err != nil {
		return nil, err
	}
	if stat.DataLength, err = decoder.int32(); err != nil {
		return nil, err
	}
	if stat.NumChildren, err = decoder.int32(); err != nil {
		return nil, err
	}
	if stat.Pzxid, err = decoder.int64(); err != nil {
		return nil, err
	}
	return stat, nil
}

func (decoder *zooKeeperDecoder) remaining() []byte {
	return decoder.data[decoder.offset:]
}
