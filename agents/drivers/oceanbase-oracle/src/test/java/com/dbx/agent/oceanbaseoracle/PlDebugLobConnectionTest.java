package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ConnectParams;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugLobConnectionTest {
    @Test void freezesOnlyTheActualConstructorLobFormalBeforeOpeningConnections() {
        var ref=new PlDebugTypeGraph.Ref("S",null,"T");
        var calls=new PlDebugObjectConstructors.Callables("resolved",java.util.List.of(
            new PlDebugObjectConstructors.Callable("lob","user",java.util.List.of(new PlDebugObjectConstructors.Formal("V",java.util.Map.of("ATTR_TYPE_NAME","CLOB"),true))),
            new PlDebugObjectConstructors.Callable("plain","user",java.util.List.of(new PlDebugObjectConstructors.Formal("V",java.util.Map.of("ATTR_TYPE_NAME","VARCHAR2"),false)))));
        var node=new PlDebugTypeGraph.Node(ref,java.util.Map.of("TYPECODE","OBJECT","FINAL","YES","INSTANTIABLE","YES"),java.util.List.of(java.util.Map.of("ATTR_NAME","N","ATTR_TYPE_NAME","NUMBER")),java.util.List.of(),null,calls);
        var graph=new PlDebugTypeGraph.Graph(java.util.List.of(node),java.util.List.of());
        var request=new com.dbx.agent.PlDebugStartRequest();var json=new com.google.gson.Gson();
        request.setTargetSignature(json.fromJson(json.toJson(java.util.Map.of("signatureVersion",2,"arguments",java.util.List.of(),"typeGraph",graph)),java.util.Map.class));
        var parameter=new com.dbx.agent.PlDebugParam("X","IN","OBJECT",null);request.setParams(java.util.List.of(parameter));
        String object="{\"kind\":\"object\",\"value\":{\"type\":{\"owner\":\"S\",\"typeName\":\"T\"},\"constructorId\":\"lob\",\"arguments\":[{\"name\":\"V\",\"state\":\"default\"}]}}";
        parameter.setTypedValue(com.google.gson.JsonParser.parseString(object));assertTrue(PlDebugTarget.requiresTypedLobConnection(request));
        parameter.setTypedValue(com.google.gson.JsonParser.parseString(object.replace("\"lob\"","\"plain\"").replace("\"state\":\"default\"","\"state\":\"value\",\"value\":{\"kind\":\"text\",\"value\":\"clob\"}")));assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
        parameter.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"record\",\"value\":[{\"name\":\"CHILD\",\"value\":{\"kind\":\"collection\",\"value\":[{\"index\":\"1\",\"value\":"+object+"}]}}]}"));assertTrue(PlDebugTarget.requiresTypedLobConnection(request));
        parameter.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"object\",\"value\":null}"));assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
        parameter.setTypedValue(com.google.gson.JsonParser.parseString(object.replace("\"lob\"","\"missing\"")));assertThrows(IllegalArgumentException.class,()->PlDebugTarget.requiresTypedLobConnection(request));
        parameter.setMode("OUT");assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
        parameter.setMode("IN");parameter.setTypedValue(com.google.gson.JsonParser.parseString("{\"kind\":\"text\",\"value\":\"clob\"}"));assertFalse(PlDebugTarget.requiresTypedLobConnection(request));
    }

    @Test
    void derivesOnlyTheDedicatedUrlWithoutChangingSavedOrOrdinarySettings() {
        ConnectParams params = params("jdbc:oceanbase://localhost:2881/SYS?sslMode=verify-full&socketTimeout=120000&usePieceData=false");
        String original = OceanBaseOracleAgent.buildUrl(params);
        String typed = OceanBaseOracleAgent.typedLobUrl(params);
        assertTrue(typed.contains("sslMode=verify-full&socketTimeout=120000"));
        assertTrue(typed.contains("useServerPrepStmts=true&usePieceData=true&rewriteBatchedStatements=false"));
        assertFalse(typed.contains("usePieceData=false"));
        assertEquals(original, OceanBaseOracleAgent.buildUrl(params));
        assertTrue(params.getConnection_string().endsWith("usePieceData=false"));
    }

    @Test
    void removesAllConflictingInstancesIncludingEncodedNamesAndSemicolonSeparators() {
        ConnectParams params = params("jdbc:oceanbase://localhost:2881/SYS?useServerPrepStmts=false;USESERVERPREPSTMTS=false"
            + "&use%50ieceData=false&usePieceData=false&rewriteBatchedStatements=true&continueBatchOnError=true&applicationName=one%3Btwo");
        String typed = OceanBaseOracleAgent.typedLobUrl(params);
        assertFalse(typed.contains("=false&USESERVER"));
        assertFalse(typed.contains("USESERVERPREPSTMTS"));
        assertFalse(typed.contains("use%50ieceData"));
        assertFalse(typed.contains("rewriteBatchedStatements=true"));
        assertFalse(typed.contains("continueBatchOnError=true"));
        assertTrue(typed.contains("continueBatchOnError=false"));
        assertEquals(1, typed.split("usePieceData=", -1).length - 1);
        assertEquals(1, typed.split("useServerPrepStmts=", -1).length - 1);
        assertTrue(typed.contains("applicationName=one%3Btwo"));
    }

    @Test
    void rejectsAmbiguousUrlsWithoutIncludingTheirContentsInTheError() {
        for (String suffix : new String[]{"#private-value", "?bad%zz=private-value", "?bad%26key=private-value"}) {
            ConnectParams params = params("jdbc:oceanbase://localhost:2881/SYS" + suffix);
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () -> OceanBaseOracleAgent.typedLobUrl(params));
            assertFalse(error.getMessage().contains("private-value"));
            assertFalse(error.getMessage().contains("localhost"));
        }
    }

    private static ConnectParams params(String url) {
        ConnectParams params = new ConnectParams();
        params.setConnection_string(url);
        return params;
    }
}
