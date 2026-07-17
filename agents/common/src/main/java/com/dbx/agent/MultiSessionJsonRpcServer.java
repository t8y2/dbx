package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

public final class MultiSessionJsonRpcServer {
    private static final String LEGACY_SESSION_ID = "__legacy__";
    private static final int MAX_SESSIONS = 256;

    private final Supplier<? extends DatabaseAgent> agentFactory;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final ExecutorService requests = Executors.newCachedThreadPool();
    private final Gson gson = new Gson();
    private final Object outputLock = new Object();

    public MultiSessionJsonRpcServer(Supplier<? extends DatabaseAgent> agentFactory) {
        this.agentFactory = agentFactory;
    }

    public void run() {
        synchronized (outputLock) {
            System.out.println("{\"ready\":true}");
            System.out.flush();
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                JsonObject request = JsonParser.parseString(line).getAsJsonObject();
                String method = request.get("method").getAsString();
                if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
                    writeResponse(handleRequest(request));
                    closeAllSessions();
                    requests.shutdown();
                    return;
                }
                requests.submit(() -> writeResponse(handleRequest(request)));
            }
        } catch (Exception e) {
            closeAllSessions();
            throw new RuntimeException(e);
        }
    }

    String handleRequest(String line) {
        return gson.toJson(handleRequest(JsonParser.parseString(line).getAsJsonObject()));
    }

    private JsonObject handleRequest(JsonObject request) {
        JsonElement id = request.get("id");
        String method = request.get("method").getAsString();
        JsonObject params = request.has("params") && request.get("params").isJsonObject()
            ? request.getAsJsonObject("params")
            : new JsonObject();
        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id);
        try {
            Object result;
            if (AgentProtocol.METHOD_HANDSHAKE.equals(method)) {
                result = AgentProtocol.multiSessionHandshakeResult();
            } else if (AgentProtocol.METHOD_OPEN_SESSION.equals(method)) {
                result = openSession(requiredSessionId(params), params);
            } else if (AgentProtocol.METHOD_CLOSE_SESSION.equals(method)) {
                result = closeSession(requiredSessionId(params));
            } else if (AgentProtocol.METHOD_VALIDATE_SESSION.equals(method)) {
                result = session(requiredSessionId(params)).handle("validate_connection", params);
            } else if (AgentProtocol.METHOD_CANCEL_SESSION.equals(method)) {
                session(requiredSessionId(params)).cancel();
                result = Collections.singletonMap("ok", true);
            } else if (AgentProtocol.METHOD_TEST_CONNECTION.equals(method)) {
                result = new JsonRpcServer(agentFactory.get()).dispatchForRuntime(method, params);
            } else if (AgentProtocol.METHOD_CONNECT.equals(method)) {
                closeSession(LEGACY_SESSION_ID);
                result = openSession(LEGACY_SESSION_ID, params);
            } else if (AgentProtocol.METHOD_DISCONNECT.equals(method)) {
                result = closeSession(LEGACY_SESSION_ID);
            } else if (AgentProtocol.METHOD_SHUTDOWN.equals(method)) {
                result = Collections.singletonMap("ok", true);
            } else {
                String sessionId = params.has("agentSessionId") ? params.get("agentSessionId").getAsString() : LEGACY_SESSION_ID;
                result = session(sessionId).handle(method, params);
            }
            response.add("result", gson.toJsonTree(result));
        } catch (Throwable error) {
            JsonObject rpcError = new JsonObject();
            rpcError.addProperty("code", -1);
            rpcError.addProperty("message", error.getMessage() == null ? error.toString() : error.getMessage());
            response.add("error", rpcError);
        }
        return response;
    }

    private Object openSession(String sessionId, JsonObject params) throws Exception {
        if (sessions.size() >= MAX_SESSIONS && !sessions.containsKey(sessionId)) {
            throw new IllegalStateException("Agent session limit reached: " + MAX_SESSIONS);
        }
        Session session = new Session(new JsonRpcServer(agentFactory.get()));
        Session existing = sessions.putIfAbsent(sessionId, session);
        if (existing != null) {
            throw new IllegalStateException("Agent session already exists: " + sessionId);
        }
        try {
            return session.handle(AgentProtocol.METHOD_CONNECT, params);
        } catch (Exception error) {
            sessions.remove(sessionId, session);
            session.close();
            throw error;
        }
    }

    private Object closeSession(String sessionId) {
        Session session = sessions.remove(sessionId);
        if (session != null) {
            session.close();
        }
        return Collections.singletonMap("ok", true);
    }

    private Session session(String sessionId) {
        Session session = sessions.get(sessionId);
        if (session == null) {
            throw new IllegalStateException("Agent session not found: " + sessionId);
        }
        return session;
    }

    private void closeAllSessions() {
        for (String sessionId : sessions.keySet()) {
            closeSession(sessionId);
        }
    }

    private static String requiredSessionId(JsonObject params) {
        if (!params.has("agentSessionId") || params.get("agentSessionId").getAsString().trim().isEmpty()) {
            throw new IllegalArgumentException("agentSessionId is required");
        }
        return params.get("agentSessionId").getAsString();
    }

    private void writeResponse(JsonObject response) {
        synchronized (outputLock) {
            System.out.println(gson.toJson(response));
            System.out.flush();
        }
    }

    private static final class Session {
        private final JsonRpcServer server;

        private Session(JsonRpcServer server) {
            this.server = server;
        }

        private synchronized Object handle(String method, JsonObject params) throws Exception {
            return server.dispatchForRuntime(method, params);
        }

        private synchronized void close() {
            try {
                server.dispatchForRuntime(AgentProtocol.METHOD_DISCONNECT, new JsonObject());
            } catch (Exception ignored) {
            }
        }

        private void cancel() {
            server.cancelActiveStatements();
        }
    }
}
