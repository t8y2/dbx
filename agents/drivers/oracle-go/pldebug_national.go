package main

import (
	"fmt"
	"strings"
	"unicode/utf16"
)

const plDebugNationalChunkType = "DBX_NATIONAL_CHUNK"

type plDebugNationalInput struct{ chunks []string }

func (a plDebugNativeArgument) national() bool { return a.Type == "NCHAR" || a.Type == "NVARCHAR2" }

func plDebugEncodeNationalInput(value string) plDebugNationalInput {
	result := plDebugNationalInput{}
	var chunk strings.Builder
	for _, character := range value {
		encoded := ""
		for _, unit := range utf16.Encode([]rune{character}) {
			encoded += fmt.Sprintf("\\%04X", unit)
		}
		if chunk.Len()+len(encoded) > 30000 {
			result.chunks = append(result.chunks, chunk.String())
			chunk.Reset()
		}
		chunk.WriteString(encoded)
	}
	result.chunks = append(result.chunks, chunk.String())
	return result
}

func (builder *plDebugCollectionInitializer) scalar(input plDebugNativeInput, variable string) {
	if input.argument.timezone() {
		builder.timezone(input, variable)
		return
	}
	if input.argument.Type == "NCLOB" {
		builder.nclob(input, variable)
		return
	}
	if !input.argument.national() {
		builder.operations = append(builder.operations, plDebugCollectionOperation{variable: variable, input: &input})
		return
	}
	local := builder.local("NVARCHAR2(32767)")
	builder.statement(local + " := NULL;")
	chunks := []string{""}
	if value, ok := input.value.(plDebugNationalInput); ok {
		chunks = value.chunks
	}
	for _, chunk := range chunks {
		binding := plDebugNativeInput{argument: plDebugNativeArgument{Mode: "IN", Type: plDebugNationalChunkType}, state: "value", value: chunk}
		builder.operations = append(builder.operations, plDebugCollectionOperation{variable: local, input: &binding})
	}
	builder.statement(variable + " := " + local + ";")
}

func (builder *plDebugCollectionInitializer) nclob(input plDebugNativeInput, variable string) {
	if input.state == "null" {
		builder.statement(variable + " := NULL;")
		return
	}
	owned := builder.local("NCLOB")
	chunk := builder.local("NVARCHAR2(16383)")
	builder.statement("SYS.DBMS_LOB.CREATETEMPORARY(" + owned + ",TRUE,SYS.DBMS_LOB.CALL);")
	value := input.value.(plDebugLobInput)
	for _, encoded := range plDebugEncodeNationalInput(value.text).chunks {
		if encoded == "" {
			continue
		}
		builder.statement(chunk + " := NULL;")
		binding := plDebugNativeInput{argument: plDebugNativeArgument{Mode: "IN", Type: plDebugNationalChunkType}, state: "value", value: encoded}
		builder.operations = append(builder.operations, plDebugCollectionOperation{variable: chunk, input: &binding})
		builder.statement("SYS.DBMS_LOB.WRITEAPPEND(" + owned + ",LENGTH2(" + chunk + ")," + chunk + ");")
	}
	builder.statement(variable + " := " + owned + ";")
}

func (input *plDebugRecordInput) needsInitializer() bool {
	if len(input.collections) > 0 || len(input.objects) > 0 {
		return true
	}
	for _, leaf := range input.leaves {
		if leaf.input.argument.national() || leaf.input.argument.Type == "NCLOB" || leaf.input.argument.timezone() {
			return true
		}
	}
	return false
}

const plDebugNationalOutputHelper = `
PROCEDURE @P@NESC(V NVARCHAR2) IS A VARCHAR2(20); C INTEGER; FRAGMENT VARCHAR2(30); BUFFER_VALUE VARCHAR2(30000); BEGIN
 FOR POS IN 1..LENGTHC(V) LOOP
  A:=ASCIISTR(SUBSTRC(V,POS,1));
  IF LENGTH(A)>1 THEN FRAGMENT:=REPLACE(A,CHR(92),CHR(92)||'u');
  ELSE C:=ASCII(A); IF C<32 THEN FRAGMENT:=CHR(92)||'u00'||SUBSTR('0123456789abcdef',TRUNC(C/16)+1,1)||SUBSTR('0123456789abcdef',MOD(C,16)+1,1);
   ELSIF C=34 OR C=92 THEN FRAGMENT:=CHR(92)||A; ELSE FRAGMENT:=A; END IF;
  END IF;
   IF NVL(LENGTH(BUFFER_VALUE),0)+LENGTH(FRAGMENT)>LEAST(30000,@B@-4096) THEN @P@APP(BUFFER_VALUE); BUFFER_VALUE:=NULL; END IF;
   IF LENGTH(FRAGMENT)>@B@-4096 THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;
   BUFFER_VALUE:=BUFFER_VALUE||FRAGMENT;
 END LOOP;
 IF BUFFER_VALUE IS NOT NULL THEN @P@APP(BUFFER_VALUE); END IF;
END;
PROCEDURE @P@NTV(V NVARCHAR2) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"text","state":"null","value":null}'); RETURN; END IF;
 @P@APP('{"kind":"text","state":"value","value":"');
 BEGIN @P@NESC(V); EXCEPTION WHEN OTHERS THEN @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; END;
 @P@CLOSE_J('"}');
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
PROCEDURE @P@NCLB(V NCLOB) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; TOTAL_UNITS INTEGER; RETAINED_UNITS INTEGER:=0; POSITION_UNITS INTEGER:=1; CHUNK_VALUE NVARCHAR2(16383); CHUNK_UNITS INTEGER; L1 INTEGER; B1 INTEGER; FAILED BOOLEAN:=FALSE; FAILURE_CODE INTEGER;
BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"nclob","state":"null","value":null,"sourceLength":null,"retainedLength":0,"lengthUnit":"utf16"}'); RETURN; END IF;
 TOTAL_UNITS:=SYS.DBMS_LOB.GETLENGTH(V);
 @P@APP('{"kind":"nclob","value":"');
 WHILE POSITION_UNITS<=TOTAL_UNITS LOOP
  L1:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B1:=@B@;
  BEGIN
   CHUNK_VALUE:=SYS.DBMS_LOB.SUBSTR(V,4096,POSITION_UNITS); CHUNK_UNITS:=LENGTH2(CHUNK_VALUE);
   IF CHUNK_UNITS IS NULL OR CHUNK_UNITS=0 THEN RAISE_APPLICATION_ERROR(-20994,'national LOB read made no progress'); END IF;
   @P@NESC(CHUNK_VALUE);
   POSITION_UNITS:=POSITION_UNITS+CHUNK_UNITS; RETAINED_UNITS:=RETAINED_UNITS+CHUNK_UNITS;
  EXCEPTION WHEN OTHERS THEN
   FAILURE_CODE:=SQLCODE; SYS.DBMS_LOB.TRIM(@P@JSON,L1); @B@:=B1; FAILED:=TRUE; @P@ERRORS:=@P@ERRORS+1;
   IF FAILURE_CODE=-20996 THEN @P@HALT:=TRUE; END IF; EXIT;
  END;
 END LOOP;
 @P@CLOSE_J('","state":"'||CASE WHEN FAILED THEN 'partial' WHEN TOTAL_UNITS=0 THEN 'empty' ELSE 'value' END||'","sourceLength":'||TO_CHAR(TOTAL_UNITS,'TM9','NLS_NUMERIC_CHARACTERS=''.,''')||',"retainedLength":'||TO_CHAR(RETAINED_UNITS,'TM9','NLS_NUMERIC_CHARACTERS=''.,''')||',"lengthUnit":"utf16"'||CASE WHEN FAILED THEN ',"errorCode":'||TO_CHAR(FAILURE_CODE,'TM9','NLS_NUMERIC_CHARACTERS=''.,''') ELSE '' END||'}');
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
`

func (encoder plDebugCompositeEncoder) nationalDeclarations() string {
	if encoder.nationalScalar {
		return strings.NewReplacer("@P@", encoder.prefix, "@B@", encoder.budget).Replace(plDebugNationalOutputHelper)
	}
	for _, node := range encoder.nodes {
		for _, row := range node.Attributes {
			kind := row.text("ATTR_TYPE_NAME")
			if kind == "NCHAR" || kind == "NVARCHAR2" || kind == "NCLOB" {
				return strings.NewReplacer("@P@", encoder.prefix, "@B@", encoder.budget).Replace(plDebugNationalOutputHelper)
			}
		}
		for _, row := range node.Collections {
			kind := row.text("ELEM_TYPE_NAME")
			if kind == "NCHAR" || kind == "NVARCHAR2" || kind == "NCLOB" {
				return strings.NewReplacer("@P@", encoder.prefix, "@B@", encoder.budget).Replace(plDebugNationalOutputHelper)
			}
		}
	}
	return ""
}
