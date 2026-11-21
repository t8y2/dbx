package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// The structured record envelope and bounded anonymous encoder follow the
// existing OceanBase PlDebugCompositeOutput; Oracle uses UCS2 LOB offsets and
// explicit AL32UTF8 accounting instead of the database character-set byte count.
func plDebugCompositeOutputTypes(graph plDebugNativeTypeGraph, roots []plDebugNativeTypeRef) ([]plDebugNativeTypeNode, error) {
	available := map[string]plDebugNativeTypeNode{}
	for _, node := range graph.Nodes {
		if _, exists := available[node.Reference.key()]; exists {
			return nil, errors.New("duplicate composite result type identity")
		}
		available[node.Reference.key()] = node
	}
	seen := map[string]bool{}
	result := []plDebugNativeTypeNode{}
	for len(roots) > 0 {
		ref := roots[0]
		roots = roots[1:]
		if seen[ref.key()] {
			continue
		}
		node, exists := available[ref.key()]
		if !exists || node.Definition.text("TYPECODE") != "PL/SQL RECORD" && node.Definition.text("TYPECODE") != "COLLECTION" && node.Definition.text("TYPECODE") != "OBJECT" {
			return nil, errors.New("composite output type identity is incomplete or has no adapter")
		}
		if node.Definition.text("TYPECODE") == "OBJECT" {
			if ref.PackageName != nil || node.ObjectAccess == nil || node.ObjectAccess.State != "type_only_verified" || node.Definition.text("FINAL") != "YES" && node.Definition.text("FINAL") != "NO" {
				return nil, errors.New("object result type access or finality is not verified")
			}
			if node.Definition.text("FINAL") == "NO" {
				for _, candidate := range graph.Nodes {
					if candidate.Reference.key() != ref.key() && candidate.ObjectAccess != nil && candidate.ObjectAccess.State == "type_only_verified" && plDebugNativeObjectAssignable(graph, candidate.Reference, ref) {
						roots = append(roots, candidate.Reference)
					}
				}
			}
		}
		if len(result) >= 256 {
			return nil, errors.New("record output type graph budget exceeded")
		}
		seen[ref.key()] = true
		result = append(result, node)
		names := map[string]bool{}
		rows, prefix := node.Attributes, "ATTR_TYPE_"
		if node.Definition.text("TYPECODE") == "COLLECTION" {
			if len(node.Collections) != 1 || len(node.Attributes) != 0 {
				return nil, errors.New("collection output shape is incomplete")
			}
			definition := node.Collections[0]
			index := definition.text("INDEX_BY")
			kind := definition.text("COLL_TYPE")
			if index != "" && index != "BINARY_INTEGER" && index != "PLS_INTEGER" && index != "VARCHAR2" {
				return nil, plDebugNativeMissingAdapter{errors.New("collection output index adapter is not implemented")}
			}
			if index != "" && kind != "PL/SQL INDEX TABLE" || index == "" && kind != "TABLE" && kind != "VARYING ARRAY" {
				return nil, errors.New("collection output kind contradicts its index identity")
			}
			rows, prefix = node.Collections, "ELEM_TYPE_"
		}
		for _, attribute := range rows {
			name := attribute.text("ATTR_NAME")
			if prefix == "ATTR_TYPE_" && (name == "" || names[name]) {
				return nil, errors.New("record output attribute identity is incomplete or duplicated")
			}
			names[name] = true
			if attribute[prefix+"MOD"] != nil {
				return nil, plDebugNativeMissingAdapter{fmt.Errorf("record output field %q requires a reference adapter", name)}
			}
			owner, pack, kind := attribute[prefix+"OWNER"], attribute[prefix+"PACKAGE"], attribute.text(prefix+"NAME")
			if owner != nil || pack != nil {
				if owner == nil || kind == "" {
					return nil, errors.New("nested record output identity is incomplete")
				}
				roots = append(roots, plDebugNativeTypeRef{Owner: *owner, PackageName: pack, TypeName: kind})
			} else {
				switch plDebugNativeScalarTypeName(kind) {
				case "NUMBER", "INTEGER", "PL/SQL PLS INTEGER", "PL/SQL BINARY INTEGER", "BINARY_FLOAT", "BINARY_DOUBLE", "BOOLEAN", "PL/SQL BOOLEAN", "VARCHAR2", "CHAR", "NCHAR", "NVARCHAR2", "DATE", "TIMESTAMP", plDebugTimestampTZ, plDebugTimestampLTZ, "CLOB", "NCLOB", "BLOB", "RAW", "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND":
				default:
					return nil, plDebugNativeMissingAdapter{fmt.Errorf("record output field %q has no verified %s leaf encoder", name, kind)}
				}
			}
		}
	}
	return result, nil
}

func plDebugSQLLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

type plDebugCompositeEncoder struct {
	nationalScalar bool
	timezone       bool
	prefix, budget string
	nodes          []plDebugNativeTypeNode
	procedures     map[string]string
}

func newPLDebugCompositeEncoder(nodes []plDebugNativeTypeNode, prefix, budget string) plDebugCompositeEncoder {
	encoder := plDebugCompositeEncoder{prefix: prefix, budget: budget, nodes: nodes, procedures: map[string]string{}}
	for index, node := range nodes {
		encoder.procedures[node.Reference.key()] = fmt.Sprintf("%sJ%d", prefix, index)
		for _, rows := range []struct {
			rows   []plDebugNativeMetadataRow
			prefix string
		}{{node.Attributes, "ATTR_TYPE_"}, {node.Collections, "ELEM_TYPE_"}} {
			for _, row := range rows.rows {
				if row[rows.prefix+"OWNER"] == nil && row[rows.prefix+"PACKAGE"] == nil {
					kind := plDebugNativeScalarTypeName(row.text(rows.prefix + "NAME"))
					encoder.timezone = encoder.timezone || kind == plDebugTimestampTZ || kind == plDebugTimestampLTZ
				}
			}
		}
	}
	return encoder
}

func (encoder plDebugCompositeEncoder) privateNames() []string {
	names := []string{}
	if encoder.timezone {
		for _, suffix := range []string{"TZ9", "LTZ9", "TIME_TEXT", "TZ_INPUT", "LTZ_INPUT", "TZ_PARTS", "LTZ_PARTS", "TZ_VALUE", "LTZ_VALUE"} {
			names = append(names, encoder.prefix+suffix)
		}
	}
	if plDebugCompositeStringIndices(encoder.nodes) {
		for _, suffix := range []string{"SORT0", "COMP0", "SORT1", "COMP1", "KEY_EQ"} {
			names = append(names, encoder.prefix+suffix)
		}
	}
	for _, suffix := range []string{"JSON", "ERRORS", "ROOT_ERRORS", "NODES", "HALT", "DEADLINE", "CLOSE_J", "APP", "FAIL", "Q", "GUARD", "DECIMAL", "NUM", "TXT", "BOOL", "TS9", "DTE", "STM", "CLB", "BLB", "RAWV", "B64"} {
		names = append(names, encoder.prefix+suffix)
	}
	for _, suffix := range []string{"YM9", "DS9", "YM9_VALUE", "DS9_VALUE", "NTV", "NESC", "NCLB", "BFLOAT", "BDOUBLE"} {
		names = append(names, encoder.prefix+suffix)
	}
	for _, node := range encoder.nodes {
		names = append(names, encoder.procedures[node.Reference.key()])
	}
	return names
}

func (encoder plDebugCompositeEncoder) encode(reference plDebugNativeTypeRef, variable string) string {
	return encoder.beginEncode() + "      " + encoder.procedures[reference.key()] + "(" + variable + ",0);\n"
}

func (encoder plDebugCompositeEncoder) beginEncode() string {
	p := encoder.prefix
	return "      " + p + "ROOT_ERRORS := " + p + "ERRORS;\n      IF " + p + "DEADLINE IS NULL THEN " + p + "DEADLINE := SYSTIMESTAMP + INTERVAL '30' SECOND; END IF;\n      SYS.DBMS_LOB.CREATETEMPORARY(" + p + "JSON, TRUE, SYS.DBMS_LOB.CALL);\n"
}

func (encoder plDebugCompositeEncoder) declarations() string {
	p := encoder.prefix
	context := ""
	if plDebugCompositeStringIndices(encoder.nodes) {
		context = p + "SORT0 VARCHAR2(128); " + p + "COMP0 VARCHAR2(128); " + p + "SORT1 VARCHAR2(128); " + p + "COMP1 VARCHAR2(128);\n"
	}
	intervalTypes, intervalProcedures := encoder.intervalDeclarations()
	context += intervalTypes
	if encoder.timezone {
		context += "SUBTYPE " + p + "TZ9 IS TIMESTAMP(9) WITH TIME ZONE;\nSUBTYPE " + p + "LTZ9 IS TIMESTAMP(9) WITH LOCAL TIME ZONE;\n"
	}
	sql := strings.NewReplacer("@P@", p, "@B@", encoder.budget, "@CONTEXT@", context).Replace(plDebugRecordOutputHelpers)
	if plDebugCompositeStringIndices(encoder.nodes) {
		sql += strings.ReplaceAll(plDebugCollectionKeyEqual, "@P@", p)
	}
	sql += encoder.temporalDeclarations()
	if encoder.timezone {
		sql += strings.TrimPrefix(plDebugNativeTimezoneDeclarations(p), plDebugNativeTimezoneTypeDeclarations(p))
		sql += encoder.timezoneDeclarations()
	}
	sql += intervalProcedures
	sql += encoder.nationalDeclarations()
	sql += encoder.binaryFloatDeclarations()
	sql += encoder.lobDeclarations()
	for _, node := range encoder.nodes {
		sql += "PROCEDURE " + encoder.procedures[node.Reference.key()] + "(V IN " + node.Reference.declaration() + ", D IN INTEGER, DECLARED_REF IN VARCHAR2 DEFAULT NULL);\n"
	}
	for _, node := range encoder.nodes {
		if node.Definition.text("TYPECODE") == "COLLECTION" {
			sql += encoder.collectionProcedure(node)
			continue
		}
		sql += "PROCEDURE " + encoder.procedures[node.Reference.key()] + "(V IN " + node.Reference.declaration() + ", D IN INTEGER, DECLARED_REF IN VARCHAR2) IS\n E0 INTEGER := " + p + "ERRORS; FIRST_ITEM BOOLEAN := TRUE; L0 INTEGER; B0 INTEGER; S0 INTEGER := SYS.DBMS_LOB.GETLENGTH(" + p + "JSON); SB INTEGER := " + encoder.budget + "; EC INTEGER;\nBEGIN\n"
		sql += " IF " + p + "HALT OR D>16 OR " + p + "NODES>=8192 OR SYSTIMESTAMP>" + p + "DEADLINE THEN " + p + "HALT:=TRUE; " + p + "ERRORS:=" + p + "ERRORS+1; " + p + "CLOSE_J('{\"state\":\"partial\"}'); RETURN; END IF;\n " + p + "NODES:=" + p + "NODES+1;\n"
		if node.Definition.text("TYPECODE") == "OBJECT" {
			sql += encoder.objectHeader(node)
		} else {
			sql += " " + p + "APP('{\"kind\":\"record\",\"fields\":{');\n"
		}
		for _, attribute := range node.Attributes {
			key, _ := json.Marshal(attribute.text("ATTR_NAME"))
			sql += " IF NOT " + p + "HALT THEN\n L0:=SYS.DBMS_LOB.GETLENGTH(" + p + "JSON); B0:=" + encoder.budget + ";\n BEGIN\n IF NOT FIRST_ITEM THEN " + p + "APP(','); END IF; " + p + "APP(" + plDebugSQLLiteral(string(key)+":") + ");\n EXCEPTION WHEN OTHERS THEN SYS.DBMS_LOB.TRIM(" + p + "JSON,L0); " + encoder.budget + ":=B0; " + p + "HALT:=TRUE; " + p + "ERRORS:=" + p + "ERRORS+1; END;\n IF NOT " + p + "HALT THEN\n"
			variable := "V." + quoteIdentifier(attribute.text("ATTR_NAME"))
			sql += encoder.child(attribute, "ATTR_TYPE_", variable)
			sql += " FIRST_ITEM:=FALSE; END IF; END IF;\n"
		}
		sql += " " + p + "CLOSE_J('},\"complete\":');\n IF E0=" + p + "ERRORS AND NOT " + p + "HALT THEN " + p + "CLOSE_J('true}'); ELSE " + p + "CLOSE_J('false}'); END IF;\nEXCEPTION WHEN OTHERS THEN EC:=SQLCODE; SYS.DBMS_LOB.TRIM(" + p + "JSON,S0); " + encoder.budget + ":=SB; " + p + "ERRORS:=" + p + "ERRORS+1; IF EC IN (-20996,-20997) THEN " + p + "HALT:=TRUE; END IF; " + p + "CLOSE_J('{\"state\":\"error\",\"code\":'||TO_CHAR(EC)||'}');\nEND;\n"
	}
	return sql
}

func (encoder plDebugCompositeEncoder) lobDeclarations() string {
	needed := map[string]bool{}
	for _, node := range encoder.nodes {
		for _, attribute := range node.Attributes {
			if attribute["ATTR_TYPE_OWNER"] == nil {
				needed[attribute.text("ATTR_TYPE_NAME")] = true
			}
		}
		for _, element := range node.Collections {
			if element["ELEM_TYPE_OWNER"] == nil {
				needed[element.text("ELEM_TYPE_NAME")] = true
			}
		}
	}
	sql := ""
	if needed["CLOB"] {
		sql += plDebugRecordClobHelper
	}
	if needed["BLOB"] || needed["RAW"] {
		sql += plDebugRecordBase64Helper
	}
	for _, binary := range []bool{false, true} {
		name, kind, formal, length, read := "RAWV", "raw", "RAW", "SYS.UTL_RAW.LENGTH(V)", "SYS.UTL_RAW.SUBSTR(V,POS,LEAST(3072,N-POS+1))"
		if binary {
			name, kind, formal, length, read = "BLB", "blob", "BLOB", "SYS.DBMS_LOB.GETLENGTH(V)", "SYS.DBMS_LOB.SUBSTR(V,LEAST(3072,N-POS+1),POS)"
		}
		if !needed[formal] {
			continue
		}
		sql += strings.NewReplacer("@NAME@", name, "@KIND@", kind, "@TYPE@", formal, "@LENGTH@", length, "@READ@", read).Replace(plDebugRecordBinaryHelper)
	}
	return strings.NewReplacer("@P@", encoder.prefix, "@B@", encoder.budget).Replace(sql)
}

const plDebugRecordBase64Helper = `
FUNCTION @P@B64(V RAW) RETURN VARCHAR2 IS BEGIN
 RETURN REPLACE(REPLACE(SYS.UTL_RAW.CAST_TO_VARCHAR2(SYS.UTL_ENCODE.BASE64_ENCODE(V)),CHR(13),''),CHR(10),'');
END;
`

const plDebugRecordClobHelper = `
PROCEDURE @P@CLB(V CLOB) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; POS INTEGER:=1; N INTEGER; CHUNK VARCHAR2(32767); EC INTEGER; C0 INTEGER; CB INTEGER; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"clob","state":"null","value":null}'); RETURN; END IF;
 N:=SYS.DBMS_LOB.GETLENGTH(V); @P@APP('{"kind":"clob","value":"');
 WHILE POS<=N LOOP
  C0:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); CB:=@B@;
  BEGIN
   CHUNK:=SYS.DBMS_LOB.SUBSTR(V,4096,POS);
   IF CHUNK IS NULL THEN RAISE_APPLICATION_ERROR(-20999,'LOB read made no progress'); END IF;
   POS:=POS+LENGTH2(CHUNK);
   CHUNK:=REPLACE(REPLACE(CHUNK,CHR(92),CHR(92)||CHR(92)),CHR(34),CHR(92)||CHR(34));
   FOR K IN 0..31 LOOP CHUNK:=REPLACE(CHUNK,CHR(K),CHR(92)||'u00'||SUBSTR('0123456789abcdef',TRUNC(K/16)+1,1)||SUBSTR('0123456789abcdef',MOD(K,16)+1,1)); END LOOP;
   @P@APP(CHUNK);
  EXCEPTION WHEN OTHERS THEN EC:=SQLCODE; SYS.DBMS_LOB.TRIM(@P@JSON,C0); @B@:=CB; @P@ERRORS:=@P@ERRORS+1;
   IF EC IN (-20996,-20997) THEN @P@HALT:=TRUE; END IF;
   @P@CLOSE_J('","state":"partial","code":'||TO_CHAR(EC)||'}'); RETURN;
  END;
 END LOOP;
 IF N=0 THEN @P@CLOSE_J('","state":"empty"}'); ELSE @P@CLOSE_J('","state":"value"}'); END IF;
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
`

const plDebugRecordBinaryHelper = `
PROCEDURE @P@@NAME@(V @TYPE@) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; POS INTEGER:=1; N INTEGER; CHUNK RAW(32767); EC INTEGER; C0 INTEGER; CB INTEGER; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"@KIND@","state":"null","value":null}'); RETURN; END IF;
 N:=@LENGTH@; @P@APP('{"kind":"@KIND@","value":{"encoding":"base64","data":"');
 WHILE POS<=N LOOP
  C0:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); CB:=@B@;
  BEGIN
   CHUNK:=@READ@;
   IF CHUNK IS NULL THEN RAISE_APPLICATION_ERROR(-20999,'binary read made no progress'); END IF;
   IF SYS.UTL_RAW.LENGTH(CHUNK)<>LEAST(3072,N-POS+1) THEN RAISE_APPLICATION_ERROR(-20999,'binary read length changed'); END IF;
   POS:=POS+SYS.UTL_RAW.LENGTH(CHUNK); @P@APP(@P@B64(CHUNK));
  EXCEPTION WHEN OTHERS THEN EC:=SQLCODE; SYS.DBMS_LOB.TRIM(@P@JSON,C0); @B@:=CB; @P@ERRORS:=@P@ERRORS+1;
   IF EC IN (-20996,-20997) THEN @P@HALT:=TRUE; END IF;
   @P@CLOSE_J('"},"state":"partial","code":'||TO_CHAR(EC)||'}'); RETURN;
  END;
 END LOOP;
 IF N=0 THEN @P@CLOSE_J('"},"state":"empty"}'); ELSE @P@CLOSE_J('"},"state":"value"}'); END IF;
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
`

func (encoder plDebugCompositeEncoder) temporalDeclarations() string {
	p := encoder.prefix
	sql := ""
	for _, timestamp := range []bool{false, true} {
		name, kind, formal := "DTE", "date", "DATE"
		if timestamp {
			name, kind, formal = "STM", "timestamp", p+"TS9"
		}
		sql += "PROCEDURE " + p + name + "(V IN " + formal + ") IS T TIMESTAMP(9); TEXT_VALUE VARCHAR2(128); OK BOOLEAN; L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(" + p + "JSON); B0 INTEGER:=" + encoder.budget + "; BEGIN\n " + p + "GUARD; T:=V; TEXT_VALUE:=" + plDebugNativeTemporalExport("T", timestamp) + ";\n"
		sql += " IF T IS NULL THEN " + p + "APP('{\"kind\":\"" + kind + "\",\"state\":\"null\",\"value\":null}');\n ELSE\n IF TEXT_VALUE='outside_supported_calendar_range' THEN RAISE_APPLICATION_ERROR(-20995,'temporal calendar range'); END IF;\n " + p + "APP('{\"kind\":\"" + kind + "\",\"state\":\"value\",\"value\":'); OK:=" + p + "Q(TEXT_VALUE); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; " + p + "CLOSE_J('}'); END IF;\nEXCEPTION WHEN OTHERS THEN " + p + "FAIL(SQLCODE,L0,B0); END;\n"
	}
	return sql
}

const plDebugRecordOutputHelpers = `
@P@JSON CLOB;
@P@ERRORS INTEGER := 0;
@P@ROOT_ERRORS INTEGER := 0;
@P@NODES INTEGER := 0;
@P@HALT BOOLEAN := FALSE;
@P@DEADLINE TIMESTAMP WITH TIME ZONE;
@CONTEXT@
SUBTYPE @P@TS9 IS TIMESTAMP(9);
PROCEDURE @P@CLOSE_J(V VARCHAR2) IS COST INTEGER; BEGIN
 COST := SYS.UTL_RAW.LENGTH(SYS.UTL_I18N.STRING_TO_RAW(V,'AL32UTF8'));
 IF COST IS NULL OR COST>@B@ THEN RAISE_APPLICATION_ERROR(-20997,'JSON closure budget'); END IF;
 SYS.DBMS_LOB.WRITEAPPEND(@P@JSON,LENGTH2(V),V); @B@:=@B@-COST;
END;
PROCEDURE @P@APP(V VARCHAR2) IS COST INTEGER; BEGIN
 COST:=SYS.UTL_RAW.LENGTH(SYS.UTL_I18N.STRING_TO_RAW(V,'AL32UTF8'));
 IF @P@HALT OR COST IS NULL OR COST>@B@-4096 OR SYSTIMESTAMP>@P@DEADLINE THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;
 @P@CLOSE_J(V);
END;
PROCEDURE @P@FAIL(EC INTEGER,L0 INTEGER,B0 INTEGER) IS BEGIN
 SYS.DBMS_LOB.TRIM(@P@JSON,L0); @B@:=B0; @P@ERRORS:=@P@ERRORS+1;
 IF EC IN (-20996,-20997) THEN @P@HALT:=TRUE; END IF;
 @P@CLOSE_J('{"state":"partial","code":'||TO_CHAR(EC)||'}');
END;
FUNCTION @P@Q(V VARCHAR2) RETURN BOOLEAN IS POS INTEGER:=1; CHUNK VARCHAR2(32767); BEGIN
 @P@APP('"');
 WHILE POS<=LENGTH(V) LOOP
  CHUNK:=SUBSTR(V,POS,1024); POS:=POS+LENGTH(CHUNK);
  CHUNK:=REPLACE(REPLACE(CHUNK,CHR(92),CHR(92)||CHR(92)),CHR(34),CHR(92)||CHR(34));
  FOR K IN 0..31 LOOP CHUNK:=REPLACE(CHUNK,CHR(K),CHR(92)||'u00'||SUBSTR('0123456789abcdef',TRUNC(K/16)+1,1)||SUBSTR('0123456789abcdef',MOD(K,16)+1,1)); END LOOP;
  BEGIN @P@APP(CHUNK); EXCEPTION WHEN OTHERS THEN @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; @P@CLOSE_J('"'); RETURN FALSE; END;
 END LOOP;
 @P@CLOSE_J('"'); RETURN TRUE;
END;
PROCEDURE @P@GUARD IS BEGIN
 IF @P@HALT OR @P@NODES>=8192 OR SYSTIMESTAMP>@P@DEADLINE THEN @P@HALT:=TRUE; RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;
 @P@NODES:=@P@NODES+1;
END;
FUNCTION @P@DECIMAL(V NUMBER) RETURN VARCHAR2 IS X NUMBER:=ABS(V); E INTEGER:=0; DIGIT INTEGER; T VARCHAR2(256); BEGIN
 IF X=0 THEN RETURN '0'; END IF;
 WHILE X>=10 LOOP X:=X/10; E:=E+1; END LOOP;
 WHILE X<1 LOOP X:=X*10; E:=E-1; END LOOP;
 IF V<0 THEN T:='-'; END IF;
 FOR K IN 1..40 LOOP DIGIT:=TRUNC(X); T:=T||SUBSTR('0123456789',DIGIT+1,1); X:=(X-DIGIT)*10; EXIT WHEN X=0; IF K=1 THEN T:=T||'.'; END IF; END LOOP;
 IF X<>0 THEN RAISE_APPLICATION_ERROR(-20998,'numeric precision exceeded'); END IF;
 RETURN T||'E'||TO_CHAR(E,'FM9990','NLS_NUMERIC_CHARACTERS=''.,''');
END;
PROCEDURE @P@NUM(V NUMBER) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; OK BOOLEAN; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"number","state":"null","value":null}');
 ELSE @P@APP('{"kind":"number","state":"value","value":'); OK:=@P@Q(@P@DECIMAL(V)); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; @P@CLOSE_J('}'); END IF;
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
PROCEDURE @P@TXT(V VARCHAR2) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; OK BOOLEAN; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"text","state":"null","value":null}');
 ELSE @P@APP('{"kind":"text","value":'); OK:=@P@Q(V); IF OK THEN @P@CLOSE_J(',"state":"value"}'); ELSE @P@CLOSE_J(',"state":"partial"}'); END IF; END IF;
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
PROCEDURE @P@BOOL(V BOOLEAN) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
 @P@GUARD;
 IF V IS NULL THEN @P@APP('{"kind":"boolean","state":"null","value":null}');
 ELSIF V THEN @P@APP('{"kind":"boolean","state":"value","value":true}');
 ELSE @P@APP('{"kind":"boolean","state":"value","value":false}'); END IF;
EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
`
