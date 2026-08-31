// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

package krb5

import (
	"encoding/hex"
	"testing"

	"github.com/jcmturner/gokrb5/v8/iana/msgtype"
	"github.com/stretchr/testify/assert"
)

const (
	// GSSAPI tokens encapsulating the apreq/apreq/krberror test vectors from the MIT Kerberos V source
	// see krb-1.19.1/src/tests/asn.1/reference_encode.out
	KRB5TokenApreqHex    = "6081AD06092a864886f71201020201006E819D30819AA003020105A10302010EA207030500FEDCBA98A35E615C305AA003020105A1101B0E415448454E412E4D49542E454455A21A3018A003020101A111300F1B066866747361691B056578747261A3253023A003020100A103020105A21704156B726241534E2E312074657374206D657373616765A4253023A003020100A103020105A21704156B726241534E2E312074657374206D657373616765"
	KRB5TOKENAprepHex    = "604206092a864886f71201020202006F333031A003020105A10302010FA2253023A003020100A103020105A21704156B726241534E2E312074657374206D657373616765"
	KRB5TOKENKrberrorHex = "6081ca06092a864886f71201020203007E81BA3081B7A003020105A10302011EA211180F31393934303631303036303331375AA305020301E240A411180F31393934303631303036303331375AA505020301E240A60302013CA7101B0E415448454E412E4D49542E454455A81A3018A003020101A111300F1B066866747361691B056578747261A9101B0E415448454E412E4D49542E454455AA1A3018A003020101A111300F1B066866747361691B056578747261AB0A1B086B72623564617461AC0A04086B72623564617461"
	AuthChksum           = "100000000000000000000000000000000000000030000000"
)

func TestKRB5TokenApreq_Unmarshal(t *testing.T) {
	t.Parallel()
	b, err := hex.DecodeString(KRB5TokenApreqHex)
	if err != nil {
		t.Fatalf("Error decoding KRB5Token hex: %v", err)
	}
	var mt kRB5Token
	err = mt.unmarshal(b)
	if err != nil {
		t.Fatalf("Error unmarshalling KRB5Token: %v", err)
	}
	assert.Equal(t, oID(), mt.oID, "KRB5Token OID not as expected.")
	assert.Equal(t, []byte{1, 0}, mt.tokID, "TokID not as expected")
	assert.NotNil(t, mt.aPReq)
	assert.Nil(t, mt.aPRep)
	assert.Nil(t, mt.kRBError)
	assert.Equal(t, msgtype.KRB_AP_REQ, mt.aPReq.MsgType, "KRB5Token AP_REQ does not have the right message type.")
	assert.Equal(t, int32(0), mt.aPReq.EncryptedAuthenticator.EType, "Authenticator within AP_REQ does not have the etype expected.")
	assert.Equal(t, 5, mt.aPReq.EncryptedAuthenticator.KVNO, "Authenticator within AP_REQ does not have the KVNO expected.")
	assert.Equal(t, []byte("krbASN.1 test message"), mt.aPReq.EncryptedAuthenticator.Cipher, "Authenticator within AP_REQ does not have the ciphertext expected.")
}

func TestKRB5TokenAprep_Unmarshal(t *testing.T) {
	t.Parallel()
	b, err := hex.DecodeString(KRB5TOKENAprepHex)
	if err != nil {
		t.Fatalf("Error decoding KRB5Token hex: %v", err)
	}
	var mt kRB5Token
	err = mt.unmarshal(b)
	if err != nil {
		t.Fatalf("Error unmarshalling KRB5Token: %v", err)
	}
	assert.Equal(t, oID(), mt.oID, "KRB5Token OID not as expected.")
	assert.Equal(t, []byte{2, 0}, mt.tokID, "TokID not as expected")
	assert.Nil(t, mt.aPReq)
	assert.NotNil(t, mt.aPRep)
	assert.Nil(t, mt.kRBError)
	assert.Equal(t, msgtype.KRB_AP_REP, mt.aPRep.MsgType, "KRB5Token AP_REP does not have the right message type.")
	assert.NotNil(t, mt.aPRep.EncPart, "Nil AP_REP encrypted part")
	assert.NotEmpty(t, mt.aPRep.EncPart, "Empty AP_REP encrypted part")
	assert.Equal(t, int32(0), mt.aPRep.EncPart.EType, "Authenticator within AP_REP does not have the etype expected.")
	assert.Equal(t, 5, mt.aPRep.EncPart.KVNO, "Authenticator within AP_REP does not have the KVNO expected.")
	assert.Equal(t, []byte("krbASN.1 test message"), mt.aPRep.EncPart.Cipher, "Authenticator within AP_REP does not have the ciphertext expected.")
}

func TestKRB5TokenKrberror_Unmarshal(t *testing.T) {
	t.Parallel()
	b, err := hex.DecodeString(KRB5TOKENKrberrorHex)
	if err != nil {
		t.Fatalf("Error decoding KRB5Token hex: %v", err)
	}
	var mt kRB5Token
	err = mt.unmarshal(b)
	if err != nil {
		t.Fatalf("Error unmarshalling KRB5Token: %v", err)
	}
	assert.Equal(t, oID(), mt.oID, "KRB5Token OID not as expected.")
	assert.Equal(t, []byte{3, 0}, mt.tokID, "TokID not as expected")
	assert.Nil(t, mt.aPReq)
	assert.Nil(t, mt.aPRep)
	assert.NotNil(t, mt.kRBError)
	assert.Equal(t, msgtype.KRB_ERROR, mt.kRBError.MsgType, "KRB5Token KRB_ERROR does not have the right message type.")
	assert.Equal(t, int32(SampleError), mt.kRBError.ErrorCode, "KRB5Token KRB_ERROR has the wrong error code.")
	assert.Equal(t, "ATHENA.MIT.EDU", mt.kRBError.Realm, "KRB5Token KRB_ERROR has the wrong realm.")
	assert.Equal(t, SampleData, mt.kRBError.EText, "KRB5Token KRB_ERROR has the wrong error test.")
}

func TestKrb5TokenApreq_Marshal(t *testing.T) {
	t.Parallel()

	apreq := ktestMakeSampleApReq()

	mt := kRB5Token{
		oID:   oID(),
		tokID: []byte{1, 0},
		aPReq: &apreq,
	}

	tok, err := mt.marshal()
	if err != nil {
		t.Fatalf("Error marshalling KRB5Token: %s", err)
	}

	ref, err := hex.DecodeString(KRB5TokenApreqHex)
	if err != nil {
		t.Fatalf("Error decoding KRB5Token hex: %s", err)
	}

	assert.Equal(t, ref, tok)
}

func TestKrb5TokenAprep_Marshal(t *testing.T) {
	t.Parallel()

	aprep := ktestMakeSampleApRep()

	mt := kRB5Token{
		oID:   oID(),
		tokID: []byte{2, 0},
		aPRep: &aprep,
	}

	tok, err := mt.marshal()
	if err != nil {
		t.Fatalf("Error marshalling KRB5Token: %s", err)
	}

	ref, err := hex.DecodeString(KRB5TOKENAprepHex)
	if err != nil {
		t.Fatalf("Error decoding KRB5Token hex: %s", err)
	}

	assert.Equal(t, ref, tok)
}

func TestKrb5TokenKrberror_Marshal(t *testing.T) {
	t.Parallel()

	krberr := ktestMakeSampleError()

	mt := kRB5Token{
		oID:      oID(),
		tokID:    []byte{3, 0},
		kRBError: &krberr,
	}

	tok, err := mt.marshal()
	if err != nil {
		t.Fatalf("Error marshalling KRB5Token: %s", err)
	}

	ref, err := hex.DecodeString(KRB5TOKENKrberrorHex)
	if err != nil {
		t.Fatalf("Error decoding KRB5Token hex: %s", err)
	}

	assert.Equal(t, ref, tok)
}
