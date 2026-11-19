package com.dbx.agent.oceanbaseoracle;

import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.Reader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugTemporalJsonTest {
    @Test void everyTruncatedSourceBoundaryAndSmallOutputBudgetRetainsValidJson()throws Exception {
        String text="{\"kind\":\"record\",\"fields\":{\"A\":{\"kind\":\"collection\",\"entries\":[{\"key\":\"-7\",\"value\":"+temporal("timestamp",false,"-0.000000001",null,null)+"}],\"complete\":true}},\"complete\":true}";
        for(int length=0;length<text.length();length++){var result=normalize(text.substring(0,length),8192);assertFalse(result.complete(),"prefix "+length);assertDoesNotThrow(()->JsonParser.parseString(result.text()),"prefix "+length+": "+result.text());}
        for(int budget=128;budget<1024;budget+=7){var result=normalize(text,budget);assertTrue(result.text().getBytes(StandardCharsets.UTF_8).length<=budget);assertDoesNotThrow(()->JsonParser.parseString(result.text()),"budget "+budget+": "+result.text());}
        var trailing=normalize(temporal("timestamp",false,"1",null,null)+"{}",8192);assertFalse(trailing.complete());assertDoesNotThrow(()->JsonParser.parseString(trailing.text()));
    }
    private static String temporal(String kind,boolean nil,String first,String second,String context) {
        var json=new com.google.gson.GsonBuilder().serializeNulls().create();var parts=new java.util.LinkedHashMap<String,Object>();
        parts.put("isNull",nil);parts.put("first",first);parts.put("second",second);parts.put("context",context);
        var node=new java.util.LinkedHashMap<String,Object>();node.put("kind",kind);node.put(PlDebugTemporalJson.MARKER,parts);
        return json.toJson(node);
    }
    private static PlDebugTemporalJson.Result normalize(String text,int budget)throws IOException {
        return PlDebugTemporalJson.normalize(new StringReader(text),budget,System.nanoTime()+TimeUnit.SECONDS.toNanos(5));
    }
    @Test void temporalLeavesUseSharedExactDecodersAndKeepNullLtzContext()throws Exception {
        String text="{\"kind\":\"record\",\"fields\":{\"T\":"+temporal("timestamp",false,"-0.000000001",null,null)+",\"L\":"+temporal("timestamp_ltz",true,null,null,"UTC")+"},\"complete\":true}";
        var result=normalize(text,8192);assertTrue(result.complete());assertNull(result.error());
        var fields=JsonParser.parseString(result.text()).getAsJsonObject().getAsJsonObject("fields");
        assertEquals("1969-12-31T23:59:59.999999999",fields.getAsJsonObject("T").get("value").getAsString());
        assertTrue(fields.getAsJsonObject("L").get("value").isJsonNull());assertEquals("UTC",fields.getAsJsonObject("L").get("sessionTimeZone").getAsString());
        assertFalse(result.text().contains(PlDebugTemporalJson.MARKER));
    }
    @Test void invalidLeafMarksAncestorsIncompleteAndKeepsFollowingSiblings()throws Exception {
        String text="{\"kind\":\"record\",\"fields\":{\"bad\":"+temporal("timestamp",false,"0.0000000001",null,null)+",\"good\":{\"kind\":\"number\",\"value\":\"17\"}},\"complete\":true}";
        var result=normalize(text,8192);assertFalse(result.complete());assertEquals("temporal_components_invalid",result.error());
        var root=JsonParser.parseString(result.text()).getAsJsonObject();assertFalse(root.get("complete").getAsBoolean());
        assertEquals("error",root.getAsJsonObject("fields").getAsJsonObject("bad").get("state").getAsString());
        assertEquals("17",root.getAsJsonObject("fields").getAsJsonObject("good").get("value").getAsString());
    }
    @Test void onlyTypedNodeLocationsInterpretMarkers()throws Exception {
        String literal="{\"kind\":\"timestamp\",\"$dbxTemporal\":{}}";
        String quoted=new com.google.gson.Gson().toJson(literal);
        String text="{\"kind\":\"record\",\"fields\":{\"$dbxTemporal\":{\"kind\":\"text\",\"value\":"+quoted+"}},\"complete\":true}";
        var result=normalize(text,8192);assertTrue(result.complete());
        assertEquals(literal,JsonParser.parseString(result.text()).getAsJsonObject().getAsJsonObject("fields").getAsJsonObject("$dbxTemporal").get("value").getAsString());
        var reordered=normalize("{\"$dbxTemporal\":{},\"kind\":\"timestamp\"}",8192);
        assertFalse(reordered.complete());assertFalse(reordered.text().contains(PlDebugTemporalJson.MARKER));assertDoesNotThrow(()->JsonParser.parseString(reordered.text()));
    }
    @Test void outputBudgetKeepsValidCommittedPrefixAndCountsUtf8Bytes()throws Exception {
        String text="{\"kind\":\"record\",\"fields\":{\"first\":{\"kind\":\"number\",\"value\":\"17\"},\"large\":{\"kind\":\"text\",\"value\":\""+"中🙂".repeat(1000)+"\"}},\"complete\":true}";
        var result=normalize(text,512);assertFalse(result.complete());assertEquals("budget_exceeded",result.error());assertTrue(result.text().getBytes(StandardCharsets.UTF_8).length<=512);
        var root=JsonParser.parseString(result.text()).getAsJsonObject();assertFalse(root.get("complete").getAsBoolean());
        assertEquals("17",root.getAsJsonObject("fields").getAsJsonObject("first").get("value").getAsString());
    }
    @Test void readFailurePreservesEarlierFieldsWithoutResynchronizing()throws Exception {
        String text="{\"kind\":\"record\",\"fields\":{\"first\":{\"kind\":\"number\",\"value\":\"17\"},\"lost\":{\"kind\":\"text\",\"value\":\""+"x".repeat(1000)+"\"}},\"complete\":true}";
        Reader failing=new Reader(){int position;public int read(char[] target,int offset,int length)throws IOException{if(position>=160)throw new IOException("injected read failure");int count=Math.min(Math.min(length,8),160-position);text.getChars(position,position+count,target,offset);position+=count;return count;}public void close(){}};
        var result=PlDebugTemporalJson.normalize(failing,8192,System.nanoTime()+TimeUnit.SECONDS.toNanos(5));
        assertFalse(result.complete());assertNotNull(result.error());
        var root=JsonParser.parseString(result.text()).getAsJsonObject();assertFalse(root.get("complete").getAsBoolean());assertEquals("17",root.getAsJsonObject("fields").getAsJsonObject("first").get("value").getAsString());
    }
    @Test void collectionEntriesDecodeTypedValuesButNeverKeys()throws Exception {
        String text="{\"kind\":\"collection\",\"entries\":[{\"key\":\"$dbxTemporal\",\"value\":"+temporal("date",false,"1",null,null)+"}],\"complete\":true}";
        var result=normalize(text,8192);assertTrue(result.complete());
        var entry=JsonParser.parseString(result.text()).getAsJsonObject().getAsJsonArray("entries").get(0).getAsJsonObject();assertEquals("$dbxTemporal",entry.get("key").getAsString());assertEquals("1970-01-01T00:00:01",entry.getAsJsonObject("value").get("value").getAsString());
    }
}
