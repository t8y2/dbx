package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSerializer;
import com.google.gson.reflect.TypeToken;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Connection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class JsonRpcServer {
    private static final long CONNECTION_VALIDATION_INTERVAL_MILLIS = 5_000L;

    private final DatabaseAgent agent;
    private final JdbcExecutor jdbcExecutor;
    private final Gson gson = new GsonBuilder()
        // JDBC DECIMAL/NUMERIC values can exceed JavaScript Number precision after JSON-RPC parsing.
        .registerTypeAdapter(
            BigDecimal.class,
            (JsonSerializer<BigDecimal>) (value, type, context) -> new JsonPrimitive(value.toPlainString())
        )
        .registerTypeAdapter(
            BigInteger.class,
            (JsonSerializer<BigInteger>) (value, type, context) -> new JsonPrimitive(value.toString())
        )
        .create();
    private ConnectParams lastConnectParams;
    private long lastConnectionValidationTimeMillis;
    private NativeJobSession nativeJobSession;
    private NativeLegacyJobSession nativeLegacyJobSession;
    private final Object dedicatedAdmission;

    public JsonRpcServer(DatabaseAgent agent) {
        this.agent = agent;
        this.jdbcExecutor = new JdbcExecutor();
        if (agent instanceof AbstractJdbcAgent jdbcAgent) {
            dedicatedAdmission = jdbcAgent.dedicatedAdmission();
            jdbcAgent.bindNativeJobReservation(() -> nativeJobSession != null || nativeLegacyJobSession != null);
        } else dedicatedAdmission = new Object();
    }

    public void run() {
        System.out.println("{\"ready\":true}");
        System.out.flush();

        try {
            BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
            while (true) {
                String line = reader.readLine();
                if (line == null) {
                    break;
                }
                String response = handleRequest(line);
                System.out.println(response);
                System.out.flush();
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    String handleRequest(String line) {
        JsonObject req = JsonParser.parseString(line).getAsJsonObject();
        JsonElement id = req.get("id");
        String method = req.get("method").getAsString();
        JsonObject params = paramsObject(req);

        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id);

        try {
            validateTypedDebugWire(line, req);
            Object result = dispatch(method, params);
            response.add("result", gson.toJsonTree(result));
            return gson.toJson(response);
        } catch (Throwable e) {
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", e.getMessage() == null ? e.toString() : e.getMessage());
            response.add("error", error);
            return gson.toJson(response);
        }
    }

    public static final int MAX_TYPED_DEBUG_WIRE_BYTES = 16 * 1024 * 1024;

    static void validateTypedDebugWire(String line, JsonObject request) {
        if (!AgentProtocol.METHOD_PL_DEBUG_START.equals(stringOrNull(request, "method"))) return;
        JsonObject params = paramsObject(request);
        JsonElement signature = params.get("targetSignature");
        if (signature == null || !signature.isJsonObject() || !signature.getAsJsonObject().has("signatureVersion")) return;
        int bytes = 0;
        for (int index = 0; index < line.length(); index++) {
            char next = line.charAt(index);
            if (Character.isHighSurrogate(next) && index + 1 < line.length() && Character.isLowSurrogate(line.charAt(index + 1))) {
                bytes += 4;
                index++;
            } else bytes += next < 128 ? 1 : next < 2048 ? 2 : 3;
            if (bytes > MAX_TYPED_DEBUG_WIRE_BYTES) throw AgentRpcError.requestRejected("Typed debug request wire byte budget exceeded");
        }
    }

    Object dispatchForRuntime(String method, JsonObject params) throws Exception {
        boolean timedQuery = agent.supportsQueryTiming()
            && (AgentProtocol.METHOD_EXECUTE_QUERY.equals(method)
                || AgentProtocol.METHOD_EXECUTE_QUERY_PAGE.equals(method)
                || AgentProtocol.METHOD_FETCH_QUERY_PAGE.equals(method));
        try (QueryTiming timing = timedQuery ? QueryTiming.begin() : null) {
            Object result = dispatchWithConnection(method, params);
            // Capture after connection return/reset, which runs in the finally
            // block below. Driver-only snapshots omit that lifecycle work.
            if (timing != null) {
                if (result instanceof QueryResult) {
                    ((QueryResult) result).setQuery_timings_ms(timing.finish());
                } else if (result instanceof QueryPageResult) {
                    ((QueryPageResult) result).setQuery_timings_ms(timing.finish());
                }
            }
            return result;
        }
    }

    private Object dispatchWithConnection(String method, JsonObject params) throws Exception {
        return AgentExecutionContext.withJdbcExecutor(jdbcExecutor, () -> {
            authorizeNativeJobRequest(method, params);
            AbstractJdbcAgent jdbcAgent = pooledJdbcAgent();
            if (AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method)
                && jdbcAgent != null
                && jdbcAgent.hasActivePooledLeases()) {
                return Collections.singletonMap("ok", true);
            }
            boolean manageConnection = jdbcAgent != null && requiresConnectedConnection(method);
            if (manageConnection) {
                long acquireStarted = System.nanoTime();
                try {
                    jdbcAgent.beginPooledRequest();
                } finally {
                    QueryTiming.record("pool_acquire", acquireStarted);
                }
            }
            boolean succeeded = false;
            try {
                Object result = dispatch(method, params);
                succeeded = true;
                return result;
            } finally {
                if (manageConnection) {
                    long releaseStarted = System.nanoTime();
                    try {
                        jdbcAgent.finishPooledRequest(
                            jdbcExecutor,
                            succeeded,
                            requiresSessionAffinity(method, params),
                            evictAfterRequest(method),
                            endsSessionAffinity(method),
                            preservesSchemaContext()
                        );
                    } finally {
                        QueryTiming.record("pool_release", releaseStarted);
                    }
                }
            }
        });
    }

    void cancelActiveStatements() {
        jdbcExecutor.cancelActiveStatements();
        agent.invalidateLargeValues();
        AbstractJdbcAgent jdbcAgent = pooledJdbcAgent();
        if (jdbcAgent != null) {
            jdbcAgent.releaseIdlePooledConnection(jdbcExecutor);
        }
    }

    boolean quarantine() {
        AbstractJdbcAgent jdbcAgent = pooledJdbcAgent();
        return jdbcAgent != null && jdbcAgent.quarantinePooledConnection();
    }

    void expireIdleResources() {
        jdbcExecutor.expireIdleResources();
        releaseIdlePooledConnection();
    }

    void expireIdleResources(long nowMillis, long idleTimeoutMillis) {
        jdbcExecutor.expireIdleResources(nowMillis, idleTimeoutMillis);
        releaseIdlePooledConnection();
    }

    private void releaseIdlePooledConnection() {
        AbstractJdbcAgent jdbcAgent = pooledJdbcAgent();
        if (jdbcAgent != null) {
            jdbcAgent.releaseIdlePooledConnection(jdbcExecutor);
        }
    }

    private Object dispatch(String method, JsonObject params) throws Exception {
        authorizeNativeJobRequest(method, params);
        if (NativeLegacyJobSession.isControl(method)) return legacyJob(method, params);
        if (AgentProtocol.METHOD_OPEN_NATIVE_JOB_SESSION.equals(method)) {
            String operationId = NativeJobSession.operationId(params);
            if (!(agent instanceof AbstractJdbcAgent jdbcAgent) || !agent.supportsNativeJobSessions()) {
                throw new UnsupportedOperationException("native_job_session_not_supported");
            }
            NativeJobSession existing;
            synchronized (dedicatedAdmission) {
                existing = nativeJobSession;
                if (existing == null && (nativeLegacyJobSession != null || jdbcAgent.hasDedicatedDebugReservation())) {
                    throw new IllegalStateException("native_job_session_reserved");
                }
            }
            if (existing != null) return existing.openedFor(operationId);
            NativeJobSession candidate = new NativeJobSession(jdbcAgent, operationId);
            jdbcAgent.requireIdleNativeJobSession(jdbcExecutor);
            synchronized (dedicatedAdmission) {
                existing = nativeJobSession;
                if (existing == null) {
                    if (nativeLegacyJobSession != null || jdbcAgent.hasDedicatedDebugReservation()) {
                        throw new IllegalStateException("native_job_session_reserved");
                    }
                    nativeJobSession = candidate;
                }
            }
            if (existing != null) return existing.openedFor(operationId);
            try {
                candidate.open();
                return candidate.openedFor(operationId);
            } catch (Exception | LinkageError error) {
                if (!candidate.openOutcomeUnknown()) synchronized (dedicatedAdmission) {
                    if (nativeJobSession == candidate) nativeJobSession = null;
                }
                throw error;
            }
        }
        if (AgentProtocol.METHOD_CLOSE_NATIVE_JOB_SESSION.equals(method)) {
            NativeJobSession current;
            synchronized (dedicatedAdmission) { current = nativeJobSession; }
            if (current == null) throw new IllegalStateException("native_job_session_unavailable");
            return current.close(params);
        }
        if (agent instanceof AbstractJdbcAgent observingAgent) {
            observingAgent.beforeAgentMethod(method, stringOrNull(params, "sessionId"));
        }
        if (AgentProtocol.METHOD_HANDSHAKE.equals(method)) {
            return AgentProtocol.withExactMetadataIdentity(AgentProtocol.handshakeResult(), agent.supportsExactMetadataIdentity());
        }
        if (AgentProtocol.METHOD_CONNECT.equals(method)) {
            ConnectParams connectParams = gson.fromJson(params, ConnectParams.class);
            agent.connect(connectParams);
            lastConnectParams = connectParams;
            lastConnectionValidationTimeMillis = 0L;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("exactMetadataIdentity", agent.supportsExactMetadataIdentity());
            return result;
        }
        if (AgentProtocol.METHOD_TEST_CONNECTION.equals(method)) {
            Map<String, Object> result = agent.testConnectionWithInfo(gson.fromJson(params, ConnectParams.class));
            if (!Boolean.TRUE.equals(result.get("ok"))) {
                Object error = result.get("error");
                throw new RuntimeException(error == null ? "Connection failed" : String.valueOf(error));
            }
            return result;
        }
        if (AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method)) {
            Connection conn = agent.getConnection();
            boolean valid = false;
            if (conn != null) {
                try {
                    valid = agent instanceof AbstractJdbcAgent jdbcAgent
                        ? jdbcAgent.isConnectionValid(conn, 2)
                        : !conn.isClosed() && conn.isValid(2);
                } catch (Exception | AbstractMethodError ignored) {
                }
            }
            if (!valid) {
                throw new IllegalStateException("Connection is not valid");
            }
            return Collections.singletonMap("ok", true);
        }
        boolean exactIdentity = booleanOrDefault(params, "exact_identity", false);
        if (exactIdentity) {
            if (!agent.supportsExactMetadataIdentity()) {
                throw new UnsupportedOperationException("Agent does not support exact_metadata_identity_v1");
            }
            String schema = stringOrNull(params, "schema");
            if (schema == null || schema.isBlank()) throw new IllegalArgumentException("schema is required for exact metadata identity");
        }
        ensureLiveConnection(method);
        if (AgentProtocol.METHOD_CONNECTION_INFO.equals(method)) {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("identifierQuote", agent.getIdentifierQuote());
            Map<String, String> databaseInfo = agent.getDatabaseInfo();
            if (databaseInfo != null && !databaseInfo.isEmpty()) {
                result.put("databaseInfo", databaseInfo);
            }
            return result;
        }
        if (AgentProtocol.METHOD_LIST_DATABASES.equals(method)) {
            return agent.listDatabases();
        }
        if (AgentProtocol.METHOD_LIST_SCHEMAS.equals(method)) {
            switchCatalog(params);
            return agent.listSchemas(stringListOrNull(params, "visible_schemas"));
        }
        if (AgentProtocol.METHOD_LIST_TABLES.equals(method)) {
            switchCatalog(params);
            return agent.listTables(params.get("schema").getAsString(), metadataListConstraints(params));
        }
        if (AgentProtocol.METHOD_LIST_OBJECTS.equals(method)) {
            switchCatalog(params);
            MetadataReadOptions options = metadataReadOptions(params);
            if (options.exact()) return agent.listObjects(params.get("schema").getAsString(), metadataListConstraints(params), options);
            return agent.listObjects(params.get("schema").getAsString(), metadataListConstraints(params));
        }
        if (AgentProtocol.METHOD_LIST_DATA_TYPES.equals(method)) {
            switchCatalog(params);
            return agent.listDataTypes();
        }
        if (AgentProtocol.METHOD_COMPLETION_ASSISTANT_SEARCH_V1.equals(method)) {
            switchCatalog(params);
            return agent.completionAssistantSearch(gson.fromJson(params, CompletionAssistantRequest.class));
        }
        if (AgentProtocol.METHOD_GET_OBJECT_SOURCE.equals(method)) {
            switchCatalog(params);
            MetadataReadOptions options = metadataReadOptions(params);
            boolean includeOrigin = params.has("include_source_origin") && params.get("include_source_origin").getAsBoolean();
            String schema = params.get("schema").getAsString();
            String name = params.get("name").getAsString();
            String objectType = params.get("object_type").getAsString();
            ObjectSource source = options.exact()
                ? agent.getObjectSource(schema, name, objectType, options)
                : includeOrigin
                    ? agent.getObjectSourceWithOrigin(schema, name, objectType)
                    : agent.getObjectSource(schema, name, objectType);
            if (includeOrigin) {
                JsonObject result = gson.toJsonTree(source).getAsJsonObject();
                if (source.getSourceOrigin() != null) {
                    result.addProperty("source_origin", source.getSourceOrigin());
                }
                return result;
            }
            return source;
        }
        if (AgentProtocol.METHOD_GET_TABLE_DDL.equals(method)) {
            switchCatalog(params);
            return agent.getTableDdl(params.get("schema").getAsString(), params.get("table").getAsString(), exactIdentity);
        }
        if (AgentProtocol.METHOD_GET_COLUMNS.equals(method)) {
            switchCatalog(params);
            String currentSchema = params.has("current_schema") && !params.get("current_schema").isJsonNull()
                ? params.get("current_schema").getAsString() : null;
            return exactIdentity
                ? agent.getColumns(params.get("schema").getAsString(), params.get("table").getAsString())
                : agent.getColumnsInContext(params.get("schema").getAsString(), params.get("table").getAsString(), currentSchema);
        }
        if (AgentProtocol.METHOD_LIST_INDEXES.equals(method)) {
            switchCatalog(params);
            return agent.listIndexes(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_FOREIGN_KEYS.equals(method)) {
            switchCatalog(params);
            return agent.listForeignKeys(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_TRIGGERS.equals(method)) {
            switchCatalog(params);
            MetadataReadOptions options = metadataReadOptions(params);
            if (options.exact()) return agent.listTriggers(params.get("schema").getAsString(), params.get("table").getAsString(), options);
            return agent.listTriggers(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_CONSTRAINTS.equals(method)) {
            switchCatalog(params);
            return agent.listConstraints(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_PARTITIONS.equals(method)) {
            switchCatalog(params);
            return agent.listPartitions(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_LIST_SUBPARTITIONS.equals(method)) {
            switchCatalog(params);
            return agent.listSubpartitions(params.get("schema").getAsString(), params.get("table").getAsString());
        }
        if (AgentProtocol.METHOD_EXECUTE_QUERY.equals(method)) {
            ExecuteQueryOptions options = new ExecuteQueryOptions(
                intOrDefault(params, "maxRows", JdbcExecutor.DEFAULT_MAX_ROWS),
                intOrNull(params, "fetchSize"), intOrDefault(params, "timeoutSecs", 0),
                booleanOrDefault(params, "deferLobs", false));
            if (params.has("returnAllResults") && params.get("returnAllResults").getAsBoolean()) {
                return agent.executeQueryResults(params.get("sql").getAsString(), stringOrNull(params, "schema"), options);
            }
            return agent.executeQuery(params.get("sql").getAsString(), stringOrNull(params, "schema"), options);
        }
        if (AgentProtocol.METHOD_EXECUTE_QUERY_PAGE.equals(method)) {
            return agent.executeQueryPage(
                params.get("sql").getAsString(),
                stringOrNull(params, "schema"),
                new QueryPageOptions(
                    intOrDefault(params, "pageSize", 100),
                    intOrNull(params, "fetchSize"),
                    intOrDefault(params, "maxRows", JdbcExecutor.DEFAULT_MAX_ROWS),
                    intOrDefault(params, "timeoutSecs", 0),
                    booleanOrDefault(params, "deferLobs", false)
                )
            );
        }
        if (AgentProtocol.METHOD_FETCH_QUERY_PAGE.equals(method)) {
            return agent.fetchQueryPage(
                params.get("sessionId").getAsString(),
                intOrDefault(params, "pageSize", 100)
            );
        }
        if (AgentProtocol.METHOD_CLOSE_QUERY_SESSION.equals(method)) {
            return agent.closeQuerySession(params.get("sessionId").getAsString());
        }
        if (AgentProtocol.METHOD_READ_LARGE_VALUE_CHUNK.equals(method)) {
            return agent.readLargeValueChunk(params.get("valueRef").getAsString(),
                params.get("offset").getAsLong(), intOrDefault(params, "limit", 4096));
        }
        if (AgentProtocol.METHOD_RELEASE_LARGE_VALUE.equals(method)) {
            return agent.releaseLargeValue(params.get("valueRef").getAsString());
        }
        if (AgentProtocol.METHOD_START_TABLE_READ.equals(method)) {
            return agent.startTableRead(
                params.get("sql").getAsString(),
                stringOrNull(params, "schema"),
                new QueryPageOptions(
                    intOrDefault(params, "pageSize", 100),
                    intOrNull(params, "fetchSize"),
                    intOrDefault(params, "maxRows", JdbcExecutor.DEFAULT_MAX_ROWS),
                    intOrDefault(params, "timeoutSecs", 0),
                    booleanOrDefault(params, "deferLobs", false)
                )
            );
        }
        if (AgentProtocol.METHOD_FETCH_TABLE_READ_PAGE.equals(method)) {
            return agent.fetchTableReadPage(
                params.get("sessionId").getAsString(),
                intOrDefault(params, "pageSize", 100)
            );
        }
        if (AgentProtocol.METHOD_CLOSE_TABLE_READ_SESSION.equals(method)) {
            return agent.closeTableReadSession(params.get("sessionId").getAsString());
        }
        if (AgentProtocol.METHOD_GET_EXPLAIN_INFO.equals(method)) {
            String plan = agent.getExplainInfo(
                params.get("sql").getAsString(),
                stringOrNull(params, "database"),
                stringOrNull(params, "schema"),
                intOrDefault(params, "timeoutSecs", -1),
                stringOrNull(params, "mode")
            );
            java.util.HashMap<String, Object> result = new java.util.HashMap<>();
            result.put("plan", plan);
            result.put("has_actual_stats", "autotrace".equals(stringOrNull(params, "mode")));
            return result;
        }
        if (AgentProtocol.METHOD_EXECUTE_TRANSACTION.equals(method)) {
            agent.invalidateLargeValues();
            Type statementsType = new TypeToken<List<String>>() {}.getType();
            List<String> statements = gson.fromJson(params.get("statements"), statementsType);
            if (params.has("boundStatements")) {
                return executeBlobBoundStatements(params, statements, true);
            }
            return executeStatementsWithTimeout(intOrDefault(params, "timeoutSecs", 0),
                () -> agent.executeTransaction(statements, stringOrNull(params, "schema")));
        }
        if (AgentProtocol.METHOD_BEGIN_MANUAL_TRANSACTION.equals(method)) {
            agent.invalidateLargeValues();
            return agent.beginManualTransaction(stringOrNull(params, "schema"));
        }
        if (AgentProtocol.METHOD_COMMIT_MANUAL_TRANSACTION.equals(method)) {
            agent.invalidateLargeValues();
            return agent.commitManualTransaction();
        }
        if (AgentProtocol.METHOD_ROLLBACK_MANUAL_TRANSACTION.equals(method)) {
            agent.invalidateLargeValues();
            return agent.rollbackManualTransaction();
        }
        if (AgentProtocol.METHOD_EXECUTE_BATCH.equals(method)) {
            agent.invalidateLargeValues();
            Type statementsType = new TypeToken<List<String>>() {}.getType();
            List<String> statements = gson.fromJson(params.get("statements"), statementsType);
            if (params.has("boundStatements")) {
                return executeBlobBoundStatements(params, statements, false);
            }
            return executeStatementsWithTimeout(intOrDefault(params, "timeoutSecs", 0),
                () -> agent.executeBatch(statements, stringOrNull(params, "schema")));
        }
        if (AgentProtocol.METHOD_PL_DEBUG_PROBE.equals(method)) return agent.plDebugProbe();
        if (AgentProtocol.METHOD_PL_DEBUG_INSPECT.equals(method)) {
            return agent.plDebugInspect(gson.fromJson(params.get("target"), PlDebugStartRequest.class));
        }
        if (AgentProtocol.METHOD_PL_DEBUG_RESOLVE_TARGET.equals(method)) {
            return agent.plDebugResolveTarget(gson.fromJson(params, PlDebugStartRequest.class));
        }
        if (AgentProtocol.METHOD_PL_DEBUG_START.equals(method)) {
            return agent.plDebugStart(gson.fromJson(params, PlDebugStartRequest.class));
        }
        if (AgentProtocol.METHOD_PL_DEBUG_COMPILE.equals(method)) {
            if (!params.has("target") || !params.get("target").isJsonObject()
                || !params.has("preview") || !params.get("preview").isJsonObject()) {
                throw AgentRpcError.requestRejected("A named target and confirmed compilation preview are required");
            }
            JsonObject target = params.getAsJsonObject("target");
            String operationId;
            PlDebugStartRequest compileTarget;
            Map<String, Object> preview;
            try {
                for (String key : List.of("schema", "objectType", "objectName", "packageName", "metadataPreparation")) debugString(target, key);
                operationId = debugString(params, "operationId");
                if (operationId == null || !operationId.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException();
                preview = gson.fromJson(params.get("preview"), new TypeToken<Map<String, Object>>() {}.getType());
                compileTarget = gson.fromJson(target, PlDebugStartRequest.class);
            } catch (IllegalArgumentException error) {
                throw AgentRpcError.requestRejected("Invalid debug compilation identity, target or preview");
            }
            return agent.plDebugCompile(operationId, compileTarget, preview);
        }
        if (AgentProtocol.METHOD_PL_DEBUG_COMPILE_STATUS.equals(method)) {
            return agent.plDebugCompileStatus(debugString(params, "operationId"));
        }
        if (AgentProtocol.METHOD_PL_DEBUG_SET_BREAKPOINTS.equals(method)
            || AgentProtocol.METHOD_PL_DEBUG_DELETE_BREAKPOINTS.equals(method)) {
            if (!params.has("breakpoints")) {
                return agent.plDebugMutateBreakpoint(requiredDebugId(params),
                    AgentProtocol.METHOD_PL_DEBUG_SET_BREAKPOINTS.equals(method) ? "set_breakpoints" : "delete_breakpoints",
                    debugBreakpointMutation(params));
            }
            Type type = new TypeToken<List<PlDebugBreakpoint>>() {}.getType();
            List<PlDebugBreakpoint> breakpoints = gson.fromJson(params.get("breakpoints"), type);
            if (breakpoints == null) throw new IllegalArgumentException("breakpoints must be an array");
            String debugId = requiredDebugId(params);
            return AgentProtocol.METHOD_PL_DEBUG_SET_BREAKPOINTS.equals(method)
                ? agent.plDebugSetBreakpoints(debugId, stringOrNull(params, "operationId"), debugInteger(params, "stopRevision", null), breakpoints)
                : agent.plDebugDeleteBreakpoints(debugId, stringOrNull(params, "operationId"), debugInteger(params, "stopRevision", null), breakpoints);
        }
        if (AgentProtocol.PL_DEBUG_SESSION_METHODS.contains(method)) {
            String debugId = requiredDebugId(params);
            return switch (method) {
                case AgentProtocol.METHOD_PL_DEBUG_LIST_BREAKPOINTS -> agent.plDebugListBreakpoints(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_RESUME -> agent.plDebugResume(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_STEP_OVER -> agent.plDebugStepOver(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_STEP_IN -> agent.plDebugStepIn(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_STEP_OUT -> agent.plDebugStepOut(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_RESUME_IGNORE_BREAKPOINTS -> agent.plDebugResumeIgnoreBreakpoints(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_ABORT -> agent.plDebugAbort(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_GET_VARIABLES -> agent.plDebugGetVariables(debugId, intOrDefault(params, "frame", 0));
                case AgentProtocol.METHOD_PL_DEBUG_GET_VALUE -> agent.plDebugGetValue(debugId, requiredDebugName(params), intOrDefault(params, "frame", 0));
                case AgentProtocol.METHOD_PL_DEBUG_SET_VALUE -> {
                    String name;
                    Long revision;
                    int frame, index;
                    try {
                        name = requiredDebugName(params);
                        revision = debugInteger(params, "stopRevision", null);
                        frame = Math.toIntExact(debugInteger(params, "frame", 0L));
                        index = Math.toIntExact(debugInteger(params, "index", 0L));
                    } catch (IllegalArgumentException | ArithmeticException error) {
                        throw AgentRpcError.requestRejected("Invalid assignment name, stopRevision, frame or index");
                    }
                    yield agent.plDebugSetValue(debugId, stringOrNull(params, "operationId"), revision,
                        name, frame, index, stringOrNull(params, "value"));
                }
                case AgentProtocol.METHOD_PL_DEBUG_OPERATION_STATUS -> agent.plDebugOperationStatus(debugId, stringOrNull(params, "operationId"));
                case AgentProtocol.METHOD_PL_DEBUG_SET_EXCEPTION_BREAKPOINT -> agent.plDebugSetExceptionBreakpoint(debugId, booleanOrDefault(params, "enabled", false));
                case AgentProtocol.METHOD_PL_DEBUG_SET_BREAKPOINT_ENABLED -> params.has("registrationId")
                    ? agent.plDebugMutateBreakpoint(debugId, "set_breakpoint_enabled", debugBreakpointMutation(params))
                    : agent.plDebugSetBreakpointEnabled(debugId, stringOrNull(params, "operationId"), debugInteger(params, "stopRevision", null),
                        intOrDefault(params, "breakpointNumber", 0), booleanOrDefault(params, "enabled", false));
                case AgentProtocol.METHOD_PL_DEBUG_GET_STACK -> agent.plDebugGetStack(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_GET_LOG -> agent.plDebugGetLog(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_GET_RESULTS -> agent.plDebugGetResults(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_GET_RESULT_PAGE -> {
                    String generation;
                    String resultId;
                    int offset;
                    int limit;
                    try {
                        for (String key : List.of("generation", "resultId")) {
                            JsonElement value = params.get(key);
                            if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                                || value.getAsString().isEmpty() || value.getAsString().length() > 128) throw new IllegalArgumentException();
                        }
                        generation = params.get("generation").getAsString();
                        resultId = params.get("resultId").getAsString();
                        offset = Math.toIntExact(debugInteger(params, "offset", 0L));
                        limit = Math.toIntExact(debugInteger(params, "limit", 32000L));
                        if (offset < 0 || limit < 1 || limit > 65536) throw new IllegalArgumentException();
                    } catch (IllegalArgumentException | ArithmeticException error) {
                        throw AgentRpcError.requestRejected("Invalid debugger result identity or page bounds");
                    }
                    yield agent.plDebugGetResultPage(debugId, generation, resultId, offset, limit);
                }
                case AgentProtocol.METHOD_PL_DEBUG_GET_LOG_PAGE -> agent.plDebugGetLogPage(debugId,
                    intOrDefault(params, "offset", 0), intOrDefault(params, "limit", 32000));
                case AgentProtocol.METHOD_PL_DEBUG_STATUS -> agent.plDebugStatus(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_HEARTBEAT -> agent.plDebugHeartbeat(debugId);
                case AgentProtocol.METHOD_PL_DEBUG_EXECUTE -> agent.plDebugExecute(debugId,
                    stringOrNull(params, "sql"), intOrDefault(params, "maxRows", 1000));
                case AgentProtocol.METHOD_PL_DEBUG_CLOSE -> agent.plDebugClose(debugId);
                default -> throw new IllegalArgumentException("Unknown debug method: " + method);
            };
        }
        if (AgentProtocol.METHOD_DISCONNECT.equals(method)) {
            disconnect();
            return Collections.singletonMap("ok", true);
        }
        if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
            disconnect();
            return Collections.singletonMap("ok", true);
        }
        throw new IllegalArgumentException("Unknown method: " + method);
    }

    private void authorizeNativeJobRequest(String method, JsonObject params) throws Exception {
        if (AgentProtocol.METHOD_HANDSHAKE.equals(method)
            || AgentProtocol.METHOD_DISCONNECT.equals(method) || AgentProtocol.METHOD_SHUTDOWN.equals(method)) return;
        NativeJobSession job;
        NativeLegacyJobSession legacy;
        synchronized (dedicatedAdmission) { job = nativeJobSession; legacy = nativeLegacyJobSession; }
        if (legacy != null && !NativeLegacyJobSession.isControl(method)) {
            throw new IllegalStateException("native_job_session_reserved");
        }
        if (NativeLegacyJobSession.isControl(method)) {
            if (job != null) throw new IllegalStateException("native_job_session_reserved");
            return;
        }
        if (NativeJobSession.isControl(method)) return;
        if (job != null) {
            job.authorize(method, params);
        } else if (params.has("nativeJobSessionToken") || params.has("nativeJobOperationId")) {
            // A replacement logical session must not borrow a connection for an old lease token.
            throw new IllegalStateException("native_job_session_unavailable");
        }
    }

    private void disconnect() {
        jdbcExecutor.closeAllQuerySessions();
        jdbcExecutor.closeAllTableReadSessions();
        NativeJobSession job;
        NativeLegacyJobSession legacy;
        synchronized (dedicatedAdmission) { job = nativeJobSession; legacy = nativeLegacyJobSession; }
        JsonObject nativeClose = job == null ? null : job.dispose();
        JsonObject legacyClose = legacy == null ? null : legacy.dispose();
        agent.disconnect();
        lastConnectParams = null;
        if ((nativeClose != null && !"closed".equals(nativeClose.get("phase").getAsString()))
            || (legacyClose != null && (!legacyClose.has("disposalConfirmed") || !legacyClose.get("disposalConfirmed").getAsBoolean()))) {
            throw AgentRpcError.resource("close", new JdbcConnectionPoolRegistry.PhysicalConnectionStateUnknownException(
                new IllegalStateException("native_job_session_dispose_unknown")));
        }
    }

    private JsonObject legacyJob(String method, JsonObject params) throws Exception {
        String operationId = NativeJobSession.operationId(params);
        if (AgentProtocol.METHOD_PREPARE_LEGACY_JOB.equals(method)) {
            if (!(agent instanceof AbstractJdbcAgent jdbcAgent) || !agent.supportsNativeLegacyJobs()) {
                throw new UnsupportedOperationException("native_job_legacy_protocol_unavailable");
            }
            NativeLegacyJobSession candidate;
            try { candidate = new NativeLegacyJobSession(jdbcAgent, params); }
            catch (IllegalArgumentException invalid) {
                return NativeLegacyJobSession.failure(operationId, "not_started", invalid.getMessage());
            }
            NativeLegacyJobSession existing;
            synchronized (dedicatedAdmission) {
                existing = nativeLegacyJobSession;
                if (existing == null && (nativeJobSession != null || jdbcAgent.hasDedicatedDebugReservation())) {
                    throw new IllegalStateException("native_job_session_reserved");
                }
            }
            if (existing != null) {
                return existing.sameRequest(candidate) ? existing.status(operationId)
                    : NativeLegacyJobSession.failure(operationId, "unknown", "native_job_operation_mismatch");
            }
            jdbcAgent.requireIdleNativeJobSession(jdbcExecutor);
            synchronized (dedicatedAdmission) {
                existing = nativeLegacyJobSession;
                if (existing == null) {
                    if (nativeJobSession != null || jdbcAgent.hasDedicatedDebugReservation()) {
                        throw new IllegalStateException("native_job_session_reserved");
                    }
                    nativeLegacyJobSession = candidate;
                }
            }
            if (existing != null) return existing.sameRequest(candidate) ? existing.status(operationId)
                : NativeLegacyJobSession.failure(operationId, "unknown", "native_job_operation_mismatch");
            candidate.prepare();
            return candidate.status(operationId);
        }
        NativeLegacyJobSession current;
        synchronized (dedicatedAdmission) { current = nativeLegacyJobSession; }
        if (current == null) {
            return NativeLegacyJobSession.failure(operationId, "unknown", "native_job_legacy_session_unavailable");
        }
        if (AgentProtocol.METHOD_LEGACY_JOB_STATUS.equals(method)) return current.status(operationId);
        return current.finish(operationId, stringOrNull(params, "jobId") == null ? "" : stringOrNull(params, "jobId"),
            AgentProtocol.METHOD_COMMIT_LEGACY_JOB.equals(method));
    }

    private static String requiredDebugId(JsonObject params) {
        String id = stringOrNull(params, "debugId");
        if (id == null || id.isBlank()) throw new IllegalArgumentException("debugId is required");
        return id;
    }

    private static String requiredDebugName(JsonObject params) {
        String name = stringOrNull(params, "name");
        if (name == null || name.isBlank()) throw new IllegalArgumentException("variable name is required");
        return name;
    }

    private QueryResult executeStatementsWithTimeout(int timeoutSecs, DatabaseAgent.ThrowingSupplier<QueryResult> execute) throws Exception {
        try (JdbcExecutor.NativeOperation operation = jdbcExecutor.beginNativeOperation()) {
            return AgentExecutionContext.withStatementTimeout(timeoutSecs, operation,
                agent instanceof AbstractJdbcAgent jdbcAgent ? jdbcAgent : null, () -> {
                operation.checkCancelled();
                if (agent instanceof AbstractJdbcAgent jdbcAgent) {
                    jdbcAgent.beforeQueryExecution(jdbcAgent.requireConnected(), timeoutSecs);
                }
                operation.checkCancelled();
                return execute.get();
            });
        }
    }

    private QueryResult executeBlobBoundStatements(JsonObject params, List<String> previews, boolean transaction) {
        if (!agent.supportsBlobBindStatements()) {
            throw new UnsupportedOperationException("Agent does not support blob_bind_statements_v1");
        }
        if (!params.get("boundStatements").isJsonArray()) {
            throw new IllegalArgumentException("BLOB bound statements must be an array");
        }
        for (com.google.gson.JsonElement entry : params.getAsJsonArray("boundStatements")) {
            if (!entry.isJsonObject()) throw new IllegalArgumentException("BLOB bound statement must be an object");
            JsonObject item = entry.getAsJsonObject();
            for (String field : java.util.Arrays.asList("previewSql", "sql")) {
                if (!item.has(field) || !item.get(field).isJsonPrimitive()
                    || !item.get(field).getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException("BLOB bound statement text fields must be strings");
                }
            }
            if (!item.has("blobParameters") || !item.get("blobParameters").isJsonArray()) {
                throw new IllegalArgumentException("BLOB parameters must be an array of hexadecimal strings");
            }
            for (com.google.gson.JsonElement value : item.getAsJsonArray("blobParameters")) {
                if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException("BLOB parameter must be a hexadecimal string");
                }
            }
        }
        Type boundType = new TypeToken<List<BlobBoundStatement>>() {}.getType();
        List<BlobBoundStatement> statements = gson.fromJson(params.get("boundStatements"), boundType);
        BlobBoundStatement.validate(previews, statements);
        return agent.executeBlobBoundStatements(previews, statements, stringOrNull(params, "schema"),
            intOrDefault(params, "queryTimeoutSecs", 0), transaction);
    }

    private void switchCatalog(JsonObject params) throws Exception {
        String database = stringOrNull(params, "database");
        if (database != null && !database.trim().isEmpty() && agent.getConnection() != null) {
            String currentCatalog = null;
            try {
                currentCatalog = agent.getConnection().getCatalog();
            } catch (Exception ignored) {
            }
            if (currentCatalog == null || !currentCatalog.trim().equalsIgnoreCase(database.trim())) {
                try {
                    agent.getConnection().setCatalog(database);
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void ensureLiveConnection(String method) {
        if (AgentProtocol.PL_DEBUG_SESSION_METHODS.contains(method)) return;
        if (agent instanceof AbstractJdbcAgent jdbcAgent && jdbcAgent.hasNativeJobConnection()) return;
        if (!agent.permitsAutomaticReconnect()) return;
        if (lastConnectParams == null || !shouldValidateConnection(method)) {
            return;
        }
        AbstractJdbcAgent jdbcAgent = pooledJdbcAgent();
        if (jdbcAgent != null) {
            return;
        }
        Connection conn = agent.getConnection();
        if (conn == null) {
            return;
        }
        long now = System.currentTimeMillis();
        if (lastConnectionValidationTimeMillis > 0
            && now - lastConnectionValidationTimeMillis < CONNECTION_VALIDATION_INTERVAL_MILLIS) {
            return;
        }
        boolean valid = false;
        try {
            valid = agent instanceof AbstractJdbcAgent validationAgent
                ? validationAgent.isConnectionValid(conn, 2)
                : !conn.isClosed() && conn.isValid(2);
        } catch (Exception | AbstractMethodError ignored) {
        }
        if (valid) {
            lastConnectionValidationTimeMillis = now;
            return;
        }

        jdbcExecutor.closeAllQuerySessions();
        jdbcExecutor.closeAllTableReadSessions();
        try {
            agent.disconnect();
        } catch (Exception ignored) {
        }
        agent.connect(lastConnectParams);
        lastConnectionValidationTimeMillis = System.currentTimeMillis();
    }

    private static boolean shouldValidateConnection(String method) {
        return !AgentProtocol.METHOD_HANDSHAKE.equals(method)
            && !AgentProtocol.METHOD_CONNECT.equals(method)
            && !AgentProtocol.METHOD_TEST_CONNECTION.equals(method)
            && !NativeJobSession.isControl(method)
            && !NativeLegacyJobSession.isControl(method)
            && !AgentProtocol.METHOD_VALIDATE_CONNECTION.equals(method)
            && !AgentProtocol.METHOD_FETCH_QUERY_PAGE.equals(method)
            && !AgentProtocol.METHOD_CLOSE_QUERY_SESSION.equals(method)
            && !AgentProtocol.METHOD_FETCH_TABLE_READ_PAGE.equals(method)
            && !AgentProtocol.METHOD_CLOSE_TABLE_READ_SESSION.equals(method)
            && !AgentProtocol.METHOD_DISCONNECT.equals(method)
            && !AgentProtocol.METHOD_SHUTDOWN.equals(method);
    }

    private AbstractJdbcAgent pooledJdbcAgent() {
        if (agent instanceof AbstractJdbcAgent jdbcAgent && jdbcAgent.usesConnectionPool()) {
            return jdbcAgent;
        }
        return null;
    }

    private static boolean requiresConnectedConnection(String method) {
        return !AgentProtocol.PL_DEBUG_SESSION_METHODS.contains(method)
            && !AgentProtocol.METHOD_HANDSHAKE.equals(method)
            && !AgentProtocol.METHOD_CONNECT.equals(method)
            && !AgentProtocol.METHOD_TEST_CONNECTION.equals(method)
            && !NativeJobSession.isControl(method)
            && !NativeLegacyJobSession.isControl(method)
            && !AgentProtocol.METHOD_DISCONNECT.equals(method)
            && !AgentProtocol.METHOD_SHUTDOWN.equals(method);
    }

    private boolean requiresSessionAffinity(String method, JsonObject params) {
        if (AgentProtocol.METHOD_BEGIN_MANUAL_TRANSACTION.equals(method)) {
            return true;
        }
        try {
            if (AgentProtocol.METHOD_EXECUTE_QUERY.equals(method)
                || AgentProtocol.METHOD_EXECUTE_QUERY_PAGE.equals(method)
                || AgentProtocol.METHOD_START_TABLE_READ.equals(method)) {
                return JdbcConnectionAffinity.requiresSessionAffinity(stringOrNull(params, "sql"));
            }
            if (AgentProtocol.METHOD_EXECUTE_TRANSACTION.equals(method)
                || AgentProtocol.METHOD_EXECUTE_BATCH.equals(method)) {
                JsonElement statements = params.get("statements");
                if (statements == null || !statements.isJsonArray()) {
                    return false;
                }
                for (JsonElement statement : statements.getAsJsonArray()) {
                    if (!statement.isJsonNull()
                        && JdbcConnectionAffinity.requiresSessionAffinity(statement.getAsString())) {
                        return true;
                    }
                }
            }
        } catch (RuntimeException ignored) {
            return false;
        }
        return false;
    }

    private static boolean endsSessionAffinity(String method) {
        return AgentProtocol.METHOD_COMMIT_MANUAL_TRANSACTION.equals(method)
            || AgentProtocol.METHOD_ROLLBACK_MANUAL_TRANSACTION.equals(method);
    }

    private boolean preservesSchemaContext() {
        Connection connection = agent.getConnection();
        if (connection == null) {
            return false;
        }
        try {
            return !connection.getAutoCommit();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean evictAfterRequest(String method) {
        return AgentProtocol.METHOD_GET_EXPLAIN_INFO.equals(method);
    }

    private static JsonObject paramsObject(JsonObject req) {
        JsonElement params = req.get("params");
        if (params == null || params instanceof JsonNull || !params.isJsonObject()) {
            return new JsonObject();
        }
        return params.getAsJsonObject();
    }

    private static String stringOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || element instanceof JsonNull) {
            return null;
        }
        return element.getAsString();
    }

    private List<String> stringListOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || element instanceof JsonNull) {
            return null;
        }
        Type listType = new TypeToken<List<String>>() {}.getType();
        return gson.fromJson(element, listType);
    }

    private static Integer intOrNull(JsonObject object, String key) {
        JsonElement element = object.get(key);
        if (element == null || element instanceof JsonNull) {
            return null;
        }
        return element.getAsInt();
    }

    private static boolean booleanOrDefault(JsonObject object, String key, boolean defaultValue) {
        JsonElement element = object.get(key);
        return element == null || element instanceof JsonNull ? defaultValue : element.getAsBoolean();
    }

    private MetadataListConstraints metadataListConstraints(JsonObject params) {
        return new MetadataListConstraints(
            stringOrNull(params, "filter"),
            intOrNull(params, "limit"),
            intOrNull(params, "offset"),
            stringListOrNull(params, "object_types"),
            booleanOrDefault(params, "exact_identity", false)
        );
    }

    private static MetadataReadOptions metadataReadOptions(JsonObject params) {
        String mode = stringOrNull(params, "identity_mode");
        String alias = stringOrNull(params, "identityMode");
        if (mode != null && alias != null && !mode.equals(alias)) {
            throw new IllegalArgumentException("Conflicting metadata identity modes");
        }
        return MetadataReadOptions.fromIdentityMode(mode != null ? mode : alias);
    }

    private PlDebugBreakpointMutation debugBreakpointMutation(JsonObject params) {
        try {
            Map<String, Object> rules = null;
            if (params.has("rules") && !params.get("rules").isJsonNull()) {
                if (!params.get("rules").isJsonObject()) throw new IllegalArgumentException("rules must be an object");
                JsonObject input = params.getAsJsonObject("rules");
                rules = gson.fromJson(input, new TypeToken<Map<String, Object>>() {}.getType());
                if (input.has("ignoreCount")) rules.put("ignoreCount", debugInteger(input, "ignoreCount", null));
            }
            Boolean enabled = null;
            if (params.has("enabled") && !params.get("enabled").isJsonNull()) {
                if (!params.get("enabled").isJsonPrimitive() || !params.getAsJsonPrimitive("enabled").isBoolean()) {
                    throw new IllegalArgumentException("enabled must be boolean");
                }
                enabled = params.get("enabled").getAsBoolean();
            }
            return new PlDebugBreakpointMutation(debugString(params, "operationId"), debugString(params, "sourceRefId"),
                nullableDebugInteger(params, "sourceRevision"), nullableDebugInteger(params, "stopRevision"),
                nullableDebugInt(params, "nativeFrameId"), nullableDebugInt(params, "line"), nullableDebugInt(params, "breakpointNumber"),
                debugString(params, "registrationId"), enabled, rules);
        } catch (RuntimeException error) {
            throw AgentRpcError.requestRejected("Invalid breakpoint identity, integer, enabled value or rules");
        }
    }

    private static String debugString(JsonObject object, String key) {
        JsonElement value = object.get(key);
        if (value == null || value.isJsonNull()) return null;
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("Expected string " + key);
        return value.getAsString();
    }

    private static Long nullableDebugInteger(JsonObject object, String key) {
        return object.has(key) && object.get(key).isJsonNull() ? null : debugInteger(object, key, null);
    }

    private static Integer nullableDebugInt(JsonObject object, String key) {
        Long value = nullableDebugInteger(object, key);
        return value == null ? null : Math.toIntExact(value);
    }

    private static Long debugInteger(JsonObject object, String key, Long defaultValue) {
        if (!object.has(key)) return defaultValue;
        JsonElement value = object.get(key);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("Expected integer " + key);
        }
        return value.getAsBigDecimal().longValueExact();
    }

    private static int intOrDefault(JsonObject object, String key, int defaultValue) {
        Integer value = intOrNull(object, key);
        return value == null ? defaultValue : value;
    }

}
