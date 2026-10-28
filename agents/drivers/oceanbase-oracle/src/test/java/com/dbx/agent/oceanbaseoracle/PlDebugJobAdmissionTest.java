package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.*;
import com.google.gson.*;
import org.junit.jupiter.api.Test;
import java.lang.reflect.Method;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugJobAdmissionTest {
    private static JsonObject rpc(MultiSessionJsonRpcServer server,String method,Map<String,Object> params) throws Exception {
        Method dispatch=MultiSessionJsonRpcServer.class.getDeclaredMethod("handleRequest",String.class);dispatch.setAccessible(true);
        return JsonParser.parseString((String)dispatch.invoke(server,new Gson().toJson(Map.of("id",1,"method",method,"params",params)))).getAsJsonObject();
    }

    private static MultiSessionJsonRpcServer server(StubAgent agent) throws Exception {
        var server=PlDebugDedicatedOwnerFixture.unpooledServer(()->agent);
        assertFalse(rpc(server,"open_session",Map.of("agentSessionId","same","sessionRole","metadata","host","fixture","database","SYS","username","fixture")).has("error"));
        return server;
    }

    private static Map<String,Object> job(boolean legacy) {
        return legacy?Map.of("agentSessionId","same","operationId","job","dialect","oceanbase-oracle","instance",0,"what","BEGIN NULL;END;","nextDate","2026-10-26 00:00:00","interval","","schema","SYS","enabled",false,"timeoutSecs",5):Map.of("agentSessionId","same","operationId","job");
    }

    private static Map<String,Object> debug() { return Map.of("agentSessionId","same","operationId","debug","objectType","ANONYMOUS","source","BEGIN NULL;END;"); }

    @Test void handshakeKeepsJobAndAllDebugCapabilities() throws Exception {
        try(var server=MultiSessionJsonRpcServer.withNativeLegacyJobs(()->new StubAgent(()->{throw new SQLException("not opened");}),true).withExactMetadataIdentity().withNativePlDebug(true).withBreakpointOperationStatus().withRetainedPlDebugResults()) {
            var result=rpc(server,"handshake",Map.of()).getAsJsonObject("result");var capabilities=result.getAsJsonArray("capabilities");
            for(String capability:List.of("native_job_legacy_ob_v1","blob_bind_statements_v1","exact_metadata_identity_v1","pl_debug_retained_results_v1"))assertTrue(capabilities.contains(new JsonPrimitive(capability)),capability);
            var debug=result.getAsJsonObject("plDebug");assertTrue(debug.get("setValueOperationStatus").getAsBoolean());assertTrue(debug.get("breakpointOperationStatus").getAsBoolean());assertFalse(debug.get("helperObjects").getAsBoolean());
        }
    }

    @Test void openingJobRejectsDebugBeforeAnyDebugAllocationEvenWhenReleaseIsUnknown() throws Exception {
        for(boolean legacy:List.of(false,true)) {
            var debugOpens=new AtomicInteger();var agent=new StubAgent(()->{debugOpens.incrementAndGet();throw new SQLException("debug must not open");});
            var server=server(agent);agent.blockJob=true;agent.closeFails=true;
            var request=CompletableFuture.supplyAsync(()->{try{return rpc(server,legacy?"prepare_legacy_job":"open_native_job_session",job(legacy));}catch(Exception error){throw new CompletionException(error);}});
            try {
                assertTrue(agent.jobEntered.await(5,TimeUnit.SECONDS),"job opener did not start");
                var denied=CompletableFuture.supplyAsync(()->{try{return rpc(server,"pl_debug_start",debug());}catch(Exception error){throw new CompletionException(error);}}).get(2,TimeUnit.SECONDS);
                assertTrue(denied.has("error"));assertEquals(0,debugOpens.get());assertFalse(agent.debugReserved());assertEquals(0,agent.statements.get());
                agent.jobRelease.countDown();request.get(5,TimeUnit.SECONDS);
                assertTrue(rpc(server,"pl_debug_start",debug()).has("error"));assertEquals(0,debugOpens.get());assertFalse(agent.debugReserved());
            } finally {agent.jobRelease.countDown();agent.closeFails=false;server.close();}
        }
    }

    @Test void openingAndUnknownDebugRejectBothJobOwnersBeforeOpening() throws Exception {
        for(boolean legacy:List.of(false,true)) {
            var entered=new CountDownLatch(1);var release=new CountDownLatch(1);var opens=new AtomicInteger();
            var agent=new StubAgent(()->{opens.incrementAndGet();entered.countDown();if(!release.await(5,TimeUnit.SECONDS))throw new SQLException("debug opener deadline");throw new PlDebugManager.UntrackedConnectionException(new SQLException("physical release unconfirmed"));});
            var server=server(agent);
            var request=CompletableFuture.supplyAsync(()->{try{return rpc(server,"pl_debug_start",debug());}catch(Exception error){throw new CompletionException(error);}});
            try {
                assertTrue(entered.await(5,TimeUnit.SECONDS),"debug opener did not start");assertTrue(agent.debugReserved());
                var denied=CompletableFuture.supplyAsync(()->{try{return rpc(server,legacy?"prepare_legacy_job":"open_native_job_session",job(legacy));}catch(Exception error){throw new CompletionException(error);}}).get(2,TimeUnit.SECONDS);
                assertTrue(denied.has("error"));assertEquals(0,agent.jobAttempts.get());assertEquals(0,agent.statements.get());
                release.countDown();assertTrue(request.get(5,TimeUnit.SECONDS).has("error"));assertTrue(agent.debugReserved());
                assertTrue(rpc(server,legacy?"prepare_legacy_job":"open_native_job_session",job(legacy)).has("error"));assertEquals(0,agent.jobAttempts.get());assertEquals(1,opens.get());
            } finally {release.countDown();server.close();}
        }
    }

    private static final class StubAgent extends ConfiguredJdbcAgent {
        final AtomicInteger jobAttempts=new AtomicInteger(),statements=new AtomicInteger();
        final CountDownLatch jobEntered=new CountDownLatch(1),jobRelease=new CountDownLatch(1);
        volatile boolean blockJob,closeFails;
        private final PlDebugManager debug;
        StubAgent(PlDebugManager.ConnectionFactory connections){
            super(OceanBaseOracleAgent.OCEANBASE_ORACLE_PROFILE);
            debug=new PlDebugManager(connections,dedicatedAdmission(),this::hasNativeJobReservation);
        }
        @Override protected boolean hasDedicatedDebugReservation(){return debug.hasUnreleased();}
        @Override public Map<String,Object> plDebugStart(PlDebugStartRequest request){return unchecked(()->debug.start(request));}
        @Override protected void afterDisconnect()throws Exception{debug.closeAll();}
        boolean debugReserved(){return hasDedicatedDebugReservation();}
        @Override public boolean supportsNativeJobSessions(){return true;}
        @Override public boolean supportsNativeLegacyJobs(){return true;}
        @Override protected void loadDriver(ConnectParams params){}
        @Override protected void afterPhysicalConnect(ConnectParams params,Connection connection){}
        @Override protected void afterConnect(ConnectParams params,Connection connection){}
        @Override protected Connection openConnection(ConnectParams params){
            return PlDebugTestJdbc.proxy(Connection.class,(method,args)->{
                if(method.getName().equals("getAutoCommit")||method.getName().equals("isValid"))return true;
                if(method.getName().equals("setAutoCommit")&&Boolean.FALSE.equals(args[0])) {
                    jobAttempts.incrementAndGet();jobEntered.countDown();
                    if(blockJob){if(!jobRelease.await(5,TimeUnit.SECONDS))throw new SQLException("job opener deadline");throw new SQLException("job open failed");}
                }
                if(method.getName().equals("close")&&closeFails)throw new SQLException("physical close unconfirmed");
                if(method.getName().startsWith("prepare")||method.getName().equals("createStatement"))statements.incrementAndGet();
                return PlDebugTestJdbc.empty(method.getReturnType());
            });
        }
    }
}
