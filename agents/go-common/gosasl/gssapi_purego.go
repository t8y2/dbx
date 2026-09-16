package gosasl

import (
	"errors"
	"fmt"

	gssapi "github.com/golang-auth/go-gssapi/v2"
	"github.com/golang-auth/go-gssapi/v2/common"
	"github.com/golang-auth/go-gssapi/v2/krb5"
)

type pureGoGSSAPIBackend struct {
	mechanism gssapi.Mech
}

func newPureGoGSSAPIBackend(options GSSAPIOptions) (gssapiBackend, error) {
	mechanism := krb5.NewKrb5MechWithOptions(krb5.ClientOptions{
		ConfigPath:      options.ConfigPath,
		CCachePath:      options.CCachePath,
		KeytabPath:      options.KeytabPath,
		Principal:       options.Principal,
		Password:        options.Password,
		UseCCache:       options.UseCCache,
		UseKeytab:       options.UseKeytab,
		DisablePAFXFAST: options.DisablePAFXFAST,
	})
	if mechanism == nil {
		return nil, errors.New("pure Go Kerberos GSSAPI mechanism is not registered")
	}
	return &pureGoGSSAPIBackend{mechanism: mechanism}, nil
}

func (backend *pureGoGSSAPIBackend) Initiate(serviceName string, channelBinding []byte) error {
	flags := gssapi.ContextFlagMutual |
		gssapi.ContextFlagReplay |
		gssapi.ContextFlagSequence |
		gssapi.ContextFlagInteg |
		gssapi.ContextFlagConf
	var binding *common.ChannelBinding
	if len(channelBinding) > 0 {
		binding = &common.ChannelBinding{Data: append([]byte(nil), channelBinding...)}
	}
	return backend.mechanism.Initiate(serviceName, flags, binding)
}

func (backend *pureGoGSSAPIBackend) Continue(token []byte) ([]byte, error) {
	return backend.mechanism.Continue(token)
}

func (backend *pureGoGSSAPIBackend) IsEstablished() bool {
	return backend.mechanism.IsEstablished()
}

func (backend *pureGoGSSAPIBackend) InitiatorName() string {
	if named, ok := backend.mechanism.(interface{ InitiatorName() string }); ok {
		return named.InitiatorName()
	}
	return ""
}

func (backend *pureGoGSSAPIBackend) SupportsIntegrity() bool {
	return backend.mechanism.ContextFlags()&gssapi.ContextFlagInteg != 0
}

func (backend *pureGoGSSAPIBackend) SupportsConfidentiality() bool {
	return backend.mechanism.ContextFlags()&gssapi.ContextFlagConf != 0
}

func (backend *pureGoGSSAPIBackend) Wrap(payload []byte, confidentiality bool) ([]byte, error) {
	return backend.mechanism.Wrap(payload, confidentiality)
}

func (backend *pureGoGSSAPIBackend) Unwrap(token []byte) ([]byte, error) {
	payload, _, err := backend.mechanism.Unwrap(token)
	return payload, err
}

func (backend *pureGoGSSAPIBackend) Dispose() error {
	disposable, ok := backend.mechanism.(interface{ Dispose() })
	if !ok {
		return nil
	}
	disposable.Dispose()
	return nil
}

func (backend *pureGoGSSAPIBackend) String() string {
	return fmt.Sprintf("pure-go-gssapi(%T)", backend.mechanism)
}
