// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

package krb5

import (
	"encoding/binary"
	"time"

	"github.com/jcmturner/gokrb5/v8/iana/msgtype"
	"github.com/jcmturner/gokrb5/v8/test/testdata"

	"github.com/jcmturner/gokrb5/v8/messages"
	"github.com/jcmturner/gokrb5/v8/types"
)

// Sample data from MIT Kerberos v1.19.1

// from src/tests/asn.1/ktest.h
const (
	SampleUSec          = 123456
	SampleSeqNumber     = 17
	SampleNonce         = 42
	SampleFlags         = 0xFEDCBA98
	SampleError         = 0x3C
	SamplePrincipalName = "hftsai/extra@ATHENA.MIT.EDU"
	SampleData          = "krb5data"
)

func ktestMakeSampleAPReqEncPart() encAPRepPart {
	tm, _ := time.Parse(testdata.TEST_TIME_FORMAT, testdata.TEST_TIME)
	return encAPRepPart{
		CTime:          tm,
		Cusec:          SampleUSec,
		Subkey:         ktestMakeSampleKeyblock(),
		SequenceNumber: SampleSeqNumber,
	}
}

func ktestMakeSampleKeyblock() types.EncryptionKey {
	kv := []byte("12345678")
	return types.EncryptionKey{
		KeyType:  1,
		KeyValue: kv,
	}
}

func ktestMakeSampleEncData() types.EncryptedData {
	return types.EncryptedData{
		EType:  0,
		KVNO:   5,
		Cipher: []byte(testdata.TEST_CIPHERTEXT),
	}
}

func ktestMakeSampleTicket() messages.Ticket {
	pn, realm := types.ParseSPNString(SamplePrincipalName)
	return messages.Ticket{
		TktVNO:  5,
		Realm:   realm,
		SName:   pn,
		EncPart: ktestMakeSampleEncData(),
	}
}

func ktestMakeSampleApReq() (aprep messages.APReq) {
	aprep = messages.APReq{
		PVNO:                   5,
		MsgType:                msgtype.KRB_AP_REQ,
		APOptions:              types.NewKrbFlags(),
		Ticket:                 ktestMakeSampleTicket(),
		EncryptedAuthenticator: ktestMakeSampleEncData(),
	}

	binary.BigEndian.PutUint32(aprep.APOptions.Bytes[0:], SampleFlags)
	return
}

func ktestMakeSampleApRep() (aprep aPRep) {
	aprep = aPRep{
		PVNO:    5,
		MsgType: msgtype.KRB_AP_REP,
		EncPart: ktestMakeSampleEncData(),
	}

	return
}

func ktestMakeSampleError() (krberr messages.KRBError) {
	pn, realm := types.ParseSPNString(SamplePrincipalName)
	tm, _ := time.Parse(testdata.TEST_TIME_FORMAT, testdata.TEST_TIME)
	krberr = messages.KRBError{
		PVNO:      5,
		MsgType:   msgtype.KRB_ERROR,
		CTime:     tm,
		Cusec:     SampleUSec,
		STime:     tm,
		Susec:     SampleUSec,
		ErrorCode: SampleError,
		CRealm:    realm,
		CName:     pn,
		Realm:     realm,
		SName:     pn,
		EText:     SampleData,
		EData:     []byte(SampleData),
	}

	return
}
