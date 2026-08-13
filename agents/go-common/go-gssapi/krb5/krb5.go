// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

/*
Package krb5 provides the pure-Go implementation of the GSS-API interface
Kerberos mechanism (RFC 4121).

Normally, this package would be imported by application code (eg. in its
main package) in order to register the Kerberos V mechanism.  Application
code that uses GSS-API would import the generic github.com/golang-auth/go-gssapi/v2
package instead and obtain a handle to this mechanism from the registry by
passing the name "kerberos_v5" or the OID "1.2.840.113554.1.2.2", eg :

# Main Package

A relatively high-level package should include the mechanisms that the
application is to use.  The idea is that the mechanisms that are supported
in an application can be managed in one place, without changing any of
the lower level code that uses the GSS-API functionality:

	 package main
	 import (
		 _ "github.com/golang-auth/go-gssapi/v2/krb5"
		 "stuff"
	 )

	 stuff.doStuff("kerberos_v5")

# Implementation package

The package that uses GSS-API should accept the name of the mechanism to
use, and use that name to obtain an instance of that mechanism-specific
implementation:

	package stuff
	import "github.com/golang-auth/go-gssapi/v2"

	func doStuff(mech) {
		ctx := gssapi.NewMech(mech)
	   ...
	}

# See Also

github.com/golang-auth/go-gssapi/v2
*/
package krb5

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/crypto/etype"
	"github.com/jcmturner/gokrb5/iana/etypeID"
	"github.com/jcmturner/gokrb5/v8/client"
	"github.com/jcmturner/gokrb5/v8/config"
	"github.com/jcmturner/gokrb5/v8/credentials"
	"github.com/jcmturner/gokrb5/v8/crypto"
	"github.com/jcmturner/gokrb5/v8/iana/chksumtype"
	ianaerrcode "github.com/jcmturner/gokrb5/v8/iana/errorcode"
	ianaflags "github.com/jcmturner/gokrb5/v8/iana/flags"
	"github.com/jcmturner/gokrb5/v8/keytab"
	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/types"

	"github.com/golang-auth/go-gssapi/v2"
	"github.com/golang-auth/go-gssapi/v2/common"
)

func init() {
	gssapi.Register("kerberos_v5", NewKrb5Mech)
	gssapi.Register("1.2.840.113554.1.2.2}", NewKrb5Mech)
}

// ClockSkew defines the maximum tolerable difference between the two peers
// of a GSS-API context, and defaults to 10 seconds.  Increase this number if
// there is poor syncronisation between client and server nodes.  Decrease
// the value to enhance security where there is good synchronisation.
var ClockSkew = time.Second * 10

type acceptorISN int

// These constants define how the Acceptor initial sequence number is derived
// when the context does not use mutual authentication.  In this case, the
// Acceptor does not have the opportunity to communicate its own sequence number
// to the Initiator.  Two different schemes are in use:
//
// 1.  Acceptor uses the Initiator's initial sequence number
//
// 2.  The Acceptor ISN is zero
//
// The default is (1), but may be changed to (2) by setting AcceptorISN to
// the value DefaultAcceptorISNZero.
const (
	// DefaultAcceptorISNInitiator is the acceptor ISN policy that uses the Initiator's initial sequence number
	// as the Acceptor ISN when not performing mutual authentication.  Use this for compatibility with MIT.
	DefaultAcceptorISNInitiator acceptorISN = iota

	// DefaultAcceptorISNZero is the acceptor ISN policy that uses zero as the Acceptor ISN when not
	// performing mutual authentication.  Use this for compatibility with Heimdal.
	DefaultAcceptorISNZero
)

// AcceptorISN holds the default Acceptor-Initial-Sequence derivation policy
// for contexts not using mutual authentication.  The default provides
// compatibility with MIT Kerberos.
// Set this to DefaultAcceptorISNZero for compatibility with Heimdal Kerberos.
var AcceptorISN acceptorISN = DefaultAcceptorISNInitiator

// krb5Mech is the implementation of the Mech interface for the
// Kerberos V mechanism
type Krb5Mech struct {
	krbClient           *client.Client
	isInitiator         bool
	isEstablished       bool
	waitingForMutual    bool
	service             string
	channelBinding      *common.ChannelBinding
	ticket              *messages.Ticket
	sessionKey          *types.EncryptionKey
	clientCTime         time.Time
	clientCusec         int
	sessionFlags        gssapi.ContextFlag
	requestFlags        gssapi.ContextFlag
	ourSequenceNumber   uint64
	theirSequenceNumber uint64
	initiatorSubKey     *types.EncryptionKey
	acceptorSubKey      *types.EncryptionKey
	peerName            string
	clientOptions       *ClientOptions
}

// ClientOptions configures initiator credentials without relying on process
// environment variables.
type ClientOptions struct {
	ConfigPath      string
	CCachePath      string
	KeytabPath      string
	Principal       string
	Password        string
	UseCCache       bool
	UseKeytab       bool
	DisablePAFXFAST bool
}

// NewMech returns a new Kerberos V mechanism context.  This function is
// registered with the GSS-API registry and is used by gssapi.NewMech()
// when a caller requests an instance of the "kerberos_v5" mechanism.
func NewKrb5Mech() gssapi.Mech {
	return &Krb5Mech{}
}

// NewKrb5MechWithOptions returns a Kerberos mechanism with connection-scoped
// credential configuration.
func NewKrb5MechWithOptions(options ClientOptions) gssapi.Mech {
	copy := options
	return &Krb5Mech{clientOptions: &copy}
}

func oID() asn1.ObjectIdentifier {
	return asn1.ObjectIdentifier{1, 2, 840, 113554, 1, 2, 2}
}

// IsEstablished returns false until the Krb5Mech context has been negotiated
// and the context is ready to use for exchanging messages.
func (m Krb5Mech) IsEstablished() bool {
	return m.isEstablished
}

// ContextFlags returns the subset of requested context flags that are available
// and may change during establishmane of the context.  The Initiator and
// Acceptor should examine the flags before using the context for message
// exchange, to verify that the state of the context matches the appliation
// security requirements.
func (m Krb5Mech) ContextFlags() (f gssapi.ContextFlag) {
	return m.sessionFlags
}

// SSF returns the Security Strength Factor of the channel established
// by the security context.  For Kerberos V, this depends on the type of
// key being used to secure the channel.
func (m Krb5Mech) SSF() uint {
	var key types.EncryptionKey
	switch {
	case m.acceptorSubKey != nil:
		key = *m.acceptorSubKey
	case m.initiatorSubKey != nil:
		key = *m.initiatorSubKey
	default:
		key = *m.sessionKey
	}

	return keySSF(key.KeyType)
}

// From MIT Kerberos 1.16 (src/lib/gssapi/krb5/wrap_size_limit.c)
func (m Krb5Mech) WrapSizeLimit(requestedOutputSize uint32, confidentiality bool) uint32 {
	var keyType int32
	switch {
	case m.acceptorSubKey != nil:
		keyType = m.acceptorSubKey.KeyType
	case m.initiatorSubKey != nil:
		keyType = m.initiatorSubKey.KeyType
	default:
		keyType = m.sessionKey.KeyType
	}

	sz := requestedOutputSize

	if confidentiality {
		// try decreasing message lengths until the encrypted length including the
		// header will fit the requested size
		for sz > 0 {
			wrapSize := 16 + encryptedLength(keyType, sz)
			if wrapSize <= requestedOutputSize {
				break
			}

			sz--
		}

		// account for the header
		if sz > 16 {
			sz -= 16
		} else {
			sz = 0
		}
	} else {
		key, _ := crypto.GetEtype(keyType)
		cksumSize := key.GetHMACBitLength() / 8

		if sz < uint32(16+cksumSize) {
			sz = 0
		} else {
			sz -= uint32(16 + cksumSize)
		}
	}

	return sz
}

// Accept is used by a GSS-API Acceptor to begin context
// negotiation with a remote Initiator.
//
// If provided, serviceName is the name of a service principal
// to use from the keytab.  If not supplied, any principal in the
// keytab matching the request will be used.
//
// See: RFC 4121 § 4.1
func (m *Krb5Mech) Accept(serviceName string) (err error) {
	m.isEstablished = false
	m.waitingForMutual = false
	m.isInitiator = false
	m.service = serviceName

	// Stash the subset of the request flags that we can support, except mutual
	// which we won't know about until we receive a token
	m.sessionFlags = gssapi.ContextFlagConf | gssapi.ContextFlagInteg |
		gssapi.ContextFlagReplay | gssapi.ContextFlagSequence

	return
}

// Initiate is used by a GSS-API Initiator to start the
// context negotiation process with a remote Acceptor.
//
// serverName is the name of the service principal to use when
// obtaining a Kerberos ticket.
//
// flags represent the desired security properties of the context
//
// cb is the channel binding data, or nil to disable
//
// It is highly recommended to make use of mutual authentication wherever
// possible and to include replay detection:
//
//	gssapi.ContextFlagMutual | gssapi.ContextFlagInteg  |gssapi.ContextFlagReplay
//
// Most users should also include gssapi.ContextFlagConf to enable the use
// of message sealing.
func (m *Krb5Mech) Initiate(serviceName string, requestFlags gssapi.ContextFlag, cb *common.ChannelBinding) (err error) {
	m.isEstablished = false
	m.waitingForMutual = false
	m.isInitiator = true
	m.channelBinding = cb

	// Obtain a Kerberos ticket for the service
	if err = m.krbClientInit(serviceName); err != nil {
		return
	}

	// Stash the subset of the request flags that we can support minus mutual until that completes
	m.sessionFlags = gssapi.ContextFlagConf | gssapi.ContextFlagInteg |
		gssapi.ContextFlagReplay | gssapi.ContextFlagSequence

	// requuest flags is the subset that we support of the requested flags, used in the context
	// negotiation.  The set we will tell the caller that we actually support is the above,
	// sessionFlags which may include more than the requested set
	m.requestFlags = requestFlags & (gssapi.ContextFlagConf | gssapi.ContextFlagInteg |
		gssapi.ContextFlagMutual | gssapi.ContextFlagReplay | gssapi.ContextFlagSequence)

	return
}

// Continue is called in a loop by Initiators and Acceptors after
// first calling one of Initiate or Accept.
//
// tokenIn represents a token received from the peer
// If tokenOut is non-zero, it should be send to the peer
// The caller should check the result of m.IsEstablished() to determine
// then the loop should end.
func (m *Krb5Mech) Continue(tokenIn []byte) (tokenOut []byte, err error) {
	if m.isEstablished {
		err = nil
		return
	}

	if m.isInitiator {
		return m.continueInitiator(tokenIn)
	} else {
		return m.continueAcceptor(tokenIn)
	}
}

func (m *Krb5Mech) continueInitiator(tokenIn []byte) (tokenOut []byte, err error) {
	// first time, create the first context-establishment token
	//
	if len(tokenIn) == 0 {
		// Create a Kerberos AP-REQ message with GSSAPI checksum
		var apreq messages.APReq
		apreq, err = m.getAPReqMessage()
		if err != nil {
			return
		}

		// Create the GSSAPI token
		tb, _ := hex.DecodeString(tokenIDKrbAPReq)
		gssToken := kRB5Token{
			oID:   oID(),
			tokID: tb,
			aPReq: &apreq,
		}

		tokenOut, err = gssToken.marshal()
		if err != nil {
			err = fmt.Errorf("gssapi: %s", err)
			return
		}

		// we need another round if we're doing mutual auth - we will receive an AP-REP from the server
		if m.requestFlags&gssapi.ContextFlagMutual == 0 {
			m.isEstablished = true

			// if there is no mutual auth, we can't tell the client what our initial sequence number is
			// MIT and Microsoft use the client's ISN so let's do that, unless we're in Heimdal mode
			// see https://bugs.openjdk.java.net/browse/JDK-8201814
			switch AcceptorISN {
			case DefaultAcceptorISNInitiator:
				m.theirSequenceNumber = m.ourSequenceNumber
			case DefaultAcceptorISNZero:
				m.theirSequenceNumber = 0
			default:
				err = fmt.Errorf("gssapi: unknown acceptor-initial-sequence-number policy configured")
				return
			}
		} else {
			m.waitingForMutual = true
		}

		return
	}

	// called again due to a previous ContinueNeeded result ?..
	if !m.waitingForMutual {
		err = fmt.Errorf("gssapi: context is not ready, call Start to initialize a new context")
		return
	}

	// unmarshal the GSSAPI token
	gssToken := kRB5Token{}
	if err = gssToken.unmarshal(tokenIn); err != nil {
		return
	}

	if gssToken.kRBError != nil {
		err = fmt.Errorf("gssapi: %s", gssToken.kRBError.Error())
		return
	}

	if gssToken.aPRep == nil {
		err = errors.New("gssapi: GSSAPI token does not contain AP-REP message")
		return
	}

	// decrypt/verify the private part of the AP-REP message
	msg, err := gssToken.aPRep.decryptEncPart(*m.sessionKey)
	if err != nil {
		err = fmt.Errorf("gssapi: %s", err)
		return
	}

	// stash their sequence number and subkey for use in GSS Wrap/Unwrap
	m.theirSequenceNumber = uint64(msg.SequenceNumber)
	if msg.Subkey.KeyType != 0 {
		m.acceptorSubKey = &msg.Subkey
	}

	// check the response has the same time values as the request
	// Note - we can't use time.Equal() as m.clientCTime has a monotomic clock value and
	// which causes the equality to fail
	if !(msg.CTime.Unix() == m.clientCTime.Unix() && msg.Cusec == m.clientCusec) {
		err = fmt.Errorf("gssapi: mutual authentication failed")
		return
	}

	// we're done!
	m.isEstablished = true
	m.waitingForMutual = false
	m.sessionFlags |= gssapi.ContextFlagMutual

	return tokenOut, nil
}

func (m *Krb5Mech) continueAcceptor(tokenIn []byte) (tokenOut []byte, err error) {
	// try to unmarshal the token
	gssInToken := kRB5Token{}
	if err = gssInToken.unmarshal(tokenIn); err != nil {
		return
	}

	if gssInToken.kRBError != nil {
		err = fmt.Errorf("gssapi: %s", gssInToken.kRBError.Error())
		return
	}

	// RFC says: must return a KRBError message to the client if the token ID was invalid
	// Note sure other implementatios really do this
	if gssInToken.kRBError == nil && gssInToken.aPReq == nil && gssInToken.aPRep == nil {
		tokenOut, err = mkGssErrKrbCode(ianaerrcode.KRB_AP_ERR_MSG_TYPE, "gss accept failed")
		return
	}

	// avoid crash if GSSAPI token isn't an initial token
	if gssInToken.aPReq == nil {
		err = errors.New("gssapi: GSSAPI token does not contain AP-REQ message")
		return
	}

	ktFile := krbKtFile()

	err, krbErr := verifyAPReq(ktFile, gssInToken.aPReq, ClockSkew)
	if err != nil {
		tokenOut, err = mkGssErrFromKrbErr(krbErr.(messages.KRBError))
		return
	}

	// stash the sequence number for use in GSS Wrap
	// Authenticator.SeqNumber is actually a 32 bit number (in the protocol), so the cast here is safe
	m.theirSequenceNumber = uint64(gssInToken.aPReq.Authenticator.SeqNumber)

	// stash the APReq time flags for use in mutual authentication
	m.clientCTime = gssInToken.aPReq.Authenticator.CTime
	m.clientCusec = gssInToken.aPReq.Authenticator.Cusec

	// stash the session key and ticket
	m.ticket = &gssInToken.aPReq.Ticket
	m.sessionKey = &gssInToken.aPReq.Ticket.DecryptedEncPart.Key

	// stash the initiator subkey if there is one
	if gssInToken.aPReq.Authenticator.SubKey.KeyType != 0 {
		m.initiatorSubKey = &gssInToken.aPReq.Authenticator.SubKey
	}

	// get the context-establishment flags from the authenticator
	requestedFlags := binary.LittleEndian.Uint32(gssInToken.aPReq.Authenticator.Cksum.Checksum[20:24])
	m.sessionFlags &= gssapi.ContextFlag(requestedFlags)

	// stash the client's principal name
	m.peerName = fmt.Sprintf("%s@%s",
		gssInToken.aPReq.Ticket.DecryptedEncPart.CName.PrincipalNameString(),
		gssInToken.aPReq.Ticket.DecryptedEncPart.CRealm)

	// if the client requested mutual authentication, send them an AP-REP message
	if types.IsFlagSet(&gssInToken.aPReq.APOptions, ianaflags.APOptionMutualRequired) {
		tb, _ := hex.DecodeString(tokenIDKrbAPRep)
		gssOutToken := kRB5Token{
			oID:   oID(),
			tokID: tb,
		}

		var aprep aPRep
		aprep, err = m.getAPRepMessage()
		if err != nil {
			return
		}
		gssOutToken.aPRep = &aprep

		tokenOut, err = gssOutToken.marshal()
		if err != nil {
			return
		}

		m.sessionFlags |= gssapi.ContextFlagMutual
	} else {
		// if there is no mutual auth, we can't tell the client what our initial sequence number is
		// MIT and Microsoft use the client's ISN so let's do that, unless we're in Heimdal mode
		// see https://bugs.openjdk.java.net/browse/JDK-8201814
		switch AcceptorISN {
		case DefaultAcceptorISNInitiator:
			m.ourSequenceNumber = m.theirSequenceNumber
		case DefaultAcceptorISNZero:
			m.ourSequenceNumber = 0
		default:
			err = fmt.Errorf("gssapi: unknown acceptor-initial-sequence-number policy configured")
			return
		}
	}

	// we're done from an acceptor perspective
	m.isEstablished = true
	return tokenOut, nil
}

// PeerName returns the name of the remote peer's Kerberos principal
func (m *Krb5Mech) PeerName() string {
	return m.peerName
}

// InitiatorName returns the authenticated initiator principal.
func (m *Krb5Mech) InitiatorName() string {
	if m.krbClient == nil || m.krbClient.Credentials == nil {
		return ""
	}
	username := m.krbClient.Credentials.UserName()
	realm := m.krbClient.Credentials.Domain()
	if username == "" || realm == "" {
		return username
	}
	return username + "@" + realm
}

// Dispose clears the Kerberos client and session state held by the mechanism.
func (m *Krb5Mech) Dispose() {
	if m.krbClient != nil {
		m.krbClient.Destroy()
	}
	m.krbClient = nil
	m.ticket = nil
	m.sessionKey = nil
	m.initiatorSubKey = nil
	m.acceptorSubKey = nil
	m.isEstablished = false
}

// Wrap encapsulates the payload in a GSS-API Wap oken that can be passed to the
// remote peer.  The payload is sealed if confidentiality is requested, and
// signed if not.  Note that the use of confidentially requires the
// gssapi.ContextFlagMutual flag to be enabled on the context.
func (m *Krb5Mech) Wrap(tokenIn []byte, confidentiality bool) (tokenOut []byte, err error) {
	wt, err := m.newWrapToken(tokenIn, confidentiality)
	if err != nil {
		return
	}

	tokenOut, err = wt.Marshal()
	return
}

// Unwrap is used to parse a token created with Wrap().  It returns the original
// payload after unsealing or verification of the signature.  isSealed can be
// inspected to determine whether the payload was encrypted or only signed.
func (m *Krb5Mech) Unwrap(tokenIn []byte) (tokenOut []byte, isSealed bool, err error) {
	// Unmarshall the token
	wt := wrapToken{}
	if err = wt.Unmarshal(tokenIn); err != nil {
		err = fmt.Errorf("gssapi: %s", err)
		return
	}

	var key types.EncryptionKey
	switch {
	case wt.Flags&gSSMessageTokenFlagAcceptorSubkey != 0:
		if m.acceptorSubKey == nil {
			err = errors.New("gssapi: acceptor subkey not negotiated, cannot unwrap message")
			return
		}

		key = *m.acceptorSubKey
	case m.initiatorSubKey != nil:
		key = *m.initiatorSubKey
	default:
		key = *m.sessionKey
	}

	// Verify the token's integrity and get the unsealed / unsigned payload
	if isSealed, err = wt.VerifyAndDecode(key, m.isInitiator); err != nil {
		err = fmt.Errorf("gssapi: %s", err)
		return
	}

	// Check the sequence number
	if m.sessionFlags&gssapi.ContextFlagReplay != 0 || m.sessionFlags&gssapi.ContextFlagSequence != 0 {
		if wt.SequenceNumber != m.theirSequenceNumber {
			err = fmt.Errorf("gssapi: bad sequence number from peer, got %d, wanted %d", wt.SequenceNumber, m.theirSequenceNumber)
			return
		}
	}
	m.theirSequenceNumber++

	tokenOut = wt.Payload
	return tokenOut, isSealed, nil
}

// MakeSignature creates a GSS-API MIC token, containing the signature of
// payload but not encapsulating any payload.  The MIC token is passed to the
// peer separately to the payload and can be used by the peer to verify
// the integrity of that payload.
func (m *Krb5Mech) MakeSignature(payload []byte) (tokenOut []byte, err error) {
	var flags gSSMessageTokenFlag

	if !m.isInitiator {
		flags |= gSSMessageTokenFlagSentByAcceptor // send by acceptor
	}

	// use the acceptor subkey if it was negotiated during auth
	key := m.sessionKey
	switch {
	case m.acceptorSubKey != nil:
		key = m.acceptorSubKey
		flags |= gSSMessageTokenFlagAcceptorSubkey
	case m.initiatorSubKey != nil:
		key = m.initiatorSubKey
	}

	mt := mICToken{
		Flags:          flags,
		SequenceNumber: m.ourSequenceNumber,
	}

	if err = mt.Sign(payload, *key); err != nil {
		return
	}

	tokenOut, err = mt.Marshal()
	return
}

// VerifySignature checks the cryptographic signature created by a call
// to MakeSignature() on the supplied payload.
func (m *Krb5Mech) VerifySignature(payload []byte, tokenIn []byte) (err error) {
	mt := mICToken{}
	if err = mt.Unmarshal(tokenIn); err != nil {
		return
	}

	var key types.EncryptionKey
	switch {
	case mt.Flags&gSSMessageTokenFlagAcceptorSubkey != 0:
		if m.acceptorSubKey == nil {
			err = errors.New("gssapi: acceptor subkey not negotiated, cannot verify MIC")
			return
		}

		key = *m.acceptorSubKey
	case m.initiatorSubKey != nil:
		key = *m.initiatorSubKey
	default:
		key = *m.sessionKey
	}

	if err = mt.Verify(payload, key, m.isInitiator); err != nil {
		return
	}

	// Check the sequence number
	if m.sessionFlags&gssapi.ContextFlagReplay != 0 || m.sessionFlags&gssapi.ContextFlagSequence != 0 {
		if mt.SequenceNumber != m.theirSequenceNumber {
			err = fmt.Errorf("gssapi: bad sequence number from peer, got %d, wanted %d", mt.SequenceNumber, m.theirSequenceNumber)
			return
		}
	}
	m.theirSequenceNumber++

	return nil
}

func (m *Krb5Mech) getAPReqMessage() (apreq messages.APReq, err error) {
	auth, err := types.NewAuthenticator(m.krbClient.Credentials.Domain(), m.krbClient.Credentials.CName())
	if err != nil {
		err = fmt.Errorf("gssapi: generating new authenticator: %s", err)
		return
	}

	// MIT compatibility
	auth.SeqNumber &= 0x3fffffff

	auth.Cksum = types.Checksum{
		CksumType: chksumtype.GSSAPI,
		Checksum:  newAuthenticatorChksum(m.requestFlags, m.channelBinding),
	}

	apreq, err = messages.NewAPReq(*m.ticket, *m.sessionKey, auth)
	if err != nil {
		err = fmt.Errorf("gssapi: %s", err)
		return
	}

	// set the Kerberos APREQ MUTUAL-REQUIRED option if we've been asked to perform mutual auth
	if m.requestFlags&gssapi.ContextFlagMutual != 0 {
		types.SetFlag(&apreq.APOptions, ianaflags.APOptionMutualRequired)
	}

	// stash the sequence number for use in GSS Wrap
	// Authenticator.SeqNumber is actually a 32 bit number (in the protocol), so the cast here is safe
	m.ourSequenceNumber = uint64(auth.SeqNumber)

	// stash the APReq time flags for use in mutual authentication
	m.clientCTime = auth.CTime
	m.clientCusec = auth.Cusec

	return apreq, err
}

func (m *Krb5Mech) getAPRepMessage() (aprep aPRep, err error) {
	seq, err := rand.Int(rand.Reader, big.NewInt(math.MaxUint32))
	if err != nil {
		return
	}

	/*
	 * Work around implementation incompatibilities by not generating
	 * initial sequence numbers greater than 2^30.  Previous MIT
	 * implementations use signed sequence numbers, so initial
	 * sequence numbers 2^31 to 2^32-1 inclusive will be rejected.
	 * Letting the maximum initial sequence number be 2^30-1 allows
	 * for about 2^30 messages to be sent before wrapping into
	 * "negative" numbers.
	 */
	seqNum := seq.Int64() & 0x3fffffff

	encPart := encAPRepPart{
		CTime:          m.clientCTime, // copied from the APReq
		Cusec:          m.clientCusec,
		SequenceNumber: seqNum,
	}

	aprep, err = newAPRep(*m.ticket, *m.sessionKey, encPart)
	if err != nil {
		err = fmt.Errorf("gssapi: %s", err)
		return
	}

	m.ourSequenceNumber = uint64(seqNum)
	return aprep, err
}

func (m *Krb5Mech) krbClientInit(service string) (err error) {
	options := clientOptionsFromEnvironment()
	if m.clientOptions != nil {
		options = *m.clientOptions
	}
	cfgFile := normalizedKerberosPath(options.ConfigPath)
	if cfgFile == "" {
		cfgFile = defaultKrbConfFile()
	}
	cfg, err := config.Load(cfgFile)
	if err != nil {
		return fmt.Errorf("gssapi: loading krb5.conf: %w", err)
	}
	m.krbClient, err = newInitiatorClient(cfg, options)
	if err != nil {
		return err
	}

	ticketService := configureServiceRealm(cfg, service)
	tkt, key, err := m.krbClient.GetServiceTicket(ticketService)
	if err != nil {
		return fmt.Errorf("gssapi: getting service ticket for '%s': %s", service, err)
	}
	m.ticket, m.sessionKey, m.service = &tkt, &key, service
	m.peerName = fmt.Sprintf("%s@%s", tkt.SName.PrincipalNameString(), tkt.Realm)

	return nil
}

func configureServiceRealm(cfg *config.Config, service string) string {
	principal, realm := types.ParseSPNString(strings.TrimSpace(service))
	if realm != "" && len(principal.NameString) > 0 {
		host := strings.ToLower(strings.TrimSpace(principal.NameString[len(principal.NameString)-1]))
		if host != "" {
			cfg.DomainRealm[host] = realm
		}
	}
	return principal.PrincipalNameString()
}

func newInitiatorClient(cfg *config.Config, options ClientOptions) (*client.Client, error) {
	settings := []func(*client.Settings){
		client.DisablePAFXFAST(options.DisablePAFXFAST),
	}
	useCCache := options.UseCCache || strings.TrimSpace(options.CCachePath) != ""
	useKeytab := options.UseKeytab || strings.TrimSpace(options.KeytabPath) != ""
	principal := strings.TrimSpace(options.Principal)
	password := options.Password

	if useCCache {
		ccachePath := normalizedKerberosPath(options.CCachePath)
		if ccachePath == "" {
			ccachePath = defaultKrbCCFile()
		}
		if ccachePath == "" {
			return nil, errors.New("gssapi: credential cache path is empty")
		}
		ccache, err := credentials.LoadCCache(ccachePath)
		if err != nil {
			return nil, fmt.Errorf("gssapi: loading credentials cache: %w", err)
		}
		value, err := client.NewFromCCache(ccache, cfg, settings...)
		if err != nil {
			return nil, fmt.Errorf("gssapi: creating krb5 client from credentials cache: %w", err)
		}
		if err := value.AffirmLogin(); err != nil {
			return nil, fmt.Errorf("gssapi: checking TGT: %w", err)
		}
		return value, nil
	}
	if useKeytab {
		keytabPath := normalizedKerberosPath(options.KeytabPath)
		if keytabPath == "" {
			keytabPath = defaultKrbKTFile()
		}
		if keytabPath == "" {
			return nil, errors.New("gssapi: keytab path is empty")
		}
		loadedKeytab, err := keytab.Load(keytabPath)
		if err != nil {
			return nil, fmt.Errorf("gssapi: loading keytab: %w", err)
		}
		if principal == "" {
			principal, err = principalFromKeytab(loadedKeytab)
			if err != nil {
				return nil, err
			}
		}
		username, realm, err := splitPrincipal(principal, cfg.LibDefaults.DefaultRealm)
		if err != nil {
			return nil, err
		}
		value := client.NewWithKeytab(username, realm, loadedKeytab, cfg, settings...)
		if err := value.Login(); err != nil {
			value.Destroy()
			return nil, fmt.Errorf("gssapi: logging in with keytab: %w", err)
		}
		return value, nil
	}
	if principal != "" && password != "" {
		username, realm, err := splitPrincipal(principal, cfg.LibDefaults.DefaultRealm)
		if err != nil {
			return nil, err
		}
		value := client.NewWithPassword(username, realm, password, cfg, settings...)
		if err := value.Login(); err != nil {
			value.Destroy()
			return nil, fmt.Errorf("gssapi: logging in with password: %w", err)
		}
		return value, nil
	}
	return nil, errors.New("gssapi: no credential cache, keytab, or principal and password configured")
}

func splitPrincipal(principal, defaultRealm string) (string, string, error) {
	principal = strings.TrimSpace(principal)
	separator := strings.LastIndexByte(principal, '@')
	if separator < 1 || separator == len(principal)-1 {
		if principal == "" || strings.TrimSpace(defaultRealm) == "" {
			return "", "", fmt.Errorf("gssapi: invalid Kerberos principal %q", principal)
		}
		return principal, strings.TrimSpace(defaultRealm), nil
	}
	return principal[:separator], principal[separator+1:], nil
}

func principalFromKeytab(value *keytab.Keytab) (string, error) {
	principals := map[string]bool{}
	for _, entry := range value.Entries {
		principals[entry.Principal.String()] = true
	}
	if len(principals) != 1 {
		return "", fmt.Errorf("gssapi: keytab contains %d principals; configure a client principal", len(principals))
	}
	for principal := range principals {
		return principal, nil
	}
	return "", errors.New("gssapi: keytab contains no principals")
}

func environmentBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func clientOptionsFromEnvironment() ClientOptions {
	return ClientOptions{
		ConfigPath:      os.Getenv("KRB5_CONFIG"),
		CCachePath:      os.Getenv("KRB5CCNAME"),
		KeytabPath:      firstEnvironmentValue("KRB5_CLIENT_KTNAME", "KRB5_KTNAME"),
		Principal:       os.Getenv("DBX_KRB5_PRINCIPAL"),
		Password:        os.Getenv("DBX_KRB5_PASSWORD"),
		UseCCache:       environmentBool("DBX_KRB5_USE_CCACHE"),
		UseKeytab:       environmentBool("DBX_KRB5_USE_KEYTAB"),
		DisablePAFXFAST: environmentBool("DBX_KRB5_DISABLE_PAFXFAST"),
	}
}

func firstEnvironmentValue(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func normalizedKerberosPath(value string) string {
	return strings.TrimPrefix(strings.TrimSpace(value), "FILE:")
}

func krbConfFile() string {
	cfgFile, ok := os.LookupEnv("KRB5_CONFIG")
	if !ok {
		cfgFile = defaultKrbConfFile()
	}

	return cfgFile
}

func krbCCFile() string {
	ccFile, ok := os.LookupEnv("KRB5CCNAME")
	if !ok {
		ccFile = defaultKrbCCFile()
	}

	return strings.TrimPrefix(ccFile, "FILE:")
}

func krbKtFile() string {
	ktFile, ok := os.LookupEnv("KRB5_CLIENT_KTNAME")
	if !ok {
		ktFile, ok = os.LookupEnv("KRB5_KTNAME")
	}
	if !ok {
		ktFile = defaultKrbKTFile()
	}

	return strings.TrimPrefix(ktFile, "FILE:")
}

func (m *Krb5Mech) newWrapToken(payload []byte, sealed bool) (token wrapToken, err error) {
	var flags gSSMessageTokenFlag

	if !m.isInitiator {
		flags |= gSSMessageTokenFlagSentByAcceptor // send by acceptor
	}
	if sealed {
		flags |= gSSMessageTokenFlagSealed // sealed
	}

	// use the acceptor subkey if it was negotiated during auth
	key := m.sessionKey
	switch {
	case m.acceptorSubKey != nil:
		key = m.acceptorSubKey
		flags |= gSSMessageTokenFlagAcceptorSubkey
	case m.initiatorSubKey != nil:
		key = m.initiatorSubKey
	}

	token = wrapToken{
		Flags:          flags,
		SequenceNumber: m.ourSequenceNumber,
		Payload:        payload,
	}

	// encrypt or sign the payload, see RFC 4121 § 4.2.4
	if sealed {
		err = token.Seal(*key)
	} else {
		err = token.Sign(*key)
	}

	if err == nil {
		m.ourSequenceNumber++ // only bump the sequence number if everything is good
	}

	return token, err
}

// must return useful Kerberos error codes here so we can respond appropriately to the client if necessary
// err is also returned for local use (eg. logging an I/O error etc)
//
// This validation routine does *NOT* currently check addresses;  the gokrb5 version in messages/APReq doesn't
// do this properly and in any case this behaviour should depend on the local kerberos configuration
func verifyAPReq(ktFile string, apreq *messages.APReq, skew time.Duration) (err error, krbError error) {
	kt, err := keytab.Load(ktFile)
	if err != nil {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_NOKEY, "no key for service")
		return
	}

	err = apreq.Ticket.DecryptEncPart(kt, &apreq.Ticket.SName)
	if _, ok := err.(messages.KRBError); ok {
		krbError = err
		return
	} else if err != nil {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_BAD_INTEGRITY, "could not decrypt ticket")
		return
	}

	// Check time validity of ticket
	ok, err := apreq.Ticket.Valid(skew)
	if err != nil || !ok {
		krbError = err
		return
	}

	// Decrypt authenticator with session key from ticket's encrypted part
	err = apreq.DecryptAuthenticator(apreq.Ticket.DecryptedEncPart.Key)
	if err != nil {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_BAD_INTEGRITY, "could not decrypt authenticator")
		return
	}

	// Check the authenticator checksum type
	if apreq.Authenticator.Cksum.CksumType != chksumtype.GSSAPI {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_BADMATCH, "wrong authenticator checksum type")
		return
	}
	if len(apreq.Authenticator.Cksum.Checksum) < 24 {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_BADMATCH, "authenticator checksum too short")
		return
	}

	// Check CName in authenticator is the same as that in the ticket
	if !apreq.Authenticator.CName.Equal(apreq.Ticket.DecryptedEncPart.CName) {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_BADMATCH, "CName in Authenticator does not match that in service ticket")
		return
	}

	// Check the clock skew between the client and the service server
	ct := apreq.Authenticator.CTime.Add(time.Duration(apreq.Authenticator.Cusec) * time.Microsecond)
	t := time.Now().UTC()
	if t.Sub(ct) > skew || ct.Sub(t) > skew {
		krbError = messages.NewKRBError(apreq.Ticket.SName, apreq.Ticket.Realm, ianaerrcode.KRB_AP_ERR_SKEW, fmt.Sprintf("clock skew with client too large. greater than %v seconds", skew))
		return
	}

	return nil, nil
}

func mkGssErrKrbCode(code int32, message string) (token []byte, err error) {
	ke := messages.NewKRBError(types.PrincipalName{}, "", code, message)
	return mkGssErrFromKrbErr(ke)
}

func mkGssErrFromKrbErr(ke messages.KRBError) (token []byte, err error) {
	tb, _ := hex.DecodeString(tokenIDKrbError)
	gssToken := kRB5Token{
		oID:      oID(),
		tokID:    tb,
		kRBError: &ke,
	}

	token, err = gssToken.marshal()
	if err == nil {
		// marshaled ok, return the kerberos error and token to the peer
		err = ke
	} else {
		// marshal failed, return that error and no token to send to the peer
		token = nil
	}

	return
}

// Generate a base key -- usually the same as GenerateEncryptionKey, except
// that the gokrb5 library doesn't handle the hash/integrity and the encryption
// keys being different lengths in aes256-cts-hmac-sha384-192
// TODO: fix GenerateEncryptionKey at some point to cope with different
// uses like this case.
func GenerateBaseKey(etype etype.EType) (types.EncryptionKey, error) {
	k := types.EncryptionKey{
		KeyType: etype.GetETypeID(),
	}

	// special-case one encryption type
	kl := etype.GetKeyByteSize()
	if etype.GetETypeID() == etypeID.AES256_CTS_HMAC_SHA384_192 {
		kl = 32
	}

	b := make([]byte, kl)
	_, err := rand.Read(b)
	if err != nil {
		return k, err
	}
	k.KeyValue = b
	return k, nil
}
