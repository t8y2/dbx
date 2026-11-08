package main

import (
	"errors"
	"strings"
)

func (a plDebugNativeArgument) binaryFloat() bool {
	return a.Type == "BINARY_FLOAT" || a.Type == "BINARY_DOUBLE"
}

func plDebugNativeBinaryFloatHex(value string, double bool) (string, error) {
	width := 8
	if double {
		width = 16
	}
	if len(value) != width {
		return "", errors.New("binary floating-point input requires fixed-width big-endian hexadecimal text")
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return "", errors.New("binary floating-point input contains a non-hexadecimal character")
		}
	}
	return strings.ToUpper(value), nil
}

func (encoder plDebugCompositeEncoder) binaryFloatDeclarations() string {
	result := ""
	for _, kind := range []string{"BINARY_FLOAT", "BINARY_DOUBLE"} {
		needed := false
		for _, node := range encoder.nodes {
			for _, row := range node.Attributes {
				needed = needed || row.text("ATTR_TYPE_NAME") == kind
			}
			for _, row := range node.Collections {
				needed = needed || row.text("ELEM_TYPE_NAME") == kind
			}
		}
		if !needed {
			continue
		}
		name := "BFLOAT"
		if kind == "BINARY_DOUBLE" {
			name = "BDOUBLE"
		}
		template := `PROCEDURE @P@@NAME@(V @TYPE@) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"@KIND@","state":"null","value":null}');
 ELSE @P@APP('{"kind":"@KIND@","state":"value","value":"'||RAWTOHEX(SYS.UTL_RAW.CAST_FROM_@TYPE@(V,SYS.UTL_RAW.BIG_ENDIAN))||'"}'); END IF;
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
`
		result += strings.NewReplacer("@P@", encoder.prefix, "@B@", encoder.budget, "@NAME@", name, "@TYPE@", kind, "@KIND@", strings.ToLower(kind)).Replace(template)
	}
	return result
}
