// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

/*
Package gssapi provides a Go interface to the Generic Security
Services Application Program Interface.

The package defines an interface that GSS-API mechanism specific
code should conform to.

An Initiator (ie. client) uses the Initiate method to start the
authentiation process.  An Acceptor (ie. server) uses the Accpet
method instead.  After that, both sides call Continue in a loop,
transferring token between themselves using a suitable communication
protocol.  When IsEstablished returns true, the security context
can be used to securely transfer messages or message signatures using
Wrap/Unwrap or MakeSignature/VerifySignature.
*/
package gssapi

import "github.com/golang-auth/go-gssapi/v2/common"

// Mech defines the interface to a GSS-API mechanism
type Mech interface {
	// IsEstablished can be used to determine whether the security
	// context between an Initiator and Acceptor is complete and
	// is ready to transfer messages between the peers.
	IsEstablished() bool

	// ContextFlags returns the security flags negotiated between
	// the initiator and acceptor.  The flags *SHOULD* be checked
	// before using the context to verify that desired security
	// requirements have been met.
	ContextFlags() ContextFlag

	// PeerName returns a string representing the peer's identity
	PeerName() string

	// SSF returns the Security Strength Factor of the channel established
	// by the security context
	SSF() uint

	// WrapSizeLimit returns the maximum possible message size that can
	// be presented to Wrap() to produce to output token no longer than
	// requestedOutputSize bytes
	WrapSizeLimit(requestedOutputSize uint32, confidentiality bool) uint32

	// Initiate is used by a GSS-API Initiator to start the
	// context negotiation process with a remote Acceptor.
	// serverName is the mechanism specific name of the remote
	// Acceptor, and flags represent the desired security
	// properties of the context.
	Initiate(serviceName string, flags ContextFlag, cb *common.ChannelBinding) (err error)

	// Accept is used by a GSS-API Acceptor to begin context
	// negotiation with a remote Initiator.
	// If provided, serviceName is the mechanism specific identifier
	// of the local Acceptor
	Accept(serviceName string) (err error)

	// Continue is called in a loop by Initiators and Acceptors after
	// first calling one of Initiate or Accept.
	// tokenIn represents a token received from the peer
	// If tokenOut is non-zero, it should be send to the peer
	Continue(tokenIn []byte) (tokenOut []byte, err error)

	// Wrap is called by either peer after the context is establighed
	// to create a token that encapsulates a payload.  If confidentially
	// is required, the payload is encrypted (*sealed*) using a key
	// negotiated during context establishment.  Otherwise, the key
	// is used to sign the payload which is encapsulated in the clear.
	// tokenOut should be communicated to the peer which should use Unwrap
	// on the token.
	Wrap(tokenIn []byte, confidentiality bool) (tokenOut []byte, err error)

	// Unwrap is passed a wrap token received from a peer.  If the token
	// provides confidentially, the key negotiated during context establishment
	// is used to decrypt (*unseal*) the payload.  Otherwise, the key is used
	// to verify the signature that the remote Wrap call calculated for the
	// payload.
	// tokenOut is the original payload
	// isSealed conveys whether the payload was encrypted or not
	Unwrap(tokenIn []byte) (tokenOut []byte, isSealed bool, err error)

	// MakeSignature creates a token that includes the signature of the
	// provided payload but does not include the payload itself.  The
	// output token should be sent to the peer, which should use its copy of
	// the payload (communicated separately) to verify the signature.
	MakeSignature(payload []byte) (tokenOut []byte, err error)

	// VerifySignature is used to check the signature received from a peer
	// using a local copy of the payloads.
	VerifySignature(payload []byte, tokenIn []byte) (err error)
}
