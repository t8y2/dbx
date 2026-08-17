package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestSASLHandshakeConnReplaysConnectResponse(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	previous := authenticateZooKeeperSASL
	t.Cleanup(func() { authenticateZooKeeperSASL = previous })
	called := make(chan saslDigestCredentials, 1)
	authenticateZooKeeperSASL = func(_ net.Conn, _ time.Duration, credentials saslDigestCredentials) error {
		called <- credentials
		return nil
	}
	go func() { _ = writeZooKeeperFrame(server, []byte("connect-response")) }()
	wrapper := newSASLHandshakeConn(client, time.Second, saslDigestCredentials{Username: "user", Password: "secret"})
	frame, err := readZooKeeperFrame(wrapper)
	if err != nil || string(frame[4:]) != "connect-response" {
		t.Fatalf("frame=%q err=%v", frame, err)
	}
	if credentials := <-called; credentials.Username != "user" || credentials.Password != "secret" {
		t.Fatalf("credentials=%#v", credentials)
	}
}

func TestZooKeeperSASLRound(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	serverError := make(chan error, 1)
	go func() {
		request, err := readZooKeeperFrame(server)
		if err != nil {
			serverError <- err
			return
		}
		if len(request) != 4+12+len("client-token") || int32(binary.BigEndian.Uint32(request[4:8])) != 41 || int32(binary.BigEndian.Uint32(request[8:12])) != zooKeeperSASLOpcode || string(request[16:]) != "client-token" {
			serverError <- errors.New("unexpected SASL request")
			return
		}
		response := make([]byte, 20+4+len("server-token"))
		binary.BigEndian.PutUint32(response[0:4], 41)
		binary.BigEndian.PutUint32(response[16:20], uint32(len("server-token")))
		copy(response[20:], "server-token")
		serverError <- writeZooKeeperFrame(server, response)
	}()
	token, err := zooKeeperSASLRound(client, 41, []byte("client-token"))
	if err != nil || string(token) != "server-token" {
		t.Fatalf("token=%q err=%v", token, err)
	}
	if err := <-serverError; err != nil {
		t.Fatal(err)
	}
}

func TestZooKeeperSASLRoundRejectsWrongXID(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	go func() {
		_, _ = readZooKeeperFrame(server)
		response := make([]byte, 24)
		binary.BigEndian.PutUint32(response[0:4], 99)
		_ = writeZooKeeperFrame(server, response)
	}()
	if _, err := zooKeeperSASLRound(client, 41, nil); err == nil || !bytes.Contains([]byte(err.Error()), []byte("does not match")) {
		t.Fatalf("error=%v", err)
	}
}

func TestZooKeeperFrameValidation(t *testing.T) {
	oversized := make([]byte, 4)
	binary.BigEndian.PutUint32(oversized, zooKeeperMaximumFrameLen+1)
	if _, err := readZooKeeperFrame(bytes.NewReader(oversized)); err == nil {
		t.Fatal("oversized frame was accepted")
	}
	truncated := append([]byte{0, 0, 0, 4}, []byte{1, 2}...)
	if _, err := readZooKeeperFrame(bytes.NewReader(truncated)); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("truncated error=%v", err)
	}
}

func TestSASLNegotiationStopsAfterRspauth(t *testing.T) {
	clientConnection, serverConnection := net.Pipe()
	defer clientConnection.Close()
	defer serverConnection.Close()
	client := &scriptedDigestClient{}
	serverError := make(chan error, 1)
	go func() {
		for round, challenge := range [][]byte{[]byte("challenge"), []byte("rspauth")} {
			request, err := readZooKeeperFrame(serverConnection)
			if err != nil {
				serverError <- err
				return
			}
			expectedToken := ""
			if round == 1 {
				expectedToken = "response"
			}
			if string(request[16:]) != expectedToken {
				serverError <- errors.New("unexpected client token")
				return
			}
			response := make([]byte, 24+len(challenge))
			xid := int32(binary.BigEndian.Uint32(request[4:8]))
			binary.BigEndian.PutUint32(response[0:4], uint32(xid))
			binary.BigEndian.PutUint32(response[16:20], uint32(len(challenge)))
			copy(response[20:], challenge)
			if err := writeZooKeeperFrame(serverConnection, response); err != nil {
				serverError <- err
				return
			}
		}
		_ = serverConnection.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		buffer := make([]byte, 1)
		if _, err := serverConnection.Read(buffer); err == nil {
			serverError <- errors.New("client sent an unexpected third SASL round")
			return
		}
		serverError <- nil
	}()
	if err := negotiateSASLDigest(clientConnection, time.Second, client); err != nil {
		t.Fatal(err)
	}
	if err := <-serverError; err != nil {
		t.Fatal(err)
	}
}

type scriptedDigestClient struct {
	step int
}

func (client *scriptedDigestClient) Start() ([]byte, error) { return nil, nil }

func (client *scriptedDigestClient) Step(challenge []byte) ([]byte, error) {
	client.step++
	if client.step == 1 && string(challenge) == "challenge" {
		return []byte("response"), nil
	}
	if client.step == 2 && string(challenge) == "rspauth" {
		return nil, nil
	}
	return nil, errors.New("unexpected challenge")
}

func (client *scriptedDigestClient) Complete() bool { return client.step == 2 }
