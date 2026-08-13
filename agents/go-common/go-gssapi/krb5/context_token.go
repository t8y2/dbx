// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

package krb5

/*
 * Derived from github.com/jcmturner/gokrb5/v8/spnego/krb5Token.go
 *
 * The modified version adds functionality to marshal an APReq message
 * to be used as part of a mutually-authenticated GSSAPI security
 * context; verification is moved out.
 */

import (
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"

	"github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/v8/asn1tools"

	"github.com/golang-auth/go-gssapi/v2"
	"github.com/golang-auth/go-gssapi/v2/common"
	"github.com/jcmturner/gokrb5/v8/messages"
)

// GSSAPI KRB5 MechToken IDs.
const (
	tokenIDKrbAPReq = "0100"
	tokenIDKrbAPRep = "0200"
	tokenIDKrbError = "0300"
)

// kRB5Token context token implementation for GSSAPI.
type kRB5Token struct {
	oID      asn1.ObjectIdentifier
	tokID    []byte
	aPReq    *messages.APReq
	aPRep    *aPRep
	kRBError *messages.KRBError
}

// marshal a KRB5Token into a slice of bytes.
func (m *kRB5Token) marshal() (outTok []byte, err error) {
	// Create the header
	b, _ := asn1.Marshal(m.oID)
	b = append(b, m.tokID...)
	var tb []byte
	switch hex.EncodeToString(m.tokID) {
	case tokenIDKrbAPReq:
		tb, err = m.aPReq.Marshal()
		if err != nil {
			err = fmt.Errorf("gssapi: error marshalling AP-REQ for MechToken: %v", err)
		}
	case tokenIDKrbAPRep:
		tb, err = m.aPRep.marshal()
		if err != nil {
			err = fmt.Errorf("gssapi: error marshalling AP-REP for MechToken: %v", err)
		}
	case tokenIDKrbError:
		tb, err = m.kRBError.Marshal()
		if err != nil {
			err = fmt.Errorf("gssapi: error marshalling KRB-ERROR for MechToken: %v", err)
		}
	}
	if err != nil {
		return
	}
	b = append(b, tb...)

	outTok = asn1tools.AddASNAppTag(b, 0)
	return
}

// unmarshal a KRB5Token.
func (m *kRB5Token) unmarshal(b []byte) error {
	m.aPReq = nil
	m.aPRep = nil
	m.kRBError = nil

	var oid asn1.ObjectIdentifier
	r, err := asn1.UnmarshalWithParams(b, &oid, fmt.Sprintf("application,explicit,tag:%v", 0))
	if err != nil {
		return fmt.Errorf("gssapi: error unmarshalling KRB5Token OID: %v", err)
	}
	if !oid.Equal(oID()) {
		return fmt.Errorf("gssapi: error unmarshalling KRB5Token, OID is %s not %s", oid.String(), oID().String())
	}
	m.oID = oid
	if len(r) < 2 {
		return fmt.Errorf("gssapi: krb5token too short")
	}
	m.tokID = r[0:2]
	switch hex.EncodeToString(m.tokID) {
	case tokenIDKrbAPReq:
		var a messages.APReq
		err = a.Unmarshal(r[2:])
		if err != nil {
			return fmt.Errorf("gssapi: error unmarshalling KRB5Token AP_REQ: %v", err)
		}
		m.aPReq = &a
	case tokenIDKrbAPRep:
		var a aPRep
		err = a.unmarshal(r[2:])
		if err != nil {
			return fmt.Errorf("gssapi: error unmarshalling KRB5Token AP_REP: %v", err)
		}
		m.aPRep = &a
	case tokenIDKrbError:
		var a messages.KRBError
		err = a.Unmarshal(r[2:])
		if err != nil {
			return fmt.Errorf("gssapi: error unmarshalling KRB5Token KRBError: %v", err)
		}
		m.kRBError = &a
	}
	return nil
}

// Create the GSSAPI checksum for the authenticator.  This isn't really
// a checksum, it is a way to carry GSSAPI level context information in
// the Kerberos AP-RREQ message. See RFC 4121 § 4.1.1
func newAuthenticatorChksum(flags gssapi.ContextFlag, cb *common.ChannelBinding) []byte {
	// 24 octet minimum length, up to and including context-establishment flags
	a := make([]byte, 24)

	// 4-byte length of "channel binding" info, always 16 bytes
	binary.LittleEndian.PutUint32(a[:4], 16)

	// Octets 4..19: Channel binding info
	if cb != nil {
		copy(a[4:20], cbChecksum(cb))
	}

	// Context-establishment flags
	binary.LittleEndian.PutUint32(a[20:24], uint32(flags))

	return a
}

func cbChecksum(cb *common.ChannelBinding) []byte {
	bufSz := 5*4 + len(cb.Data) // 5 x 32 bit length fields plus the data

	// .. plus the length of the address types, if not null
	for _, addr := range []net.Addr{cb.InitiatorAddr, cb.AcceptorAddr} {
		if addr == nil {
			continue
		}

		switch c := addr.(type) {
		case *net.IPAddr:
			bufSz += ipLength(c.IP)
		case *net.TCPAddr:
			bufSz += ipLength(c.IP)
		case *net.UDPAddr:
			bufSz += ipLength(c.IP)
		case *net.UnixAddr:
			bufSz += len(c.Name)
		}
	}

	buf := make([]byte, 0, bufSz)

	// write the address types and address data
	for _, addr := range []net.Addr{cb.InitiatorAddr, cb.AcceptorAddr} {
		addrType := 0
		addrData := []byte{}

		if addr != nil {
			switch c := addr.(type) {
			case *net.IPAddr:
				addrType = int(common.GssAddrFamilyINET)
				addrData = ipData(c.IP)
			case *net.TCPAddr:
				addrType = int(common.GssAddrFamilyINET)
				addrData = ipData(c.IP)
			case *net.UDPAddr:
				addrType = int(common.GssAddrFamilyINET)
				addrData = ipData(c.IP)
			case *net.UnixAddr:
				addrType = int(common.GssAddrFamilyLOCAL)
				addrData = []byte(c.Name)
			}
		}

		// write little endian 32-bit address type and address size
		bufTmp := [8]byte{}
		binary.LittleEndian.PutUint32(bufTmp[:], uint32(addrType))
		binary.LittleEndian.PutUint32(bufTmp[4:], uint32(len(addrData)))
		buf = append(buf, bufTmp[:]...)

		// write the address data
		buf = append(buf, addrData...)
	}

	// write the data
	bufTmp := [4]byte{}
	binary.LittleEndian.PutUint32(bufTmp[:], uint32(len(cb.Data)))
	buf = append(buf, bufTmp[:]...)
	buf = append(buf, cb.Data...)

	fmt.Printf("Channel binding data (%d bytes):\n% x\n", len(buf), buf)

	hashed := md5.Sum(buf)
	return hashed[:]
}

func ipLength(addr net.IP) int {
	if addr.To4() != nil {
		return 4
	}
	if addr.To16() != nil {
		return 16
	}

	return 0
}

func ipData(addr net.IP) (ret net.IP) {
	if ret = addr.To4(); ret != nil {
		return ret
	}

	if ret = addr.To16(); ret != nil {
		return ret
	}

	return nil
}
