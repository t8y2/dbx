package com.dbx.agent.oceanbaseoracle;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.FilterReader;
import java.io.IOException;
import java.io.Reader;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

final class PlDebugTemporalJson {
    static final String MARKER="$dbxTemporal";
    private static final Gson JSON=new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    record Result(String text,boolean complete,String error) {}
    private record Checkpoint(int length,int bytes) {}
    private static final class Limit extends IOException {Limit(){super("temporal JSON budget");}}
    private final JsonReader input;
    private final StringBuilder output=new StringBuilder();
    private final int maximum,reserve;
    private final long deadline;
    private int bytes,nodes;
    private boolean stopped;
    private String error;

    private PlDebugTemporalJson(Reader source,int maximum,long deadline) {
        this.maximum=maximum;this.reserve=Math.min(4096,maximum/2);this.deadline=deadline;
        input=new JsonReader(new Source(source,PlDebugResultCache.MAX_BYTES,deadline));
        input.setStrictness(Strictness.STRICT);
    }

    static Result normalize(Reader source,int maximum,long deadline) throws IOException {
        if(maximum<128||maximum>PlDebugResultCache.MAX_BYTES)throw new IOException("No bounded composite JSON output budget remains");
        var normalizer=new PlDebugTemporalJson(source,maximum,deadline);
        boolean complete=normalizer.node(0);
        return new Result(normalizer.output.toString(),complete&&!normalizer.stopped,normalizer.error);
    }

    private Checkpoint checkpoint(){return new Checkpoint(output.length(),bytes);}
    private void restore(Checkpoint point){output.setLength(point.length());bytes=point.bytes();}
    private void add(String text) throws IOException {write(text,false);}
    private void close(String text) throws IOException {write(text,true);}
    private void write(String text,boolean closure) throws IOException {
        int cost=text.getBytes(StandardCharsets.UTF_8).length;
        if(cost>maximum-bytes-(closure?0:reserve))throw new Limit();
        output.append(text);bytes+=cost;
    }
    private void stop(Exception failure){stopped=true;if(error==null)error=failure instanceof Limit?"budget_exceeded":"source_invalid_or_unreadable";}
    private void guard(int depth) throws IOException {if(depth>16||++nodes>8192||System.nanoTime()>deadline)throw new Limit();}
    private void name(String name,boolean comma) throws IOException {add((comma?",":"")+JSON.toJson(name)+":");}

    private boolean node(int depth) throws IOException {
        var start=checkpoint();boolean opened=false,first=true,complete=true,hadComplete=false;
        try {
            guard(depth);input.beginObject();
            String key=input.hasNext()?input.nextName():null;
            String kind=null;
            if("kind".equals(key)) {kind=input.nextString();if(Set.of("date","timestamp","timestamp_tz","timestamp_ltz").contains(kind))return temporal(kind,depth==0);}
            add("{");opened=true;
            Set<String> seen=new HashSet<>();
            while(key!=null&&!stopped) {
                if(MARKER.equals(key))throw new IOException("Unexpected temporal marker outside its generated leaf");
                if(!seen.add(key))throw new IOException("Duplicate typed node member");
                if("kind".equals(key)&&kind!=null){var property=checkpoint();try{name(key,!first);add(JSON.toJson(kind));first=false;}catch(IOException failure){restore(property);throw failure;}}
                else if("complete".equals(key)){complete&=input.nextBoolean();hadComplete=true;}
                else {
                    var property=checkpoint();
                    try {
                        name(key,!first);
                        if("fields".equals(key)&&Set.of("record","object").contains(kind==null?"":kind)&&input.peek()!=JsonToken.NULL)complete&=fields(depth);
                        else if("entries".equals(key)&&"collection".equals(kind)&&input.peek()!=JsonToken.NULL)complete&=entries(depth);
                        else if("state".equals(key)){String state=input.nextString();add(JSON.toJson(state));if(Set.of("partial","error").contains(state))complete=false;}
                        else copy(0,true);
                        first=false;
                    }catch(IOException|RuntimeException failure){restore(property);stop(failure);complete=false;}
                }
                key=!stopped&&input.hasNext()?input.nextName():null;
            }
            if(!stopped)input.endObject();
            if(depth==0&&!stopped&&input.peek()!=JsonToken.END_DOCUMENT)throw new IOException("Trailing composite JSON data");
        }catch(IOException|RuntimeException failure){stop(failure);complete=false;}
        if(!opened){restore(start);close("{\"state\":\"partial\",\"complete\":false}");return false;}
        if(hadComplete||!complete||stopped)close((first?"":",")+"\"complete\":"+(complete&&!stopped));
        close("}");return complete&&!stopped;
    }

    private boolean fields(int depth) throws IOException {
        input.beginObject();add("{");boolean first=true,complete=true;
        Set<String> seen=new HashSet<>();
        try {
            while(!stopped&&input.hasNext()) {
                String key=input.nextName();if(!seen.add(key))throw new IOException("Duplicate exact composite field");
                var point=checkpoint();
                try {name(key,!first);complete&=node(depth+1);first=false;}
                catch(IOException|RuntimeException failure){restore(point);stop(failure);complete=false;}
            }
            if(!stopped)input.endObject();
        }catch(IOException|RuntimeException failure){stop(failure);complete=false;}
        close("}");return complete&&!stopped;
    }

    private boolean entries(int depth) throws IOException {
        input.beginArray();add("[");boolean first=true,complete=true;
        try {
            while(!stopped&&input.hasNext()) {
                var point=checkpoint();boolean valueCommitted=false;
                try {
                    if(!first)add(",");input.beginObject();add("{");boolean propertyFirst=true;
                    Set<String> seen=new HashSet<>();
                    while(!stopped&&input.hasNext()) {
                        String key=input.nextName();if(!seen.add(key))throw new IOException("Duplicate collection entry member");
                        name(key,!propertyFirst);
                        if("value".equals(key)){complete&=node(depth+1);valueCommitted=true;}else copy(0,true);
                        propertyFirst=false;
                    }
                    if(!stopped)input.endObject();
                    if(!valueCommitted)throw new IOException("Collection entry has no committed value");
                    close("}");first=false;
                }catch(IOException|RuntimeException failure){restore(point);stop(failure);complete=false;}
            }
            if(!stopped)input.endArray();
        }catch(IOException|RuntimeException failure){stop(failure);complete=false;}
        close("]");return complete&&!stopped;
    }

    private void copy(int depth,boolean emit) throws IOException {
        if(depth>16||System.nanoTime()>deadline)throw new Limit();
        switch(input.peek()) {
            case NULL -> {input.nextNull();if(emit)add("null");}
            case STRING -> {String value=input.nextString();if(emit)add(JSON.toJson(value));}
            case NUMBER -> {String value=input.nextString();new BigDecimal(value);if(emit)add(value);}
            case BOOLEAN -> {boolean value=input.nextBoolean();if(emit)add(Boolean.toString(value));}
            case BEGIN_OBJECT -> {input.beginObject();if(emit)add("{");boolean first=true;Set<String> seen=new HashSet<>();while(input.hasNext()){String key=input.nextName();if(!seen.add(key))throw new IOException("Duplicate metadata member");if(emit)name(key,!first);copy(depth+1,emit);first=false;}input.endObject();if(emit)add("}");}
            case BEGIN_ARRAY -> {input.beginArray();if(emit)add("[");boolean first=true;while(input.hasNext()){if(emit&&!first)add(",");copy(depth+1,emit);first=false;}input.endArray();if(emit)add("]");}
            default -> throw new IOException("Unexpected composite JSON token");
        }
    }

    private boolean temporal(String kind,boolean root) throws IOException {
        boolean valid=true;Boolean isNull=null;Map<String,String> parts=new LinkedHashMap<>();Set<String> names=new HashSet<>();
        while(input.hasNext()) {
            String key=input.nextName();
            if(!names.add(key)||!MARKER.equals(key)||input.peek()!=JsonToken.BEGIN_OBJECT){valid=false;copy(0,false);continue;}
            input.beginObject();Set<String> fields=new HashSet<>();
            while(input.hasNext()) {
                String part=input.nextName();if(!fields.add(part))valid=false;
                if("isNull".equals(part)&&input.peek()==JsonToken.BOOLEAN)isNull=input.nextBoolean();
                else if(Set.of("first","second","context").contains(part)&&(input.peek()==JsonToken.STRING||input.peek()==JsonToken.NULL)){if(input.peek()==JsonToken.NULL){input.nextNull();parts.put(part,null);}else {String value=input.nextString();if(value.length()>256)valid=false;parts.put(part,value);}}
                else {valid=false;copy(0,false);}
            }
            input.endObject();if(!fields.equals(Set.of("isNull","first","second","context")))valid=false;
        }
        input.endObject();
        if(root&&input.peek()!=JsonToken.END_DOCUMENT)throw new IOException("Trailing temporal JSON data");
        Map<String,Object> result=new LinkedHashMap<>();result.put("kind",kind);
        try {
            if(!valid||isNull==null||!names.equals(Set.of(MARKER)))throw new IllegalArgumentException();
            String first=parts.get("first"),second=parts.get("second"),context=parts.get("context");
            boolean zoned="timestamp_tz".equals(kind)||"timestamp_ltz".equals(kind),ltz="timestamp_ltz".equals(kind);
            if(isNull&&(first!=null||second!=null||!ltz&&context!=null)||!isNull&&(first==null||zoned&&second==null))throw new IllegalArgumentException();
            if(!zoned){if(second!=null||context!=null)throw new IllegalArgumentException();result.put("state",isNull?"null":"value");result.put("value",isNull?null:PlDebugTarget.temporalText(new BigDecimal(first),"timestamp".equals(kind)));}
            else {
                var argument=new PlDebugTarget.Argument("component",1,1,0,"OUT",ltz?"TIMESTAMP WITH LOCAL TIME ZONE":"TIMESTAMP WITH TIME ZONE",null,null,null,"N");
                BigDecimal component=first==null?null:new BigDecimal(first);
                var decoded=PlDebugTarget.decodeZoned(argument,component,ltz?null:second,ltz?second==null?null:new BigDecimal(second):component,context);
                result.put("state",decoded.get("state"));result.put("value",((Map<?,?>)decoded.get("typedValue")).get("value"));
                if(ltz&&isNull)result.put("sessionTimeZone",decoded.get("sessionTimeZone"));
            }
            add(JSON.toJson(result));return true;
        }catch(java.sql.SQLException|IllegalArgumentException failure){result.clear();result.put("kind",kind);result.put("state","error");result.put("error","temporal_components_invalid");add(JSON.toJson(result));if(error==null)error="temporal_components_invalid";return false;}
    }

    private static final class Source extends FilterReader {
        private final int maximum;private final long deadline;private int bytes;private boolean high;
        Source(Reader source,int maximum,long deadline){super(source);this.maximum=maximum;this.deadline=deadline;}
        @Override public int read(char[] buffer,int offset,int length)throws IOException {
            if(System.nanoTime()>deadline)throw new Limit();
            int count=super.read(buffer,offset,Math.min(length,1024));
            if(count<0&&high)throw new IOException("Incomplete UTF-16 source");
            for(int i=0;i<count;i++){char value=buffer[offset+i];if(high){if(!Character.isLowSurrogate(value))throw new IOException("Invalid UTF-16 source");bytes+=4;high=false;}else if(Character.isHighSurrogate(value))high=true;else if(Character.isLowSurrogate(value))throw new IOException("Invalid UTF-16 source");else bytes+=value<128?1:value<2048?2:3;if(bytes>maximum)throw new Limit();}
            return count;
        }
    }
}
