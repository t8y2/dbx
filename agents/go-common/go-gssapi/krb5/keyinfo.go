package krb5

import (
	"github.com/jcmturner/gokrb5/v8/crypto"
)

func keySSF(keyType int32) uint {
	// From MIT Kerberos 1.16 (src/lib/crypto/krb/etypes.c)
	/*
		ENCTYPE_DES3_CBC_RAW				112
		ENCTYPE_DES3_CBC_SHA1				112
		ENCTYPE_ARCFOUR_HMAC		 		 64
		ENCTYPE_ARCFOUR_HMAC_EXP	 		 40
		ENCTYPE_AES128_CTS_HMAC_SHA1_96		128
		ENCTYPE_AES256_CTS_HMAC_SHA1_96		256
		ENCTYPE_CAMELLIA128_CTS_CMAC		128
		ENCTYPE_CAMELLIA256_CTS_CMAC		256
		ENCTYPE_AES128_CTS_HMAC_SHA256_128	128
		ENCTYPE_AES256_CTS_HMAC_SHA384_192	256
	*/

	key, _ := crypto.GetEtype(keyType)

	switch key.(type) {
	case crypto.Des3CbcSha1Kd:
		return 112
	case crypto.RC4HMAC:
		return 64
	}

	// default to the key length in bits
	return uint(key.GetKeyByteSize()) * 8
}

// port from MIT Kerberos 1.16 (krb5_c_encrypt_length)
func encryptedLength(keyType int32, plainTextSize uint32) uint32 {
	paddingLen := paddingLength(keyType, plainTextSize)
	return uint32(keyHeaderLength(keyType)) +
		plainTextSize +
		paddingLen +
		uint32(keyTrailerLength(keyType))
}

// port from MIT Kerberos 1.16 (krb5int_c_padding_length)
func paddingLength(keyType int32, dataLength uint32) uint32 {
	dataLength += uint32(keyHeaderLength(keyType))
	padding := uint32(keyPaddingLength(keyType))

	if padding == 0 || (dataLength%padding) == 0 {
		return 0
	} else {
		return padding - (dataLength % padding)
	}
}

func keyHeaderLength(keyType int32) uint {
	key, _ := crypto.GetEtype(keyType)

	switch key.(type) {
	case crypto.Des3CbcSha1Kd:
		return uint(key.GetCypherBlockBitLength()) / 8
	case crypto.RC4HMAC:
		return uint(key.GetHMACBitLength()/8 + key.GetConfounderByteSize())
	case crypto.Aes128CtsHmacSha96:
		return uint(key.GetCypherBlockBitLength()) / 8
	case crypto.Aes128CtsHmacSha256128:
		return uint(key.GetCypherBlockBitLength()) / 8
	case crypto.Aes256CtsHmacSha96:
		return uint(key.GetCypherBlockBitLength()) / 8
	case crypto.Aes256CtsHmacSha384192:
		return uint(key.GetCypherBlockBitLength()) / 8
	}

	return 0
}

func keyPaddingLength(keyType int32) uint {
	key, _ := crypto.GetEtype(keyType)

	switch key.(type) {
	case crypto.Des3CbcSha1Kd:
		return uint(key.GetCypherBlockBitLength()) / 8
	case crypto.RC4HMAC:
		return 0
	case crypto.Aes128CtsHmacSha96:
		return 0
	case crypto.Aes128CtsHmacSha256128:
		return 0
	case crypto.Aes256CtsHmacSha96:
		return 0
	case crypto.Aes256CtsHmacSha384192:
		return 0
	}

	return 0
}

func keyTrailerLength(keyType int32) uint {
	key, _ := crypto.GetEtype(keyType)

	switch key.(type) {
	case crypto.Des3CbcSha1Kd:
		return uint(key.GetHMACBitLength()) / 8
	case crypto.RC4HMAC:
		return 0
	case crypto.Aes128CtsHmacSha96:
		return uint(key.GetHMACBitLength()) / 8
	case crypto.Aes128CtsHmacSha256128:
		return uint(key.GetHMACBitLength()) / 8
	case crypto.Aes256CtsHmacSha96:
		return uint(key.GetHMACBitLength()) / 8
	case crypto.Aes256CtsHmacSha384192:
		return uint(key.GetHMACBitLength()) / 8
	}

	return 0
}
