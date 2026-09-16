// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

package krb5

import (
	"encoding/hex"
	"fmt"
	"testing"

	"github.com/jcmturner/gokrb5/v8/iana/etypeID"
	"github.com/stretchr/testify/assert"

	"github.com/jcmturner/gokrb5/v8/types"
)

const (
	TestWrapPayload = "testing 123"

	// from kadmin:
	//   ank -kvno 123 -pw password -e test test
	//   ktadd -k test.kt -norandkey test
	TestAES256KVNO = 123
	TestAES256Key  = "93860ea9a3961f58f1e1370286c720ab8da6574cacb26396f7de6ebfbbfd00a0"
	AESCksumLen    = 12
	EncPayloadLen  = 55

	SampleWrapTokenSignature     = "71914A5D08018A97375AB52A"
	WrapTokenSignedHeader        = "050400ff000c0000000000000000007B"
	SampleSignedWrapTOken        = "050404ff000c000000000000209bb2cb74657374696e6720313233efed11aa6caa6cf5a7e595a5"
	SampleSignedWrapTokenWindows = "050400ff000c000c0000000000000000a79b6be6ce749f2f6102c78774657374"
	SampleMICTokenSignature      = "b479cc6b1a27beb60a815b26"
	MICTokenHeader               = "040404ffffffffff000000000000007B"
	SampleMICToken               = "040404ffffffffff000000000000007Bb479cc6b1a27beb60a815b26"
)

func mkSampleWrapToken() (wt wrapToken) {
	return wrapToken{
		Flags:          0,
		SequenceNumber: 123,
		Payload:        []byte(TestWrapPayload),
	}
}

func mkSampleMICToken() (mt mICToken) {
	return mICToken{
		Flags:          4,
		SequenceNumber: 123,
	}
}

func mkSampleAESKey() (key types.EncryptionKey) {
	b, _ := hex.DecodeString(TestAES256Key)
	return types.EncryptionKey{
		KeyType:  etypeID.AES256_CTS_HMAC_SHA1_96,
		KeyValue: b,
	}
}

func TestWrapTokenSign(t *testing.T) {
	key := mkSampleAESKey()
	tok := mkSampleWrapToken()

	err := tok.Sign(key)

	assert.NoError(t, err, "signing operation failed")
	assert.True(t, tok.signedOrSealed, "token was not signed")
	assert.Equal(t, uint16(AESCksumLen), tok.EC, "wrong checksum length")
	assert.Equal(t, len(TestWrapPayload)+AESCksumLen, len(tok.Payload), "wrong signed payload length")

	wantSig, _ := hex.DecodeString(SampleWrapTokenSignature)
	assert.Equal(t, wantSig, tok.Payload[len(TestWrapPayload):], "signature not as expected")
	assert.Equal(t, []byte(TestWrapPayload), tok.Payload[0:len(TestWrapPayload)], "corrupt payload")
}

func TestWrapTokenSeal(t *testing.T) {
	key := mkSampleAESKey()
	tok := mkSampleWrapToken()

	err := tok.Seal(key)

	assert.NoError(t, err, "sealing operation failed")
	assert.True(t, tok.signedOrSealed, "token was not sealed")
	assert.Equal(t, uint16(0), tok.EC, "wrong extra-count")
	assert.Equal(t, EncPayloadLen, len(tok.Payload), "sealed token length is wrong")
}

func TestWrapTokenMarshal(t *testing.T) {
	key := mkSampleAESKey()
	tok := mkSampleWrapToken()

	_, err := tok.Marshal()
	assert.Error(t, err, "Marshal of unsigned/sealed token should be an error")

	err = tok.Sign(key)
	assert.NoError(t, err, "signing operation failed")

	tokBytes, err := tok.Marshal()
	assert.NoError(t, err, "Marshal of signed token should succeed")
	assert.Equal(t, 16+len(TestWrapPayload)+AESCksumLen, len(tokBytes), "bad token length")

	wantHeader, _ := hex.DecodeString(WrapTokenSignedHeader)
	assert.Equal(t, wantHeader, tokBytes[0:16], "bad wrap token header")

	wantSig, _ := hex.DecodeString(SampleWrapTokenSignature)
	assert.Equal(t, []byte(TestWrapPayload), tokBytes[16:16+len(TestWrapPayload)], "corrupt payload")
	assert.Equal(t, wantSig, tokBytes[16+len(TestWrapPayload):], "signature not as expected")
}

func TestWrapTokenUnmarshal(t *testing.T) {
	tokBytes, _ := hex.DecodeString(SampleSignedWrapTOken)

	tok := wrapToken{}
	err := tok.Unmarshal(tokBytes)
	assert.NoError(t, err, "Unmarshal of signed token failed")

	assert.Equal(t, 0x04, int(tok.Flags), "bad token flags")
	assert.Equal(t, uint16(AESCksumLen), tok.EC, "bad EC (signature length)")
	assert.Equal(t, uint16(0), tok.RRC, "bad RRC")
	assert.Equal(t, uint64(0x209bb2cb), tok.SequenceNumber, "bad sequence number")
	assert.Equal(t, true, tok.signedOrSealed, "token is not signed/sealed")
}

func TestWindowsWrapTokenUnmarshal(t *testing.T) {
	tokBytes, _ := hex.DecodeString(SampleSignedWrapTokenWindows)

	tok := wrapToken{}
	err := tok.Unmarshal(tokBytes)
	assert.NoError(t, err, "Unmarshal of signed token failed")

	assert.Equal(t, 0x00, int(tok.Flags), "bad token flags")
	assert.Equal(t, uint16(AESCksumLen), tok.EC, "bad EC (signature length)")
	assert.Equal(t, uint16(12), tok.RRC, "bad RRC")
	assert.Equal(t, uint64(0), tok.SequenceNumber, "bad sequence number")
	assert.Equal(t, true, tok.signedOrSealed, "token is not signed/sealed")
}

func TestRotateLeft(t *testing.T) {
	var testData = "abcdefghijklmnop"

	var tests = []struct {
		rc       uint
		expected string
	}{
		{0, "abcdefghijklmnop"},
		{1, "bcdefghijklmnopa"},
		{15, "pabcdefghijklmno"},
		{16, "abcdefghijklmnop"},
		{17, "bcdefghijklmnopa"},
		{32, "abcdefghijklmnop"},
		{33, "bcdefghijklmnopa"},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("rc=%d", tt.rc), func(t *testing.T) {
			in := testData
			out := rotateLeft([]byte(in), tt.rc)
			assert.Equal(t, tt.expected, string(out))
		})
	}
}

func TestMICTokenSign(t *testing.T) {
	key := mkSampleAESKey()
	tok := mkSampleMICToken()

	err := tok.Sign([]byte(TestWrapPayload), key)

	assert.NoError(t, err, "signing operation failed")
	assert.True(t, tok.signed, "token was not signed")

	wantSig, _ := hex.DecodeString(SampleMICTokenSignature)
	assert.Equal(t, wantSig, tok.Checksum, "signature not as expected")
}

func TestMICTokenMarshal(t *testing.T) {
	key := mkSampleAESKey()
	tok := mkSampleMICToken()

	_, err := tok.Marshal()
	assert.Error(t, err, "Marshal of unsigned MIC token should be an error")

	err = tok.Sign([]byte(TestWrapPayload), key)
	assert.NoError(t, err, "signing operation failed")

	tokBytes, err := tok.Marshal()
	assert.NoError(t, err, "Marshal of signed token should succeed")
	assert.Equal(t, 16+AESCksumLen, len(tokBytes), "bad token length")

	wantHeader, _ := hex.DecodeString(MICTokenHeader)
	assert.Equal(t, wantHeader, tokBytes[0:16], "bad MIC token header")

	wantSig, _ := hex.DecodeString(SampleMICTokenSignature)
	assert.Equal(t, wantSig, tokBytes[16:], "signature not as expected")
}

func TestMICTokenUnmarshal(t *testing.T) {
	tokBytes, _ := hex.DecodeString(SampleMICToken)

	tok := mICToken{}
	err := tok.Unmarshal(tokBytes)
	assert.NoError(t, err, "Unmarshal of MIC token failed")

	assert.Equal(t, 0x04, int(tok.Flags), "bad token flags")
	assert.Equal(t, uint64(123), tok.SequenceNumber, "bad sequence number")
	assert.Equal(t, true, tok.signed, "token is not signed/sealed")
}
