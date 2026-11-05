package main

import (
	"strings"
	"testing"
)

func TestPLDebugTypedWireRejectsUnpairedSurrogateBeforeStart(t *testing.T) {
	r := newRuntimeServer()
	r.plDebugRuntime = true
	line := `{"id":1,"method":"pl_debug_start","params":{"metadataPreparation":"type_only","operationId":"unicode-invalid","agentSessionId":"a","params":[{"name":"X","typedValue":{"kind":"clob","value":"\ud800"}}]}}`
	response, _ := r.handleLine(line)
	if response.Error == nil || !strings.Contains(response.Error.Message, "Unicode") || len(r.plNativeEntries) != 0 {
		t.Fatalf("malformed typed text was normalized before validation: %+v", response.Error)
	}
}

func TestPLDebugTypedUnicodeAcceptsPairsAndLiteralEscapes(t *testing.T) {
	for _, raw := range []string{`"中文🙂\u0000"`, `"\ud83d\ude42"`, `"\\ud800"`, `{"\ud83d\ude42":"x\\\""}`} {
		if err := plDebugValidateTypedUnicode(raw); err != nil {
			t.Fatalf("valid Unicode rejected: %s", raw)
		}
	}
	for _, raw := range []string{`"\udc00"`, `"\ud800x"`, `"\ud800\u0041"`, `"\ud800\ud800"`, string([]byte{'"', 0xed, 0xa0, 0x80, '"'})} {
		if plDebugValidateTypedUnicode(raw) == nil {
			t.Fatal("invalid Unicode accepted")
		}
	}
	r := newRuntimeServer()
	r.plDebugRuntime = true
	response, _ := r.handleLine(`{"id":1,"method":"handshake","params":{"metadataPreparation":"type_only","padding":"\ud800"}}`)
	if response.Error != nil {
		t.Fatal("typed Unicode validation changed the existing handshake contract")
	}
}
