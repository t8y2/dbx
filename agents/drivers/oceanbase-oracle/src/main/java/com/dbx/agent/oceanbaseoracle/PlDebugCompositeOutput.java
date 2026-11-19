package com.dbx.agent.oceanbaseoracle;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Private anonymous-block encoders. Collection keys come from FIRST/NEXT, never JDBC row positions. */
final class PlDebugCompositeOutput {
    private static final Gson JSON = new GsonBuilder().serializeNulls().create();
    private final Map<PlDebugTypeGraph.Ref, PlDebugTypeGraph.Node> nodes = new LinkedHashMap<>();
    private final Map<PlDebugTypeGraph.Ref, String> procedures = new LinkedHashMap<>();
    private final String prefix;
    private final String budget;
    private boolean temporal;
    private boolean raw;
    private final Set<String> binaryFloats=new HashSet<>();
    private final Set<String> intervals=new HashSet<>();
    private final Set<String> lobs=new HashSet<>();

    PlDebugCompositeOutput(PlDebugTypeGraph.Graph graph, String prefix, String budget) {
        this(graph,prefix,budget,graph.nodes().stream().map(PlDebugTypeGraph.Node::reference).toList());
    }

    PlDebugCompositeOutput(PlDebugTypeGraph.Graph graph, String prefix, String budget, java.util.List<PlDebugTypeGraph.Ref> roots) {
        if (!prefix.matches("[A-Z][A-Z0-9_]{0,16}") || !budget.matches("[A-Z][A-Z0-9_]*")) throw new IllegalArgumentException("Invalid private encoder identity");
        this.prefix = prefix;
        this.budget = budget;
        if (graph.nodes().size() > 256) throw new IllegalArgumentException("Composite type graph budget exceeded");
        Map<PlDebugTypeGraph.Ref,PlDebugTypeGraph.Node> available=new LinkedHashMap<>();
        for(var node:graph.nodes())if(available.putIfAbsent(node.reference(),node)!=null)throw new IllegalArgumentException("Duplicate composite type identity");
        var pending=new java.util.ArrayDeque<>(roots);
        while(!pending.isEmpty()) {
            var ref=pending.removeFirst();if(nodes.containsKey(ref))continue;
            var node=available.get(ref);if(node==null)throw new IllegalArgumentException("Incomplete composite result type identity");
            nodes.put(ref,node);procedures.put(ref,prefix+"J"+procedures.size());
            for(var row:node.attributes())addChild(pending,row,"ATTR_TYPE_");
            for(var row:node.collections())addChild(pending,row,"ELEM_TYPE_");
            if("OBJECT".equals(node.definition().get("TYPECODE"))&&"NO".equals(node.definition().get("FINAL")))for(var candidate:available.values())if(verifiedAccess(candidate)&&subtypeOf(candidate.reference(),ref,available))pending.add(candidate.reference());
        }
        for (var node : nodes.values()) validate(node);
    }

    private static void addChild(java.util.ArrayDeque<PlDebugTypeGraph.Ref> pending,Map<String,String> row,String prefix) {
        if(row.get(prefix+"OWNER")!=null||row.get(prefix+"PACKAGE")!=null)pending.add(new PlDebugTypeGraph.Ref(row.get(prefix+"OWNER"),row.get(prefix+"PACKAGE"),row.get(prefix+"NAME")));
    }

    String valueVariable() { return prefix + "JSON"; }
    boolean temporal(){return temporal;}
    String completeExpression() { return prefix + "ERRORS = " + prefix + "ROOT_ERRORS AND NOT " + prefix + "HALT"; }

    Set<String> privateNames() {
        Set<String> names = new HashSet<>(procedures.values());
        for (String suffix : java.util.List.of("JSON", "ERRORS", "ROOT_ERRORS", "NODES", "HALT", "ENTRY_LEN", "ENTRY_LEFT", "SORT0", "COMP0", "SORT1", "COMP1", "DEADLINE", "CLOSE_J", "APP", "FAIL", "Q", "NQ", "NTV", "GUARD", "DECIMAL", "NUM", "TXT", "BOOL", "VAL")) names.add(prefix + suffix);
        if(temporal)names.add(prefix+"TC");
        if(raw)names.add(prefix+"RAWV");
        for(String type:binaryFloats)names.add(prefix+("BINARY_FLOAT".equals(type)?"BFLOAT":"BDOUBLE"));
        for(String type:intervals) {String name=prefix+("INTERVAL DAY TO SECOND".equals(type)?"DS9":"YM9");names.add(name);names.add(name+"_VALUE");}
        for(String type:lobs)names.add(prefix+("CLOB".equals(type)?"CLB":"BLB"));
        return Set.copyOf(names);
    }

    String captureContext() {
        return "SELECT MAX(CASE WHEN PARAMETER='NLS_SORT' THEN VALUE END), MAX(CASE WHEN PARAMETER='NLS_COMP' THEN VALUE END) INTO "
            + prefix + "SORT0," + prefix + "COMP0 FROM SYS.NLS_SESSION_PARAMETERS WHERE PARAMETER IN ('NLS_SORT','NLS_COMP');\n";
    }

    String beginExport() {
        return "SELECT MAX(CASE WHEN PARAMETER='NLS_SORT' THEN VALUE END), MAX(CASE WHEN PARAMETER='NLS_COMP' THEN VALUE END) INTO "
            + prefix + "SORT1," + prefix + "COMP1 FROM SYS.NLS_SESSION_PARAMETERS WHERE PARAMETER IN ('NLS_SORT','NLS_COMP');\n"
            + prefix + "DEADLINE := SYSTIMESTAMP + INTERVAL '30' SECOND;\n";
    }

    String encode(PlDebugTypeGraph.Ref reference, String variable) {
        if (!variable.matches("[A-Z][A-Z0-9_]*") || !procedures.containsKey(reference)) throw new IllegalArgumentException("Unknown composite result identity");
        return prefix + "ROOT_ERRORS := " + prefix + "ERRORS;\n" + valueVariable() + " := NULL;\n"
            + "SYS.DBMS_LOB.CREATETEMPORARY(" + valueVariable() + ",TRUE);\n" + procedures.get(reference) + "(" + variable + ",0);\n";
    }

    String encodeNational(String variable) {
        if(!variable.matches("[A-Z][A-Z0-9_]*"))throw new IllegalArgumentException("Invalid national result identity");
        return prefix+"ROOT_ERRORS := "+prefix+"ERRORS;\n"+valueVariable()+" := NULL;\nSYS.DBMS_LOB.CREATETEMPORARY("+valueVariable()+",TRUE);\n"+prefix+"NTV("+variable+");\n";
    }

    String declarations() {
        StringBuilder sql = new StringBuilder(helperDeclarations());
        for (var node : nodes.values()) sql.append("PROCEDURE ").append(procedures.get(node.reference())).append("(V IN ")
            .append(node.reference().declaration()).append(", D IN PLS_INTEGER, DECLARED_REF IN VARCHAR2 DEFAULT NULL);\n");
        for (var node : nodes.values()) sql.append(procedure(node));
        return sql.toString();
    }

    private void validate(PlDebugTypeGraph.Node node) {
        String kind = node.definition().get("TYPECODE");
        if ("PL/SQL RECORD".equals(kind) || object(node)) {
            if("OBJECT".equals(kind)&&(!finalObject(node)||node.objectAccess()!=null)&&!verifiedAccess(node))throw new IllegalArgumentException("Object type access has not been verified; inspect its type-only preparation result");
            Set<String> names = new HashSet<>();
            for (var attribute : node.attributes()) {
                String name = attribute.get("ATTR_NAME");
                if (name == null || !names.add(name)) throw new IllegalArgumentException("Incomplete record field identity");
                child(attribute,"ATTR_TYPE_","V."+quote(name));
            }
        } else if ("COLLECTION".equals(kind) && node.collections().size()==1) {
            var definition = node.collections().getFirst();
            String index = definition.get("INDEX_BY");
            if (index != null && !Set.of("VARCHAR2","BINARY_INTEGER","PLS_INTEGER").contains(index)) throw new IllegalArgumentException("No verified collection index adapter");
            child(definition,"ELEM_TYPE_","V(I)");
        } else throw new IllegalArgumentException("No verified composite output adapter for "+kind);
    }

    private static boolean finalObject(PlDebugTypeGraph.Node node) {
        return "OBJECT".equals(node.definition().get("TYPECODE")) && "YES".equals(node.definition().get("FINAL")) && node.reference().packageName() == null;
    }

    private static boolean object(PlDebugTypeGraph.Node node) {
        return "OBJECT".equals(node.definition().get("TYPECODE"))&&node.reference().packageName()==null&&("YES".equals(node.definition().get("FINAL"))||"NO".equals(node.definition().get("FINAL")));
    }

    private static boolean verifiedAccess(PlDebugTypeGraph.Node node) {
        return node.objectAccess()!=null&&"type_only_verified".equals(node.objectAccess().state());
    }

    private static boolean subtypeOf(PlDebugTypeGraph.Ref actual,PlDebugTypeGraph.Ref declared,Map<PlDebugTypeGraph.Ref,PlDebugTypeGraph.Node> available) {
        if(actual.equals(declared))return false;
        Set<PlDebugTypeGraph.Ref> seen=new HashSet<>();
        var current=available.get(actual);
        while(current!=null) {
            if(!seen.add(current.reference()))throw new IllegalArgumentException("Cyclic object supertype identities");
            String owner=current.definition().get("SUPERTYPE_OWNER"),name=current.definition().get("SUPERTYPE_NAME");
            if(owner==null&&name==null)return false;
            if(owner==null||name==null)throw new IllegalArgumentException("Incomplete object supertype identity");
            var parent=new PlDebugTypeGraph.Ref(owner,null,name);
            if(parent.equals(declared))return true;
            current=available.get(parent);
        }
        return false;
    }

    private String child(Map<String,String> row, String key, String expression) {
        if(row.get(key+"MOD")!=null)throw new IllegalArgumentException("No verified composite reference adapter");
        String owner=row.get(key+"OWNER"), pack=row.get(key+"PACKAGE"), type=row.get(key+"NAME");
        if (owner!=null || pack!=null) {
            var ref=new PlDebugTypeGraph.Ref(owner,pack,type);
            String procedure=procedures.get(ref);
            if(procedure==null)throw new IllegalArgumentException("Incomplete nested composite type graph");
            return procedure+"("+expression+",D+1);\n";
        }
        type=PlDebugTarget.builtinType(row,key);
        return switch(type==null?"":type) {
            case "NCHAR","NVARCHAR2" -> prefix+"NTV("+expression+");\n";
            case "NUMBER","VARCHAR2","CHAR","BOOLEAN","PL/SQL BOOLEAN" -> prefix+"VAL("+expression+");\n";
            case "DATE","TIMESTAMP","TIMESTAMP WITH TIME ZONE","TIMESTAMP WITH LOCAL TIME ZONE" -> temporal(type,expression);
            case "RAW" -> { raw=true; yield prefix+"RAWV("+expression+");\n"; }
            case "BINARY_FLOAT", "BINARY_DOUBLE" -> { binaryFloats.add(type); yield prefix+("BINARY_FLOAT".equals(type)?"BFLOAT":"BDOUBLE")+"("+expression+");\n"; }
            case "INTERVAL YEAR TO MONTH", "INTERVAL DAY TO SECOND" -> {intervals.add(type);yield prefix+("INTERVAL DAY TO SECOND".equals(type)?"DS9":"YM9")+"_VALUE("+expression+");\n";}
            case "CLOB", "BLOB" -> {lobs.add(type);yield prefix+("CLOB".equals(type)?"CLB":"BLB")+"("+expression+");\n";}
            default -> throw new IllegalArgumentException("No verified composite leaf output adapter for "+type);
        };
    }

    private String temporal(String type,String expression) {
        temporal=true;
        String kind= switch(type){case "DATE"->"date";case "TIMESTAMP"->"timestamp";case "TIMESTAMP WITH TIME ZONE"->"timestamp_tz";default->"timestamp_ltz";};
        String wall="CAST("+expression+" AS TIMESTAMP(9))";
        String first="DATE".equals(type)?"ROUND(("+expression+"-DATE '1970-01-01')*86400)":PlDebugTarget.timestampEpoch("TIMESTAMP".equals(type)?expression:"timestamp_tz".equals(kind)?wall:"SYS_EXTRACT_UTC("+expression+")");
        String second="timestamp_ltz".equals(kind)?PlDebugTarget.timestampEpoch(wall):"NULL";
        String offset="timestamp_tz".equals(kind)?"TO_CHAR("+expression+",'TZH:TZM')":"NULL";
        String context="timestamp_tz".equals(kind)?"EXTRACT(TIMEZONE_REGION FROM "+expression+")":"timestamp_ltz".equals(kind)?"SESSIONTIMEZONE":"NULL";
        return "DECLARE TL INTEGER:=SYS.DBMS_LOB.GETLENGTH("+valueVariable()+"); TB INTEGER:="+budget+"; BEGIN\n"+prefix+"TC('"+kind+"',CASE WHEN "+expression+" IS NULL THEN 1 ELSE 0 END,"+first+","+second+","+offset+","+context+");\nEXCEPTION WHEN OTHERS THEN "+prefix+"FAIL(SQLCODE,TL,TB); END;\n";
    }

    private String procedure(PlDebugTypeGraph.Node node) {
        boolean collection="COLLECTION".equals(node.definition().get("TYPECODE"));
        boolean object=object(node);
        boolean stringIndex=collection&&"VARCHAR2".equals(node.collections().getFirst().get("INDEX_BY"));
        StringBuilder sql=new StringBuilder("PROCEDURE "+procedures.get(node.reference())+"(V IN "+node.reference().declaration()+", D IN PLS_INTEGER, DECLARED_REF IN VARCHAR2) IS\n"
            +" E0 INTEGER := "+prefix+"ERRORS; FIRST_ITEM BOOLEAN := TRUE; N INTEGER; C INTEGER := 0; L0 INTEGER; B0 INTEGER; EC INTEGER; S0 INTEGER := SYS.DBMS_LOB.GETLENGTH("+valueVariable()+"); SB INTEGER := "+budget+";\n");
        if(collection)sql.append(" I ").append(stringIndex?"VARCHAR2(32767)":"BINARY_INTEGER")
            .append("; TYPE SEEN_T IS TABLE OF RAW(32767) INDEX BY BINARY_INTEGER; SEEN SEEN_T; KEY_RAW RAW(32767);\n");
        sql.append("BEGIN\n IF ").append(prefix).append("HALT OR D>16 OR ").append(prefix).append("NODES>=8192 OR SYSTIMESTAMP>").append(prefix).append("DEADLINE THEN ")
            .append(prefix).append("HALT:=TRUE; ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; ").append(prefix).append("CLOSE_J('{\"state\":\"partial\"}'); RETURN; END IF;\n ")
            .append(prefix).append("NODES:=").append(prefix).append("NODES+1;\n");
        if(collection) {
            sql.append(" BEGIN N:=V.COUNT; EXCEPTION WHEN COLLECTION_IS_NULL THEN ").append(prefix).append("APP('{\"kind\":\"collection\",\"state\":\"null\",\"entries\":null}'); RETURN; END;\n");
            if(stringIndex)sql.append(" IF ").append(prefix).append("SORT0 IS NULL OR ").append(prefix).append("COMP0 IS NULL OR ").append(prefix).append("SORT1 IS NULL OR ").append(prefix)
                .append("COMP1 IS NULL OR ").append(prefix).append("SORT0<>").append(prefix).append("SORT1 OR ").append(prefix).append("COMP0<>").append(prefix).append("COMP1 THEN ")
                .append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; ").append(prefix).append("APP('{\"kind\":\"collection\",\"state\":\"error\",\"error\":\"NLS context changed\"}'); RETURN; END IF;\n");
            sql.append(' ').append(prefix).append("APP('{\"kind\":\"collection\",\"entries\":[');\n BEGIN I:=V.FIRST; EXCEPTION WHEN OTHERS THEN ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; I:=NULL; END;\n WHILE I IS NOT NULL LOOP\n")
                .append("  EXIT WHEN ").append(prefix).append("HALT;\n  IF C>=8192 OR ").append(prefix).append("NODES>=8192 OR SYSTIMESTAMP>").append(prefix).append("DEADLINE THEN ").append(prefix).append("HALT:=TRUE; ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; EXIT; END IF;\n")
                .append("  KEY_RAW:=SYS.UTL_RAW.CAST_TO_RAW(").append(stringIndex?"I":"TO_CHAR(I)").append(");\n")
                .append("  FOR K IN 1..C LOOP IF SEEN(K)=KEY_RAW THEN ").append(prefix).append("HALT:=TRUE; ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; EXIT; END IF; END LOOP; EXIT WHEN ").append(prefix).append("HALT;\n")
                .append("  BEGIN\n   ").append(prefix).append("ENTRY_LEN:=SYS.DBMS_LOB.GETLENGTH(").append(valueVariable()).append("); ").append(prefix).append("ENTRY_LEFT:=").append(budget).append(";\n")
                .append("   IF NOT FIRST_ITEM THEN ").append(prefix).append("APP(','); END IF;\n   ").append(prefix).append("APP('{\"key\":');\n");
            if(stringIndex)sql.append("   IF NOT ").append(prefix).append("Q(I) THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;\n");
            else sql.append("   IF NOT ").append(prefix).append("Q(TO_CHAR(I)) THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;\n");
            sql.append("   ").append(prefix).append("APP(',\"value\":');\n  EXCEPTION WHEN OTHERS THEN\n   SYS.DBMS_LOB.TRIM(").append(valueVariable()).append(',').append(prefix).append("ENTRY_LEN); ").append(budget).append(":=").append(prefix).append("ENTRY_LEFT; ")
                .append(prefix).append("HALT:=TRUE; ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; EXIT;\n  END;\n  ")
                .append(child(node.collections().getFirst(),"ELEM_TYPE_","V(I)")).append(' ').append(prefix).append("CLOSE_J('}'); FIRST_ITEM:=FALSE; C:=C+1; SEEN(C):=KEY_RAW;\n")
                .append("  BEGIN I:=V.NEXT(I); EXCEPTION WHEN OTHERS THEN ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; I:=NULL; END;\n END LOOP;\n ").append(prefix).append("CLOSE_J('],\"complete\":');\n");
        } else {
            String identity=JSON.toJson(node.reference());
            String declared="COALESCE(DECLARED_REF,"+literal(identity)+")";
            if(object) {
                sql.append(" IF V IS NULL THEN ").append(prefix).append("APP('{\"kind\":\"object\",\"state\":\"null\",\"declaredType\":'||").append(declared).append("||',\"actualType\":null,\"fields\":null,\"complete\":true}'); RETURN; END IF;\n");
                if(!finalObject(node)) {
                    sql.append(" IF V IS OF (ONLY ").append(node.reference().declaration()).append(") THEN NULL;\n");
                    for(var candidate:nodes.values())if(verifiedAccess(candidate)&&subtypeOf(candidate.reference(),node.reference(),nodes)) {
                        sql.append(" ELSIF V IS OF (ONLY ").append(candidate.reference().declaration()).append(") THEN\n DECLARE CHILD ").append(candidate.reference().declaration()).append("; BEGIN CHILD:=TREAT(V AS ").append(candidate.reference().declaration()).append("); IF CHILD IS NULL THEN RAISE_APPLICATION_ERROR(-20993,'Object subtype conversion returned NULL'); END IF;\n ").append(procedures.get(candidate.reference())).append("(CHILD,D,").append(declared).append("); RETURN; END;\n");
                    }
                    sql.append(" ELSE ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; ").append(prefix).append("APP('{\"kind\":\"object\",\"state\":\"partial\",\"error\":\"actual_type_unresolved\",\"declaredType\":'||").append(declared).append("||',\"actualType\":null,\"fields\":null,\"complete\":false}'); RETURN; END IF;\n");
                }
                sql.append(' ').append(prefix).append("APP('{\"kind\":\"object\",\"declaredType\":'||").append(declared).append("||").append(literal(",\"actualType\":"+identity+",\"fields\":{")).append(");\n");
            } else sql.append(' ').append(prefix).append("APP('{\"kind\":\"record\",\"fields\":{');\n");
            for(var attribute:node.attributes()) {
                String key=JSON.toJson(attribute.get("ATTR_NAME"))+":";
            sql.append(" IF NOT ").append(prefix).append("HALT THEN\n  L0:=SYS.DBMS_LOB.GETLENGTH(").append(valueVariable()).append("); B0:=").append(budget).append(";\n  BEGIN\n   IF NOT FIRST_ITEM THEN ").append(prefix).append("APP(','); END IF; ").append(prefix).append("APP(").append(literal(key)).append(");\n")
                    .append("  EXCEPTION WHEN OTHERS THEN SYS.DBMS_LOB.TRIM(").append(valueVariable()).append(",L0); ").append(budget).append(":=B0; ").append(prefix).append("HALT:=TRUE; ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; END;\n  IF NOT ").append(prefix).append("HALT THEN\n   ")
                    .append(child(attribute,"ATTR_TYPE_","V."+quote(attribute.get("ATTR_NAME")))).append("   FIRST_ITEM:=FALSE;\n  END IF;\n END IF;\n");
            }
            sql.append(' ').append(prefix).append("CLOSE_J('},\"complete\":');\n");
        }
        sql.append(" IF E0=").append(prefix).append("ERRORS AND NOT ").append(prefix).append("HALT THEN ").append(prefix).append("CLOSE_J('true}'); ELSE ").append(prefix).append("CLOSE_J('false}'); END IF;\n")
            .append("EXCEPTION WHEN OTHERS THEN EC:=SQLCODE; SYS.DBMS_LOB.TRIM(").append(valueVariable()).append(",S0); ").append(budget).append(":=SB; ").append(prefix).append("ERRORS:=").append(prefix).append("ERRORS+1; ")
            .append("IF EC IN (-20996,-20997) THEN ").append(prefix).append("HALT:=TRUE; END IF; ").append(prefix).append("CLOSE_J('{\"state\":\"error\",\"code\":'||TO_CHAR(EC)||'}');\nEND;\n");
        return sql.toString();
    }

    private String helperDeclarations() {
        String helpers="""
        @P@JSON CLOB;
        @P@ERRORS INTEGER := 0;
        @P@ROOT_ERRORS INTEGER := 0;
        @P@NODES INTEGER := 0;
        @P@HALT BOOLEAN := FALSE;
        @P@ENTRY_LEN INTEGER;
        @P@ENTRY_LEFT INTEGER;
        @P@SORT0 VARCHAR2(128); @P@COMP0 VARCHAR2(128);
        @P@SORT1 VARCHAR2(128); @P@COMP1 VARCHAR2(128);
        @P@DEADLINE TIMESTAMP WITH TIME ZONE;
        PROCEDURE @P@CLOSE_J(V VARCHAR2) IS BEGIN
          IF LENGTHB(V)>@B@ THEN RAISE_APPLICATION_ERROR(-20997,'JSON closure budget'); END IF;
          SYS.DBMS_LOB.WRITEAPPEND(@P@JSON,LENGTH(V),V); @B@:=@B@-LENGTHB(V);
        END;
        PROCEDURE @P@APP(V VARCHAR2) IS BEGIN
          IF @P@HALT OR LENGTHB(V)>@B@-4096 THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;
          @P@CLOSE_J(V);
        END;
        PROCEDURE @P@FAIL(EC INTEGER, L0 INTEGER, B0 INTEGER) IS MSG VARCHAR2(128); BEGIN
          SYS.DBMS_LOB.TRIM(@P@JSON,L0); @B@:=B0; @P@ERRORS:=@P@ERRORS+1;
          IF EC IN (-20996,-20997) OR @P@HALT THEN @P@HALT:=TRUE; MSG:='{"state":"partial","code":'||TO_CHAR(EC)||'}';
          ELSE MSG:='{"state":"error","code":'||TO_CHAR(EC)||'}'; END IF;
          IF NOT @P@HALT AND LENGTHB(MSG)<=@B@-4096 THEN @P@APP(MSG);
          ELSE @P@HALT:=TRUE; @P@CLOSE_J(MSG); END IF;
        END;
        FUNCTION @P@Q(V VARCHAR2) RETURN BOOLEAN IS
          POS INTEGER:=1; CHUNK VARCHAR2(32767);
        BEGIN
          @P@APP('"');
          WHILE POS<=LENGTH(V) LOOP
            CHUNK:=SUBSTR(V,POS,1024); POS:=POS+LENGTH(CHUNK);
            CHUNK:=REPLACE(REPLACE(CHUNK,CHR(92),CHR(92)||CHR(92)),CHR(34),CHR(92)||CHR(34));
            FOR K IN 0..31 LOOP CHUNK:=REPLACE(CHUNK,CHR(K),CHR(92)||'u00'||SUBSTR('0123456789abcdef',TRUNC(K/16)+1,1)||SUBSTR('0123456789abcdef',MOD(K,16)+1,1)); END LOOP;
            BEGIN @P@APP(CHUNK); EXCEPTION WHEN OTHERS THEN
              @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; @P@CLOSE_J('"'); RETURN FALSE;
            END;
          END LOOP;
          @P@CLOSE_J('"'); RETURN TRUE;
        END;
        PROCEDURE @P@GUARD IS BEGIN
          IF @P@HALT OR @P@NODES>=8192 OR SYSTIMESTAMP>@P@DEADLINE THEN
            @P@HALT:=TRUE; RAISE_APPLICATION_ERROR(-20996,'budget');
          END IF;
          @P@NODES:=@P@NODES+1;
        END;
        FUNCTION @P@DECIMAL(V NUMBER) RETURN VARCHAR2 IS
          X NUMBER:=ABS(V); E INTEGER:=0; DIGIT INTEGER; TEXT_VALUE VARCHAR2(256);
        BEGIN
          IF X=0 THEN RETURN '0'; END IF;
          WHILE X>=10 LOOP X:=X/10; E:=E+1; END LOOP;
          WHILE X<1 LOOP X:=X*10; E:=E-1; END LOOP;
          IF V<0 THEN TEXT_VALUE:='-'; END IF;
          FOR K IN 1..40 LOOP
            DIGIT:=TRUNC(X); TEXT_VALUE:=TEXT_VALUE||SUBSTR('0123456789',DIGIT+1,1);
            X:=(X-DIGIT)*10;
            EXIT WHEN X=0;
            IF K=1 THEN TEXT_VALUE:=TEXT_VALUE||'.'; END IF;
          END LOOP;
          IF X<>0 THEN RAISE_APPLICATION_ERROR(-20998,'numeric precision exceeded'); END IF;
          RETURN TEXT_VALUE||'E'||TO_CHAR(E,'FM9990');
        END;
        PROCEDURE @P@NUM(V NUMBER) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; EC INTEGER; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"number","state":"null","value":null}');
          ELSE @P@APP('{"kind":"number","state":"value","value":');
            IF NOT @P@Q(@P@DECIMAL(V)) THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;
            @P@CLOSE_J('}');
          END IF;
        EXCEPTION WHEN OTHERS THEN EC:=SQLCODE; @P@FAIL(EC,L0,B0); END;
        PROCEDURE @P@TXT(V VARCHAR2) IS OK BOOLEAN; L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"text","state":"null","value":null}');
          ELSE @P@APP('{"kind":"text","value":'); OK:=@P@Q(V);
            IF OK THEN @P@CLOSE_J(',"state":"value"}'); ELSE @P@CLOSE_J(',"state":"partial"}'); END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
        FUNCTION @P@NQ(V NVARCHAR2) RETURN BOOLEAN IS
          C NVARCHAR2(2); A VARCHAR2(16); F VARCHAR2(16); BUF VARCHAR2(32767); N INTEGER;
          PROCEDURE FLUSH IS BEGIN
            IF SYSTIMESTAMP>@P@DEADLINE THEN @P@HALT:=TRUE; RAISE_APPLICATION_ERROR(-20996,'deadline'); END IF;
            IF BUF IS NOT NULL THEN @P@APP(BUF); BUF:=NULL; END IF;
          END;
        BEGIN
          @P@APP('"');
          FOR I IN 1..LENGTH(V) LOOP
            C:=SUBSTRC(V,I,1); A:=ASCIISTR(C);
            IF LENGTH(A)>1 THEN F:=REPLACE(A,CHR(92),CHR(92)||'u');
            ELSIF A=CHR(92) OR A=CHR(34) THEN F:=CHR(92)||A;
            ELSIF ASCII(A)<32 THEN N:=ASCII(A); F:=CHR(92)||'u00'||SUBSTR('0123456789abcdef',TRUNC(N/16)+1,1)||SUBSTR('0123456789abcdef',MOD(N,16)+1,1);
            ELSE F:=A; END IF;
            IF NVL(LENGTH(BUF),0)+LENGTH(F)>30000 THEN FLUSH; END IF;
            BUF:=BUF||F;
          END LOOP;
          FLUSH; @P@CLOSE_J('"'); RETURN TRUE;
        EXCEPTION WHEN OTHERS THEN
          IF SQLCODE<>-20996 THEN RAISE; END IF;
          @P@HALT:=TRUE; @P@ERRORS:=@P@ERRORS+1; @P@CLOSE_J('"'); RETURN FALSE;
        END;
        PROCEDURE @P@NTV(V NVARCHAR2) IS OK BOOLEAN; L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"text","state":"null","value":null}');
          ELSE @P@APP('{"kind":"text","value":'); OK:=@P@NQ(V);
            IF OK THEN @P@CLOSE_J(',"state":"value"}'); ELSE @P@CLOSE_J(',"state":"partial"}'); END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
        PROCEDURE @P@BOOL(V BOOLEAN) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"boolean","state":"null","value":null}');
          ELSIF V THEN @P@APP('{"kind":"boolean","state":"value","value":true}');
          ELSE @P@APP('{"kind":"boolean","state":"value","value":false}'); END IF;
        EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
        PROCEDURE @P@VAL(V NUMBER) IS BEGIN @P@NUM(V); END;
        PROCEDURE @P@VAL(V VARCHAR2) IS BEGIN @P@TXT(V); END;
        PROCEDURE @P@VAL(V BOOLEAN) IS BEGIN @P@BOOL(V); END;
        """.replace("@P@",prefix).replace("@B@",budget);
        for(String type:java.util.List.of("RAW","BLOB"))if("RAW".equals(type)?raw:lobs.contains(type))helpers+="""
        PROCEDURE @P@@NAME@(V @TYPE@) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; POS INTEGER:=1; N INTEGER; CHUNK RAW(3072); C0 INTEGER; CB INTEGER; EC INTEGER; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"@KIND@","state":"null","value":null}'); RETURN; END IF;
          N:=@LENGTH@; @P@APP('{"kind":"@KIND@","value":{"encoding":"base64","data":"');
          WHILE POS<=N LOOP
            C0:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); CB:=@B@;
            BEGIN
              IF SYSTIMESTAMP>@P@DEADLINE THEN @P@HALT:=TRUE; RAISE_APPLICATION_ERROR(-20996,'deadline'); END IF;
              CHUNK:=@READ@;
              IF CHUNK IS NULL OR SYS.UTL_RAW.LENGTH(CHUNK)<>LEAST(3072,N-POS+1) THEN RAISE_APPLICATION_ERROR(-20999,'binary read length changed'); END IF;
              @P@APP(REPLACE(REPLACE(SYS.UTL_RAW.CAST_TO_VARCHAR2(SYS.UTL_ENCODE.BASE64_ENCODE(CHUNK)),CHR(13),''),CHR(10),''));
              POS:=POS+SYS.UTL_RAW.LENGTH(CHUNK);
            EXCEPTION WHEN OTHERS THEN EC:=SQLCODE; SYS.DBMS_LOB.TRIM(@P@JSON,C0); @B@:=CB; @P@ERRORS:=@P@ERRORS+1;
              IF EC IN (-20996,-20997) THEN @P@HALT:=TRUE; END IF;
              @P@CLOSE_J('"},"state":"partial","code":'||TO_CHAR(EC)||'}'); RETURN;
            END;
          END LOOP;
          IF N=0 THEN @P@CLOSE_J('"},"state":"empty"}'); ELSE @P@CLOSE_J('"},"state":"value"}'); END IF;
        EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
        """.replace("@P@",prefix).replace("@B@",budget).replace("@NAME@","RAW".equals(type)?"RAWV":"BLB").replace("@TYPE@",type).replace("@KIND@",type.toLowerCase(java.util.Locale.ROOT)).replace("@LENGTH@","RAW".equals(type)?"SYS.UTL_RAW.LENGTH(V)":"SYS.DBMS_LOB.GETLENGTH(V)").replace("@READ@","RAW".equals(type)?"SYS.UTL_RAW.SUBSTR(V,POS,LEAST(3072,N-POS+1))":"SYS.DBMS_LOB.SUBSTR(V,LEAST(3072,N-POS+1),POS)");
        if(lobs.contains("CLOB"))helpers+="""
        PROCEDURE @P@CLB(V CLOB) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; POS INTEGER:=1; N INTEGER; CHUNK VARCHAR2(32767); C0 INTEGER; CB INTEGER; EC INTEGER; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"clob","state":"null","value":null}'); RETURN; END IF;
          N:=SYS.DBMS_LOB.GETLENGTH(V); @P@APP('{"kind":"clob","value":"');
          WHILE POS<=N LOOP
            C0:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); CB:=@B@;
            BEGIN
              IF SYSTIMESTAMP>@P@DEADLINE THEN @P@HALT:=TRUE; RAISE_APPLICATION_ERROR(-20996,'deadline'); END IF;
              CHUNK:=SYS.DBMS_LOB.SUBSTR(V,4096,POS);
              IF CHUNK IS NULL THEN RAISE_APPLICATION_ERROR(-20999,'LOB read made no progress'); END IF;
              POS:=POS+LENGTH(CHUNK);
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
        """.replace("@P@",prefix).replace("@B@",budget);
        for(String type:java.util.List.of("BINARY_FLOAT","BINARY_DOUBLE"))if(binaryFloats.contains(type))helpers+="""
        PROCEDURE @P@@NAME@(V @TYPE@) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; BEGIN
          @P@GUARD;
          IF V IS NULL THEN @P@APP('{"kind":"@KIND@","state":"null","value":null}');
          ELSE @P@APP('{"kind":"@KIND@","state":"value","value":"'||RAWTOHEX(SYS.UTL_RAW.CAST_FROM_@TYPE@(V,1))||'"}'); END IF;
        EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
        """.replace("@P@",prefix).replace("@B@",budget).replace("@NAME@","BINARY_FLOAT".equals(type)?"BFLOAT":"BDOUBLE").replace("@TYPE@",type).replace("@KIND@",type.toLowerCase(java.util.Locale.ROOT));
        for(String type:java.util.List.of("INTERVAL YEAR TO MONTH","INTERVAL DAY TO SECOND"))if(intervals.contains(type)) {
            boolean ds="INTERVAL DAY TO SECOND".equals(type);
            helpers+="""
            SUBTYPE @P@@TYPE@ IS @DECL@;
            PROCEDURE @P@@TYPE@_VALUE(V IN @P@@TYPE@) IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; OK BOOLEAN; BEGIN
              @P@GUARD;
              IF V IS NULL THEN @P@APP('{"kind":"@KIND@","state":"null","value":null}');
              ELSE @P@APP('{"kind":"@KIND@","state":"value","value":'); OK:=@P@Q(REPLACE(TO_CHAR(V),',','.'));
                IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; @P@CLOSE_J('}'); END IF;
            EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
            """.replace("@P@",prefix).replace("@B@",budget).replace("@TYPE@",ds?"DS9":"YM9").replace("@DECL@",ds?"INTERVAL DAY(9) TO SECOND(9)":"INTERVAL YEAR(9) TO MONTH").replace("@KIND@",ds?"interval_day_second":"interval_year_month");
        }
        if(!temporal)return helpers;
        return helpers+"""
        PROCEDURE @P@TC(K VARCHAR2,NN NUMBER,A NUMBER,B NUMBER,O VARCHAR2,C VARCHAR2) IS
          L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(@P@JSON); B0 INTEGER:=@B@; OK BOOLEAN;
        BEGIN
          @P@GUARD;
          @P@APP('{"kind":'); OK:=@P@Q(K); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF;
          @P@APP(',"$dbxTemporal":{"isNull":'); IF NN=1 THEN @P@APP('true'); ELSE @P@APP('false'); END IF;
          @P@APP(',"first":'); IF A IS NULL THEN @P@APP('null'); ELSE OK:=@P@Q(@P@DECIMAL(A)); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; END IF;
          @P@APP(',"second":');
          IF K='timestamp_tz' THEN IF O IS NULL THEN @P@APP('null'); ELSE OK:=@P@Q(O); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; END IF;
          ELSE IF B IS NULL THEN @P@APP('null'); ELSE OK:=@P@Q(@P@DECIMAL(B)); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; END IF; END IF;
          @P@APP(',"context":'); IF C IS NULL THEN @P@APP('null'); ELSE OK:=@P@Q(C); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; END IF;
          @P@CLOSE_J('}}');
        EXCEPTION WHEN OTHERS THEN @P@FAIL(SQLCODE,L0,B0); END;
        """.replace("@P@",prefix).replace("@B@",budget);
    }

    private static String quote(String value) { return '"'+value.replace("\"","\"\"")+'"'; }
    private static String literal(String value) { return "'"+value.replace("'","''")+"'"; }
}
