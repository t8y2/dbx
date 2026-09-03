/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package client

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/apache/thrift/lib/go/thrift"
)

// TLSConfig enables TLS for an IoTDB client connection. Set CertFile and
// KeyFile together to enable mTLS client authentication.
type TLSConfig struct {
	// Config is an optional base tls.Config. It is cloned before use.
	Config *tls.Config

	// CAFile is an optional PEM encoded CA certificate file used to verify the server.
	CAFile string

	// CertFile and KeyFile are optional PEM encoded client certificate and key files for mTLS.
	CertFile string
	KeyFile  string
}

func newTransport(host string, port string, connectionTimeoutInMs int, tlsConfig *TLSConfig) (thrift.TTransport, error) {
	conf := &thrift.TConfiguration{
		ConnectTimeout: time.Duration(connectionTimeoutInMs) * time.Millisecond,
		MaxFrameSize:   thrift.DEFAULT_MAX_FRAME_SIZE,
	}
	hostPort := net.JoinHostPort(host, port)

	var base thrift.TTransport
	if tlsConfig == nil {
		base = thrift.NewTSocketConf(hostPort, conf)
	} else {
		cfg, err := buildTLSConfig(tlsConfig)
		if err != nil {
			return nil, err
		}
		conf.TLSConfig = cfg
		base = thrift.NewTSSLSocketConf(hostPort, conf)
	}

	return thrift.NewTFramedTransportConf(base, conf), nil
}

func buildTLSConfig(config *TLSConfig) (*tls.Config, error) {
	if config == nil {
		return nil, nil
	}

	tlsConfig := &tls.Config{}
	if config.Config != nil {
		tlsConfig = config.Config.Clone()
	}
	if config.CAFile != "" {
		rootCAs, err := loadCertPool(tlsConfig.RootCAs, config.CAFile)
		if err != nil {
			return nil, err
		}
		tlsConfig.RootCAs = rootCAs
	}
	if config.CertFile != "" || config.KeyFile != "" {
		if config.CertFile == "" || config.KeyFile == "" {
			return nil, fmt.Errorf("both TLS CertFile and KeyFile must be set")
		}
		certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("load TLS client certificate/key: %w", err)
		}
		tlsConfig.Certificates = append(tlsConfig.Certificates, certificate)
	}

	return tlsConfig, nil
}

func loadCertPool(base *x509.CertPool, caFile string) (*x509.CertPool, error) {
	rootCAs := base
	if rootCAs != nil {
		rootCAs = rootCAs.Clone()
	} else {
		systemPool, err := x509.SystemCertPool()
		if err == nil && systemPool != nil {
			rootCAs = systemPool
		} else {
			rootCAs = x509.NewCertPool()
		}
	}

	caCert, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read TLS CA file %q: %w", caFile, err)
	}
	if !rootCAs.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("append TLS CA file %q: no certificates found", caFile)
	}
	return rootCAs, nil
}
