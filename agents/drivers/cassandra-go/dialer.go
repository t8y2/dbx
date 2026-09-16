package main

import (
	"context"
	"net"
	"time"
)

const cassandraKeepAlivePeriod = 30 * time.Second

type cassandraDialer struct {
	timeout    time.Duration
	keepAlive  bool
	tcpNoDelay bool
}

func (dialer cassandraDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	keepAlivePeriod := time.Duration(-1)
	if dialer.keepAlive {
		keepAlivePeriod = cassandraKeepAlivePeriod
	}
	connection, err := (&net.Dialer{
		Timeout:   dialer.timeout,
		KeepAlive: keepAlivePeriod,
	}).DialContext(ctx, network, address)
	if err != nil {
		return nil, err
	}
	tcpConnection, ok := connection.(*net.TCPConn)
	if !ok {
		return connection, nil
	}
	if err := tcpConnection.SetNoDelay(dialer.tcpNoDelay); err != nil {
		connection.Close()
		return nil, err
	}
	if err := tcpConnection.SetKeepAlive(dialer.keepAlive); err != nil {
		connection.Close()
		return nil, err
	}
	if dialer.keepAlive {
		if err := tcpConnection.SetKeepAlivePeriod(cassandraKeepAlivePeriod); err != nil {
			connection.Close()
			return nil, err
		}
	}
	return connection, nil
}
