package com.dbx.agent;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.io.InputStream;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.CallableStatement;
import java.sql.Savepoint;
import java.sql.SQLTimeoutException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class BlobBoundExecutorTest {
    private static final String PREVIEW = "UPDATE t SET b=HEXTORAW('00ff80')";
    private static final String SQL = "BEGIN UPDATE t SET b=? WHERE DBMS_LOB.COMPARE(b,?)=0; END;";
    private static BlobBoundStatement bound() { return new BlobBoundStatement(PREVIEW, SQL, Arrays.asList("00ff80", "cafe")); }

    @Test void bindsStreamsOnFixedCallableSqlAndClosesThemBeforeCommit() throws Exception {
        Fake jdbc = new Fake();
        QueryResult result = run(jdbc, Arrays.asList(bound()), true);
        assertEquals(SQL, jdbc.preparedSql);
        assertEquals(Arrays.asList("00ff80", "cafe"), jdbc.boundHex);
        assertEquals(Arrays.asList(3L, 2L), jdbc.lengths);
        assertEquals(7, jdbc.timeout);
        assertEquals(1, jdbc.closedStatements);
        assertTrue(jdbc.events.indexOf("close") < jdbc.events.indexOf("commit"));
        assertEquals(1, jdbc.commits);
        assertEquals(0, jdbc.rollbacks);
        assertTrue(jdbc.autoCommit);
        assertEquals(1, result.getAffected_rows());
        for (InputStream stream : jdbc.streams) assertThrows(java.io.IOException.class, stream::read);
    }

    @Test void piecewiseDriverSeesRemainingBytesUntilEntireHexStreamIsSent() throws Exception {
        Fake jdbc=new Fake(); jdbc.piecewiseRead=true;
        String hex="00ff80".repeat(40000);
        BlobBoundStatement statement=new BlobBoundStatement(PREVIEW,"UPDATE t SET b=?",Arrays.asList(hex));
        run(jdbc,Arrays.asList(statement),false);
        assertEquals(Arrays.asList(hex),jdbc.boundHex);
        assertEquals(4,jdbc.pieces);
        assertEquals(0,jdbc.streams.get(0).available());
    }

    @Test void timeoutRollsBackClosesStreamsAndNeverFallsBackToText() throws Exception {
        Fake jdbc = new Fake(); jdbc.fail = true;
        RuntimeException failure = assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound()), true));
        assertInstanceOf(SQLTimeoutException.class, failure.getCause());
        assertEquals(1, jdbc.executions); assertEquals(1, jdbc.rollbacks); assertEquals(0, jdbc.commits);
        assertEquals(1, jdbc.closedStatements); assertTrue(jdbc.autoCommit);
        for (InputStream stream : jdbc.streams) assertThrows(java.io.IOException.class, stream::read);
    }

    @Test void manualFailureRollsBackOnlyBatchSavepoint() {
        Fake jdbc = new Fake(); jdbc.autoCommit = false; jdbc.fail = true;
        assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound()), false));
        assertEquals(1, jdbc.savepointRollbacks); assertEquals(0, jdbc.rollbacks);
        assertEquals(0, jdbc.commits); assertFalse(jdbc.autoCommit); assertEquals(1, jdbc.releases);
    }

    @Test void manualSuccessDoesNotCommitOrChangeAutoCommit() {
        Fake jdbc = new Fake(); jdbc.autoCommit = false;
        run(jdbc, Arrays.asList(bound()), false);
        assertEquals(1, jdbc.savepoints); assertEquals(1, jdbc.releases);
        assertEquals(0, jdbc.commits); assertEquals(0, jdbc.rollbacks); assertFalse(jdbc.autoCommit);
    }

    @Test void laterManualConflictRollsBackFirstWriteButPreservesPriorTransactionWork() {
        Fake jdbc = new Fake(); jdbc.autoCommit=false; jdbc.failAt=2;
        assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound(),bound()), false));
        assertEquals(2,jdbc.executions); assertEquals(42,jdbc.value);
        assertEquals(1,jdbc.savepointRollbacks); assertEquals(0,jdbc.rollbacks);
        assertEquals(0,jdbc.commits); assertFalse(jdbc.autoCommit);
    }

    @Test void failedManualRollbackQuarantinesConnectionWithUnknownOutcome() {
        Fake jdbc = new Fake(); jdbc.autoCommit=false; jdbc.failAt=1; jdbc.failRollback=true;
        RuntimeException failure=assertThrows(RuntimeException.class,()->run(jdbc,Arrays.asList(bound()),false));
        assertTrue(jdbc.connectionClosed); assertEquals(0,jdbc.commits);
        com.google.gson.JsonObject data=AgentRpcError.toJson(failure,"execute_batch","test").getAsJsonObject("data");
        assertEquals("quarantine",data.get("sessionDisposition").getAsString());
        assertEquals("unknown",data.get("operationOutcome").getAsString());
        assertEquals("connection",data.get("category").getAsString());
        assertEquals("08007",data.get("sqlState").getAsString());
    }

    @Test void confirmedObBusinessErrorKeepsPriorWorkButRollbackFailureStillQuarantines() {
        for (int cleanupFailure : new int[]{0,1,2}) {
            boolean cleanupFails=cleanupFailure!=0;
            Fake jdbc=new Fake(); jdbc.autoCommit=false; jdbc.failAt=2; jdbc.failRollback=cleanupFailure==1; jdbc.failRelease=cleanupFailure==2;
            jdbc.executionFailure=new java.sql.SQLTransientConnectionException("ORA-20001: stale target", "HY000", 20001);
            BlobBoundExecutor.PreparedStatementConfigurer configurer=new BlobBoundExecutor.PreparedStatementConfigurer() {
                public void configure(PreparedStatement statement) { }
                public boolean isRollbackConfirmedBusinessError(java.sql.SQLException error) { return error.getErrorCode()==20001; }
            };
            RuntimeException failure=assertThrows(RuntimeException.class,()->BlobBoundExecutor.execute(jdbc.connection(),
                Arrays.asList(PREVIEW,PREVIEW),Arrays.asList(bound(),bound()),null,s->s,()->null,7,false,configurer));
            var data=AgentRpcError.toJson(failure,"execute_batch","test").getAsJsonObject("data");
            assertEquals(cleanupFails?"quarantine":"keep",data.get("sessionDisposition").getAsString());
            assertEquals(cleanupFails?"connection":"sql",data.get("category").getAsString());
            assertEquals("unknown",data.get("operationOutcome").getAsString());
            assertEquals(0,jdbc.commits); assertEquals(0,jdbc.rollbacks);
            if(!cleanupFails) { assertEquals(42,jdbc.value); assertEquals(1,jdbc.savepointRollbacks); assertFalse(jdbc.connectionClosed); }
            else { assertTrue(jdbc.connectionClosed); assertEquals("08007",data.get("sqlState").getAsString()); }
        }
    }

    @Test void exactUnsupportedReleaseDoesNotCommitOrDiscardSuccessfulOrRolledBackManualBatch() {
        for(boolean conflict : new boolean[]{false,true}) {
            Fake jdbc=new Fake(); jdbc.autoCommit=false; jdbc.failRelease=true;
            jdbc.releaseFailure=new java.sql.SQLException("releaseSavepoint is not supported","99999",17023);
            if(conflict) { jdbc.failAt=2; jdbc.executionFailure=new java.sql.SQLTransientConnectionException("ORA-20001: stale", "HY000",20001); }
            BlobBoundExecutor.PreparedStatementConfigurer configurer=new BlobBoundExecutor.PreparedStatementConfigurer() {
                public void configure(PreparedStatement statement) { }
                public boolean isRollbackConfirmedBusinessError(java.sql.SQLException error) { return error.getErrorCode()==20001; }
                public boolean isUnsupportedSavepointRelease(java.sql.SQLException error) { return error.getErrorCode()==17023 && "99999".equals(error.getSQLState()); }
            };
            if(conflict) {
                RuntimeException failure=assertThrows(RuntimeException.class,()->BlobBoundExecutor.execute(jdbc.connection(),
                    Arrays.asList(PREVIEW,PREVIEW),Arrays.asList(bound(),bound()),null,s->s,()->null,7,false,configurer));
                assertEquals("keep",AgentRpcError.toJson(failure,"execute_batch","test").getAsJsonObject("data").get("sessionDisposition").getAsString());
                assertEquals(42,jdbc.value); assertEquals(1,jdbc.savepointRollbacks);
            } else {
                BlobBoundExecutor.execute(jdbc.connection(),Arrays.asList(PREVIEW),Arrays.asList(bound()),null,s->s,()->null,7,false,configurer);
                assertEquals(43,jdbc.value); assertEquals(0,jdbc.savepointRollbacks);
            }
            assertEquals(0,jdbc.commits); assertFalse(jdbc.autoCommit); assertFalse(jdbc.connectionClosed);
        }
    }

    @Test void defaultTypedBatchCommitsOrRollsBackBeforeRestoringAutoCommit() {
        for(boolean conflict : new boolean[]{false,true}) {
            Fake jdbc=new Fake();
            if(conflict) { jdbc.failAt=2; jdbc.executionFailure=new java.sql.SQLTransientConnectionException("ORA-20001: stale", "HY000",20001); }
            BlobBoundExecutor.PreparedStatementConfigurer configurer=new BlobBoundExecutor.PreparedStatementConfigurer() {
                public void configure(PreparedStatement statement) { }
                public boolean isRollbackConfirmedBusinessError(java.sql.SQLException error) { return error.getErrorCode()==20001; }
            };
            if(conflict) {
                RuntimeException failure=assertThrows(RuntimeException.class,()->BlobBoundExecutor.execute(jdbc.connection(),
                    Arrays.asList(PREVIEW,PREVIEW),Arrays.asList(bound(),bound()),null,s->s,()->null,7,false,configurer));
                assertEquals("keep",AgentRpcError.toJson(failure,"execute_batch","test").getAsJsonObject("data").get("sessionDisposition").getAsString());
                assertEquals(42,jdbc.value); assertEquals(1,jdbc.rollbacks); assertEquals(0,jdbc.commits);
            } else {
                BlobBoundExecutor.execute(jdbc.connection(),Arrays.asList(PREVIEW,PREVIEW),Arrays.asList(bound(),bound()),null,s->s,()->null,7,false,configurer);
                assertEquals(44,jdbc.value); assertEquals(1,jdbc.commits); assertEquals(0,jdbc.rollbacks);
            }
            assertTrue(jdbc.autoCommit); assertEquals(0,jdbc.savepoints);
        }
        Fake manual=new Fake(); manual.autoCommit=false;
        assertThrows(IllegalStateException.class,()->run(manual,Arrays.asList(bound()),true));
        assertEquals(0,manual.executions); assertFalse(manual.autoCommit);
    }

    @Test void typedDdlOrTransactionControlRejectsCompleteBatchBeforeOpeningConnection() {
        for(String sql : List.of("CREATE TABLE t (b BLOB)","BEGIN UPDATE t SET b=?; COMMIT; END;", "BEGIN EXECUTE IMMEDIATE 'DROP TABLE t'; END;")) {
            Fake jdbc=new Fake();
            BlobBoundStatement invalid=new BlobBoundStatement(sql,sql,sql.contains("?")?List.of("00"):List.of());
            assertThrows(IllegalArgumentException.class,()->run(jdbc,Arrays.asList(bound(),invalid),false));
            assertEquals(0,jdbc.executions); assertNull(jdbc.preparedSql); assertTrue(jdbc.autoCommit);
        }
        BlobBoundStatement.validate(List.of(PREVIEW),List.of(new BlobBoundStatement(PREVIEW,"UPDATE t SET b=? /* COMMIT */ WHERE note='CREATE TABLE x'",List.of("00"))));
    }

    @Test void defaultTypedCommitRollbackOrResetFailuresNeverBecomeKnownBusinessKeep() {
        for(String stage : List.of("commit","rollback","reset")) {
            Fake jdbc=new Fake(); jdbc.failCommit=stage.equals("commit"); jdbc.failReset=stage.equals("reset");
            if(stage.equals("rollback")) { jdbc.failAt=1; jdbc.failRollback=true; jdbc.executionFailure=new java.sql.SQLTransientConnectionException("stale", "HY000",20001); }
            BlobBoundExecutor.PreparedStatementConfigurer configurer=new BlobBoundExecutor.PreparedStatementConfigurer() {
                public void configure(PreparedStatement statement) { }
                public boolean isRollbackConfirmedBusinessError(java.sql.SQLException error) { return error.getErrorCode()==20001; }
            };
            RuntimeException failure=assertThrows(RuntimeException.class,()->BlobBoundExecutor.execute(jdbc.connection(),
                Arrays.asList(PREVIEW),Arrays.asList(bound()),null,s->s,()->null,7,false,configurer));
            var data=AgentRpcError.toJson(failure,"execute_batch","test").getAsJsonObject("data");
            assertEquals("quarantine",data.get("sessionDisposition").getAsString());
            assertEquals("unknown",data.get("operationOutcome").getAsString());
        }
    }

    @Test void unsupportedSavepointFailsBeforeAnyWrite() {
        Fake jdbc = new Fake(); jdbc.autoCommit = false; jdbc.unsupportedSavepoint = true;
        assertThrows(RuntimeException.class, () -> run(jdbc, Arrays.asList(bound()), false));
        assertEquals(0, jdbc.executions); assertEquals(0, jdbc.commits); assertEquals(0, jdbc.rollbacks);
    }

    @Test void rejectsInvalidLaterBindingBeforeOpeningAnyStatement() {
        Fake jdbc = new Fake();
        assertThrows(IllegalArgumentException.class, () -> run(jdbc,
            Arrays.asList(bound(), new BlobBoundStatement(PREVIEW, SQL, Arrays.asList("0x00"))), true));
        assertEquals(0, jdbc.executions); assertNull(jdbc.preparedSql); assertTrue(jdbc.autoCommit);
        assertThrows(IllegalArgumentException.class, () -> BlobBoundStatement.validate(Arrays.asList("edited"), Arrays.asList(bound())));
    }

    @Test void cancellationTracksStatementAndPreventsNextStatement() {
        Fake jdbc = new Fake(); jdbc.cancel = true;
        assertThrows(java.util.concurrent.CancellationException.class, () -> run(jdbc, Arrays.asList(bound(), bound()), true));
        assertEquals(2, jdbc.cancels); assertEquals(1, jdbc.executions);
        assertEquals(1, jdbc.rollbacks); assertEquals(2, jdbc.closedStatements);
    }

    @Test void invalidLaterParameterCountFailsBeforeAnyWriteAndIgnoresQuotedMarkers() {
        Fake jdbc=new Fake();
        assertThrows(IllegalArgumentException.class,()->run(jdbc,Arrays.asList(bound(),new BlobBoundStatement(PREVIEW,SQL,Arrays.asList("cafe"))),true));
        assertEquals(0,jdbc.executions); assertNull(jdbc.preparedSql);
        BlobBoundStatement.validate(Arrays.asList(PREVIEW),Arrays.asList(new BlobBoundStatement(PREVIEW,
            "BEGIN UPDATE t SET b=?; x:='?''?'; x:=q'[?]'; -- ?\n/* ? */ END;",Arrays.asList("cafe"))));
    }

    @Test void legacyAgentRejectsBindingBeforeCallingLegacyBatch() {
        DatabaseAgent agent = (DatabaseAgent) Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(), new Class<?>[]{DatabaseAgent.class},
            (p, m, a) -> { if (m.getName().equals("supportsBlobBindStatements")) return false;
                if (m.getName().equals("getConnection")) return new Fake().connection();
                if (m.getName().startsWith("execute")) throw new AssertionError("Must not execute unsupported payload"); return defaultValue(m.getReturnType()); });
        String response = new JsonRpcServer(agent).handleRequest("{\"id\":1,\"method\":\"execute_batch\",\"params\":{\"statements\":[],\"boundStatements\":[]}}");
        assertTrue(JsonParser.parseString(response).getAsJsonObject().getAsJsonObject("error").get("message").getAsString().contains("blob_bind_statements_v1"), response);
    }

    @Test void onlyOptedInServerAdvertisesBindingCapability() {
        com.google.gson.Gson gson = new com.google.gson.Gson();
        assertFalse(gson.toJson(AgentProtocol.multiSessionJdbcHandshakeResult()).contains("blob_bind_statements_v1"));
        assertTrue(gson.toJson(AgentProtocol.multiSessionJdbcHandshakeResult(true)).contains("blob_bind_statements_v1"));
    }

    @Test void laterSetterFailureOccursBeforeAnyWriteAndClosesAllResources() {
        Fake jdbc=new Fake(); jdbc.failBindAt=3;
        assertThrows(RuntimeException.class,()->run(jdbc,Arrays.asList(bound(),bound()),true));
        assertEquals(0,jdbc.executions); assertEquals(1,jdbc.rollbacks); assertEquals(2,jdbc.closedStatements);
        for(InputStream stream:jdbc.streams)assertThrows(java.io.IOException.class,stream::read);
    }

    @Test void cancellationDuringResourceCloseStillPreventsCommit() {
        Fake jdbc=new Fake();jdbc.cancelOnClose=true;
        assertThrows(java.util.concurrent.CancellationException.class,()->run(jdbc,Arrays.asList(bound()),true));
        assertEquals(1,jdbc.executions);assertEquals(0,jdbc.commits);assertEquals(1,jdbc.rollbacks);
    }

    @Test void connectionResetAfterCommitReportsUnknownInsteadOfClaimingNoWrite() {
        Fake jdbc=new Fake();jdbc.failReset=true;
        RuntimeException failure=assertThrows(RuntimeException.class,()->run(jdbc,Arrays.asList(bound()),true));
        assertEquals(1,jdbc.commits);assertTrue(jdbc.connectionClosed);
        com.google.gson.JsonObject data=AgentRpcError.toJson(failure,"execute_transaction","test").getAsJsonObject("data");
        assertEquals("quarantine",data.get("sessionDisposition").getAsString());
        assertEquals("unknown",data.get("operationOutcome").getAsString());
    }

    @Test void rpcRejectsNonStringHexRatherThanGsonCoercingIt() {
        DatabaseAgent agent=(DatabaseAgent)Proxy.newProxyInstance(DatabaseAgent.class.getClassLoader(),new Class<?>[]{DatabaseAgent.class},
            (p,m,a)->{if(m.getName().equals("supportsBlobBindStatements"))return true;
                if(m.getName().equals("getConnection"))return new Fake().connection();
                if(m.getName().startsWith("execute"))throw new AssertionError("Malformed payload must not execute");return defaultValue(m.getReturnType());});
        String response=new JsonRpcServer(agent).handleRequest("{\"id\":2,\"method\":\"execute_transaction\",\"params\":{\"statements\":[\"preview\"],\"boundStatements\":[{\"previewSql\":\"preview\",\"sql\":\"BEGIN x:=?; END;\",\"blobParameters\":[12]}]}}");
        assertTrue(response.contains("hexadecimal string"),response);
    }

    private static QueryResult run(Fake jdbc, List<BlobBoundStatement> statements, boolean transaction) {
        List<String> previews = new ArrayList<>(); for (BlobBoundStatement ignored : statements) previews.add(PREVIEW);
        return BlobBoundExecutor.execute(jdbc.connection(), previews, statements, null, schema -> null, () -> "", 7, transaction);
    }

    private static final class Fake {
        boolean autoCommit = true, fail, cancel, unsupportedSavepoint, failRollback, connectionClosed, failReset, cancelOnClose, piecewiseRead, failRelease, failCommit;
        int pieces;
        int value=42,savedValue=42,transactionStartValue=42,failAt,failBindAt;
        int commits, rollbacks, savepointRollbacks, savepoints, releases, executions, closedStatements, cancels, timeout;
        String preparedSql;
        java.sql.SQLException executionFailure;
        java.sql.SQLException releaseFailure;
        List<String> events = new ArrayList<>(), boundHex = new ArrayList<>();
        List<Long> lengths = new ArrayList<>(); List<InputStream> streams = new ArrayList<>();
        Connection connection() {
            return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[]{Connection.class}, (p,m,a) -> {
                switch (m.getName()) {
                    case "getAutoCommit": return autoCommit;
                    case "isValid": return true;
                    case "close": connectionClosed=true; return null;
                    case "setAutoCommit": if(failReset && (boolean)a[0])throw new java.sql.SQLException("reset failed"); if(autoCommit && !(boolean)a[0])transactionStartValue=value; autoCommit = (boolean)a[0]; return null;
                    case "getMetaData": return Proxy.newProxyInstance(DatabaseMetaData.class.getClassLoader(), new Class<?>[]{DatabaseMetaData.class}, (x,y,z) -> y.getName().equals("supportsTransactions") ? true : defaultValue(y.getReturnType()));
                    case "setSavepoint": if (unsupportedSavepoint) throw new java.sql.SQLFeatureNotSupportedException(); savepoints++; savedValue=value; return Proxy.newProxyInstance(Savepoint.class.getClassLoader(),new Class<?>[]{Savepoint.class},(x,y,z)->defaultValue(y.getReturnType()));
                    case "releaseSavepoint": releases++; if(failRelease)throw releaseFailure!=null?releaseFailure:new java.sql.SQLTransientConnectionException("release lost connection","08006"); return null;
                    case "commit": commits++; events.add("commit"); if(failCommit)throw new java.sql.SQLTransientConnectionException("commit outcome unknown","HY000",20001); return null;
                    case "rollback": if(failRollback)throw new java.sql.SQLException("rollback lost connection","08006"); if (a == null || a.length == 0) {rollbacks++;value=transactionStartValue;} else {savepointRollbacks++;value=savedValue;} return null;
                    case "prepareCall": case "prepareStatement": preparedSql=(String)a[0]; return statement(m.getName().equals("prepareCall"));
                    default: return defaultValue(m.getReturnType());
                }
            });
        }
        PreparedStatement statement(boolean callable) {
            Class<?> type = callable ? CallableStatement.class : PreparedStatement.class;
            return (PreparedStatement) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (p,m,a) -> {
                switch (m.getName()) {
                    case "setQueryTimeout": timeout=(int)a[0]; return null;
                    case "setBlob": assertInstanceOf(InputStream.class,a[1]); assertInstanceOf(Long.class,a[2]);
                        InputStream stream=(InputStream)a[1]; streams.add(stream); lengths.add((Long)a[2]);
                        if(streams.size()==failBindAt)throw new java.sql.SQLException("binding failed");
                        byte[] bytes;
                        if(piecewiseRead) {
                            java.io.ByteArrayOutputStream sent=new java.io.ByteArrayOutputStream(); byte[] buffer=new byte[32768];
                            int read;
                            while((read=stream.read(buffer))!=-1) { sent.write(buffer,0,read); pieces++; if(stream.available()==0)break; }
                            bytes=sent.toByteArray();
                        } else bytes=stream.readAllBytes();
                        StringBuilder hex=new StringBuilder(); for(byte b:bytes)hex.append(String.format("%02x",b&255)); boundHex.add(hex.toString()); return null;
                    case "execute": executions++;value++; if(fail)throw new SQLTimeoutException("timed out","HYT00"); if(executions==failAt)throw executionFailure!=null?executionFailure:new java.sql.SQLException("stale target","23000"); if(cancel)JdbcExecutor.current().cancelActiveStatements(); return false;
                    case "getUpdateCount": return 1;
                    case "cancel": cancels++; return null;
                    case "close": closedStatements++; events.add("close"); if(cancelOnClose)JdbcExecutor.current().cancelActiveStatements(); return null;
                    case "hashCode": return System.identityHashCode(p);
                    case "equals": return p==a[0];
                    default: return defaultValue(m.getReturnType());
                }
            });
        }
    }
    private static Object defaultValue(Class<?> type) {
        if(type==boolean.class)return false;if(type==int.class)return 0;if(type==long.class)return 0L;return null;
    }
}
