package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/beltran/gosasl"
)

const (
	zooKeeperSASLOpcode      = int32(102)
	zooKeeperSASLXIDBase     = int32(0x3fff0000)
	zooKeeperSASLMaxRounds   = 8
	zooKeeperMaximumFrameLen = 16 * 1024 * 1024
)

type saslDigestCredentials struct {
	Username string
	Password string
}

type saslHandshakeConn struct {
	net.Conn
	timeout     time.Duration
	credentials saslDigestCredentials
	mutex       sync.Mutex
	initialized bool
	buffer      []byte
	error       error
}

var authenticateZooKeeperSASL = authenticateSASLDigest

func newSASLHandshakeConn(connection net.Conn, timeout time.Duration, credentials saslDigestCredentials) net.Conn {
	return &saslHandshakeConn{
		Conn:        connection,
		timeout:     timeout,
		credentials: credentials,
	}
}

func (connection *saslHandshakeConn) Read(payload []byte) (int, error) {
	connection.mutex.Lock()
	defer connection.mutex.Unlock()
	if !connection.initialized {
		connection.initialized = true
		connection.buffer, connection.error = readZooKeeperFrame(connection.Conn)
		if connection.error == nil {
			connection.error = authenticateZooKeeperSASL(connection.Conn, connection.timeout, connection.credentials)
		}
	}
	if connection.error != nil {
		return 0, connection.error
	}
	if len(connection.buffer) > 0 {
		read := copy(payload, connection.buffer)
		connection.buffer = connection.buffer[read:]
		return read, nil
	}
	return connection.Conn.Read(payload)
}

func authenticateSASLDigest(connection net.Conn, timeout time.Duration, credentials saslDigestCredentials) error {
	mechanism := gosasl.NewDigestMD5Mechanism("zookeeper", credentials.Username, credentials.Password)
	saslClient := gosasl.NewSaslClient("zk-sasl-md5", mechanism)
	defer saslClient.Dispose()
	return negotiateSASLDigest(connection, timeout, saslClient)
}

type saslClient interface {
	Start() ([]byte, error)
	Step(challenge []byte) ([]byte, error)
	Complete() bool
}

func negotiateSASLDigest(connection net.Conn, timeout time.Duration, saslClient saslClient) error {
	if timeout <= 0 {
		timeout = defaultConnectionTimeout
	}
	if err := connection.SetDeadline(time.Now().Add(timeout)); err != nil {
		return err
	}
	defer connection.SetDeadline(time.Time{})

	token, err := saslClient.Start()
	if err != nil {
		return fmt.Errorf("start ZooKeeper DIGEST-MD5 negotiation: %w", err)
	}
	for round := 0; round < zooKeeperSASLMaxRounds; round++ {
		challenge, err := zooKeeperSASLRound(connection, zooKeeperSASLXIDBase+int32(round), token)
		if err != nil {
			return fmt.Errorf("ZooKeeper SASL round %d: %w", round+1, err)
		}
		if saslClient.Complete() {
			if len(challenge) != 0 {
				return errors.New("ZooKeeper sent an unexpected token after DIGEST-MD5 completion")
			}
			return nil
		}
		token, err = saslClient.Step(challenge)
		if err != nil {
			return fmt.Errorf("continue ZooKeeper DIGEST-MD5 negotiation at round %d: %w", round+1, err)
		}
		if saslClient.Complete() {
			if len(token) != 0 {
				return errors.New("ZooKeeper DIGEST-MD5 completed with an unexpected client token")
			}
			return nil
		}
	}
	return fmt.Errorf("ZooKeeper DIGEST-MD5 negotiation exceeded %d rounds", zooKeeperSASLMaxRounds)
}

func zooKeeperSASLRound(connection net.Conn, xid int32, token []byte) ([]byte, error) {
	payload := make([]byte, 12+len(token))
	binary.BigEndian.PutUint32(payload[0:4], uint32(xid))
	binary.BigEndian.PutUint32(payload[4:8], uint32(zooKeeperSASLOpcode))
	binary.BigEndian.PutUint32(payload[8:12], uint32(len(token)))
	copy(payload[12:], token)
	if err := writeZooKeeperFrame(connection, payload); err != nil {
		return nil, err
	}
	response, err := readZooKeeperFrame(connection)
	if err != nil {
		return nil, err
	}
	if len(response) < 20 {
		return nil, errors.New("ZooKeeper SASL response is truncated")
	}
	responseXID := int32(binary.BigEndian.Uint32(response[4:8]))
	if responseXID != xid {
		return nil, fmt.Errorf("ZooKeeper SASL response xid %d does not match request xid %d", responseXID, xid)
	}
	errorCode := int32(binary.BigEndian.Uint32(response[16:20]))
	if errorCode != 0 {
		return nil, fmt.Errorf("ZooKeeper SASL server returned error %d", errorCode)
	}
	if len(response) < 24 {
		return nil, errors.New("ZooKeeper SASL token is truncated")
	}
	tokenLength := int(int32(binary.BigEndian.Uint32(response[20:24])))
	if tokenLength < 0 || tokenLength > zooKeeperMaximumFrameLen || 24+tokenLength > len(response) {
		return nil, fmt.Errorf("ZooKeeper SASL token length %d is invalid", tokenLength)
	}
	return append([]byte(nil), response[24:24+tokenLength]...), nil
}

func readZooKeeperFrame(reader io.Reader) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	length := int(int32(binary.BigEndian.Uint32(header)))
	if length < 0 || length > zooKeeperMaximumFrameLen {
		return nil, fmt.Errorf("ZooKeeper frame length %d is invalid", length)
	}
	payload := make([]byte, length+4)
	copy(payload, header)
	if _, err := io.ReadFull(reader, payload[4:]); err != nil {
		return nil, err
	}
	return payload, nil
}

func writeZooKeeperFrame(writer io.Writer, payload []byte) error {
	if len(payload) > zooKeeperMaximumFrameLen {
		return fmt.Errorf("ZooKeeper frame length %d exceeds maximum %d", len(payload), zooKeeperMaximumFrameLen)
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(payload)))
	if err := writeAll(writer, header); err != nil {
		return err
	}
	return writeAll(writer, payload)
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
