//go:build windows

package gosasl

import (
	"os"
	"strings"

	"github.com/alexbrainman/sspi"
	"github.com/alexbrainman/sspi/kerberos"
)

const sspiQOPWrapNoEncrypt uint32 = 0x80000001

type sspiGSSAPIBackend struct {
	credentials *sspi.Credentials
	context     *kerberos.ClientContext
	established bool
	initial     []byte
	sendSeq     uint32
	receiveSeq  uint32
	principal   string
}

func newPlatformGSSAPIBackend() (gssapiBackend, error) {
	return newPlatformGSSAPIBackendWithOptions(gssapiOptionsFromEnvironment())
}

func newPlatformGSSAPIBackendWithOptions(options GSSAPIOptions) (gssapiBackend, error) {
	if !options.UseSSPI {
		return newPureGoGSSAPIBackend(options)
	}
	credentials, err := kerberos.AcquireCurrentUserCredentials()
	if err != nil {
		return nil, err
	}
	return &sspiGSSAPIBackend{credentials: credentials, principal: strings.TrimSpace(options.Principal)}, nil
}

func (backend *sspiGSSAPIBackend) Initiate(serviceName string, channelBinding []byte) error {
	flags := uint32(sspi.ISC_REQ_CONNECTION |
		sspi.ISC_REQ_MUTUAL_AUTH |
		sspi.ISC_REQ_REPLAY_DETECT |
		sspi.ISC_REQ_SEQUENCE_DETECT |
		sspi.ISC_REQ_INTEGRITY |
		sspi.ISC_REQ_CONFIDENTIALITY)
	context, established, token, err := kerberos.NewClientContextWithChannelBindings(
		backend.credentials,
		serviceName,
		flags,
		append([]byte(nil), channelBinding...),
	)
	if err != nil {
		return err
	}
	backend.context = context
	backend.established = established
	backend.initial = token
	return nil
}

func (backend *sspiGSSAPIBackend) Continue(token []byte) ([]byte, error) {
	if backend.context == nil {
		return nil, os.ErrInvalid
	}
	if backend.initial != nil {
		initial := backend.initial
		backend.initial = nil
		return initial, nil
	}
	if backend.established {
		return nil, nil
	}
	established, output, err := backend.context.Update(token)
	if err != nil {
		return nil, err
	}
	backend.established = established
	return output, nil
}

func (backend *sspiGSSAPIBackend) IsEstablished() bool {
	return backend.established
}

func (backend *sspiGSSAPIBackend) InitiatorName() string {
	return backend.principal
}

func (backend *sspiGSSAPIBackend) SupportsIntegrity() bool {
	return backend.context != nil && backend.context.VerifySelectiveFlags(sspi.ISC_REQ_INTEGRITY) == nil
}

func (backend *sspiGSSAPIBackend) SupportsConfidentiality() bool {
	return backend.context != nil && backend.context.VerifySelectiveFlags(sspi.ISC_REQ_CONFIDENTIALITY) == nil
}

func (backend *sspiGSSAPIBackend) Wrap(payload []byte, confidentiality bool) ([]byte, error) {
	qop := uint32(0)
	if !confidentiality {
		qop = sspiQOPWrapNoEncrypt
	}
	token, err := backend.context.EncryptMessage(append([]byte(nil), payload...), qop, backend.sendSeq)
	if err == nil {
		backend.sendSeq++
	}
	return token, err
}

func (backend *sspiGSSAPIBackend) Unwrap(token []byte) ([]byte, error) {
	_, payload, err := backend.context.DecryptMessage(append([]byte(nil), token...), backend.receiveSeq)
	if err == nil {
		backend.receiveSeq++
	}
	return payload, err
}

func (backend *sspiGSSAPIBackend) Dispose() error {
	var firstErr error
	if backend.context != nil {
		firstErr = backend.context.Release()
		backend.context = nil
	}
	if backend.credentials != nil {
		if err := backend.credentials.Release(); firstErr == nil {
			firstErr = err
		}
		backend.credentials = nil
	}
	backend.initial = nil
	return firstErr
}
