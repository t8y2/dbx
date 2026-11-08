package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.*;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

final class NativeLegacyJobTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<Physical> PHYSICAL = new ArrayList<>();
    private final List<String> sessions = new ArrayList<>();

    @AfterEach
    void cleanup() throws Exception {
        for (String session : sessions) call("closeJdbcSession", params(session));
        call("close", MAPPER.createObjectNode());
        var driverKey = DbxJdbcPlugin.class.getDeclaredField("logicalDriverKey");
        driverKey.setAccessible(true);
        driverKey.set(null, null);
        FakeDriver.product = "Oracle";
        FakeDriver.nextFailure = "";
        FakeDriver.failOpen = false;
        PHYSICAL.clear();
    }

    @Test
    void advertisesTheNarrowProtocolWithoutOpeningAConnection() throws Exception {
        JsonNode protocol = result(call("jdbcSessionProtocol", params(null)));
        assertEquals(2, protocol.path("version").asInt());
        assertEquals("native_job_legacy_v1", protocol.path("capabilities").path(0).asText());
        assertTrue(PHYSICAL.isEmpty());
    }

    @Test
    void nativeCatalogDiagnosticsUseTheExistingQueryCorridorWithoutChangingOrdinaryErrors() throws Exception {
        open("catalog");
        FakeDriver.nextFailure = "catalog";
        ObjectNode query = params("catalog").put("sql", "SELECT * FROM SYS.DBA_JOBS").put("nativeDiagnostics", true);
        JsonNode response = result(call("executeQuery", query));
        assertTrue(response.path("execution_error").asBoolean());
        assertEquals("sql", response.path("error").path("diagnostics").path("category").asText());
        assertEquals(942, response.path("error").path("diagnostics").path("vendorCode").asInt());
        assertFalse(response.toString().contains("private"));
        query.remove("nativeDiagnostics");
        assertTrue(call("executeQuery", query).path("error").path("message").asText().contains("private"));
    }

    @Test
    void connectionFailureIsNotDisguisedAsAHiddenCatalogEvenWithTheSameVendorCode() throws Exception {
        open("connection");
        FakeDriver.nextFailure = "connection";
        JsonNode response = result(call("executeQuery", params("connection")
            .put("sql", "SELECT * FROM SYS.DBA_JOBS").put("nativeDiagnostics", true)));
        assertEquals("connection", response.path("error").path("diagnostics").path("category").asText());
        assertFalse(response.toString().contains("private"));
    }

    @Test
    void preparesOnOneConnectionWithoutCommittingOrInterpolatingTheBody() throws Exception {
        open("native");
        JsonNode prepared = result(call("prepareLegacyJob", prepare("native", "op")));
        assertEquals("prepared", prepared.path("phase").asText());
        assertEquals("9007199254740993", prepared.path("jobId").asText());
        assertEquals(1, PHYSICAL.size());
        Physical physical = PHYSICAL.getFirst();
        assertFalse(physical.autoCommit);
        assertFalse(physical.closed);
        assertEquals(List.of("schema", "auto:false", "submit", "broken", "read"), physical.events);
        assertEquals(0, physical.commits);
        assertTrue(physical.sql.stream().noneMatch(sql -> sql.contains("private_")));
        assertEquals("private_body('private_argument');", physical.what);
        assertEquals(Types.VARCHAR, physical.outType);
        assertEquals(List.of(17, 17, 17, 17), physical.timeouts);
    }

    @Test
    void finalBrokenStateAndExplicitNextDatePrecedeTheFirstCommit() throws Exception {
        for (boolean enabled : List.of(false, true)) {
            String session = "enabled-" + enabled;
            open(session);
            JsonNode prepared = result(call("prepare_legacy_job", prepare(session, session).put("enabled", enabled)));
            assertEquals("prepared", prepared.path("phase").asText());
            Physical physical = PHYSICAL.getLast();
            assertEquals(enabled ? "N" : "Y", physical.broken);
            assertEquals("2026-10-21 10:20:30", physical.brokenNextDate);
            assertEquals("committed", result(call("commitLegacyJob", finish(session, session, physical.id))).path("phase").asText());
            assertTrue(physical.events.indexOf("broken") < physical.events.indexOf("commit"));
            assertEquals(1, physical.commits);
            assertEquals(0, physical.rollbacks);
            assertTrue(physical.closed);
        }
    }

    @Test
    void duplicatePreparationCannotReplaceTheImmutableDefinition() throws Exception {
        open("native");
        ObjectNode request = prepare("native", "op");
        JsonNode prepared = result(call("prepareLegacyJob", request));
        assertEquals(prepared, result(call("prepareLegacyJob", request)));
        assertEquals("native_job_operation_mismatch", result(call("prepareLegacyJob", request.deepCopy().put("what", "other;"))).path("reason").asText());
        assertEquals(1, PHYSICAL.getFirst().events.stream().filter("submit"::equals).count());
        assertEquals(prepared, result(call("legacyJobStatus", finish("native", "op", null))));
        assertFalse(result(call("legacyJobStatus", finish("native", "different", null))).has("jobId"));
    }

    @Test
    void commitRequiresTheRecordedIdAndNeverReplaysAfterItCompletes() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        Physical physical = PHYSICAL.getFirst();
        assertEquals("native_job_identity_mismatch", result(call("commitLegacyJob", finish("native", "op", null))).path("reason").asText());
        assertEquals("native_job_identity_mismatch", result(call("commitLegacyJob", finish("native", "op", "2"))).path("reason").asText());
        assertEquals(0, physical.commits);
        JsonNode committed = result(call("commit_legacy_job", finish("native", "op", physical.id)));
        assertEquals("committed", committed.path("phase").asText());
        assertEquals(committed, result(call("commitLegacyJob", finish("native", "op", physical.id))));
        assertEquals(committed, result(call("rollbackLegacyJob", finish("native", "op", physical.id))));
        assertEquals(1, physical.commits);
        assertEquals(0, physical.rollbacks);
        assertEquals(1, PHYSICAL.size());
    }

    @Test
    void lostPreparationResponseCanBeRolledBackWithoutKnowingTheOutId() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        assertEquals("native_job_identity_mismatch", result(call("rollbackLegacyJob", finish("native", "op", "2"))).path("reason").asText());
        JsonNode rolledBack = result(call("rollback_legacy_job", finish("native", "op", null)));
        assertEquals("rolled_back", rolledBack.path("phase").asText());
        assertEquals(rolledBack, result(call("rollbackLegacyJob", finish("native", "op", null))));
        assertEquals(1, PHYSICAL.getFirst().rollbacks);
        assertEquals(0, PHYSICAL.getFirst().commits);
        assertTrue(PHYSICAL.getFirst().closed);
    }

    @Test
    void lostCommitResponseStaysUnknownAndCannotSubmitCommitOrRollbackAgain() throws Exception {
        open("native");
        ObjectNode prepare = prepare("native", "op");
        result(call("prepareLegacyJob", prepare));
        Physical physical = PHYSICAL.getFirst();
        physical.fail = "commit";
        JsonNode unknown = result(call("commitLegacyJob", finish("native", "op", physical.id)));
        assertEquals("unknown", unknown.path("phase").asText());
        assertEquals("native_job_commit_unknown", unknown.path("reason").asText());
        assertEquals(unknown, result(call("prepareLegacyJob", prepare)));
        assertEquals(unknown, result(call("commitLegacyJob", finish("native", "op", physical.id))));
        assertEquals(unknown, result(call("rollbackLegacyJob", finish("native", "op", null))));
        result(call("closeJdbcSession", params("native")));
        assertEquals(1, physical.commits);
        assertEquals(0, physical.rollbacks);
        assertEquals(1, physical.events.stream().filter("submit"::equals).count());
        assertFalse(unknown.toString().contains("private"));
    }

    @Test
    void failedSubmitConfigurationAndReadbackRollBackAndKeepOnlyTypedDiagnostics() throws Exception {
        for (String failure : List.of("submit", "broken", "read", "mismatch", "out")) {
            String session = "fail-" + failure;
            open(session);
            FakeDriver.nextFailure = failure;
            JsonNode response = result(call("prepareLegacyJob", prepare(session, session)));
            Physical physical = PHYSICAL.getLast();
            assertEquals("rolled_back", response.path("phase").asText(), failure);
            assertEquals(1, physical.rollbacks);
            assertEquals(0, physical.commits);
            assertTrue(physical.closed);
            assertFalse(response.toString().contains("private"));
            if (List.of("submit", "broken", "read").contains(failure)) {
                assertEquals(27486, response.path("vendorCode").asInt());
                assertEquals("42501", response.path("sqlState").asText());
            }
        }
    }

    @Test
    void lostRollbackResponseIsUnknownAndCleanupDoesNotReplayIt() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        Physical physical = PHYSICAL.getFirst();
        physical.fail = "rollback";
        JsonNode response = result(call("rollbackLegacyJob", finish("native", "op", null)));
        assertEquals("unknown", response.path("phase").asText());
        assertEquals("native_job_rollback_unknown", response.path("reason").asText());
        result(call("rollbackLegacyJob", finish("native", "op", null)));
        call("closeJdbcSession", params("native"));
        assertEquals(1, physical.rollbacks);
        assertEquals(0, physical.commits);
        assertTrue(physical.closed);
    }

    @Test
    void closingAnUncommittedNativeSessionRollsBackInsteadOfEnablingOrCommitting() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        result(call("closeJdbcSession", params("native")));
        Physical physical = PHYSICAL.getFirst();
        assertEquals(1, physical.rollbacks);
        assertEquals(0, physical.commits);
        assertTrue(physical.closed);
        assertFalse(physical.events.contains("auto:true"));
    }

    @Test
    void closingReportsAnUnconfirmedRollbackWithoutNativeErrorText() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        Physical physical = PHYSICAL.getFirst();
        physical.fail = "rollback";
        JsonNode response = call("closeJdbcSession", params("native"));
        assertEquals("native_job_session_dispose_unknown", response.path("error").path("message").asText());
        assertEquals(1, physical.rollbacks);
        assertEquals(0, physical.commits);
        assertTrue(physical.closed);
        assertFalse(response.toString().contains("private"));
    }

    @Test
    void failedPhysicalDisposalDoesNotHideItsGapOrRepeatTheCommit() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        Physical physical = PHYSICAL.getFirst();
        physical.fail = "close";
        JsonNode committed = result(call("commitLegacyJob", finish("native", "op", physical.id)));
        assertEquals("committed", committed.path("phase").asText());
        assertEquals("native_job_session_dispose_unknown", call("closeJdbcSession", params("native")).path("error").path("message").asText());
        assertEquals(1, physical.commits);
        assertEquals(0, physical.rollbacks);
        assertEquals(1, physical.events.stream().filter("close"::equals).count());
    }

    @Test
    void globalCloseRetainsUnknownDisposalFromALogicalLegacyMember() throws Exception {
        open("owned-member");
        result(call("prepareLegacyJob", prepare("owned-member", "operation")));
        PHYSICAL.getFirst().fail = "rollback";
        JsonNode closed = call("close", MAPPER.createObjectNode());
        assertEquals("native_job_session_dispose_unknown", closed.path("error").path("message").asText());
        assertEquals(1, PHYSICAL.getFirst().rollbacks);
        assertEquals(0, PHYSICAL.getFirst().commits);
    }

    @Test
    void aNativePhysicalLeaseCannotTakeOverThePreparedLegacyTransaction() throws Exception {
        open("legacy-owned");
        result(call("prepareLegacyJob", prepare("legacy-owned", "legacy")));
        Physical physical = PHYSICAL.getFirst();
        List<String> before = List.copyOf(physical.events);
        JsonNode denied = result(call("openNativeJobSession", params("legacy-owned").put("operationId", "different")));
        assertEquals("not_started", denied.path("phase").asText());
        assertEquals("native_job_session_busy", denied.path("reason").asText());
        assertEquals(before, physical.events);
        assertEquals(1, PHYSICAL.size());
    }

    @Test
    void editorTransactionsAreNeitherBorrowedNorCommittedByNativeSessions() throws Exception {
        open("editor");
        result(call("beginManualTransaction", params("editor")));
        Physical editor = PHYSICAL.getFirst();
        assertEquals("not_started", result(call("prepareLegacyJob", prepare("editor", "op"))).path("phase").asText());
        open("native");
        JsonNode prepared = result(call("prepareLegacyJob", prepare("native", "other")));
        result(call("commitLegacyJob", finish("native", "other", prepared.path("jobId").asText())));
        assertEquals(2, PHYSICAL.size());
        assertFalse(editor.autoCommit);
        assertFalse(editor.closed);
        assertEquals(0, editor.commits);
        assertEquals(0, editor.rollbacks);
        result(call("rollbackManualTransaction", params("editor")));
        assertEquals(1, editor.rollbacks);
    }

    @Test
    void ordinaryRequestsCannotReconnectOrImplicitlyCommitTheReservedSession() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        for (String method : List.of("connect", "connectionInfo", "executeQuery", "beginManualTransaction", "commitManualTransaction")) {
            JsonNode denied = call(method, params("native").put("sql", "COMMIT"));
            assertEquals("native_job_session_reserved", denied.path("error").path("message").asText(), method);
        }
        assertEquals(1, PHYSICAL.size());
        assertFalse(PHYSICAL.getFirst().autoCommit);
        assertEquals(0, PHYSICAL.getFirst().commits);
    }

    @Test
    void endpointChangesDoNotRedirectAnAlreadyPreparedOperation() throws Exception {
        open("native");
        result(call("prepareLegacyJob", prepare("native", "op")));
        ObjectNode changed = finish("native", "op", PHYSICAL.getFirst().id);
        ((ObjectNode) changed.path("connection")).put("connection_string", "jdbc:oracle:thin:@other");
        assertEquals("native_job_connection_changed", result(call("commitLegacyJob", changed)).path("reason").asText());
        assertEquals("prepared", result(call("legacy_job_status", finish("native", "op", null))).path("phase").asText());
        assertEquals(0, PHYSICAL.getFirst().commits);
        assertEquals(1, PHYSICAL.size());
    }

    @Test
    void oracleTransactionSemanticsAreNotAssumedFromAnOracleShapedUrl() throws Exception {
        for (String product : List.of("OceanBase", "DM DBMS", "PostgreSQL")) {
            String session = "product-" + product;
            open(session);
            FakeDriver.product = product;
            JsonNode response = result(call("prepareLegacyJob", prepare(session, session)));
            assertEquals("not_started", response.path("phase").asText());
            assertEquals("native_job_dialect_unverified", response.path("reason").asText());
            assertEquals(0, PHYSICAL.getLast().commits);
            assertEquals(0, PHYSICAL.getLast().rollbacks);
            assertTrue(PHYSICAL.getLast().closed);
        }
    }

    @Test
    void validDefinitionIsRequiredBeforeOpeningTheDriver() throws Exception {
        open("native");
        for (ObjectNode invalid : List.of(
            prepare("native", "op").put("nextDate", "2026-02-30 10:20:30"),
            prepare("native", "op").put("what", " "),
            prepare("native", "op").put("instance", -1),
            prepare("native", "op").put("timeoutSecs", -1))) {
            assertEquals("not_started", result(call("prepareLegacyJob", invalid)).path("phase").asText());
        }
        assertTrue(PHYSICAL.isEmpty());
    }

    @Test
    void dedicatedDefaultProcessUsesTheSameOutProtocolWithoutBorrowingAnEditorTransaction() throws Exception {
        result(call("beginManualTransaction", params(null)));
        assertEquals("native_job_session_busy", result(call("prepareLegacyJob", prepare(null, "blocked"))).path("reason").asText());
        result(call("rollbackManualTransaction", params(null)));
        JsonNode prepared = result(call("prepareLegacyJob", prepare(null, "owned")));
        assertEquals("prepared", prepared.path("phase").asText());
        assertEquals("native_job_session_reserved", call("connect", params(null)).path("error").path("message").asText());
        JsonNode committed = result(call("commitLegacyJob", finish(null, "owned", prepared.path("jobId").asText())));
        assertEquals("committed", committed.path("phase").asText());
        assertEquals(1, PHYSICAL.getFirst().commits);
        assertEquals(1, PHYSICAL.getFirst().rollbacks);
    }

    @Test
    void defaultProcessCloseReportsNativeDisposalFailureBeforeItExits() throws Exception {
        result(call("prepareLegacyJob", prepare(null, "owned")));
        PHYSICAL.getFirst().fail = "rollback";
        JsonNode close = call("close", MAPPER.createObjectNode());
        assertEquals("native_job_session_dispose_unknown", close.path("error").path("message").asText());
        assertTrue(close.path("_dbx_close").asBoolean());
        assertEquals(0, PHYSICAL.getFirst().commits);
    }

    @Test
    void failedOpenIsNotRetriedByDuplicatePreparation() throws Exception {
        open("native");
        FakeDriver.failOpen = true;
        ObjectNode request = prepare("native", "op");
        JsonNode failed = result(call("prepareLegacyJob", request));
        assertEquals("not_started", failed.path("phase").asText());
        assertEquals(12541, failed.path("vendorCode").asInt());
        FakeDriver.failOpen = false;
        assertEquals(failed, result(call("prepareLegacyJob", request)));
        assertTrue(PHYSICAL.isEmpty());
    }

    @Test
    void oceanbaseUsesItsBoundNullableZoneAndNeverCoercesTheNativeInstanceColumn() throws Exception {
        assertTrue(result(call("jdbcSessionProtocol", params(null))).path("capabilities").toString().contains("native_job_legacy_ob_v1"));
        FakeDriver.product = "OceanBase";
        for (String zone : new String[]{null, "zone1"}) {
            String session = zone == null ? "ob-default" : "ob-zone";
            open(session);
            ObjectNode request = prepare(session, session).put("dialect", "oceanbase-oracle");
            if (zone == null) request.putNull("zone"); else request.put("zone", zone);
            JsonNode prepared = result(call("prepareLegacyJob", request));
            assertEquals("prepared", prepared.path("phase").asText());
            Physical physical = PHYSICAL.getLast();
            assertEquals(zone, physical.instance);
            assertTrue(physical.sql.stream().anyMatch(sql -> sql.contains("zone => ?")));
            assertTrue(physical.sql.stream().noneMatch(sql -> sql.contains("TO_CHAR(INSTANCE)") || sql.contains("instance => ?")));
            assertTrue(physical.events.indexOf("broken") < physical.events.indexOf("next-date"));
            assertTrue(physical.events.indexOf("next-date") < physical.events.indexOf("read"));
            assertFalse(prepared.has("disposalConfirmed"));
            assertEquals(0, physical.commits);
            ObjectNode changed = request.deepCopy().put("zone", "other-zone");
            assertEquals("native_job_operation_mismatch", result(call("prepareLegacyJob", changed)).path("reason").asText());
            JsonNode committed = result(call("commitLegacyJob", finish(session, session, physical.id)));
            assertTrue(committed.path("disposalConfirmed").asBoolean());
            assertEquals(1, physical.commits);
            assertEquals(0, physical.rollbacks);
        }
    }

    @Test
    void oceanbaseOutGetterFailureIsDistinctFromSubmitAndRollsBackBeforeFirstCommit() throws Exception {
        FakeDriver.product = "OceanBase";
        open("ob-out");
        FakeDriver.nextFailure = "out-read";
        JsonNode failed = result(call("prepareLegacyJob", prepare("ob-out", "ob-out").put("dialect", "oceanbase-oracle")));
        assertEquals("rolled_back", failed.path("phase").asText());
        assertEquals("native_job_out_read_failed", failed.path("reason").asText());
        assertTrue(failed.path("disposalConfirmed").asBoolean());
        assertEquals(1, PHYSICAL.getLast().rollbacks);
        assertEquals(0, PHYSICAL.getLast().commits);
        assertFalse(failed.toString().contains("private"));
    }

    @Test
    void oceanbaseCloseFailureRemainsVisibleInTerminalStatusWithoutRepeatingNativeWork() throws Exception {
        FakeDriver.product = "OceanBase";
        open("ob-close");
        result(call("prepareLegacyJob", prepare("ob-close", "op").put("dialect", "oceanbase-oracle")));
        Physical physical = PHYSICAL.getLast();
        physical.fail = "close";
        JsonNode committed = result(call("commitLegacyJob", finish("ob-close", "op", physical.id)));
        assertEquals("committed", committed.path("phase").asText());
        assertTrue(committed.has("disposalConfirmed"));
        assertFalse(committed.path("disposalConfirmed").asBoolean());
        assertEquals(committed, result(call("legacyJobStatus", finish("ob-close", "op", null))));
        result(call("rollbackLegacyJob", finish("ob-close", "op", null)));
        assertEquals(1, physical.commits);
        assertEquals(0, physical.rollbacks);
        assertEquals(1, physical.events.stream().filter("close"::equals).count());
    }

    @Test
    void explicitDialectCannotPromoteAnotherProductOrUseAnOracleInstanceForAnObZone() throws Exception {
        for (String dialect : List.of("dameng", "oceanbase-oracle")) {
            String session = "invalid-" + dialect;
            open(session);
            ObjectNode request = prepare(session, session).put("dialect", dialect);
            JsonNode failed = result(call("prepareLegacyJob", request));
            assertEquals("not_started", failed.path("phase").asText());
            assertTrue(PHYSICAL.stream().allMatch(physical -> physical.commits == 0));
        }
        open("ob-instance");
        int opens = PHYSICAL.size();
        JsonNode failed = result(call("prepareLegacyJob", prepare("ob-instance", "invalid").put("dialect", "oceanbase-oracle").put("instance", 1)));
        assertEquals("not_started", failed.path("phase").asText());
        assertEquals(opens, PHYSICAL.size());
    }

    private void open(String session) throws Exception {
        sessions.add(session);
        result(call("openJdbcSession", params(session)));
    }

    private static ObjectNode params(String session) {
        ObjectNode config = MAPPER.createObjectNode().put("connection_string", "jdbc:oracle:thin:@job-test")
            .put("jdbc_driver_class", FakeDriver.class.getName());
        ObjectNode params = MAPPER.createObjectNode();
        params.set("connection", config);
        if (session != null) params.put("jdbcSessionId", session);
        return params;
    }

    private static ObjectNode prepare(String session, String operation) {
        return params(session).put("operationId", operation).put("what", "private_body('private_argument');")
            .put("nextDate", "2026-10-21 10:20:30").put("interval", "SYSDATE + 1")
            .put("enabled", false).put("instance", 0).put("schema", "Ow\"ner").put("timeoutSecs", 17);
    }

    private static ObjectNode finish(String session, String operation, String id) {
        ObjectNode params = params(session).put("operationId", operation);
        if (id != null) params.put("jobId", id);
        return params;
    }

    private static JsonNode result(JsonNode response) {
        assertFalse(response.has("error"), response.toString());
        return response.path("result");
    }

    private static JsonNode call(String name, ObjectNode params) throws Exception {
        Method handler = DbxJdbcPlugin.class.getDeclaredMethod("handleLine", String.class);
        handler.setAccessible(true);
        ObjectNode request = MAPPER.createObjectNode().put("id", 1).put("method", name);
        request.set("params", params);
        return (JsonNode) handler.invoke(null, request.toString());
    }

    public static final class FakeDriver implements Driver {
        static String product = "Oracle";
        static String nextFailure = "";
        static boolean failOpen;

        public Connection connect(String url, Properties properties) throws SQLException {
            if (!acceptsURL(url)) return null;
            if (failOpen) throw new SQLException("private connection details", "08001", 12541);
            Physical physical = new Physical();
            physical.fail = nextFailure;
            nextFailure = "";
            physical.product = product;
            PHYSICAL.add(physical);
            return physical.connection();
        }
        public boolean acceptsURL(String url) { return url.startsWith("jdbc:oracle:thin:@"); }
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties properties) { return new DriverPropertyInfo[0]; }
        public int getMajorVersion() { return 1; }
        public int getMinorVersion() { return 0; }
        public boolean jdbcCompliant() { return true; }
        public Logger getParentLogger() { return Logger.getGlobal(); }
    }

    private static final class Physical {
        boolean autoCommit = true;
        boolean closed;
        int commits;
        int rollbacks;
        int outType;
        String product;
        String fail = "";
        String id = "9007199254740993";
        String what;
        String nextDate;
        String interval;
        String instance;
        String broken;
        String brokenNextDate;
        final List<String> events = new ArrayList<>();
        final List<String> sql = new ArrayList<>();
        final List<Integer> timeouts = new ArrayList<>();

        Connection connection() {
            return proxy(Connection.class, (ignored, method, args) -> switch (method.getName()) {
                case "getAutoCommit" -> autoCommit;
                case "setAutoCommit" -> { autoCommit = (boolean) args[0]; events.add("auto:" + autoCommit); yield null; }
                case "isClosed" -> closed;
                case "close" -> { stage("close"); closed = true; yield null; }
                case "commit" -> { commits++; stage("commit"); yield null; }
                case "rollback" -> { rollbacks++; stage("rollback"); yield null; }
                case "getMetaData" -> proxy(DatabaseMetaData.class, (metadata, called, values) -> switch (called.getName()) {
                    case "getDatabaseProductName" -> product;
                    case "supportsTransactions" -> true;
                    default -> defaultValue(called.getReturnType());
                });
                case "createStatement" -> statement("", Statement.class);
                case "prepareCall" -> statement((String) args[0], CallableStatement.class);
                case "prepareStatement" -> statement((String) args[0], PreparedStatement.class);
                default -> defaultValue(method.getReturnType());
            });
        }

        private void stage(String stage) throws SQLException {
            events.add(stage);
            if (fail.equals(stage)) throw new SQLException("private body/argument must not escape", "42501", 27486);
        }

        private void catalogFailure() throws SQLException {
            if (fail.equals("catalog")) throw new SQLException("private job/connection input", "42000", 942);
            if (fail.equals("connection")) throw new SQLRecoverableException("private connection input", "08006", 942);
        }

        private <T> T statement(String text, Class<T> type) {
            Map<Integer, Object> bindings = new HashMap<>();
            if (!text.isEmpty()) sql.add(text);
            return proxy(type, (ignored, method, args) -> switch (method.getName()) {
                case "setString", "setLong", "setInt" -> { bindings.put((int) args[0], args[1]); yield null; }
                case "setNull" -> { bindings.put((int) args[0], null); yield null; }
                case "registerOutParameter" -> { assertEquals(5, args[0]); outType = (int) args[1]; yield null; }
                case "setQueryTimeout" -> { timeouts.add((int) args[0]); yield null; }
                case "getString" -> { if(fail.equals("out-read"))stage("out-read"); yield fail.equals("out") ? "0" : id; }
                case "execute", "executeUpdate" -> {
                    catalogFailure();
                    String executed = text.isEmpty() ? (String) args[0] : text;
                    if (text.isEmpty()) sql.add(executed);
                    if (executed.contains("DBMS_JOB.SUBMIT")) {
                        assertEquals(Types.VARCHAR, outType);
                        stage("submit");
                        what = (String) bindings.get(1);
                        nextDate = (String) bindings.get(2);
                        interval = (String) bindings.get(3);
                        instance = bindings.get(4) == null ? null : bindings.get(4).toString();
                    } else if (executed.contains("DBMS_JOB.BROKEN")) {
                        stage("broken");
                        assertEquals(id, bindings.get(1));
                        broken = (int) bindings.get(2) == 1 ? "Y" : "N";
                        brokenNextDate = (String) bindings.get(3);
                        if(product.equals("OceanBase") && broken.equals("Y"))nextDate="4000-01-01 00:00:00";
                    } else if(executed.contains("DBMS_JOB.NEXT_DATE")) {
                        stage("next-date");assertEquals(id,bindings.get(1));nextDate=(String)bindings.get(2);
                    } else {
                        assertEquals("ALTER SESSION SET CURRENT_SCHEMA = \"Ow\"\"ner\"", executed);
                        stage("schema");
                    }
                    yield method.getReturnType() == int.class ? 0 : false;
                }
                case "executeQuery" -> {
                    catalogFailure();
                    if(text.equals("SELECT USER AS DBX_SESSION_USER FROM DUAL"))yield stringRows(new String[]{"Owner"});
                    stage("read"); assertEquals(id, bindings.get(1)); yield rows();
                }
                default -> defaultValue(method.getReturnType());
            });
        }

        private ResultSet rows() {
            String[] values = {id, fail.equals("mismatch") ? "changed;" : what, nextDate, interval, broken, instance, product.equals("OceanBase")?"Owner":"Login", product.equals("OceanBase")?"Owner":"Privilege", "Ow\"ner"};
            return stringRows(values);
        }
        private ResultSet stringRows(String[] values) {
            int[] row = {0};
            return proxy(ResultSet.class, (ignored, method, args) -> switch (method.getName()) {
                case "next" -> ++row[0] == 1;
                case "getString" -> values[(int) args[0] - 1];
                default -> defaultValue(method.getReturnType());
            });
        }
    }

    private static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(NativeLegacyJobTest.class.getClassLoader(), new Class<?>[]{type}, handler));
    }

    private static Object defaultValue(Class<?> type) {
        if (type == boolean.class) return false;
        if (type == int.class) return 0;
        if (type == long.class) return 0L;
        return null;
    }
}
