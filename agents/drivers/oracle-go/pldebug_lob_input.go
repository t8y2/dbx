package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

const plDebugTypedInputBytes = 8 * 1024 * 1024
const plDebugTypedRequestWireBytes = 16 * 1024 * 1024

type plDebugLobInput struct {
	text   string
	binary []byte
	bytes  int
}

func plDebugDecodeLobInput(raw json.RawMessage, binary bool, remaining int) (plDebugLobInput, error) {
	kind := "clob"
	if binary {
		kind = "blob"
	}
	return plDebugDecodeBinaryOrLobInput(raw, kind, remaining)
}

func plDebugDecodeBinaryOrLobInput(raw json.RawMessage, want string, remaining int) (plDebugLobInput, error) {
	var envelope struct {
		Kind  string          `json:"kind"`
		Value json.RawMessage `json:"value"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return plDebugLobInput{}, err
	}
	if envelope.Kind != want || len(envelope.Value) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Value), []byte("null")) {
		return plDebugLobInput{}, errors.New("LOB input does not match its declared type")
	}
	if want == "clob" || want == "nclob" {
		var text string
		if err := json.Unmarshal(envelope.Value, &text); err != nil {
			return plDebugLobInput{}, err
		}
		if !utf8.ValidString(text) || len(text) > remaining {
			return plDebugLobInput{}, errors.New("typed LOB input byte budget exceeded or invalid text")
		}
		return plDebugLobInput{text: text, bytes: len(text)}, nil
	}
	if want == "raw" && remaining > 32767 {
		remaining = 32767
	}
	var value struct {
		Encoding string  `json:"encoding"`
		Data     *string `json:"data"`
	}
	decoder = json.NewDecoder(bytes.NewReader(envelope.Value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return plDebugLobInput{}, err
	}
	if value.Encoding != "base64" || value.Data == nil || len(*value.Data)%4 != 0 {
		return plDebugLobInput{}, errors.New("BLOB input requires explicit padded base64 data")
	}
	encoded := *value.Data
	size := len(encoded) / 4 * 3
	if len(encoded) > 0 && encoded[len(encoded)-1] == '=' {
		size--
		if len(encoded) > 1 && encoded[len(encoded)-2] == '=' {
			size--
		}
	}
	if size > remaining {
		return plDebugLobInput{}, errors.New("typed LOB input byte budget exceeded")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(data) != encoded {
		return plDebugLobInput{}, errors.New("BLOB input contains invalid base64 data")
	}
	return plDebugLobInput{binary: data, bytes: len(data)}, nil
}
