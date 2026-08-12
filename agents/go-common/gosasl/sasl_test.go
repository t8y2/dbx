//go:build !kerberos
// +build !kerberos

package gosasl

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestAnonymousMechanism(t *testing.T) {
	mechanism := NewAnonymousMechanism()
	client := NewSaslClient("localhost", mechanism)
	client.Start()
	ret, _ := client.Step(nil)
	if !reflect.DeepEqual(ret, []byte("Anonymous, None")) {
		t.Fatal("Unexpected response from client.process")
	}
	if !client.Complete() {
		t.Fatal("Challenge should have completed")
	}
	client.Dispose()
}

func TestPlainMechanism(t *testing.T) {
	mechanism := NewPlainMechanism("user", "password")
	client := NewSaslClient("localhost", mechanism)
	client.Start()
	response, _ := client.Step([]byte("abcd"))
	if !client.Complete() {
		t.Fatal("Challenge should have completed")
	}

	NULL := "\x00"
	expectedResponse := []byte(fmt.Sprintf("%s%s%s%s", NULL, "user", NULL, "password"))
	if !reflect.DeepEqual(response, expectedResponse) {
		t.Fatal("Unexpected response from client.process")
	}
	client.Dispose()
}

func TestPlainMechanismWithAuthorizationId(t *testing.T) {
	mechanism := NewPlainMechanism("user", "password")
	client := NewSaslClient("localhost", mechanism)
	client.GetConfig().AuthorizationID = "authId"
	client.Start()
	response, _ := client.Step([]byte("abcd"))
	if !client.Complete() {
		t.Fatal("Challenge should have completed")
	}

	NULL := "\x00"
	expectedResponse := []byte(fmt.Sprintf("%s%s%s%s%s", "authId", NULL, "user", NULL, "password"))
	if !reflect.DeepEqual(response, expectedResponse) {
		t.Fatal("Unexpected response from client.process")
	}
	client.Dispose()
}

func TestCramMD5Mechanism(t *testing.T) {
	mechanism := NewCramMD5Mechanism("user", "pass")
	client := NewSaslClient("localhost", mechanism)
	client.Start()
	response, _ := client.Step([]byte("msg"))
	if !client.Complete() {
		t.Fatal("Challenge should have completed")
	}

	var expected = []byte{117, 115, 101, 114, 32, 182, 240, 88, 240, 136, 183, 51, 193, 125, 1, 166, 33, 169, 193, 157, 192}

	if !reflect.DeepEqual(response, expected) {
		t.Fatalf("Response expected was %x, but got %x", expected, response)
	}

	client.Dispose()
}

func mapFromString(s string) map[string]string {
	entries := strings.Split(string(s), ",")
	c := make(map[string]string)
	for _, e := range entries {
		parts := strings.SplitN(e, "=", 2)
		c[parts[0]] = parts[1]
	}
	return c
}

func TestDigestMD5Mechanism(t *testing.T) {
	mechanism := NewDigestMD5Mechanism("imap", "chris", "secret")
	client := NewSaslClient("elwood.innosoft.com", mechanism)
	client.Start()
	challenge := `utf-8,username="chris",realm="elwood.innosoft.com",nonce="OA6MG9tEQGm2hh",nc=00000001,cnonce="OA6MHXh6VqTrRk",digest-uri="imap/elwood.innosoft.com",response=d388dad90d4bbd760a152321f2143af7,qop=auth`
	response, err := client.Step([]byte(challenge))
	if err != nil {
		t.Fatal(err)
	}
	if client.Complete() {
		t.Fatal("Challenge should not have completed")
	}

	var expected = `username="chris",realm="elwood.innosoft.com",qop=auth,nonce="OA6MG9tEQGm2hh",nc=00000001,digest-uri="imap/elwood.innosoft.com"`
	expectedMap := mapFromString(expected)
	actualMap := mapFromString(string(response))
	delete(actualMap, "cnonce")
	delete(actualMap, "response")

	if !reflect.DeepEqual(actualMap, expectedMap) {
		t.Fatalf("Response expected was %s, but got %s", expectedMap, actualMap)
	}

	serverResponse := []byte("rspauth=ea40f60335c427b5527b84dbabcdfffd")
	response, err = client.Step([]byte(serverResponse))
	if !client.Complete() {
		t.Fatal("Challenge should have completed")
	}
	if response != nil {
		t.Fatalf("Response should be nil, instead: %s", response)
	}

	client.Dispose()
}

func TestDigestMD5ChallengeParserHandlesQuotedCommasAndEscapes(t *testing.T) {
	values, err := parseChallenge([]byte(`realm="EXAMPLE, INC",nonce="a\\\"b",qop="auth,auth-int"`))
	if err != nil {
		t.Fatal(err)
	}
	if values["realm"] != "EXAMPLE, INC" || values["nonce"] != `a\"b` || values["qop"] != "auth,auth-int" {
		t.Fatalf("unexpected challenge values: %#v", values)
	}
}

func TestDigestMD5RejectsMalformedChallengeWithoutPanicking(t *testing.T) {
	mechanism := NewDigestMD5Mechanism("hive", "user", "password")
	client := NewSaslClient("hs2.example.com", mechanism)
	if _, err := client.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Step([]byte(`nonce="unterminated`)); err == nil {
		t.Fatal("expected malformed challenge error")
	}
}

func TestDigestMD5RejectsUnsupportedQOP(t *testing.T) {
	mechanism := NewDigestMD5Mechanism("hive", "user", "password")
	client := NewSaslClient("hs2.example.com", mechanism)
	if _, err := client.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Step([]byte(`realm="EXAMPLE.COM",nonce="nonce",qop="auth-conf"`)); err == nil || !strings.Contains(err.Error(), "qop=auth") {
		t.Fatalf("expected unsupported QOP error, got %v", err)
	}
}
