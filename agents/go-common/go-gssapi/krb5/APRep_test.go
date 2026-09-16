// Copyright 2021 Jake Scott. All rights reserved.
// Use of this source code is governed by the Apache License
// version 2.0 that can be found in the LICENSE file.

package krb5

import (
	"encoding/hex"
	"testing"
	"time"

	"github.com/jcmturner/gokrb5/v8/iana"
	"github.com/jcmturner/gokrb5/v8/iana/msgtype"
	"github.com/jcmturner/gokrb5/v8/test/testdata"
	"github.com/stretchr/testify/assert"

	"github.com/jcmturner/gokrb5/v8/types"
)

func TestUnmarshalAPRep(t *testing.T) {
	t.Parallel()
	var a aPRep
	b, err := hex.DecodeString(testdata.MarshaledKRB5ap_rep)
	if err != nil {
		t.Fatalf("Test vector read error: %v", err)
	}
	err = a.unmarshal(b)
	if err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	assert.Equal(t, iana.PVNO, a.PVNO, "PVNO not as expected")
	assert.Equal(t, msgtype.KRB_AP_REP, a.MsgType, "MsgType is not as expected")
	assert.Equal(t, testdata.TEST_ETYPE, a.EncPart.EType, "Ticket encPart etype not as expected")
	assert.Equal(t, iana.PVNO, a.EncPart.KVNO, "Ticket encPart KVNO not as expected")
	assert.Equal(t, []byte(testdata.TEST_CIPHERTEXT), a.EncPart.Cipher, "Ticket encPart cipher not as expected")
}

func TestUnmarshalEncAPRepPart(t *testing.T) {
	t.Parallel()
	var a encAPRepPart
	b, err := hex.DecodeString(testdata.MarshaledKRB5ap_rep_enc_part)
	if err != nil {
		t.Fatalf("Test vector read error: %v", err)
	}
	err = a.unmarshal(b)
	if err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	// Parse the test time value into a time.Time type
	tt, _ := time.Parse(testdata.TEST_TIME_FORMAT, testdata.TEST_TIME)

	assert.Equal(t, tt, a.CTime, "CTime not as expected")
	assert.Equal(t, 123456, a.Cusec, "Client microseconds not as expected")
	assert.Equal(t, int32(1), a.Subkey.KeyType, "Subkey type not as expected")
	assert.Equal(t, []byte("12345678"), a.Subkey.KeyValue, "Subkey value not as expected")
	assert.Equal(t, int64(17), a.SequenceNumber, "Sequence number not as expected")
}

func TestUnmarshalEncAPRepPart_optionalsNULL(t *testing.T) {
	t.Parallel()
	var a encAPRepPart
	b, err := hex.DecodeString(testdata.MarshaledKRB5ap_rep_enc_partOptionalsNULL)
	if err != nil {
		t.Fatalf("Test vector read error: %v", err)
	}
	err = a.unmarshal(b)
	if err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	// Parse the test time value into a time.Time type
	tt, _ := time.Parse(testdata.TEST_TIME_FORMAT, testdata.TEST_TIME)

	assert.Equal(t, tt, a.CTime, "CTime not as expected")
	assert.Equal(t, 123456, a.Cusec, "Client microseconds not as expected")
}

// test with all fields populated
func TestAPRepEncPartMarshall(t *testing.T) {
	t.Parallel()

	want, err := hex.DecodeString(testdata.MarshaledKRB5ap_rep_enc_part)
	assert.Nil(t, err, "error not expected decoding test data")

	encpart := ktestMakeSampleAPReqEncPart()

	b, err := encpart.marshal()
	assert.Nil(t, err, "enc part marshal error not expected")
	assert.Equal(t, want, b)
}

// test with the optionals not present
func TestAPRepEncPartMarshall_optionalsNULL(t *testing.T) {
	t.Parallel()

	want, err := hex.DecodeString(testdata.MarshaledKRB5ap_rep_enc_partOptionalsNULL)
	assert.Nil(t, err, "error not expected decoding test data")

	encpart := ktestMakeSampleAPReqEncPart()
	encpart.SequenceNumber = 0
	encpart.Subkey = types.EncryptionKey{}

	b, err := encpart.marshal()
	assert.Nil(t, err, "enc part marshal error not expected")
	assert.Equal(t, want, b)
}

func TestAprepMarshal(t *testing.T) {
	t.Parallel()

	want, err := hex.DecodeString(testdata.MarshaledKRB5ap_rep)
	assert.Nil(t, err, "error not expected decoding test data")

	aprep := ktestMakeSampleApRep()

	b, err := aprep.marshal()
	assert.Nil(t, err, "enc part marshal error not expected")
	assert.Equal(t, want, b)
}
