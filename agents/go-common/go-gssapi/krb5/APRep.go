// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

package krb5

/*
 * Derived from github.com/jcmturner/gokrb5/v8/messages/APRep.go
 *
 * The modified version adds marshalling functionality.  Remove if/when the changes
 * make it upstream.
 */

import (
	"fmt"
	"time"

	"github.com/jcmturner/gofork/encoding/asn1"
	"github.com/jcmturner/gokrb5/v8/asn1tools"
	"github.com/jcmturner/gokrb5/v8/crypto"
	"github.com/jcmturner/gokrb5/v8/iana"
	"github.com/jcmturner/gokrb5/v8/iana/asnAppTag"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/jcmturner/gokrb5/v8/iana/msgtype"
	"github.com/jcmturner/gokrb5/v8/krberror"

	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/types"
)

// aPRep implements RFC 4120 KRB_AP_REP: https://tools.ietf.org/html/rfc4120#section-5.5.2.
type aPRep struct {
	PVNO    int                 `asn1:"explicit,tag:0"`
	MsgType int                 `asn1:"explicit,tag:1"`
	EncPart types.EncryptedData `asn1:"explicit,tag:2"`
}

// encAPRepPart is the encrypted part of KRB_AP_REP.
type encAPRepPart struct {
	CTime          time.Time           `asn1:"generalized,explicit,tag:0"`
	Cusec          int                 `asn1:"explicit,tag:1"`
	Subkey         types.EncryptionKey `asn1:"optional,explicit,tag:2"`
	SequenceNumber int64               `asn1:"optional,explicit,tag:3"`
}

// unmarshal bytes b into the APRep struct.
func (a *aPRep) unmarshal(b []byte) error {
	_, err := asn1.UnmarshalWithParams(b, a, fmt.Sprintf("application,explicit,tag:%v", asnAppTag.APREP))
	if err != nil {
		return processUnmarshalReplyError(b, err)
	}
	expectedMsgType := msgtype.KRB_AP_REP
	if a.MsgType != expectedMsgType {
		return krberror.NewErrorf(krberror.KRBMsgError, "message ID does not indicate a KRB_AP_REP. Expected: %v; Actual: %v", expectedMsgType, a.MsgType)
	}
	return nil
}

// marshal the AP-REP message to a byte slice
func (a *aPRep) marshal() (b []byte, err error) {
	b, err = asn1.Marshal(*a)
	if err != nil {
		return
	}

	b = asn1tools.AddASNAppTag(b, asnAppTag.APREP)
	return
}

func (a *aPRep) decryptEncPart(sessionKey types.EncryptionKey) (encpart encAPRepPart, err error) {
	decrypted, err := crypto.DecryptEncPart(a.EncPart, sessionKey, uint32(keyusage.AP_REP_ENCPART))
	if err != nil {
		err = krberror.Errorf(err, krberror.DecryptingError, "error decrypting AP-REP enc-part")
		return
	}

	err = encpart.unmarshal(decrypted)
	if err != nil {
		err = krberror.Errorf(err, krberror.EncodingError, "error unmarshalling decrypted AP-REP enc-part")
		return
	}

	return
}

// unmarshal bytes b into the APRep encrypted part struct.
func (a *encAPRepPart) unmarshal(b []byte) error {
	_, err := asn1.UnmarshalWithParams(b, a, fmt.Sprintf("application,explicit,tag:%v", asnAppTag.EncAPRepPart))
	if err != nil {
		return krberror.Errorf(err, krberror.EncodingError, "AP_REP unmarshal error")
	}
	return nil
}

func (a *encAPRepPart) marshal() (b []byte, err error) {
	b, err = asn1.Marshal(*a)
	if err != nil {
		return
	}

	b = asn1tools.AddASNAppTag(b, asnAppTag.EncAPRepPart)
	return
}

func newAPRep(tkt messages.Ticket, sessionKey types.EncryptionKey, encPart encAPRepPart) (a aPRep, err error) {
	m, err := encPart.marshal()
	if err != nil {
		err = krberror.Errorf(err, krberror.EncodingError, "marshaling error of AP-REP enc-part")
		return
	}

	ed, err := crypto.GetEncryptedData(m, sessionKey, uint32(keyusage.AP_REP_ENCPART), tkt.EncPart.KVNO)
	if err != nil {
		err = krberror.Errorf(err, krberror.EncryptingError, "error encrypting AP-REP enc-part")
		return
	}

	a = aPRep{
		PVNO:    iana.PVNO,
		MsgType: msgtype.KRB_AP_REP,
		EncPart: ed,
	}
	return
}

func processUnmarshalReplyError(b []byte, err error) error {
	switch err.(type) {
	case asn1.StructuralError:
		var krberr messages.KRBError
		tmperr := krberr.Unmarshal(b)
		if tmperr != nil {
			return krberror.Errorf(err, krberror.EncodingError, "failed to unmarshal message")
		}
		return krberr
	default:
		return krberror.Errorf(err, krberror.EncodingError, "failed to unmarshal message")
	}
}
