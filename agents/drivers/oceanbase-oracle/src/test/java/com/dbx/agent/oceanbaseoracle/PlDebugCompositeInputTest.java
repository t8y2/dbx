package com.dbx.agent.oceanbaseoracle;

import com.google.gson.JsonParser;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugCompositeInputTest {
    @Test void recursiveLobsUseTwoStreamSlotsAndKeepOwnedEmptyLocatorsOutsideChildScopes() throws Exception {
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","C","ATTR_TYPE_NAME","CLOB"),Map.of("ATTR_NAME","B","ATTR_TYPE_NAME","BLOB")),List.of())),List.of());
        for(int state:List.of(0,1,2)) {
            String text=state==1?"":"中文🙂".repeat(10000);byte[] bytes=state==1?new byte[0]:new byte[40001];for(int i=0;i<bytes.length;i++)bytes[i]=(byte)(i*131+17);
            var fields=new com.google.gson.JsonArray();
            var c=new com.google.gson.JsonObject();c.addProperty("kind","clob");if(state==0)c.add("value",com.google.gson.JsonNull.INSTANCE);else c.addProperty("value",text);
            var b=new com.google.gson.JsonObject();b.addProperty("kind","blob");if(state==0)b.add("value",com.google.gson.JsonNull.INSTANCE);else{var binary=new com.google.gson.JsonObject();binary.addProperty("encoding","base64");binary.addProperty("data",java.util.Base64.getEncoder().encodeToString(bytes));b.add("value",binary);}
            for(var item:List.of(Map.entry("C",c),Map.entry("B",b))){var field=new com.google.gson.JsonObject();field.addProperty("name",item.getKey());field.add("value",item.getValue());fields.add(field);}
            var payload=new com.google.gson.JsonObject();payload.addProperty("kind","record");payload.add("value",fields);var prepared=PlDebugCompositeInput.prepare(graph,R,payload);
            var code=PlDebugCompositeInput.render(graph,R,prepared,"DBX_LOB_","DBX_VALUE","DBX_CHECK");assertEquals(4,code.slots());assertEquals(2,code.ownedInputLobs().size());assertEquals(state,code.values().get(0).value());assertEquals(state,code.values().get(2).value());
            for(String owned:code.ownedInputLobs()){assertTrue(code.declarations().contains(owned+" CLOB;")||code.declarations().contains(owned+" BLOB;"));assertFalse(code.assignments().contains(owned+" CLOB;"));assertFalse(code.assignments().contains(owned+" BLOB;"));}
            var argument=new PlDebugTarget.Argument("X",1,1,0,"IN OUT","PL/SQL RECORD","S","P","R","N");
            var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","RUN","P","1",1,"VALID",List.of(argument)),List.of(new PlDebugTarget.Input(argument,"value",prepared)),graph,Map.of(1,R));
            var bound=new java.util.LinkedHashMap<Integer,Object>();var call=PlDebugTestJdbc.proxy(java.sql.CallableStatement.class,(method,args)->{if(method.getName().startsWith("set")){bound.put((int)args[0],args[1]);return null;}return PlDebugTestJdbc.empty(method.getReturnType());});
            assertEquals(9,plan.bind(call));assertTrue(plan.slots().inputLobs());assertEquals(6,plan.slots().inputCleanupIndex());
            if(state<2){assertEquals(java.sql.Types.CLOB,bound.get(2));assertEquals(java.sql.Types.BLOB,bound.get(4));}
            else{var writer=new java.io.StringWriter();((java.io.Reader)bound.get(2)).transferTo(writer);assertEquals(text,writer.toString());assertArrayEquals(bytes,((java.io.InputStream)bound.get(4)).readAllBytes());}
            assertTrue(plan.block().sql().contains("LOB_CLEANUP"));
        }
    }

    @Test void recursiveLobCleanupReceiptFailurePreservesCompletedScalarReturn() {
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","C","ATTR_TYPE_NAME","CLOB")),List.of())),List.of());
        var prepared=PlDebugCompositeInput.prepare(graph,R,JsonParser.parseString("{\"kind\":\"record\",\"value\":[{\"name\":\"C\",\"value\":{\"kind\":\"clob\",\"value\":\"\"}}]}"));
        var input=new PlDebugTarget.Argument("X",1,2,0,"IN","PL/SQL RECORD","S","P","R","N");
        var output=new PlDebugTarget.Argument(null,0,1,0,"OUT","NUMBER",null,null,null,"N");
        var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","RUN","P","1",1,"VALID",List.of(output,input)),List.of(new PlDebugTarget.Input(input,"value",prepared)),graph,Map.of(2,R));
        for(boolean unreadable:List.of(false,true)) {
            var call=PlDebugTestJdbc.proxy(java.sql.CallableStatement.class,(method,args)->{
                if(method.getName().equals("getInt")&&(int)args[0]==plan.slots().inputCleanupIndex()) {
                    if(unreadable)throw new java.sql.SQLException("receipt unavailable");
                    return 1;
                }
                if(method.getName().equals("getInt"))return 1;
                if(method.getName().equals("getBigDecimal"))return new BigDecimal("42");
                return PlDebugTestJdbc.empty(method.getReturnType());
            });
            var result=plan.read(call,3,new PlDebugResultCache());
            assertEquals("partial",result.state());
            assertEquals(unreadable?"Temporary input LOB cleanup could not be read":"Temporary input LOB cleanup could not be confirmed",result.error());
            assertEquals("42",result.returnValue().get("value"));
        }
    }

    @Test void cumulativeNonLobBudgetExcludesOnlyTheRootKindAsBefore() {
        var attributes=new java.util.ArrayList<Map<String,String>>();
        var fields=new com.google.gson.JsonArray();int left=PlDebugTarget.MAX_INPUT_BYTES/2;
        for(int i=0;left>0;i++) {
            String name="F"+i;int size=Math.min(32700,left-name.length()-4);
            assertTrue(size>=0);attributes.add(Map.of("ATTR_NAME",name,"ATTR_TYPE_NAME","VARCHAR2"));
            var field=new com.google.gson.JsonObject();field.addProperty("name",name);
            var leaf=new com.google.gson.JsonObject();leaf.addProperty("kind","text");leaf.addProperty("value","x".repeat(size));field.add("value",leaf);fields.add(field);
            left-=size+name.length()+4;
        }
        var payload=new com.google.gson.JsonObject();payload.addProperty("kind","record");payload.add("value",fields);
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),attributes,List.of())),List.of());
        int oldCharge=PlDebugTarget.inputPayloadBytes(fields,PlDebugTarget.MAX_INPUT_BYTES,0);
        var first=PlDebugCompositeInput.prepare(graph,R,payload,PlDebugTarget.MAX_INPUT_BYTES);
        var second=PlDebugCompositeInput.prepare(graph,R,payload,PlDebugTarget.MAX_INPUT_BYTES-first.inputBytes());
        assertEquals(PlDebugTarget.MAX_INPUT_BYTES/2,oldCharge);
        assertEquals(oldCharge,first.inputBytes());assertEquals(PlDebugTarget.MAX_INPUT_BYTES,first.inputBytes()+second.inputBytes());
        assertThrows(IllegalArgumentException.class,()->PlDebugCompositeInput.prepare(graph,R,payload,oldCharge-1));
    }

    @Test void recursiveBlobBudgetCountsDecodedBytesOnceAndKeepsNonLobCountingUnchanged() {
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","B","ATTR_TYPE_NAME","BLOB")),List.of())),List.of());
        String binary=java.util.Base64.getEncoder().encodeToString(new byte[32]);
        var payload=JsonParser.parseString("{\"kind\":\"record\",\"value\":[{\"name\":\"B\",\"value\":{\"kind\":\"blob\",\"value\":{\"encoding\":\"base64\",\"data\":\""+binary+"\"}}}]}");
        assertEquals(43,PlDebugCompositeInput.prepare(graph,R,payload,43).inputBytes());assertThrows(IllegalArgumentException.class,()->PlDebugCompositeInput.prepare(graph,R,payload,42));
        var ordinary=JsonParser.parseString("{\"kind\":\"record\",\"value\":[{\"name\":\"B\",\"value\":{\"kind\":\"text\",\"value\":\"中文🙂\"}}]}");
        assertEquals(PlDebugTarget.inputPayloadBytes(ordinary,1000,0),PlDebugCompositeInput.payloadBytes(ordinary,1000,0));
    }

    @Test void recursiveIntervalsKeepPrecisionNineWithoutChangingOriginalMetadata() {
        for(boolean ds:List.of(false,true)) {
            String type=ds?"INTERVAL DAY(9) TO SECOND(9)":"INTERVAL YEAR(9) TO MONTH",value=ds?"-0 00:00:00.000000001":"999999999-11";
            var definition=Map.of("ELEM_TYPE_NAME",type,"INDEX_BY","PLS_INTEGER","COLL_TYPE","PL/SQL INDEX TABLE");
            var node=new PlDebugTypeGraph.Node(A,Map.of("TYPECODE","COLLECTION"),List.of(),List.of(definition));
            var graph=new PlDebugTypeGraph.Graph(List.of(node),List.of());
            var prepared=parse(graph,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"-7\",\"value\":{\"kind\":\"text\",\"value\":\""+value+"\"}}]}");
            var code=PlDebugCompositeInput.render(graph,A,prepared,"DBX_IV_","DBX_VALUE","DBX_CHECK");
            assertTrue(code.assignments().contains(type+";"));assertEquals(PlDebugTarget.intervalText(value,ds),code.values().getFirst().value());assertEquals(type,definition.get("ELEM_TYPE_NAME"));
            var output=new PlDebugCompositeOutput(graph,"DBX_IV_","DBX_LEFT");assertTrue(output.declarations().contains(" IS "+type+";"));
        }
    }

    @Test void recursiveBinaryFloatsUseTheirRealStaticCarrierAndHexRatherThanNumber() {
        for(String type:List.of("BINARY_FLOAT","BINARY_DOUBLE")) {
            String hex=type.equals("BINARY_FLOAT")?"00000001":"0000000000000001";
            var node=new PlDebugTypeGraph.Node(A,Map.of("TYPECODE","COLLECTION"),List.of(),List.of(Map.of("ELEM_TYPE_NAME",type,"INDEX_BY","PLS_INTEGER","COLL_TYPE","PL/SQL INDEX TABLE")));
            var graph=new PlDebugTypeGraph.Graph(List.of(node),List.of());
            for(boolean nil:List.of(false,true)) {
                var prepared=parse(graph,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"-7\",\"value\":{\"kind\":\""+type.toLowerCase()+"\",\"value\":"+(nil?"null":"\""+hex+"\"")+"}}]}");
                var code=PlDebugCompositeInput.render(graph,A,prepared,"DBX_BF_","DBX_VALUE","DBX_CHECK");
                assertTrue(code.assignments().contains(" "+type+";"));assertTrue(code.assignments().contains("CAST_TO_"+type));
                assertEquals("text",code.values().getFirst().kind());assertEquals(nil?null:hex,code.values().getFirst().value());
            }
        }
    }

    @Test void rawLeavesReuseBoundedBinaryDecoderAcrossRecordsCollectionsAndConstructors() {
        String raw="{\"kind\":\"raw\",\"value\":{\"encoding\":\"base64\",\"data\":\"AP+AQQ==\"}}";
        var record=new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","X","ATTR_TYPE_NAME","RAW")),List.of());
        var array=new PlDebugTypeGraph.Node(A,Map.of("TYPECODE","COLLECTION"),List.of(),List.of(Map.of("ELEM_TYPE_NAME","RAW","INDEX_BY","PLS_INTEGER","COLL_TYPE","PL/SQL INDEX TABLE")));
        var ref=new PlDebugTypeGraph.Ref("S",null,"T");
        var object=PlDebugObjectConstructorsTest.node("TYPE T AS OBJECT(X RAW(20),CONSTRUCTOR FUNCTION T(V RAW) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","X","ATTR_TYPE_NAME","RAW")));
        var graph=new PlDebugTypeGraph.Graph(List.of(record,array,object),List.of());
        var payloads=List.of("{\"kind\":\"record\",\"value\":[{\"name\":\"X\",\"value\":"+raw+"}]}","{\"kind\":\"collection\",\"value\":[{\"index\":\"-7\",\"value\":"+raw+"}]}","{\"kind\":\"object\",\"value\":{\"type\":{\"owner\":\"S\",\"typeName\":\"T\"},\"constructorId\":\"user-1\",\"arguments\":[{\"name\":\"V\",\"state\":\"value\",\"value\":"+raw+"}]}}");
        for(int i=0;i<payloads.size();i++) {
            var root=List.of(R,A,ref).get(i);var prepared=parse(graph,root,payloads.get(i));
            var code=PlDebugCompositeInput.render(graph,root,prepared,"DBX_RAW_","DBX_VALUE","DBX_CHECK");
            assertEquals("raw",code.values().getFirst().kind());
            assertArrayEquals(new byte[]{0,(byte)255,(byte)128,65},(byte[])code.values().getFirst().value());
            if(i>0)assertTrue(code.assignments().contains("RAW(32767)"));
            var nil=parse(graph,root,payloads.get(i).replace(raw,"{\"kind\":\"raw\",\"value\":null}"));
            assertNull(PlDebugCompositeInput.render(graph,root,nil,"DBX_RAW_","DBX_VALUE","DBX_CHECK").values().getFirst().value());
        }
    }

    @Test void recursiveZonedInputsKeepFixedSlotsAndCaptureLtzContextEvenForNull() {
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","Z","ATTR_TYPE_NAME","TIMESTAMP(9) WITH TIME ZONE"),Map.of("ATTR_NAME","L","ATTR_TYPE_NAME","TIMESTAMP(9) WITH LOCAL TIME ZONE")),List.of())),List.of());
        for(boolean nonnull:List.of(false,true)) {
            String tz=nonnull?"{\"local\":\"2024-11-03T01:30:00.123456789\",\"offset\":\"-04:00\",\"region\":\"America/New_York\"}":"null";
            String ltz=nonnull?"{\"instant\":\"1969-12-31T23:59:59.999999999Z\"}":"null";
            var prepared=parse(graph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\"Z\",\"value\":{\"kind\":\"timestamp_tz\",\"value\":"+tz+"}},{\"name\":\"L\",\"value\":{\"kind\":\"timestamp_ltz\",\"value\":"+ltz+"}}]}");
            assertTrue(PlDebugCompositeInput.localTimeZone(prepared));
            var code=PlDebugCompositeInput.render(graph,R,prepared,"DBX_ZN_","DBX_VALUE","DBX_CHECK");
            assertEquals(4,code.values().size());assertEquals(List.of("number","text","text","number"),code.values().stream().map(PlDebugCompositeInput.Binding::kind).toList());
            if(nonnull){assertEquals("-04:00",code.values().get(1).value());assertEquals("America/New_York",code.values().get(2).value());assertEquals(new BigDecimal("-0.000000001"),code.values().getLast().value());}else assertTrue(code.values().stream().allMatch(binding->binding.value()==null));
            assertTrue(code.declarations().contains("TIMESTAMP(9) WITH LOCAL TIME ZONE"));assertTrue(code.declarations().contains("TIMESTAMP(9) WITH TIME ZONE"));
            assertTrue(code.assignments().contains("Timezone region, offset and wall clock do not agree"));
            assertTrue(code.assignments().indexOf("Timezone region, offset and wall clock do not agree")<code.assignments().indexOf("DBX_VALUE.\"Z\" :="));
            var argument=new PlDebugTarget.Argument("V",1,1,0,"IN","PL/SQL RECORD","S","P","R","N");
            var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","F","P","1",1,"VALID",List.of(argument)),List.of(new PlDebugTarget.Input(argument,"value",prepared)),graph,Map.of(1,R));
            assertEquals(4,plan.slots().inputs());assertTrue(plan.slots().context());
            assertTrue(plan.block().sql().contains("SELECT SESSIONTIMEZONE INTO "));
        }
        assertThrows(IllegalArgumentException.class,()->parse(graph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\"Z\",\"value\":{\"kind\":\"timestamp_tz\",\"value\":{\"local\":\"2024-01-01T00:00:00\",\"offset\":\"not-a-zone\"}}}]}"));
    }
    @Test void recursiveDatesAndTimestampsReuseStrictRootParsingAndExactNumberConstruction() {
        var timestamp=new java.util.LinkedHashMap<String,String>(Map.of("ELEM_TYPE_NAME","TIMESTAMP(9)","COLL_TYPE","PL/SQL INDEX TABLE","INDEX_BY","PLS_INTEGER"));
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(A,Map.of("TYPECODE","COLLECTION"),List.of(),List.of(timestamp))),List.of());
        var prepared=parse(graph,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"-1\",\"value\":{\"kind\":\"timestamp\",\"value\":\"1969-12-31T23:59:59.999999999\"}},{\"index\":\"2\",\"value\":{\"kind\":\"timestamp\",\"value\":null}}]}");
        var code=PlDebugCompositeInput.render(graph,A,prepared,"DBX_TM_","DBX_VALUE","DBX_CHECK");
        assertEquals(new BigDecimal("-0.000000001"),code.values().getFirst().value());
        assertNull(code.values().getLast().value());assertTrue(code.values().stream().allMatch(binding->"number".equals(binding.kind())));
        assertTrue(code.assignments().contains("TIMESTAMP(9)"));assertTrue(code.assignments().contains("FLOOR("));assertTrue(code.assignments().contains("NUMTODSINTERVAL("));
        assertEquals("TIMESTAMP(9)",timestamp.get("ELEM_TYPE_NAME"));
        for(String value:List.of("2023-02-29T00:00:00","2024-01-01T00:00:00.1234567890","0000-01-01T00:00:00"))assertThrows(IllegalArgumentException.class,()->parse(graph,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"1\",\"value\":{\"kind\":\"timestamp\",\"value\":\""+value+"\"}}]}"));
        var recordGraph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","D","ATTR_TYPE_NAME","DATE")),List.of())),List.of());
        var date=parse(recordGraph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\"D\",\"value\":{\"kind\":\"date\",\"value\":\"1970-01-01T00:00:01\"}}]}");
        var dateCode=PlDebugCompositeInput.render(recordGraph,R,date,"DBX_DT_","DBX_VALUE","DBX_CHECK");
        assertEquals(BigDecimal.ONE,dateCode.values().getFirst().value());assertTrue(dateCode.assignments().contains("DATE '1970-01-01'"));
        assertEquals("TIMESTAMP(9)",PlDebugTarget.builtinType(Map.of("ATTR_TYPE_OWNER","S","ATTR_TYPE_NAME","TIMESTAMP(9)"),"ATTR_TYPE_"));
    }
    @Test void nationalChunksKeepCompleteCharactersAndNeverBindDatabaseCharsetText() {
        String value="中".repeat(5999)+"🙂\\\u0000  ";
        var chunks=PlDebugCompositeInput.nationalChunks(value);
        assertEquals(2,chunks.size());
        assertEquals(29995,chunks.getFirst().length());
        assertTrue(chunks.getLast().startsWith("\\D83D\\DE42\\005C\\0000"));
        assertTrue(chunks.stream().allMatch(chunk->chunk.length()<=30000&&chunk.chars().allMatch(character->character<128)));
        assertThrows(IllegalArgumentException.class,()->PlDebugCompositeInput.nationalChunks("\uD83D"));
        assertThrows(IllegalArgumentException.class,()->PlDebugCompositeInput.nationalChunks("\uDE42"));
    }
    @Test void nationalRecordInputsAssembleBeforeAssigningTheRealFixedWidthField() {
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NCHAR")),List.of())),List.of());
        var payload=new com.google.gson.JsonObject();payload.addProperty("kind","record");
        var fields=new com.google.gson.JsonArray();var field=new com.google.gson.JsonObject();field.addProperty("name","N");
        var value=new com.google.gson.JsonObject();value.addProperty("kind","text");value.addProperty("value","中".repeat(6001)+"🙂  ");field.add("value",value);fields.add(field);payload.add("value",fields);
        var prepared=PlDebugCompositeInput.prepare(graph,R,payload);
        var code=PlDebugCompositeInput.render(graph,R,prepared,"DBX_IN_","DBX_VALUE","DBX_CHECK");
        assertEquals(2,prepared.nodes());assertEquals(2,code.slots());
        assertTrue(code.values().stream().allMatch(binding->"text".equals(binding.kind())&&((String)binding.value()).chars().allMatch(character->character<128)));
        assertTrue(code.declarations().contains("NVARCHAR2(32767)"));
        assertEquals(1,code.assignments().split("DBX_VALUE\\.\"N\" :=",-1).length-1);
        assertTrue(code.assignments().indexOf("UNISTR(?)")<code.assignments().indexOf("DBX_VALUE.\"N\" :="));
    }
    private static final PlDebugTypeGraph.Ref R = new PlDebugTypeGraph.Ref("S","P","R");
    private static final PlDebugTypeGraph.Ref A = new PlDebugTypeGraph.Ref("S","P","A");
    private static PlDebugTypeGraph.Graph graph(String index, String collType) {
        var collection = new java.util.LinkedHashMap<String,String>(Map.of("ELEM_TYPE_NAME","NUMBER","COLL_TYPE",collType));
        if(index!=null)collection.put("INDEX_BY",index);
        if("VARYING ARRAY".equals(collType))collection.put("UPPER_BOUND","8");
        else if(index==null)collection.put("UPPER_BOUND","-1");
        return new PlDebugTypeGraph.Graph(List.of(
            new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","Quoted. Field","ATTR_TYPE_NAME","NUMBER"),Map.of("ATTR_NAME","ITEMS","ATTR_TYPE_OWNER","S","ATTR_TYPE_PACKAGE","P","ATTR_TYPE_NAME","A")),List.of()),
            new PlDebugTypeGraph.Node(A,Map.of("TYPECODE","COLLECTION"),List.of(),List.of(collection))),List.of());
    }
    private static PlDebugCompositeInput.Prepared parse(PlDebugTypeGraph.Graph graph, PlDebugTypeGraph.Ref ref, String json) {
        return PlDebugCompositeInput.prepare(graph,ref,JsonParser.parseString(json));
    }
    @Test void exactFieldsPreserveOmissionNullAndHighPrecisionWithoutHostFloatingPoint() {
        var graph=graph("BINARY_INTEGER","TABLE");
        var prepared=parse(graph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\"Quoted. Field\",\"value\":{\"kind\":\"number\",\"value\":\"12345678901234567890123456789012345678\"}}]}");
        var field=(PlDebugCompositeInput.Field)((List<?>)prepared.value().value()).getFirst();
        assertEquals("Quoted. Field",field.name());assertEquals(new BigDecimal("12345678901234567890123456789012345678"),field.value().value());
        assertEquals(1,((List<?>)prepared.value().value()).size());
        assertThrows(IllegalArgumentException.class,()->parse(graph,R,"{\"kind\":\"record\",\"value\":null}"));
        assertTrue(((List<?>)parse(graph,R,"{\"kind\":\"record\",\"value\":[]}").value().value()).isEmpty());
        for(String name:List.of("quoted. Field","ITEMS ","missing"))assertThrows(IllegalArgumentException.class,()->parse(graph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\""+name+"\",\"value\":{\"kind\":\"number\",\"value\":null}}]}"));
    }
    @Test void collectionIndexesAreCanonicalStringsAndSparsePhysicalCostIsBoundedBeforeGeneration() {
        var integers=graph("BINARY_INTEGER","TABLE");
        var sparse=parse(integers,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"-2\",\"value\":{\"kind\":\"number\",\"value\":\"1\"}},{\"index\":\"100\",\"value\":{\"kind\":\"number\",\"value\":null}}]}");
        assertEquals("-2",((PlDebugCompositeInput.Entry)((List<?>)sparse.value().value()).getFirst()).index());
        for(String key:List.of("01","+1","-0","2147483648"))assertThrows(IllegalArgumentException.class,()->parse(integers,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\""+key+"\",\"value\":{\"kind\":\"number\",\"value\":null}}]}"));
        var nested=graph(null,"TABLE");
        assertEquals(8192,parse(nested,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"8192\",\"value\":{\"kind\":\"number\",\"value\":null}}]}").physicalElements());
        assertThrows(IllegalArgumentException.class,()->parse(nested,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"8193\",\"value\":{\"kind\":\"number\",\"value\":null}}]}"));
        assertNull(parse(nested,A,"{\"kind\":\"collection\",\"value\":null}").value().value());
        assertThrows(IllegalArgumentException.class,()->parse(integers,A,"{\"kind\":\"collection\",\"value\":null}"));
    }
    @Test void duplicateKeysAndFieldsOrMixedPayloadsAreNotSilentlyOverwritten() {
        var graph=graph("VARCHAR2","TABLE");
        String entry="{\"index\":\"A\",\"value\":{\"kind\":\"number\",\"value\":\"1\"}}";
        assertThrows(IllegalArgumentException.class,()->parse(graph,A,"{\"kind\":\"collection\",\"value\":["+entry+","+entry+"]}"));
        String field="{\"name\":\"Quoted. Field\",\"value\":{\"kind\":\"number\",\"value\":null}}";
        assertThrows(IllegalArgumentException.class,()->parse(graph,R,"{\"kind\":\"record\",\"value\":["+field+","+field+"]}"));
        assertThrows(IllegalArgumentException.class,()->parse(graph,A,"{\"kind\":\"collection\",\"value\":[],\"sql\":\"ignored\"}"));
        assertEquals(2,((List<?>)parse(graph,A,"{\"kind\":\"collection\",\"value\":["+entry+","+entry.replace("\"A\"","\"a\"")+"]}").value().value()).size());
    }
    @Test void varraysRejectHolesAndDeclaredBoundsAndNumbersRequireDecimalStrings() {
        var graph=graph(null,"VARYING ARRAY");
        for(String index:List.of("2","9"))assertThrows(IllegalArgumentException.class,()->parse(graph,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\""+index+"\",\"value\":{\"kind\":\"number\",\"value\":null}}]}"));
        for(String value:List.of("1","\"NaN\"","\"1E126\"","\"1E-131\"","\"01\""))assertThrows(IllegalArgumentException.class,()->parse(graph,A,"{\"kind\":\"collection\",\"value\":[{\"index\":\"1\",\"value\":{\"kind\":\"number\",\"value\":"+value+"}}]}"));
    }
    @Test void originalPlanBindsAllPreflightKeysBeforeRecursiveValuesWithoutInliningPayloads() throws Exception {
        var graph=graph("VARCHAR2","TABLE");
        var prepared=parse(graph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\"ITEMS\",\"value\":{\"kind\":\"collection\",\"value\":[{\"index\":\"A' quoted\",\"value\":{\"kind\":\"number\",\"value\":\"12\"}},{\"index\":\"a\",\"value\":{\"kind\":\"number\",\"value\":\"13\"}}]}}]}");
        var argument=new PlDebugTarget.Argument("X",1,1,0,"IN OUT","EXT","S","R","P","N");
        var candidate=new PlDebugTarget.Candidate("S","F","P","1",1,"VALID",List.of(argument));
        var plan=new PlDebugTarget.Plan(candidate,List.of(new PlDebugTarget.Input(argument,"value",prepared)),graph,Map.of(1,R));
        var values=new java.util.LinkedHashMap<Integer,Object>();
        var registered=new java.util.LinkedHashMap<Integer,Integer>();
        int capture=plan.bind(PlDebugTestJdbc.proxy(java.sql.CallableStatement.class,(method,args)->{
            if(method.getName().equals("setString")||method.getName().equals("setBigDecimal"))values.put((int)args[0],args[1]);
            if(method.getName().equals("registerOutParameter"))registered.put((int)args[0],(int)args[1]);
            return PlDebugTestJdbc.empty(method.getReturnType());
        }));
        assertEquals(Map.of(1,"A' quoted",2,"a",3,new BigDecimal("12"),4,new BigDecimal("13")),values);
        assertEquals(java.sql.Types.CLOB,registered.get(5));assertEquals(8,capture);assertEquals(8,plan.captureIndex());
        var block=plan.block();assertFalse(block.sql().contains("A' quoted"));
        assertTrue(block.privateNames().stream().anyMatch(name->name.endsWith("CHECK_NLS")));
    }

    @Test void atomicNullObjectDoesNotRequireAConstructorAdapterButNonNullInputStillDoes() {
        var object=new PlDebugTypeGraph.Ref("S",null,"T");
        var graph=new PlDebugTypeGraph.Graph(List.of(
            new PlDebugTypeGraph.Node(object,Map.of("TYPECODE","OBJECT","FINAL","YES"),List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")),List.of()),
            new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","O","ATTR_TYPE_OWNER","S","ATTR_TYPE_NAME","T")),List.of())),List.of());
        var output=new PlDebugTarget.Argument("X",1,1,0,"OUT","EXT","S","T",null,"N");
        var target=new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(output));
        assertDoesNotThrow(()->new PlDebugTarget.Plan(target,List.of(),graph,Map.of(1,object)));
        var input=new PlDebugTarget.Argument("X",1,1,0,"IN","EXT","S","T",null,"N");
        var inputTarget=new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(input));
        assertDoesNotThrow(()->new PlDebugTarget.Plan(inputTarget,List.of(),graph,Map.of(1,object)));
        assertNull(parse(graph,object,"{\"kind\":\"object\",\"value\":null}").value().value());
        assertDoesNotThrow(()->parse(graph,R,"{\"kind\":\"record\",\"value\":[{\"name\":\"O\",\"value\":{\"kind\":\"object\",\"value\":null}}]}"));
        assertThrows(IllegalArgumentException.class,()->parse(graph,object,"{\"kind\":\"object\",\"value\":{\"type\":{\"owner\":\"S\",\"packageName\":null,\"typeName\":\"T\"},\"constructorId\":\"attribute-value\",\"arguments\":[]}}"));
    }

    @Test void objectInputUsesNamedConstructorArgumentsOnceAndPreservesAtomicNull() {
        var ref=new PlDebugTypeGraph.Ref("S",null,"T");
        var node=PlDebugObjectConstructorsTest.node("TYPE T AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION T(N NUMBER) RETURN SELF AS RESULT,CONSTRUCTOR FUNCTION T(LABEL VARCHAR2) RETURN SELF AS RESULT)",List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")));
        var graph=new PlDebugTypeGraph.Graph(List.of(node),List.of());
        assertDoesNotThrow(()->PlDebugCompositeInput.requireInputAdapter(graph,ref));
        String json="{\"kind\":\"object\",\"value\":{\"type\":{\"owner\":\"S\",\"packageName\":null,\"typeName\":\"T\"},\"constructorId\":\"user-1\",\"arguments\":[{\"name\":\"N\",\"state\":\"value\",\"value\":{\"kind\":\"number\",\"value\":\"4\"}}]}}";
        var prepared=parse(graph,ref,json);
        var code=PlDebugCompositeInput.render(graph,ref,prepared,"DBX_O_","DBX_VALUE","DBX_CHECK");
        assertEquals(List.of(new PlDebugCompositeInput.Binding("number",new BigDecimal("4"))),code.values());
        assertEquals(1,code.slots());
        assertNull(parse(graph,ref,"{\"kind\":\"object\",\"value\":null}").value().value());
        assertThrows(IllegalArgumentException.class,()->parse(graph,ref,json.replace("user-1","attribute-value")));
        assertThrows(IllegalArgumentException.class,()->parse(graph,ref,json.replace("\"state\":\"value\",\"value\":{\"kind\":\"number\",\"value\":\"4\"}","\"state\":\"default\"")));
        assertThrows(IllegalArgumentException.class,()->parse(graph,ref,json.replace("\"typeName\":\"T\"","\"typeName\":\"OTHER\"")));
    }

    @Test void rootedInputValidationRetainsFieldIndexAndReferenceGuardsWithoutInspectingUnrelatedNodes() {
        assertThrows(IllegalArgumentException.class,()->parse(graph("FLOAT","TABLE"),A,"{\"kind\":\"collection\",\"value\":[]}"));
        var field=Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER");
        var duplicate=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(field,field),List.of())),List.of());
        assertThrows(IllegalArgumentException.class,()->parse(duplicate,R,"{\"kind\":\"record\",\"value\":[]}"));
        var reference=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(R,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER","ATTR_TYPE_MOD","REF")),List.of())),List.of());
        assertThrows(IllegalArgumentException.class,()->parse(reference,R,"{\"kind\":\"record\",\"value\":[]}"));
        var valid=graph(null,"TABLE");var nodes=new java.util.ArrayList<>(valid.nodes());
        nodes.add(new PlDebugTypeGraph.Node(new PlDebugTypeGraph.Ref("S",null,"UNUSED"),Map.of("TYPECODE","OPAQUE"),List.of(),List.of()));
        assertDoesNotThrow(()->parse(new PlDebugTypeGraph.Graph(nodes,List.of()),A,"{\"kind\":\"collection\",\"value\":[]}"));
    }

    static PlDebugTypeGraph.Graph inheritance(boolean instantiable) {
        var base=new PlDebugTypeGraph.Ref("S",null,"BASE");var sub=new PlDebugTypeGraph.Ref("S",null,"SUB");
        var access=new PlDebugTypeGraph.TypeAccess("type_only_verified",null,null);var number=Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER");
        return new PlDebugTypeGraph.Graph(List.of(
            new PlDebugTypeGraph.Node(base,Map.of("TYPECODE","OBJECT","FINAL","NO","INSTANTIABLE",instantiable?"YES":"NO"),List.of(number),List.of(),PlDebugObjectConstructors.read(base,"TYPE BASE AS OBJECT(N NUMBER,CONSTRUCTOR FUNCTION BASE(N NUMBER) RETURN SELF AS RESULT) NOT FINAL"),null,access),
            new PlDebugTypeGraph.Node(sub,Map.of("TYPECODE","OBJECT","FINAL","YES","INSTANTIABLE","YES","SUPERTYPE_OWNER","S","SUPERTYPE_NAME","BASE"),List.of(number,Map.of("ATTR_NAME","T","ATTR_TYPE_NAME","VARCHAR2")),List.of(),PlDebugObjectConstructors.read(sub,"TYPE SUB UNDER BASE(T VARCHAR2(40))"),null,access)),List.of());
    }

    @Test void subtypeConstructionKeepsTheDeclaredFormalAndCannotUseAnUnrelatedTypeOrImplicitDowncast() {
        var base=new PlDebugTypeGraph.Ref("S",null,"BASE");var sub=new PlDebugTypeGraph.Ref("S",null,"SUB");var graph=inheritance(true);
        String json="{\"kind\":\"object\",\"value\":{\"type\":{\"owner\":\"S\",\"packageName\":null,\"typeName\":\"SUB\"},\"constructorId\":\"attribute-value\",\"arguments\":[{\"name\":\"N\",\"state\":\"value\",\"value\":{\"kind\":\"number\",\"value\":\"19\"}},{\"name\":\"T\",\"state\":\"value\",\"value\":{\"kind\":\"text\",\"value\":\"dynamic-child\"}}]}}";
        var prepared=parse(graph,base,json);
        assertDoesNotThrow(()->parse(graph,base,json.replace("\"packageName\":null,","")));
        assertEquals(sub,((PlDebugCompositeInput.ObjectValue)prepared.value().value()).type());
        var code=PlDebugCompositeInput.render(graph,base,prepared,"DBX_SUB_","DBX_VALUE","DBX_CHECK");
        assertEquals(List.of(new PlDebugCompositeInput.Binding("number",new BigDecimal("19")),new PlDebugCompositeInput.Binding("text","dynamic-child")),code.values());
        var argument=new PlDebugTarget.Argument("X",1,1,0,"IN","EXT","S","BASE",null,"N");
        var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(argument)),List.of(new PlDebugTarget.Input(argument,"value",prepared)),graph,Map.of(1,base));
        assertEquals(base,plan.typeBindings().get(1));assertEquals("BASE",plan.target().parameters().getFirst().typeName());assertDoesNotThrow(plan::block);
        assertThrows(IllegalArgumentException.class,()->parse(graph,base,json.replace("\"typeName\":\"SUB\"","\"typeName\":\"OTHER\"")));
        assertFalse(PlDebugObjectConstructors.assignable(graph,base,sub));
        assertTrue(PlDebugObjectConstructors.assignable(graph,sub,base));
        var abstractGraph=inheritance(false);
        assertNull(parse(abstractGraph,base,"{\"kind\":\"object\",\"value\":null}").value().value());
        assertDoesNotThrow(()->parse(abstractGraph,base,json));
        assertEquals("not_instantiable",PlDebugObjectConstructors.callables(abstractGraph,abstractGraph.nodes().getFirst()).state());
    }
}
