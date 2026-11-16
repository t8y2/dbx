package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.Reader;
import java.io.StringReader;
import java.util.Base64;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugResultCacheTest {
    @Test void normalizedPartialJsonFitsRemainingBudgetAndEofDoesNotClearItsError() throws Exception {
        var cache=new PlDebugResultCache(4608);
        String source="{\"kind\":\"record\",\"fields\":{\"N\":{\"kind\":\"number\",\"value\":\"17\"},\"large\":{\"kind\":\"text\",\"value\":\""+"中🙂".repeat(1000)+"\"}},\"complete\":true}";
        var normalized=PlDebugTemporalJson.normalize(new StringReader(source),cache.remaining(),System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5));
        var ref=cache.text(new StringReader(normalized.text()),"V",normalized.complete(),normalized.error());
        assertEquals(false,ref.get("complete"));assertEquals(true,ref.get("truncated"));assertEquals("budget_exceeded",ref.get("error"));
        assertEquals(normalized.text(),page(cache,ref,0,4096).get("data"));
        assertDoesNotThrow(()->com.google.gson.JsonParser.parseString((String)page(cache,ref,0,4096).get("data")));
        assertEquals(ref.get("length"),normalized.text().length());
        var errors=new PlDebugResultCache();var error=errors.text(new StringReader("{\"state\":\"error\"}"),"V",false,"temporal_components_invalid");
        assertEquals("temporal_components_invalid",error.get("error"));assertEquals(false,error.get("complete"));assertEquals(false,error.get("truncated"));
    }
    private static Map<String,Object> page(PlDebugResultCache cache, Map<String,Object> ref, int offset, int limit) {
        return cache.page((String)ref.get("generation"),(String)ref.get("resultId"),offset,limit);
    }

    @Test
    void immutableTextPagesKeepUnicodeControlsAndExactIdentity() {
        var cache = new PlDebugResultCache();
        var ref = cache.text(new StringReader("中\u0000😀\n尾"),"X");
        assertEquals(true,ref.get("complete"));
        assertEquals(6,ref.get("length"));
        var first = page(cache,ref,0,3);
        assertEquals("中\u0000",first.get("data"));
        assertEquals(2,first.get("nextOffset"));
        assertEquals(first,page(cache,ref,0,3));
        assertThrows(IllegalArgumentException.class,()->page(cache,ref,2,1));
        assertThrows(IllegalArgumentException.class,()->page(cache,ref,3,2));
        var rest = page(cache,ref,2,64);
        assertEquals("😀\n尾",rest.get("data"));
        assertEquals(true,rest.get("eof"));
        assertThrows(IllegalArgumentException.class,()->cache.page("other",(String)ref.get("resultId"),0,5));
        assertThrows(IllegalArgumentException.class,()->new PlDebugResultCache().page((String)ref.get("generation"),(String)ref.get("resultId"),0,5));
        assertThrows(UnsupportedOperationException.class,()->ref.put("length",0));
    }

    @Test
    void binaryPagesHaveByteOffsetsAndIndependentBase64Encoding() {
        var cache = new PlDebugResultCache();
        byte[] bytes = new byte[80001];
        for(int i=0;i<bytes.length;i++)bytes[i]=(byte)i;
        var ref = cache.binary(new ByteArrayInputStream(bytes),"B");
        assertEquals(bytes.length,ref.get("length"));
        var out = new java.io.ByteArrayOutputStream();
        for(int offset=0;offset<bytes.length;){
            var part=page(cache,ref,offset,32767);
            out.writeBytes(Base64.getDecoder().decode((String)part.get("data")));
            offset=(int)part.get("nextOffset");
        }
        assertArrayEquals(bytes,out.toByteArray());
    }

    @Test
    void budgetRetainsAnExplicitPartialPrefixWithoutSplittingUnicode() {
        var cache = new PlDebugResultCache(4101);
        var ref = cache.text(new StringReader("😀😀尾"),"X");
        assertEquals(false,ref.get("complete"));
        assertEquals(true,ref.get("truncated"));
        assertEquals("partial",ref.get("state"));
        assertEquals("😀",page(cache,ref,0,64).get("data"));
        assertThrows(IllegalStateException.class,()->cache.text(new StringReader("next"),"Y"));
        assertEquals(1,cache.manifests().size());
    }

    @Test
    void readFailuresKeepConfirmedPrefixAndDoNotBecomeTruncationOrEmptySuccess() {
        var cache = new PlDebugResultCache();
        var ref = cache.text(new Reader(){
            int calls;
            @Override public int read(char[] target,int offset,int count)throws IOException {
                if(calls++>0)throw new IOException("private driver failure");
                target[offset]='中';return 1;
            }
            @Override public void close() { }
        },"X.field");
        assertEquals("read_failed",ref.get("error"));
        assertEquals(false,ref.get("truncated"));
        assertEquals("中",page(cache,ref,0,64).get("data"));
        assertFalse(ref.toString().contains("private driver failure"));
        var empty=cache.text(new StringReader(""),"empty");
        assertEquals(0,empty.get("length"));
        assertEquals(true,empty.get("complete"));
        assertEquals("",page(cache,empty,0,64).get("data"));
    }

    @Test
    void binaryCapacityCountsBase64ExpansionAndSharesTheAggregateBudget() {
        var cache = new PlDebugResultCache(4104);
        var ref = cache.binary(new ByteArrayInputStream(new byte[7]),"B");
        assertEquals(6,ref.get("length"));
        assertEquals(true,ref.get("truncated"));
        assertEquals(8,((String)page(cache,ref,0,64).get("data")).length());
        assertThrows(IllegalStateException.class,()->cache.binary(new ByteArrayInputStream(new byte[0]),"second"));
        assertThrows(IllegalArgumentException.class,()->page(cache,ref,-1,64));
        assertThrows(IllegalArgumentException.class,()->page(cache,ref,0,PlDebugResultCache.MAX_PAGE_UNITS+1));
    }

    @Test
    void malformedUtf16KeepsOnlyTheConfirmedValidPrefix() {
        var cache = new PlDebugResultCache();
        var ref=cache.text(new StringReader("ok\uD800x"),"X");
        assertEquals("invalid_utf16",ref.get("error"));
        assertEquals(false,ref.get("complete"));
        assertEquals(false,ref.get("truncated"));
        assertEquals("ok",page(cache,ref,0,64).get("data"));
    }

    @Test
    void aBlockedLocatorReadDoesNotBlockAlreadyRetainedPagesOrManifestReads() throws Exception {
        var cache = new PlDebugResultCache();
        var ready=cache.text(new StringReader("ready"),"first");
        var entered=new java.util.concurrent.CountDownLatch(1);
        var release=new java.util.concurrent.CountDownLatch(1);
        try(var worker=java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var capture=worker.submit(()->cache.text(new Reader(){
                @Override public int read(char[] target,int offset,int count)throws IOException {
                    entered.countDown();
                    try { release.await(); } catch(InterruptedException error) { throw new IOException(error); }
                    return -1;
                }
                @Override public void close() { }
            },"second"));
            try {
                assertTrue(entered.await(2,java.util.concurrent.TimeUnit.SECONDS));
                assertTimeoutPreemptively(java.time.Duration.ofSeconds(1),()->{
                    assertEquals(1,cache.manifests().size());
                    assertEquals("ready",page(cache,ready,0,64).get("data"));
                });
            } finally { release.countDown(); }
            assertEquals(true,capture.get(2,java.util.concurrent.TimeUnit.SECONDS).get("complete"));
        }
    }
}
