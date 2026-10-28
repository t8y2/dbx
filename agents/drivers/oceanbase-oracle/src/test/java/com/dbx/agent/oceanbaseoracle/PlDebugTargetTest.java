package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.PlDebugParam;
import com.dbx.agent.PlDebugStartRequest;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.empty;
import static com.dbx.agent.oceanbaseoracle.PlDebugTestJdbc.proxy;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugTargetTest {
    @Test void intervalPlansKeepNineDigitsTextAndRejectNativeOverloadAmbiguity() throws Exception {
        for(boolean ds:List.of(false,true)) {
            String type=ds?"INTERVAL DAY(9) TO SECOND(9)":"INTERVAL YEAR(9) TO MONTH",text=ds?"-0 00:00:00.000000001":"999999999-11";
            var io=new PlDebugTarget.Argument("V",1,1,0,"IN OUT",type,null,null,null,"N");
            var returns=new PlDebugTarget.Argument(null,0,2,0,"OUT",type,null,null,null,"N");
            assertTrue(io.typedAdapted());
            var param=new PlDebugParam("V","IN OUT",type,null);param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"text\",\"value\":\""+text+"\"}"));
            String normalized=PlDebugTarget.intervalText(text,ds);assertEquals(normalized,PlDebugTarget.scalarInput(io,param,"value"));
            var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(io,returns)),List.of(new PlDebugTarget.Input(io,"value",normalized)));
            var call=proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
                case "setString" -> {assertEquals(normalized,args[1]);yield null;}
                case "getString" -> (int)args[0]==2?normalized:null;
                case "getInt" -> 1;
                default -> empty(method.getReturnType());
            });
            plan.bind(call);var results=plan.read(call,3);assertEquals("available",results.state());assertEquals(normalized,results.outParams().getFirst().get("value"));assertEquals("null",results.returnValue().get("state"));
            assertTrue(plan.block().sql().contains(type+";"));assertTrue(plan.block().sql().contains(ds?"TO_DSINTERVAL(?)":"TO_YMINTERVAL(?)"));assertFalse(plan.block().sql().contains("NLS_NUMERIC_CHARACTERS"));
            var other=new PlDebugTarget.Argument("V",1,1,0,"IN",ds?"INTERVAL YEAR TO MONTH":"INTERVAL DAY TO SECOND",null,null,null,"N");
            assertTrue(PlDebugTarget.exactCallMatch(new PlDebugTarget.Candidate("S","F",null,"2",2,"VALID",List.of(other)),plan.supplied(),false));
        }
        for(String value:List.of("1-12","1000000000-00","1-1"))assertThrows(IllegalArgumentException.class,()->PlDebugTarget.intervalText(value,false));
        for(String value:List.of("0 24:00:00","0 00:00:60","0 00:00:00.0000000001"))assertThrows(IllegalArgumentException.class,()->PlDebugTarget.intervalText(value,true));
    }

    @Test void binaryFloatPlansKeepStaticTypesHexNullAndIndependentResults() throws Exception {
        for(String type:List.of("BINARY_FLOAT","BINARY_DOUBLE")) {
            String hex="BINARY_FLOAT".equals(type)?"7f800000":"7ff0000000000000";
            var io=new PlDebugTarget.Argument("V",1,1,0,"IN OUT",type,null,null,null,"N");
            var returns=new PlDebugTarget.Argument(null,0,2,0,"OUT",type,null,null,null,"N");
            var param=new PlDebugParam("V","IN OUT",type,null);param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\""+type.toLowerCase()+"\",\"value\":\""+hex+"\"}"));
            assertEquals(hex.toUpperCase(),PlDebugTarget.scalarInput(io,param,"value"));
            var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(io,returns)),List.of(new PlDebugTarget.Input(io,"value",hex.toUpperCase())));
            var call=proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
                case "setString" -> {assertEquals(hex.toUpperCase(),args[1]);yield null;}
                case "registerOutParameter" -> {if((int)args[0]<4)assertEquals(Types.VARCHAR,args[1]);yield null;}
                case "getInt" -> 1;
                case "getString" -> (int)args[0]==2?hex:null;
                default -> empty(method.getReturnType());
            });
            plan.bind(call);var results=plan.read(call,3);
            assertEquals("available",results.state());assertEquals(hex.toUpperCase(),results.outParams().getFirst().get("value"));assertEquals("null",results.returnValue().get("state"));
            assertEquals(type.toLowerCase(),((Map<?,?>)results.outParams().getFirst().get("typedValue")).get("kind"));
            var sql=plan.block().sql();assertTrue(sql.contains(" "+type+";"));assertTrue(sql.contains("CAST_TO_"+type));assertTrue(sql.contains("CAST_FROM_"+type));
            param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\""+type.toLowerCase()+"\",\"value\":null}"));assertNull(PlDebugTarget.scalarInput(io,param,"value"));
            assertThrows(IllegalArgumentException.class,()->PlDebugTarget.binaryFloatHex("+0",type.equals("BINARY_DOUBLE")));
            assertThrows(IllegalArgumentException.class,()->PlDebugTarget.binaryFloatHex(hex+"0",type.equals("BINARY_DOUBLE")));
        }
    }

    @Test void rawInputRequiresCanonicalBoundedBinaryAndPreservesSqlNull() {
        var argument=new PlDebugTarget.Argument("R",1,1,0,"IN","RAW",null,null,null,"N");
        assertTrue(argument.typedAdapted());assertFalse(argument.adapted());
        for(int size:List.of(0,8193,32767)) {
            byte[] bytes=new byte[size];for(int i=0;i<size;i++)bytes[i]=(byte)(i*131+17);
            var param=new PlDebugParam("R","IN","RAW",null);
            param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"raw\",\"value\":{\"encoding\":\"base64\",\"data\":\""+java.util.Base64.getEncoder().encodeToString(bytes)+"\"}}"));
            byte[] actual=(byte[])PlDebugTarget.scalarInput(argument,param,"value");
            if(size==0)assertNull(actual);else assertArrayEquals(bytes,actual);
        }
        for(String data:List.of("A","AB==","AA==\n",java.util.Base64.getEncoder().encodeToString(new byte[32768]))) {
            var param=new PlDebugParam("R","IN","RAW",null);
            param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"raw\",\"value\":{\"encoding\":\"base64\",\"data\":\""+data.replace("\n","\\n")+"\"}}"));
            assertThrows(IllegalArgumentException.class,()->PlDebugTarget.scalarInput(argument,param,"value"));
        }
    }

    @Test void rawPlanUsesBinarySlotsAndRetainsIndependentResultPages() throws Exception {
        var in=new PlDebugTarget.Argument("I",1,1,0,"IN","RAW",null,null,null,"N");
        var out=new PlDebugTarget.Argument("O",2,2,0,"OUT","RAW",null,null,null,"N");
        var io=new PlDebugTarget.Argument("IO",3,3,0,"IN OUT","RAW",null,null,null,"N");
        var returns=new PlDebugTarget.Argument(null,0,4,0,"OUT","RAW",null,null,null,"N");
        byte[] bytes=new byte[]{0,(byte)255,(byte)128,65};
        var plan=new PlDebugTarget.Plan(new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(in,out,io,returns)),List.of(new PlDebugTarget.Input(in,"value",bytes),new PlDebugTarget.Input(out,"null",null),new PlDebugTarget.Input(io,"null",null)));
        var values=new LinkedHashMap<Integer,Object>();var types=new LinkedHashMap<Integer,Integer>();
        var call=proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
            case "setBytes" -> {values.put((int)args[0],args[1]);yield null;}
            case "setNull" -> {assertEquals(Types.VARBINARY,args[1]);values.put((int)args[0],null);yield null;}
            case "registerOutParameter" -> {types.put((int)args[0],(int)args[1]);yield null;}
            case "getInt" -> 1;
            case "getBytes" -> (int)args[0]==4?null:bytes;
            default -> empty(method.getReturnType());
        });
        plan.bind(call);assertArrayEquals(bytes,(byte[])values.get(1));assertNull(values.get(2));
        for(int index:List.of(3,4,5))assertEquals(Types.VARBINARY,types.get(index));
        assertTrue(plan.block().sql().contains("RAW(32767)"));
        var cache=new PlDebugResultCache();var result=plan.read(call,3,cache);
        assertEquals("available",result.state());assertEquals("null",result.outParams().get(1).get("state"));
        for(var item:List.of(result.outParams().getFirst(),result.returnValue())) {
            var ref=(Map<?,?>)item.get("resultRef");var page=cache.page((String)ref.get("generation"),(String)ref.get("resultId"),0,4096);
            assertArrayEquals(bytes,java.util.Base64.getDecoder().decode((String)page.get("data")));
        }
        var limited=plan.read(call,3,new PlDebugResultCache(4096));
        assertEquals("partial",limited.state());
        assertEquals("partial",limited.outParams().getFirst().get("state"));
        assertEquals("null",limited.outParams().get(1).get("state"));
        assertEquals("error",limited.returnValue().get("state"));
    }

    @Test
    void integerDictionaryRootUsesExactNumericInputWithoutChangingNumber() {
        for(String type:List.of("INT","BINARY_INTEGER")) {
        var integer = new PlDebugTarget.Argument("I",1,1,0,"IN",type,null,null,null,"N");
        assertTrue(integer.typedAdapted());
        assertFalse(integer.adapted());
        var input = new PlDebugParam("I","IN",type,null);
        input.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"number\",\"value\":\"0.66\"}"));
        assertEquals(new BigDecimal("0.66"), PlDebugTarget.scalarInput(integer,input,"value"));
        input.setTypedValue(null);
        assertNull(PlDebugTarget.scalarInput(integer,input,"null"));
        }
        var number = new PlDebugTarget.Argument("N",1,1,0,"IN","NUMBER",null,null,null,"N");
        var numberInput = new PlDebugParam("N","IN","NUMBER","12345678901234567890123456789012345678");
        assertEquals(new BigDecimal("12345678901234567890123456789012345678"), PlDebugTarget.scalarInput(number,numberInput,"value"));
    }

    @Test
    void integerPlanKeepsNumericSlotsNullAndIndependentOutputs() throws Exception {
        var in = new PlDebugTarget.Argument("I",1,1,0,"IN","INT",null,null,null,"N");
        var out = new PlDebugTarget.Argument("O",2,2,0,"OUT","INT",null,null,null,"N");
        var io = new PlDebugTarget.Argument("IO",3,3,0,"IN OUT","INT",null,null,null,"N");
        var returns = new PlDebugTarget.Argument(null,0,4,0,"OUT","INT",null,null,null,"N");
        var candidate = new PlDebugTarget.Candidate("S","F",null,"1",1,"VALID",List.of(in,out,io,returns));
        var plan = new PlDebugTarget.Plan(candidate,List.of(new PlDebugTarget.Input(in,"value",new BigDecimal("0.66")),new PlDebugTarget.Input(out,"null",null),new PlDebugTarget.Input(io,"null",null)));
        var values = new LinkedHashMap<Integer,Object>();
        var registrations = new LinkedHashMap<Integer,Integer>();
        var call = proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
            case "setBigDecimal" -> {values.put((int)args[0],args[1]);yield null;}
            case "setNull" -> {values.put((int)args[0],null);assertEquals(Types.NUMERIC,args[1]);yield null;}
            case "registerOutParameter" -> {registrations.put((int)args[0],(int)args[1]);yield null;}
            case "getInt" -> 1;
            case "getBigDecimal" -> {
                if ((int)args[0]==3) throw new SQLException("one output unavailable");
                yield (int)args[0]==4 ? null : new BigDecimal("2147483647");
            }
            default -> empty(method.getReturnType());
        });
        assertEquals(10,plan.bind(call));
        assertEquals(new BigDecimal("0.66"),values.get(1));
        assertTrue(values.containsKey(2));assertNull(values.get(2));
        for(int index:List.of(3,4,5))assertEquals(Types.NUMERIC,registrations.get(index));
        assertTrue(plan.initializesTypes());
        assertEquals(-1,plan.phase(proxy(CallableStatement.class,(method,args)->method.getName().equals("getInt") ? -1 : empty(method.getReturnType()))));
        var sql=plan.block().sql();
        assertTrue(sql.contains(" PLS_INTEGER;"));
        assertTrue(sql.contains("CAST("));
        assertFalse(sql.contains("SIMPLE_INTEGER"));
        var result=plan.read(call,3);
        assertEquals("partial",result.state());
        assertEquals("error",result.outParams().get(0).get("state"));
        assertEquals("null",result.outParams().get(1).get("state"));
        assertEquals("2147483647",result.returnValue().get("value"));
    }

    @Test
    void integerAndNumberRemainDistinctWithCharacterCarrierMatching() {
        for(String characterType:List.of("CHAR","NCHAR","NVARCHAR2")) {
            var text=new PlDebugTarget.Argument("T",1,1,0,"IN",characterType,null,null,null,"N");
            var integer=new PlDebugTarget.Argument("N",2,2,0,"IN","INT",null,null,null,"Y");
            var number=new PlDebugTarget.Argument("N",2,2,0,"IN","NUMBER",null,null,null,"Y");
            var integerCandidate=new PlDebugTarget.Candidate("S","P","PKG","1",1,"VALID",List.of(text,integer));
            var numberCandidate=new PlDebugTarget.Candidate("S","P","PKG","1",2,"VALID",List.of(text,number));
            var integerNull=List.of(new PlDebugTarget.Input(text,"value","x"),new PlDebugTarget.Input(integer,"null",null));
            var numberNull=List.of(new PlDebugTarget.Input(text,"value","x"),new PlDebugTarget.Input(number,"null",null));
            assertTrue(PlDebugTarget.exactCallMatch(integerCandidate,integerNull,true));
            assertFalse(PlDebugTarget.exactCallMatch(numberCandidate,integerNull,true));
            assertTrue(PlDebugTarget.exactCallMatch(numberCandidate,numberNull,true));
            assertFalse(PlDebugTarget.exactCallMatch(integerCandidate,numberNull,true));
            var omitted=List.of(new PlDebugTarget.Input(text,"value","x"));
            assertTrue(PlDebugTarget.exactCallMatch(integerCandidate,omitted,true));
            assertTrue(PlDebugTarget.exactCallMatch(numberCandidate,omitted,true));
        }
    }

    @Test
    void temporalCompositeReleaseFailureKeepsNormalizedValueAndReportsUnknownLocator() {
        var ref=new PlDebugTypeGraph.Ref("S","P","R");
        var graph=new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(ref,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","T","ATTR_TYPE_NAME","TIMESTAMP(9)")),List.of())),List.of());
        var argument=new PlDebugTarget.Argument("X",1,1,0,"OUT","EXT","S","R","P","N");
        var candidate=new PlDebugTarget.Candidate("S","F","P","1",1,"VALID",List.of(argument));
        var plan=new PlDebugTarget.Plan(candidate,List.of(new PlDebugTarget.Input(argument,"null",null)),graph,Map.of(1,ref));
        var closed=new AtomicInteger();var freed=new AtomicInteger();
        var clob=proxy(java.sql.Clob.class,(method,args)->switch(method.getName()) {
            case "getCharacterStream" -> new java.io.StringReader("{\"kind\":\"record\",\"fields\":{\"T\":{\"kind\":\"timestamp\",\"$dbxTemporal\":{\"isNull\":false,\"first\":\"-0.000000001\",\"second\":null,\"context\":null}}},\"complete\":true}") {
                @Override public void close(){super.close();closed.incrementAndGet();}
            };
            case "free" -> {freed.incrementAndGet();throw new SQLException("release acknowledgement unavailable");}
            default -> empty(method.getReturnType());
        });
        var call=proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
            case "getInt" -> 1;
            case "getClob" -> clob;
            default -> empty(method.getReturnType());
        });
        var cache=new PlDebugResultCache();var result=plan.read(call,3,cache);
        assertEquals("partial",result.state());var output=result.outParams().getFirst();
        assertEquals("partial",output.get("state"));assertEquals("unknown",output.get("locatorReleaseState"));
        var manifest=cache.manifests().getFirst();assertEquals(true,manifest.get("complete"));assertEquals(false,manifest.get("truncated"));assertFalse(manifest.containsKey("error"));
        var page=cache.page((String)manifest.get("generation"),(String)manifest.get("resultId"),0,4096);
        var node=com.google.gson.JsonParser.parseString((String)page.get("data")).getAsJsonObject();
        assertEquals("1969-12-31T23:59:59.999999999",node.getAsJsonObject("fields").getAsJsonObject("T").get("value").getAsString());
        assertEquals(1,closed.get());assertEquals(1,freed.get());
    }

    @Test
    void compositeOutputsUseTheOriginalSlotsAndRetainStructuredResultsAfterTransfer() throws Exception {
        var ref = new PlDebugTypeGraph.Ref("S","P","R");
        var graph = new PlDebugTypeGraph.Graph(List.of(new PlDebugTypeGraph.Node(ref,Map.of("TYPECODE","PL/SQL RECORD"),List.of(Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")),List.of())),List.of());
        var argument = new PlDebugTarget.Argument("X",1,1,0,"OUT","EXT","S","R","P","N");
        var candidate = new PlDebugTarget.Candidate("S","F","P","1",1,"VALID",List.of(argument));
        var plan = new PlDebugTarget.Plan(candidate,List.of(new PlDebugTarget.Input(argument,"null",null)),graph,Map.of(1,ref));
        var registrations = new LinkedHashMap<Integer,Integer>();
        var cache = new PlDebugResultCache();
        var frees = new AtomicInteger();
        var clob = proxy(java.sql.Clob.class,(method,args)->switch(method.getName()) {
            case "getCharacterStream" -> new java.io.StringReader("{\"kind\":\"record\",\"fields\":{},\"complete\":true}");
            case "free" -> { frees.incrementAndGet(); yield null; }
            default -> empty(method.getReturnType());
        });
        for (int copied : List.of(1,2,3,4)) {
            var call = proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
                case "registerOutParameter" -> { registrations.put((int)args[0],(int)args[1]); yield null; }
                case "getInt" -> copied;
                case "getClob" -> clob;
                default -> empty(method.getReturnType());
            });
            assertEquals(4,plan.bind(call));
            assertEquals(Types.CLOB,registrations.get(1));
            var result = plan.read(call,3,cache);
            assertEquals(copied==1?"available":"partial",result.state());
            if(copied==2||copied==4)assertEquals("unknown",result.outParams().getFirst().get("locatorReleaseState"));
            var manifest=cache.manifests().getLast();
            assertEquals(copied<=2,manifest.get("complete"));
            assertTrue(((String)cache.page((String)manifest.get("generation"),(String)manifest.get("resultId"),0,1024).get("data")).contains("record"));
        }
        assertEquals(4,frees.get());
        var missing = new PlDebugTarget.Plan(candidate,List.of(),graph,Map.of());
        assertThrows(IllegalArgumentException.class,()->new PlDebugTarget.Plan(candidate,List.of(),graph,Map.of(1,new PlDebugTypeGraph.Ref("OTHER","P","R"))));
        assertThrows(SQLException.class,()->missing.phase(proxy(CallableStatement.class,(method,args)->method.getName().equals("getInt")?-1:empty(method.getReturnType()))));
        assertEquals(-1,plan.phase(proxy(CallableStatement.class,(method,args)->method.getName().equals("getInt")?-1:empty(method.getReturnType()))));
    }

    @Test
    void typedPayloadBudgetCountsAllTextValuesBeforeExpansion() {
        var value = com.google.gson.JsonParser.parseString("{\"local\":\"中😀\",\"offset\":\"+08:00\",\"items\":[null,true,12]}");
        assertEquals(19,PlDebugTarget.inputPayloadBytes(value,19,0));
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.inputPayloadBytes(value,18,0));
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.inputPayloadBytes(new com.google.gson.JsonPrimitive("\uD800"),100,0));
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.inputPayloadBytes(new com.google.gson.JsonPrimitive("\uDC00"),100,0));
        var text = new com.google.gson.JsonPrimitive("x".repeat(PlDebugTarget.MAX_INPUT_BYTES));
        assertEquals(PlDebugTarget.MAX_INPUT_BYTES,PlDebugTarget.inputPayloadBytes(text,PlDebugTarget.MAX_INPUT_BYTES,0));
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.inputPayloadBytes(text,PlDebugTarget.MAX_INPUT_BYTES-1,0));
    }

    @Test
    void lobAdaptersRequireVersionedSignaturesAndScalarDeclarations() {
        for (String type : List.of("CLOB", "BLOB")) {
            var scalar = new PlDebugTarget.Argument("P",1,1,0,"IN OUT",type,null,null,null,"N");
            assertTrue(scalar.typedAdapted());
            assertFalse(scalar.adapted());
            assertFalse(new PlDebugTarget.Argument("P",1,1,1,"IN OUT",type,null,null,null,"N").typedAdapted());
            assertFalse(new PlDebugTarget.Argument("P",1,1,0,"IN OUT",type,"S","T",null,"N").typedAdapted());
        }
    }

    @Test
    void lobInputParsingChecksDecodedByteBudgetsBeforeBindingAndKeepsEmptyDistinctFromNull() {
        var clob=new PlDebugTarget.Argument("C",1,1,0,"IN OUT","CLOB",null,null,null,"N");
        var blob=new PlDebugTarget.Argument("B",2,2,0,"IN OUT","BLOB",null,null,null,"N");
        var param=new PlDebugParam("C","IN OUT","CLOB",null);
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"clob\",\"value\":\"中😀\"}"));
        assertEquals(7,PlDebugTarget.lobInput(clob,param,"value",7).encodedBytes());
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.lobInput(clob,param,"value",6));
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.lobInput(clob,param,"null",7));
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"clob\",\"value\":\"\"}"));
        assertTrue(PlDebugTarget.lobInput(clob,param,"value",0).empty());
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"blob\",\"value\":{\"encoding\":\"base64\",\"data\":\"AAH/\"}}"));
        assertArrayEquals(new byte[]{0,1,-1},PlDebugTarget.lobInput(blob,param,"value",3).bytes());
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.lobInput(blob,param,"value",2));
        for(String data:List.of("AA!=" ,"A", "AAH/=")) {
            param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"blob\",\"value\":{\"encoding\":\"base64\",\"data\":\""+data+"\"}}"));
            assertThrows(IllegalArgumentException.class,()->PlDebugTarget.lobInput(blob,param,"value",100));
        }
        param.setTypedValue(null);
        assertNull(PlDebugTarget.lobInput(blob,param,"null",0));
        assertThrows(IllegalArgumentException.class,()->PlDebugTarget.lobInput(blob,param,"value",0));
    }

    @Test
    void lobInputsUseSeparateStateAndStreamSlotsAndAnIndependentCleanupReceipt() throws Exception {
        var c=new PlDebugTarget.Argument("C",1,2,0,"IN OUT","CLOB",null,null,null,"N");
        var b=new PlDebugTarget.Argument("B",2,3,0,"IN OUT","BLOB",null,null,null,"N");
        var r=new PlDebugTarget.Argument(null,0,1,0,"OUT","NUMBER",null,null,null,"N");
        var target=new PlDebugTarget.Candidate("S","F","P","1",1,"VALID",List.of(r,c,b));
        var plan=new PlDebugTarget.Plan(target,List.of(new PlDebugTarget.Input(c,"value",new PlDebugTarget.LobInput("",null,0)),new PlDebugTarget.Input(b,"value",new PlDebugTarget.LobInput(null,new byte[]{0,1,-1},3))));
        assertEquals(9,plan.phaseIndex());assertEquals(13,plan.captureIndex());
        Map<Integer,Object> bindings=new LinkedHashMap<>();Map<Integer,Integer> outputs=new LinkedHashMap<>();
        assertEquals(13,plan.bind(proxy(CallableStatement.class,(method,args)->{
            if(method.getName().equals("setInt"))bindings.put((int)args[0],args[1]);
            if(method.getName().equals("setNull"))bindings.put((int)args[0],args[1]);
            if(method.getName().equals("setBinaryStream"))bindings.put((int)args[0],((java.io.InputStream)args[1]).readAllBytes());
            if(method.getName().equals("registerOutParameter"))outputs.put((int)args[0],(int)args[1]);
            return empty(method.getReturnType());
        })));
        assertEquals(1,bindings.get(1));assertEquals(Types.CLOB,bindings.get(2));assertEquals(2,bindings.get(3));assertArrayEquals(new byte[]{0,1,-1},(byte[])bindings.get(4));
        assertEquals(Types.CLOB,outputs.get(5));assertEquals(Types.BLOB,outputs.get(6));assertEquals(Types.NUMERIC,outputs.get(7));assertEquals(Types.INTEGER,outputs.get(8));
        var results=plan.read(proxy(CallableStatement.class,(method,args)->switch(method.getName()){
            case "getInt" -> 1;
            case "getBigDecimal" -> BigDecimal.valueOf(42);
            default -> empty(method.getReturnType());
        }),3,new PlDebugResultCache());
        assertEquals("partial",results.state());
        assertEquals("Temporary input LOB cleanup could not be confirmed",results.error());
        assertEquals("42",results.returnValue().get("value"));
    }

    @Test
    void privateLobExportsAreCachedAndFreedBeforeTheStatementCloses() throws Exception {
        var clob = new PlDebugTarget.Argument("C",1,2,0,"OUT","CLOB",null,null,null,"N");
        var blob = new PlDebugTarget.Argument("B",2,3,0,"OUT","BLOB",null,null,null,"N");
        var number = new PlDebugTarget.Argument(null,0,1,0,"OUT","NUMBER",null,null,null,"N");
        var candidate = new PlDebugTarget.Candidate("S","F","P","1",1,"VALID",List.of(number,clob,blob));
        var plan = new PlDebugTarget.Plan(candidate,List.of(new PlDebugTarget.Input(clob,"null",null),new PlDebugTarget.Input(blob,"null",null)));
        for (int copied : List.of(0,1,2,3,4,-1)) {
            var closed=new java.util.concurrent.atomic.AtomicBoolean();
            var frees=new AtomicInteger();
            var reads=new AtomicInteger();
            var c=proxy(java.sql.Clob.class,(method,args)->switch(method.getName()) {
                case "getCharacterStream" -> { reads.incrementAndGet(); assertFalse(closed.get()); yield new java.io.StringReader("中😀尾"); }
                case "free" -> { assertFalse(closed.get()); frees.incrementAndGet(); yield null; }
                default -> empty(method.getReturnType());
            });
            var b=proxy(java.sql.Blob.class,(method,args)->switch(method.getName()) {
                case "getBinaryStream" -> { assertFalse(closed.get()); yield new java.io.ByteArrayInputStream(new byte[]{0,1,-1}); }
                case "free" -> { assertFalse(closed.get()); frees.incrementAndGet(); yield null; }
                default -> empty(method.getReturnType());
            });
            var call=proxy(CallableStatement.class,(method,args)->switch(method.getName()) {
                case "getClob" -> c;
                case "getBlob" -> b;
                case "getBigDecimal" -> BigDecimal.valueOf(42);
                case "getInt" -> (int)args[0]==5?copied:1;
                case "close" -> { closed.set(true); yield null; }
                default -> empty(method.getReturnType());
            });
            var cache=new PlDebugResultCache();
            var result=plan.read(call,3,cache);
            call.close();
            assertEquals(2,frees.get());
            assertEquals(copied>0?1:0,reads.get());
            assertEquals("42",result.returnValue().get("value"));
            assertEquals(copied==1?"available":"partial",result.state());
            assertEquals(copied>0?2:1,cache.manifests().size());
            if(copied>0) {
                var firstRef=(Map<?,?>)result.outParams().getFirst().get("resultRef");
                assertEquals(copied<=2,firstRef.get("complete"));
                assertEquals(copied>=3,firstRef.get("truncated"));
            }
            if(copied==-1||copied==2||copied==4) assertEquals("unknown",result.outParams().getFirst().get("locatorReleaseState"));
            var ref=(Map<?,?>)result.outParams().get(1).get("resultRef");
            assertEquals("AAH/",cache.page((String)ref.get("generation"),(String)ref.get("resultId"),0,64).get("data"));
        }
    }

    @Test
    void typedLobConnectionSelectionUsesTheWholeSignatureRatherThanInputValues() {
        var request = new PlDebugStartRequest();
        assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
        request.setTargetSignature(Map.of("arguments",List.of(Map.of("type","CLOB"))));
        assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
        for (String type : List.of("CLOB","BLOB")) {
            request.setTargetSignature(Map.of("signatureVersion",2,"arguments",List.of(Map.of("type",type,"mode","OUT","position",0))));
            assertTrue(PlDebugTarget.requiresTypedLobConnection(request));
            for (String shape : List.of("attributes","collections")) {
                String key = shape.equals("attributes") ? "ATTR_TYPE_NAME" : "ELEM_TYPE_NAME";
                request.setTargetSignature(Map.of("signatureVersion",2,"arguments",List.of(Map.of("type","EXT")),
                    "typeGraph",Map.of("nodes",List.of(Map.of(shape,List.of(Map.of(key,type)))))));
                assertTrue(PlDebugTarget.requiresTypedLobConnection(request));
            }
        }
        request.setTargetSignature(Map.of("signatureVersion",2,"arguments",List.of(Map.of("type","VARCHAR2","name","CLOB")),
            "typeGraph",Map.of("nodes",List.of())));
        assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
    }

    @Test
    void structuredZonedInputsRequireAnOffsetOrAnExplicitUtcInstant() {
        var tz = new PlDebugTarget.Argument("Z", 1, 1, 0, "IN", "TIMESTAMP WITH TIME ZONE", null, null, null, "N");
        var ltz = new PlDebugTarget.Argument("L", 1, 1, 0, "IN", "TIMESTAMP WITH LOCAL TIME ZONE", null, null, null, "N");
        var param = new PlDebugParam("Z", "IN", tz.type(), null);
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"timestamp_tz\",\"value\":{\"local\":\"2024-11-03T01:30:00.123456789\",\"offset\":\"-04:00\",\"region\":\"America/New_York\"}}"));
        var value = (PlDebugTarget.ZonedInput) PlDebugTarget.scalarInput(tz, param, "value");
        assertEquals("-04:00", value.offset());
        assertEquals("America/New_York", value.region());
        for (String payload : List.of("{\"kind\":\"timestamp_tz\",\"value\":{\"local\":\"2024-11-03T01:30:00\",\"region\":\"America/New_York\"}}",
            "{\"kind\":\"timestamp_tz\",\"value\":{\"local\":\"2024-11-03T01:30:00\",\"offset\":false}}",
            "{\"kind\":\"timestamp_ltz\",\"value\":{\"instant\":\"2024-11-03T01:30:00\"}}")) {
            param.setTypedValue(com.google.gson.JsonParser.parseString(payload));
            assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(payload.contains("timestamp_ltz") ? ltz : tz, param, "value"));
        }
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"timestamp_ltz\",\"value\":{\"instant\":\"1969-12-31T23:59:59.876543211Z\"}}"));
        assertEquals(new BigDecimal("-0.123456789"), PlDebugTarget.scalarInput(ltz, param, "value"));
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(ltz, param, "null"));
        param.setTypedValue(null);
        assertNull(PlDebugTarget.scalarInput(ltz, param, "null"));
    }

    @Test
    void mixedZonedSlotsPreservePhaseCaptureIndependentReturnAndBothTimezoneContexts() throws Exception {
        var tz = new PlDebugTarget.Argument("Z", 1, 2, 0, "IN OUT", "TIMESTAMP WITH TIME ZONE", null, null, null, "N");
        var number = new PlDebugTarget.Argument("N", 2, 3, 0, "IN", "NUMBER", null, null, null, "N");
        var returns = new PlDebugTarget.Argument(null, 0, 1, 0, "OUT", "TIMESTAMP WITH LOCAL TIME ZONE", null, null, null, "N");
        var candidate = new PlDebugTarget.Candidate("S", "F", "P", "1", 1, "VALID", List.of(returns, tz, number));
        BigDecimal wall = new BigDecimal("1730597400.123456789"), utc = new BigDecimal("1730611800.123456789");
        var plan = new PlDebugTarget.Plan(candidate, List.of(new PlDebugTarget.Input(tz, "value", new PlDebugTarget.ZonedInput(wall, "-04:00", "America/New_York")), new PlDebugTarget.Input(number, "value", BigDecimal.ONE)));
        assertEquals(12, plan.phaseIndex());
        assertEquals(15, plan.captureIndex());
        Map<Integer,Object> bindings = new LinkedHashMap<>();
        Map<Integer,Integer> types = new LinkedHashMap<>();
        assertEquals(15, plan.bind(proxy(CallableStatement.class, (method,args) -> {
            if(method.getName().equals("setBigDecimal") || method.getName().equals("setString")) bindings.put((int)args[0],args[1]);
            if(method.getName().equals("registerOutParameter")) types.put((int)args[0],(int)args[1]);
            return empty(method.getReturnType());
        })));
        assertEquals(Map.of(1,wall,2,"-04:00",3,"America/New_York",4,BigDecimal.ONE),bindings);
        assertEquals(Types.NUMERIC,types.get(5));assertEquals(Types.VARCHAR,types.get(6));
        assertEquals(Types.NUMERIC,types.get(8));assertEquals(Types.NUMERIC,types.get(9));assertEquals(Types.VARCHAR,types.get(11));
        assertEquals(Types.INTEGER,types.get(12));
        var block = plan.block();
        assertEquals(19, block.sql().chars().filter(c -> c == '?').count());
        assertTrue(block.sql().contains("FROM_TZ("));
        assertTrue(block.sql().contains(" AT TIME ZONE "));
        assertTrue(block.privateNames().stream().allMatch(name -> name.length() <= 30));
        var call = proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getBigDecimal" -> (int)args[0] == 8 ? utc : wall;
            case "getString" -> switch((int)args[0]) { case 6 -> "-04:00"; case 7,10 -> "America/New_York"; case 11 -> "+08:00"; default -> null; };
            default -> empty(method.getReturnType());
        });
        var results = plan.read(call,3);
        assertEquals("available",results.state());
        assertEquals("+08:00",results.inputSessionTimeZone());
        assertEquals("2024-11-03T01:30:00.123456789-04:00[America/New_York]",results.outParams().getFirst().get("value"));
        var typed = (Map<?,?>)results.returnValue().get("typedValue");
        assertEquals("timestamp_ltz",typed.get("kind"));
        assertEquals("America/New_York",((Map<?,?>)typed.get("value")).get("sessionTimeZone"));
        var partial = plan.read(proxy(CallableStatement.class, (method,args) -> {
            if(method.getName().equals("getInt") && (int)args[0] == 13) return 0;
            return method.invoke(call,args);
        }),3);
        assertEquals("partial",partial.state());
        assertEquals("error",partial.outParams().getFirst().get("state"));
        assertEquals("value",partial.returnValue().get("state"));
    }

    @Test
    void zonedNullAndIncompleteComponentsRemainDistinctAndKeepLaterResults() throws Exception {
        var tz = new PlDebugTarget.Argument("Z", 1, 2, 0, "OUT", "TIMESTAMP WITH TIME ZONE", null, null, null, "N");
        var returns = new PlDebugTarget.Argument(null, 0, 1, 0, "OUT", "TIMESTAMP WITH LOCAL TIME ZONE", null, null, null, "N");
        var candidate = new PlDebugTarget.Candidate("S", "F", "P", "1", 1, "VALID", List.of(returns, tz));
        var plan = new PlDebugTarget.Plan(candidate, List.of(new PlDebugTarget.Input(tz, "null", null)));
        var nulls = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getString" -> (int)args[0] == 6 || (int)args[0] == 7 ? "+08:00" : null;
            default -> empty(method.getReturnType());
        }),3);
        assertEquals("available",nulls.state());
        assertEquals("null",nulls.outParams().getFirst().get("state"));
        assertEquals("null",nulls.returnValue().get("state"));
        assertEquals("+08:00",nulls.returnValue().get("sessionTimeZone"));
        for (int missing : List.of(1,2,3)) {
            var partial = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
                case "getInt" -> 1;
                case "getBigDecimal" -> (int)args[0] == missing ? null : BigDecimal.ZERO;
                case "getString" -> (int)args[0] == missing ? null : switch((int)args[0]) {
                    case 2 -> "+00:00";
                    case 3 -> "UNKNOWN";
                    default -> "+00:00";
                };
                default -> empty(method.getReturnType());
            }),3);
            assertEquals("partial",partial.state());
            assertEquals("error",partial.outParams().getFirst().get("state"));
            assertEquals("value",partial.returnValue().get("state"));
        }
    }

    @Test
    void timestampCodecKeepsNegativeNanosecondsAndOneInputBinding() throws Exception {
        var argument = new PlDebugTarget.Argument("T", 1, 1, 0, "IN OUT", "TIMESTAMP", null, null, null, "N");
        var param = new PlDebugParam("T", "IN OUT", "TIMESTAMP", null);
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"timestamp\",\"value\":\"1969-12-31T23:59:59.876543211\"}"));
        BigDecimal seconds = new BigDecimal("-0.123456789");
        assertEquals(seconds, PlDebugTarget.scalarInput(argument, param, "value"));
        var candidate = new PlDebugTarget.Candidate("S", "P", "PKG", "1", 1, "VALID", List.of(argument));
        var plan = new PlDebugTarget.Plan(candidate, List.of(new PlDebugTarget.Input(argument, "value", seconds)));
        var block = plan.block();
        assertTrue(block.sql().contains(" TIMESTAMP(9);"));
        assertTrue(block.sql().contains("NUMTODSINTERVAL(FLOOR("));
        assertTrue(block.sql().contains("EXTRACT(SECOND FROM"));
        assertTrue(block.sql().contains(" AS DATE) - DATE '1970-01-01') * 86400)"));
        assertFalse(block.sql().contains(" - TIMESTAMP '1970-01-01 00:00:00'"));
        assertTrue(block.sql().split("\n", -1)[block.callLine() - 1].contains("\"S\".\"PKG\".\"P\"("));
        assertTrue(block.privateNames().stream().anyMatch(name -> name.endsWith("_N")));
        var bindings = new LinkedHashMap<Integer,Object>();
        assertEquals(plan.captureIndex(), plan.bind(proxy(CallableStatement.class, (method,args) -> {
            if(method.getName().equals("setBigDecimal")) bindings.put((int)args[0],args[1]);
            return empty(method.getReturnType());
        })));
        assertEquals(Map.of(1, seconds), bindings);
        var result = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getBigDecimal" -> seconds;
            default -> empty(method.getReturnType());
        }), 3).outParams().getFirst();
        assertEquals("1969-12-31T23:59:59.876543211", result.get("value"));
        assertEquals(Map.of("kind", "timestamp", "value", "1969-12-31T23:59:59.876543211"), result.get("typedValue"));
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"timestamp\",\"value\":\"2024-01-01T00:00:00.1234567891\"}"));
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(argument, param, "value"));
    }

    @Test
    void dateCodecUsesNumericWallClockSecondsAndRejectsInvalidOrFractionalInputs() throws Exception {
        var argument = new PlDebugTarget.Argument("D", 1, 1, 0, "IN OUT", "DATE", null, null, null, "N");
        assertTrue(argument.typedAdapted());
        assertFalse(argument.adapted());
        var param = new PlDebugParam("D", "IN OUT", "DATE", null);
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"date\",\"value\":\"2024-02-29T12:34:56\"}"));
        BigDecimal seconds = BigDecimal.valueOf(java.time.LocalDateTime.of(2024, 2, 29, 12, 34, 56).toEpochSecond(java.time.ZoneOffset.UTC));
        assertEquals(seconds, PlDebugTarget.scalarInput(argument, param, "value"));
        for (String invalid : List.of("2023-02-29T12:34:56", "2024-02-29T12:34:56.123", "2024-02-29T12:34:56Z", "2024-02-29", "0000-01-01T00:00:00")) {
            param.setTypedValue(new com.google.gson.Gson().toJsonTree(Map.of("kind", "date", "value", invalid)));
            assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(argument, param, "value"), invalid);
        }
        param.setTypedValue(null);
        assertNull(PlDebugTarget.scalarInput(argument, param, "null"));
        var candidate = new PlDebugTarget.Candidate("S", "P", "PKG", "1", 1, "VALID", List.of(argument));
        var plan = new PlDebugTarget.Plan(candidate, List.of(new PlDebugTarget.Input(argument, "value", seconds)));
        assertTrue(plan.block().sql().contains(" := DATE '1970-01-01' + ? / 86400;"));
        assertTrue(plan.block().sql().contains("ROUND(("));
        assertFalse(plan.block().sql().contains("TO_DATE"));
        var result = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getBigDecimal" -> seconds;
            default -> empty(method.getReturnType());
        }), 3).outParams().getFirst();
        assertEquals("2024-02-29T12:34:56", result.get("value"));
        assertEquals(Map.of("kind", "date", "value", "2024-02-29T12:34:56"), result.get("typedValue"));
        var partial = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getBigDecimal" -> new BigDecimal("0.1");
            default -> empty(method.getReturnType());
        }), 3);
        assertEquals("partial", partial.state());
    }

    @Test
    void charCarrierPreservesTheRealCallLineBindingsAndDeclaredResultType() throws Exception {
        var input = new PlDebugTarget.Argument("X", 1, 2, 0, "IN OUT", "CHAR", null, null, null, "N");
        var returns = new PlDebugTarget.Argument(null, 0, 1, 0, "OUT", "CHAR", null, null, null, "N");
        assertTrue(input.typedAdapted());
        assertFalse(input.adapted());
        var param = new PlDebugParam("X", "IN OUT", "CHAR", null);
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"text\",\"value\":\"中  \"}"));
        assertEquals("中  ", PlDebugTarget.scalarInput(input, param, "value"));
        var candidate = new PlDebugTarget.Candidate("SCOTT", "F", "PKG", "1", 1, "VALID", List.of(returns, input));
        var plan = new PlDebugTarget.Plan(candidate, List.of(new PlDebugTarget.Input(input, "value", "中  ")));
        var block = plan.block();
        assertTrue(block.sql().contains(" VARCHAR2(32767);"));
        assertFalse(block.sql().contains(" CHAR("));
        assertFalse(block.sql().contains("RTRIM"));
        assertTrue(block.sql().split("\n", -1)[block.callLine() - 1].contains(" := \"SCOTT\".\"PKG\".\"F\"("));
        Map<Integer,Object> bindings = new LinkedHashMap<>();
        assertEquals(plan.captureIndex(), plan.bind(proxy(CallableStatement.class, (method,args) -> {
            if (method.getName().equals("setString")) bindings.put((int) args[0], args[1]);
            return empty(method.getReturnType());
        })));
        assertEquals("中  ", bindings.get(1));
        var results = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getString" -> "中  ";
            default -> empty(method.getReturnType());
        }), 3);
        assertEquals("CHAR", results.outParams().getFirst().get("type"));
        assertEquals("中  ", results.outParams().getFirst().get("value"));
        assertEquals("中  ", results.returnValue().get("value"));
        assertEquals("unavailable", plan.read(null, 1).returnValue().get("state"));
        Metadata legacy = new Metadata();
        legacy.arguments.put(1, List.of(arg("X", 1, "IN", "CHAR", "N")));
        var request = request("CHAR");
        request.setParams(List.of(new PlDebugParam("X", "IN", "CHAR", "x")));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(legacy.connection(), "SCOTT", request)).getMessage().contains("transport is not yet implemented"));
    }

    @Test
    void charOverloadChecksAllKnownFamiliesAndUnknownAliasesWithoutChangingLegacyMatching() {
        var selected = new PlDebugTarget.Argument("X", 1, 1, 0, "IN", "CHAR", null, null, null, "N");
        var supplied = List.of(new PlDebugTarget.Input(selected, "value", "7"));
        for (String type : List.of("CHAR", "VARCHAR2", "NCHAR", "NVARCHAR2", "RAW", "ROWID", "UNKNOWN_ALIAS")) {
            var other = new PlDebugTarget.Argument("X", 1, 1, 0, "IN", type, null, null, null, "N");
            var omitted = new PlDebugTarget.Argument("Y", 2, 2, 0, "IN", "NUMBER", null, null, null, "Y");
            var candidate = new PlDebugTarget.Candidate("S", "P", "PKG", "1", 2, "VALID", List.of(other, omitted));
            assertEquals(!"RAW".equals(type),PlDebugTarget.exactCallMatch(candidate, supplied, true), type);
            assertEquals("CHAR".equals(type), PlDebugTarget.exactCallMatch(candidate, supplied, false), type);
        }
        for (String type : List.of("NUMBER", "PL/SQL BOOLEAN", "DATE", "TIMESTAMP(9)", "CLOB")) {
            var other = new PlDebugTarget.Argument("X", 1, 1, 0, "IN", type, null, null, null, "N");
            assertFalse(PlDebugTarget.exactCallMatch(new PlDebugTarget.Candidate("S", "P", "PKG", "1", 2, "VALID", List.of(other)), supplied, true), type);
        }
        var unknown = new PlDebugTarget.Argument("X", 1, 1, 0, "IN", "NUMBER", "S", "T", null, "N");
        assertTrue(PlDebugTarget.exactCallMatch(new PlDebugTarget.Candidate("S", "P", "PKG", "1", 2, "VALID", List.of(unknown)), supplied, true));
        var number = new PlDebugTarget.Argument("N", 2, 2, 0, "IN", "NUMBER", null, null, null, "N");
        var integer = new PlDebugTarget.Argument("N", 2, 2, 0, "IN", "PLS_INTEGER", null, null, null, "N");
        var mixed = List.of(supplied.getFirst(), new PlDebugTarget.Input(number, "value", BigDecimal.ONE));
        assertTrue(PlDebugTarget.exactCallMatch(new PlDebugTarget.Candidate("S", "P", "PKG", "1", 2, "VALID", List.of(selected, integer)), mixed, true));
        var booleanArgument = new PlDebugTarget.Argument("N", 2, 2, 0, "IN", "PL/SQL BOOLEAN", null, null, null, "N");
        assertFalse(PlDebugTarget.exactCallMatch(new PlDebugTarget.Candidate("S", "P", "PKG", "1", 2, "VALID", List.of(unknown, booleanArgument)), mixed, true));
    }

    @Test
    void booleanAdapterUsesNumericBindingsAndPreservesTypedNullAndReturnValues() throws Exception {
        var argument = new PlDebugTarget.Argument("B", 1, 2, 0, "IN OUT", "PL/SQL BOOLEAN", null, null, null, "N");
        var returns = new PlDebugTarget.Argument(null, 0, 1, 0, "OUT", "PL/SQL BOOLEAN", null, null, null, "N");
        var param = new PlDebugParam("B", "IN OUT", "PL/SQL BOOLEAN", null);
        for (boolean value : List.of(true, false)) {
            param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"boolean\",\"value\":" + value + "}"));
            assertEquals(value ? BigDecimal.ONE : BigDecimal.ZERO, PlDebugTarget.scalarInput(argument, param, "value"));
        }
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"boolean\",\"value\":\"false\"}"));
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(argument, param, "value"));
        param.setTypedValue(null);
        assertNull(PlDebugTarget.scalarInput(argument, param, "null"));
        param.setValue("false");
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(argument, param, "value"));
        var candidate = new PlDebugTarget.Candidate("SCOTT", "F", "PKG", "1", 1, "VALID", List.of(returns, argument));
        assertEquals("not_implemented", candidate.preview().get("parameterTransport"));
        var plan = new PlDebugTarget.Plan(candidate, List.of(new PlDebugTarget.Input(argument, "value", BigDecimal.ONE)));
        Map<Integer,Object> bindings = new LinkedHashMap<>();
        plan.bind(proxy(CallableStatement.class, (method,args) -> {
            if (method.getName().equals("setBigDecimal")) bindings.put((int) args[0], args[1]);
            if (method.getName().equals("registerOutParameter")) assertEquals((int) args[0] <= 3 ? Types.NUMERIC : Types.INTEGER, args[1]);
            return empty(method.getReturnType());
        }));
        assertEquals(BigDecimal.ONE, bindings.get(1));
        assertTrue(plan.block().sql().contains(" BOOLEAN;"));
        assertTrue(plan.block().sql().contains(" := (? = 1);"));
        assertTrue(plan.block().sql().contains(" THEN 1 ELSE 0 END;"));
        var results = plan.read(proxy(CallableStatement.class, (method,args) -> switch(method.getName()) {
            case "getInt" -> 1;
            case "getBigDecimal" -> (int) args[0] == 2 ? BigDecimal.ZERO : null;
            default -> empty(method.getReturnType());
        }), 3);
        assertEquals("false", results.outParams().getFirst().get("value"));
        assertEquals(Map.of("kind", "boolean", "value", false), results.outParams().getFirst().get("typedValue"));
        assertEquals("null", results.returnValue().get("state"));
        assertTrue(results.returnValue().containsKey("typedValue"));
    }

    @Test
    void rejectsTypedValuesInsteadOfSilentlyExecutingTheLegacyNullableValue() {
        Metadata jdbc = overloaded();
        PlDebugStartRequest request = request("NUMBER");
        request.getParams().getFirst().setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"number\",\"value\":\"7\"}"));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request))
            .getMessage().contains("complete versioned debug signature"));
    }

    @Test
    void decodesTypedScalarsWithoutNumberCoercionAndRejectsMixedOrMalformedPayloads() {
        var number = new PlDebugTarget.Argument("N", 1, 1, 0, "IN", "NUMBER", null, null, null, "N");
        var text = new PlDebugTarget.Argument("T", 1, 1, 0, "IN", "VARCHAR2", null, null, null, "N");
        PlDebugParam param = new PlDebugParam("N", "IN", "NUMBER", null);
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"number\",\"value\":\"12345678901234567890.123400\"}"));
        assertEquals(new BigDecimal("12345678901234567890.123400"), PlDebugTarget.scalarInput(number, param, "value"));
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(number, param, "null"));
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(number, param, "default"));
        param.setValue("7");
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(number, param, "value"));
        param.setValue(null);
        for (String payload : List.of("null", "7", "{}", "{\"kind\":\"number\",\"value\":7}",
            "{\"kind\":\"text\",\"value\":\"7\"}", "{\"kind\":\"number\",\"value\":\"7\",\"extra\":true}")) {
            param.setTypedValue(com.google.gson.JsonParser.parseString(payload));
            assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.scalarInput(number, param, "value"));
        }
        param.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"text\",\"value\":\"  中\\n  \"}"));
        assertEquals("  中\n  ", PlDebugTarget.scalarInput(text, param, "value"));
    }

    @Test
    void rejectsUnknownOrIncompleteVersionedSignaturesWithoutTypePreparation() throws Exception {
        Metadata jdbc = overloaded();
        PlDebugStartRequest request = request("NUMBER");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) PlDebugTarget.preview(jdbc.connection(), request).get("candidates");
        @SuppressWarnings("unchecked")
        Map<String, Object> signature = new LinkedHashMap<>((Map<String, Object>) candidates.getFirst().get("signature"));
        signature.put("signatureVersion", 3);
        request.setTargetSignature(signature);
        assertTrue(assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request))
            .getMessage().contains("Unsupported debug signature version"));
        signature.put("signatureVersion", 2);
        assertTrue(assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request))
            .getMessage().contains("Incomplete versioned debug type signature"));
    }

    @Test
    void resolvesAnExactOverloadAndBindsDecimalAndTextWithoutCoercingEitherToStrings() throws Exception {
        Metadata jdbc = overloaded();
        PlDebugStartRequest request = request("NUMBER");
        request.getParams().getFirst().setValue("12345678901234567890.123400");
        PlDebugTarget.Plan plan = PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request);
        assertEquals(1, plan.target().subprogramId());
        Map<Integer, Object> values = new LinkedHashMap<>();
        Map<Integer, Integer> types = new LinkedHashMap<>();
        CallableStatement call = proxy(CallableStatement.class, (method, args) -> {
            switch (method.getName()) {
                case "setBigDecimal", "setString": values.put((int) args[0], args[1]); break;
                case "setNull", "registerOutParameter": types.put((int) args[0], (int) args[1]); break;
            }
            return empty(method.getReturnType());
        });
        assertEquals(plan.captureIndex(), plan.bind(call));
        assertEquals(new BigDecimal("12345678901234567890.123400"), values.get(1));
        assertEquals(new BigDecimal("1"), values.get(2));
        assertEquals(Types.NUMERIC, types.get(3));
        assertEquals(Types.VARCHAR, types.get(4));
        PlDebugOutput.Block block = plan.block();
        assertTrue(block.sql().contains("\"P_IN\" => "));
        assertTrue(block.sql().contains(" NUMBER;"));
        assertFalse(block.sql().contains("12345678901234567890.123400"));
        assertTrue(block.sql().split("\n", -1)[block.callLine() - 1].contains("\"SCOTT\".\"P_TEST\".\"RUN\"("));
        assertTrue(block.privateNames().stream().allMatch(name -> name.length() <= 30));
        PlDebugNativeTest.assertNoHelperDdl(List.of(block.sql()));

        request = request("VARCHAR2");
        request.getParams().getFirst().setValue("  文本\n  ");
        plan = PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request);
        assertEquals(2, plan.target().subprogramId());
        plan.bind(call);
        assertEquals("  文本\n  ", values.get(1));
        assertEquals("1", values.get(2));
    }

    @Test
    void nullInputsRemainTypedAndDefaultsAreOmittedOnlyWhenConfirmed() throws Exception {
        Metadata jdbc = overloaded();
        PlDebugStartRequest request = request("NUMBER");
        request.getParams().getFirst().setInputState("null");
        PlDebugTarget.Plan plan = PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request);
        assertNull(plan.inputs().getFirst().value());
        List<Integer> nullTypes = new ArrayList<>();
        plan.bind(proxy(CallableStatement.class, (method, args) -> {
            if (method.getName().equals("setNull")) nullTypes.add((int) args[1]);
            return empty(method.getReturnType());
        }));
        assertEquals(List.of(Types.NUMERIC), nullTypes);
        request.getParams().getFirst().setInputState("default");
        assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request));

        Metadata defaults = new Metadata();
        defaults.arguments.put(1, List.of(arg("P_IN", 1, "IN", "NUMBER", "Y")));
        request.setParams(List.of(request.getParams().getFirst()));
        plan = PlDebugTarget.resolve(defaults.connection(), "SCOTT", request);
        assertTrue(plan.inputs().isEmpty());
        assertTrue(plan.block().sql().contains("\"RUN\"();"));
    }

    @Test
    void selectionUsesTheWholeSignatureAndStillRejectsAmbiguousDefaultCalls() throws Exception {
        Metadata jdbc = overloaded();
        PlDebugStartRequest request = request("NUMBER");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) PlDebugTarget.preview(jdbc.connection(), request).get("candidates");
        @SuppressWarnings("unchecked")
        Map<String, Object> signature = (Map<String, Object>) candidates.getFirst().get("signature");
        request.setTargetSignature(signature);
        assertEquals(1, PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request).target().subprogramId());
        jdbc.arguments.put(1, List.of(arg("P_CHANGED", 1, "IN", "NUMBER", "N")));
        assertTrue(assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request))
            .getMessage().contains("changed"));

        Metadata defaults = new Metadata();
        defaults.arguments.put(1, List.of(arg("P_IN", 1, "IN", "NUMBER", "Y")));
        defaults.arguments.put(2, List.of(arg("P_OTHER", 1, "IN", "NUMBER", "Y")));
        PlDebugParam omitted = new PlDebugParam("P_IN", "IN", "NUMBER", null);
        omitted.setInputState("default");
        request.setParams(List.of(omitted));
        request.setTargetSignature(null);
        assertTrue(assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(defaults.connection(), "SCOTT", request))
            .getMessage().contains("ambiguous"));
    }

    @Test
    void preservesEveryIdentifierCharacterAndDoesNotDeriveIdentityBySplittingDots() throws Exception {
        Metadata jdbc = new Metadata();
        String owner = " Owner.\n\" ";
        String pack = " P.kg\n ";
        String member = " Me.m\"ber ";
        String formal = " P.in\n ";
        jdbc.arguments.put(1, List.of(arg(formal, 1, "IN", "VARCHAR2", "N")));
        PlDebugStartRequest request = request("VARCHAR2");
        request.setSchema(owner); request.setPackageName(pack); request.setObjectName(member);
        request.setParams(List.of(new PlDebugParam(formal, "IN", "VARCHAR2", "  original value  ")));
        PlDebugTarget.Plan plan = PlDebugTarget.resolve(jdbc.connection(), owner, request);
        assertEquals(owner, jdbc.queries.getFirst().get(1));
        assertEquals(pack, jdbc.queries.getFirst().get(2));
        assertEquals(member, jdbc.queries.get(1).get(5));
        assertTrue(plan.block().sql().contains("\" Owner.\n\"\" \".\" P.kg\n \".\" Me.m\"\"ber \"(\" P.in\n \" => "));
        assertEquals("  original value  ", plan.inputs().getFirst().value());
        assertEquals(owner, PlDebugTarget.owner(jdbc.connection(), owner));
    }

    @Test
    void rejectsInvalidOrIncompleteInputsBeforeNativeInitializationAndKeepsARecoveryPath() throws Exception {
        Metadata jdbc = overloaded();
        OceanBaseOracleAgent agent = new OceanBaseOracleAgent(jdbc::connection);
        PlDebugStartRequest request = request("NUMBER");
        request.setOperationId("bad-number");
        request.getParams().getFirst().setValue("not-a-number");
        assertThrows(RuntimeException.class, () -> agent.plDebugStart(request));
        assertEquals(false, agent.plDebugStatus("bad-number").get("targetDispatched"));
        assertEquals("released", agent.plDebugStatus("bad-number").get("releaseState"));
        assertEquals(0, jdbc.nativeCalls.get());
        assertEquals(2, jdbc.closes.get());
        request.setOperationId("corrected-attempt");
        request.getParams().getFirst().setValue("41");
        assertEquals(1, PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request).target().subprogramId());
        request.setParams(List.of(new PlDebugParam("unknown", "IN", "NUMBER", "1")));
        assertThrows(RuntimeException.class, () -> agent.plDebugStart(request));
        assertEquals("released", agent.plDebugStatus("corrected-attempt").get("releaseState"));
        assertEquals(0, jdbc.nativeCalls.get());
        assertEquals(4, jdbc.closes.get());
    }

    @Test
    void zeroRowsAndMetadataFailuresDoNotInventPermissionOrDatabaseSupportConclusions() throws Exception {
        Metadata jdbc = new Metadata();
        PlDebugStartRequest request = request("NUMBER");
        assertEquals("not_visible", PlDebugTarget.preview(jdbc.connection(), request).get("state"));
        jdbc.failure = new SQLException("injected dictionary rejection", "42S22", 904);
        SQLException error = assertThrows(SQLException.class, () -> PlDebugTarget.preview(jdbc.connection(), request));
        assertEquals(904, error.getErrorCode());
        assertEquals("42S22", error.getSQLState());
    }

    @Test
    void keepsTypedFunctionReturnSeparateAndPreservesOtherOutFieldsOnAReadFailure() throws Exception {
        Metadata jdbc = new Metadata();
        jdbc.arguments.put(1, List.of(arg(null, 0, "OUT", "NUMBER", "N"), arg("P_IN", 1, "IN", "NUMBER", "N"),
            arg("P_FIRST", 2, "OUT", "VARCHAR2", "N"), arg("P_SECOND", 3, "OUT", "NUMBER", "N")));
        PlDebugStartRequest request = request("NUMBER");
        request.setObjectType("FUNCTION");
        request.setParams(List.of(new PlDebugParam("P_IN", "IN", "NUMBER", "41"), new PlDebugParam("P_FIRST", "OUT", "VARCHAR2", null),
            new PlDebugParam("P_SECOND", "OUT", "NUMBER", null)));
        PlDebugTarget.Plan plan = PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request);
        PlDebugTarget.Results results = plan.read(proxy(CallableStatement.class, (method, args) -> switch (method.getName()) {
            case "getInt" -> 1;
            case "getString" -> throw new SQLException("injected field read loss", "HY000", 77);
            case "getBigDecimal" -> new BigDecimal((int) args[0] == 3 ? "42" : "82.000");
            default -> empty(method.getReturnType());
        }), 3);
        assertEquals("partial", results.state());
        assertEquals("error", results.outParams().getFirst().get("state"));
        assertEquals(77, results.outParams().getFirst().get("vendorCode"));
        assertEquals("42", results.outParams().get(1).get("value"));
        assertEquals("NUMBER", results.returnValue().get("type"));
        assertEquals("82.000", results.returnValue().get("value"));
        assertFalse(results.returnValue().containsKey("name"));
        assertEquals("unavailable", plan.read(proxy(CallableStatement.class, (method, args) -> {
            fail("An unreturned call has no readable OUT bindings"); return null;
        }), 1).returnValue().get("state"));
    }

    @Test
    void zeroParameterProceduresHaveARealCallLineAndNoInventedArgumentsOrReturn() throws Exception {
        Metadata jdbc = new Metadata();
        jdbc.arguments.put(1, List.of());
        PlDebugStartRequest request = request("NUMBER");
        request.setParams(List.of());
        request.setPackageName(null);
        PlDebugTarget.Plan plan = PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request);
        assertTrue(plan.inputs().isEmpty());
        assertTrue(plan.outputs().isEmpty());
        assertNull(plan.pendingReturn());
        PlDebugOutput.Block block = plan.block();
        assertEquals("    \"SCOTT\".\"RUN\"();", block.sql().split("\n", -1)[block.callLine() - 1]);
    }

    @Test
    void retainsCompositeMetadataAndReportsTheMissingTransportInsteadOfCallingItUnsupportedByTheDatabase() throws Exception {
        Metadata jdbc = new Metadata();
        jdbc.arguments.put(1, List.of(
            java.util.Arrays.asList("P_RECORD", 1, 1, 0, "IN", "PL/SQL RECORD", "SCOTT", "PKG", "REC", "N"),
            java.util.Arrays.asList("FIELD", 1, 2, 1, "IN", "NUMBER", null, null, null, "N")));
        PlDebugStartRequest request = request("NUMBER");
        request.setParams(List.of(new PlDebugParam("P_RECORD", "IN", "PL/SQL RECORD", null)));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) PlDebugTarget.preview(jdbc.connection(), request).get("candidates");
        assertEquals("not_implemented", candidates.getFirst().get("parameterTransport"));
        String error = assertThrows(IllegalArgumentException.class, () -> PlDebugTarget.resolve(jdbc.connection(), "SCOTT", request)).getMessage();
        assertTrue(error.contains("P_RECORD"));
        assertTrue(error.contains("transport is not yet implemented"));
        assertEquals(0, jdbc.nativeCalls.get());
    }

    static PlDebugStartRequest request(String type) {
        PlDebugStartRequest request = new PlDebugStartRequest();
        request.setSchema("SCOTT"); request.setObjectType("PROCEDURE"); request.setPackageName("P_TEST"); request.setObjectName("RUN");
        request.setParams(List.of(new PlDebugParam("P_IN", "IN", type, "41"), new PlDebugParam("P_IO", "INOUT", type, "1"),
            new PlDebugParam("P_OUT", "OUT", "VARCHAR2", null)));
        return request;
    }

    static Metadata overloaded() {
        Metadata jdbc = new Metadata();
        jdbc.arguments.put(1, List.of(arg("P_IN", 1, "IN", "NUMBER", "N"), arg("P_IO", 2, "INOUT", "NUMBER", "N"), arg("P_OUT", 3, "OUT", "VARCHAR2", "N")));
        jdbc.arguments.put(2, List.of(arg("P_IN", 1, "IN", "VARCHAR2", "N"), arg("P_IO", 2, "INOUT", "VARCHAR2", "N"), arg("P_OUT", 3, "OUT", "VARCHAR2", "N")));
        return jdbc;
    }

    static List<Object> arg(String name, int position, String mode, String type, String defaulted) {
        return java.util.Arrays.asList(name, position, position + 1, 0, mode, type, null, null, null, defaulted);
    }

    static final class Metadata {
        final Map<Integer, List<List<Object>>> arguments = new LinkedHashMap<>();
        final List<Map<Integer, Object>> queries = new ArrayList<>();
        final AtomicInteger nativeCalls = new AtomicInteger();
        final AtomicInteger closes = new AtomicInteger();
        SQLException failure;
        String bodyText = "PACKAGE BODY P_TEST IS\nEND;\n";
        String specText = "PACKAGE P_TEST IS\nEND;\n";

        Connection connection() {
            return proxy(Connection.class, (method, args) -> switch (method.getName()) {
                case "prepareStatement" -> query((String) args[0]);
                case "prepareCall" -> { nativeCalls.incrementAndGet(); fail("Target preflight must complete before native initialization"); yield null; }
                case "close" -> { closes.incrementAndGet(); yield null; }
                default -> empty(method.getReturnType());
            });
        }

        PreparedStatement query(String sql) {
            Map<Integer, Object> bindings = new LinkedHashMap<>();
            return proxy(PreparedStatement.class, (method, args) -> {
                if (method.getName().equals("setString") || method.getName().equals("setInt")) bindings.put((int) args[0], args[1]);
                if (!method.getName().equals("executeQuery")) return empty(method.getReturnType());
                if (failure != null) throw failure;
                queries.add(new LinkedHashMap<>(bindings));
                List<List<Object>> result;
                if (sql.contains("JOIN SYS.ALL_SOURCE")) result = arguments.isEmpty() ? List.of()
                    : List.of(List.of("123", "VALID", "2026-10-24 01:00:00", 1,
                        "PACKAGE".equals(bindings.get(3)) ? specText : bodyText));
                else if (sql.contains("SYS.ALL_OBJECTS")) result = arguments.isEmpty() ? List.of() : List.of(List.of("123", "VALID"));
                else if (sql.contains("SYS.ALL_PROCEDURES")) result = arguments.keySet().stream().map(id -> List.<Object>of(id)).toList();
                else if (sql.contains("SYS.ALL_ARGUMENTS")) result = arguments.get((int) bindings.get(3));
                else throw new AssertionError("Unexpected metadata query");
                return rows(result);
            });
        }

        private static ResultSet rows(List<List<Object>> result) {
            int[] cursor = {-1};
            boolean[] wasNull = {false};
            return proxy(ResultSet.class, (method, args) -> {
                if (method.getName().equals("next")) return ++cursor[0] < result.size();
                if (method.getName().equals("wasNull")) return wasNull[0];
                if (method.getName().equals("getInt") || method.getName().equals("getString")) {
                    Object value = result.get(cursor[0]).get((int) args[0] - 1);
                    wasNull[0] = value == null;
                    return method.getName().equals("getInt") ? value == null ? 0 : ((Number) value).intValue() : value == null ? null : value.toString();
                }
                return empty(method.getReturnType());
            });
        }
    }
}
