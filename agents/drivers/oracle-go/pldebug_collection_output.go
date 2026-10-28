package main

import "strings"

func plDebugCompositeStringIndices(nodes []plDebugNativeTypeNode) bool {
	for _, node := range nodes {
		for _, definition := range node.Collections {
			if definition.text("INDEX_BY") == "VARCHAR2" {
				return true
			}
		}
	}
	return false
}

func plDebugCompositeCaptureContext(nodes []plDebugNativeTypeNode, prefix string) string {
	if !plDebugCompositeStringIndices(nodes) {
		return ""
	}
	return "    SELECT MAX(CASE WHEN PARAMETER='NLS_SORT' THEN VALUE END), MAX(CASE WHEN PARAMETER='NLS_COMP' THEN VALUE END) INTO " + prefix + "SORT0," + prefix + "COMP0 FROM SYS.NLS_SESSION_PARAMETERS WHERE PARAMETER IN ('NLS_SORT','NLS_COMP');\n"
}

func (encoder plDebugCompositeEncoder) child(row plDebugNativeMetadataRow, key, variable string) string {
	if owner := row[key+"OWNER"]; owner != nil {
		ref := plDebugNativeTypeRef{Owner: *owner, PackageName: row[key+"PACKAGE"], TypeName: row.text(key + "NAME")}
		return " " + encoder.procedures[ref.key()] + "(" + variable + ",D+1);\n"
	}
	procedure := "TXT"
	switch plDebugNativeScalarTypeName(row.text(key + "NAME")) {
	case plDebugTimestampTZ:
		procedure = "TZ_VALUE"
	case plDebugTimestampLTZ:
		procedure = "LTZ_VALUE"
	case "BINARY_FLOAT":
		procedure = "BFLOAT"
	case "BINARY_DOUBLE":
		procedure = "BDOUBLE"
	case "NCHAR", "NVARCHAR2":
		procedure = "NTV"
	case "NUMBER", "INTEGER", "PL/SQL PLS INTEGER", "PL/SQL BINARY INTEGER":
		procedure = "NUM"
	case "BOOLEAN", "PL/SQL BOOLEAN":
		procedure = "BOOL"
	case "DATE":
		procedure = "DTE"
	case "TIMESTAMP":
		procedure = "STM"
	case "INTERVAL YEAR TO MONTH":
		procedure = "YM9_VALUE"
	case "INTERVAL DAY TO SECOND":
		procedure = "DS9_VALUE"
	case "CLOB":
		procedure = "CLB"
	case "NCLOB":
		procedure = "NCLB"
	case "BLOB":
		procedure = "BLB"
	case "RAW":
		procedure = "RAWV"
	}
	return " " + encoder.prefix + procedure + "(" + variable + ");\n"
}

func (encoder plDebugCompositeEncoder) collectionProcedure(node plDebugNativeTypeNode) string {
	p := encoder.prefix
	definition := node.Collections[0]
	indexType, key, comparison := "BINARY_INTEGER", "TO_CHAR(I,'TM9','NLS_NUMERIC_CHARACTERS=''.,''')", "SEEN(K)=I"
	context := ""
	if definition.text("INDEX_BY") == "VARCHAR2" {
		indexType, key, comparison = "VARCHAR2(32767)", "I", p+"KEY_EQ(SEEN(K),I)"
		context = ` BEGIN
  IF @P@SORT1 IS NULL OR @P@COMP1 IS NULL THEN
   SELECT MAX(CASE WHEN PARAMETER='NLS_SORT' THEN VALUE END),MAX(CASE WHEN PARAMETER='NLS_COMP' THEN VALUE END) INTO @P@SORT1,@P@COMP1 FROM SYS.NLS_SESSION_PARAMETERS WHERE PARAMETER IN ('NLS_SORT','NLS_COMP');
  END IF;
 EXCEPTION WHEN OTHERS THEN @P@ERRORS:=@P@ERRORS+1; @P@APP('{"kind":"collection","state":"error","error":"NLS context unavailable","complete":false}'); RETURN; END;
 IF @P@SORT0 IS NULL OR @P@COMP0 IS NULL OR @P@SORT1 IS NULL OR @P@COMP1 IS NULL OR @P@SORT0<>@P@SORT1 OR @P@COMP0<>@P@COMP1 THEN
  @P@ERRORS:=@P@ERRORS+1; @P@APP('{"kind":"collection","state":"error","error":"NLS context changed","complete":false}'); RETURN;
 END IF;
`
	}
	template := `PROCEDURE @PROC@(V IN @TYPE@,D IN INTEGER,DECLARED_REF IN VARCHAR2) IS
 E0 INTEGER:=@P@ERRORS; FIRST_ITEM BOOLEAN:=TRUE; N INTEGER; C INTEGER:=0; L0 INTEGER; B0 INTEGER;
 S0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); SB INTEGER:=@B@; EC INTEGER; DUPLICATE_KEY BOOLEAN;
 I @INDEX@; TYPE SEEN_T IS TABLE OF @INDEX@ INDEX BY BINARY_INTEGER; SEEN SEEN_T;
BEGIN
 IF @P@HALT OR D>16 OR @P@NODES>=8192 OR SYSTIMESTAMP>@P@DEADLINE THEN @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; @P@CLOSE_J('{"state":"partial"}'); RETURN; END IF;
 @P@NODES:=@P@NODES+1;
 BEGIN N:=V.COUNT; EXCEPTION WHEN COLLECTION_IS_NULL THEN @P@APP('{"kind":"collection","state":"null","entries":null}'); RETURN; END;
 IF N=0 THEN @P@APP('{"kind":"collection","entries":[],"complete":true}'); RETURN; END IF;
@CONTEXT@
 @P@APP('{"kind":"collection","entries":[');
 BEGIN I:=V.FIRST; EXCEPTION WHEN OTHERS THEN @P@ERRORS:=@P@ERRORS+1; I:=NULL; END;
 WHILE I IS NOT NULL LOOP
  EXIT WHEN @P@HALT;
  IF C>=8192 OR @P@NODES>=8192 OR SYSTIMESTAMP>@P@DEADLINE THEN @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; EXIT; END IF;
  DUPLICATE_KEY:=FALSE;
  FOR K IN 1..C LOOP IF @COMPARE@ THEN DUPLICATE_KEY:=TRUE; EXIT; END IF; END LOOP;
  IF DUPLICATE_KEY THEN @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; EXIT; END IF;
  L0:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0:=@B@;
  BEGIN
   IF NOT FIRST_ITEM THEN @P@APP(','); END IF;
   @P@APP('{"key":'); IF NOT @P@Q(@KEY@) THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; @P@APP(',"value":');
  EXCEPTION WHEN OTHERS THEN SYS.DBMS_LOB.TRIM(@P@JSON,L0); @B@:=B0; @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; EXIT; END;
@CHILD@
  @P@CLOSE_J('}'); FIRST_ITEM:=FALSE; C:=C+1; SEEN(C):=I;
  BEGIN I:=V.NEXT(I); EXCEPTION WHEN OTHERS THEN @P@ERRORS:=@P@ERRORS+1; I:=NULL; END;
 END LOOP;
 IF C<>N THEN @P@ERRORS:=@P@ERRORS+1; END IF;
 @P@CLOSE_J('],"complete":');
 IF E0=@P@ERRORS AND NOT @P@HALT THEN @P@CLOSE_J('true}'); ELSE @P@CLOSE_J('false}'); END IF;
EXCEPTION WHEN OTHERS THEN EC:=SQLCODE; SYS.DBMS_LOB.TRIM(@P@JSON,S0); @B@:=SB; @P@ERRORS:=@P@ERRORS+1;
 IF EC IN (-20996,-20997) THEN @P@HALT:=TRUE; END IF;
 @P@CLOSE_J('{"state":"error","code":'||TO_CHAR(EC)||'}');
END;
`
	template = strings.NewReplacer("@PROC@", encoder.procedures[node.Reference.key()], "@TYPE@", node.Reference.declaration(), "@INDEX@", indexType, "@COMPARE@", comparison, "@KEY@", key, "@CONTEXT@", context, "@CHILD@", encoder.child(definition, "ELEM_TYPE_", "V(I)")).Replace(template)
	return strings.NewReplacer("@P@", p, "@B@", encoder.budget).Replace(template)
}

const plDebugCollectionKeyEqual = `
FUNCTION @P@KEY_EQ(A VARCHAR2,B VARCHAR2) RETURN BOOLEAN IS POS INTEGER:=1; BEGIN
 IF LENGTH(A)<>LENGTH(B) THEN RETURN FALSE; END IF;
 WHILE POS<=LENGTH(A) LOOP
  IF SYS.UTL_RAW.CAST_TO_RAW(SUBSTR(A,POS,1024))<>SYS.UTL_RAW.CAST_TO_RAW(SUBSTR(B,POS,1024)) THEN RETURN FALSE; END IF;
  POS:=POS+1024;
 END LOOP;
 RETURN TRUE;
END;
`
