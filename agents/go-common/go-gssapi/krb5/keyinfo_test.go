package krb5

import (
	"fmt"
	"math/rand"
	"testing"

	"github.com/jcmturner/gokrb5/v8/crypto"
	"github.com/jcmturner/gokrb5/v8/iana/etypeID"
	"github.com/jcmturner/gokrb5/v8/iana/keyusage"
	"github.com/stretchr/testify/assert"
)

func TestEncryptedLength(t *testing.T) {
	var tests = []struct {
		keyTypeName string
	}{
		{"rc4-hmac"},
		{"des3-cbc-sha1-kd"},
		{"aes128-cts-hmac-sha1-96"},
		{"aes256-cts-hmac-sha1-96"},
		{"aes128-cts-hmac-sha256-128"},
		{"aes256-cts-hmac-sha384-192"},
	}

	var plainTextLengths = []int{0, 1, 2, 8, 16, 64, 128, 256, 1024, 3000, 4000}

	for _, tt := range tests {
		for _, plainLength := range plainTextLengths {
			plainData := make([]byte, plainLength)
			_, _ = rand.Read(plainData)

			name := fmt.Sprintf("%s (%d byte plaintext)", tt.keyTypeName, plainLength)

			t.Run(name, func(t *testing.T) {
				etypeID := etypeID.EtypeSupported(tt.keyTypeName)
				assert.Positive(t, etypeID, "key type %s should be supported")

				etype, _ := crypto.GetEtype(etypeID)
				key, err := GenerateBaseKey(etype)
				assert.NoError(t, err, "failed to generate encryption key")

				_, cipherText, err := etype.EncryptMessage(key.KeyValue, plainData, keyusage.GSSAPI_INITIATOR_SEAL)
				assert.NoError(t, err, "failed to encrypt message")

				expectedLength := encryptedLength(etypeID, uint32(plainLength))
				assert.Equal(t, expectedLength, uint32(len(cipherText)))

				_ = cipherText
			})
		}
	}

	assert.True(t, true)
}
