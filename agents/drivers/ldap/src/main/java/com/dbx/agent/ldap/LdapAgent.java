package com.dbx.agent.ldap;

import com.google.gson.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.naming.Context;
import javax.naming.NamingEnumeration;
import javax.naming.NamingException;
import javax.naming.PartialResultException;
import javax.naming.SizeLimitExceededException;
import javax.naming.directory.*;
import javax.naming.ldap.InitialLdapContext;
import javax.naming.ldap.LdapContext;
import javax.security.auth.Subject;
import javax.security.auth.callback.*;
import javax.security.auth.login.AppConfigurationEntry;
import javax.security.auth.login.Configuration;
import javax.security.auth.login.LoginContext;
import java.util.concurrent.Callable;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.security.PrivilegedAction;
import java.time.Duration;
import java.util.*;

/**
 * LDAP agent for DBX. Communicates with the Rust bridge via JSON-RPC
 * over stdin/stdout. Uses JNDI for LDAP operations and JAAS for
 * Kerberos/GSSAPI authentication.
 */
public final class LdapAgent {

    private static final PrintStream JSON_RPC_OUT = System.out;
    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final int DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
    private static final int DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

    private static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        "ldap_connect", "ldap_test_connection", "ldap_search"
    ));

    private static LdapContext ldapContext;
    private static LoginContext loginContext;
    private static Path tempJaasConfig;
    private static JsonObject activeConnection;
    private static volatile boolean shutdownRequested;

    private LdapAgent() {}

    private static Logger logger() {
        return LoggerHolder.INSTANCE;
    }

    private static final class LoggerHolder {
        private static final Logger INSTANCE = LoggerFactory.getLogger(LdapAgent.class);
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    public static void main(String[] args) throws Exception {
        System.setOut(System.err);
        System.setProperty("org.slf4j.simpleLogger.logFile", "System.err");
        JSON_RPC_OUT.println("{\"ready\":true}");
        JSON_RPC_OUT.flush();

        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        while (true) {
            String line = reader.readLine();
            if (line == null) break;
            String response = handleRequest(line);
            JSON_RPC_OUT.println(response);
            JSON_RPC_OUT.flush();
            if (shutdownRequested) {
                System.exit(0);
            }
        }
    }

    // -----------------------------------------------------------------------
    // JSON-RPC dispatch
    // -----------------------------------------------------------------------

    static String handleRequest(String line) {
        JsonObject req = JsonParser.parseString(line).getAsJsonObject();
        JsonElement id = req.get("id");
        String method = req.get("method").getAsString();
        JsonObject params = req.has("params") && req.get("params").isJsonObject()
            ? req.getAsJsonObject("params") : new JsonObject();

        JsonObject response = new JsonObject();
        response.addProperty("jsonrpc", "2.0");
        response.add("id", id);

        try {
            Object result = dispatch(method, params);
            response.add("result", GSON.toJsonTree(result));
        } catch (Exception e) {
            logger().warn("LDAP Agent request failed: method={}, id={}", method, id, e);
            JsonObject error = new JsonObject();
            error.addProperty("code", -1);
            error.addProperty("message", normalizeErrorMessage(e));
            response.add("error", error);
        }
        return GSON.toJson(response);
    }

    private static Object dispatch(String method, JsonObject params) throws Exception {
        return switch (method) {
            case "handshake" -> handshakeResult();
            case "connect" -> connect(params);
            case "test_connection" -> testConnection(params);
            case "validate_connection" -> validateConnection(params);
            case "connection_info" -> connectionInfo(params);
            case "disconnect" -> { closeClients(); yield Collections.singletonMap("ok", true); }
            case "shutdown" -> { closeClients(); shutdownRequested = true; yield Collections.singletonMap("ok", true); }
            case "ldap_search" -> search(params);
            case "list_databases" -> listDatabases(params);
            default -> throw new IllegalArgumentException("Unknown method: " + method);
        };
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    private static Object handshakeResult() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("protocolVersion", 1);
        result.put("agentProtocolVersion", 1);
        result.put("capabilities", CAPABILITIES);
        return result;
    }

    private static Object connect(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        LdapContext nextContext = null;
        LoginContext nextLogin = null;
        Path nextTempJaas = null;
        try {
            ContextResult ctx = createContext(conn, nextTempJaas, nextLogin);
            nextContext = ctx.context;
            nextLogin = ctx.loginContext;
            nextTempJaas = ctx.tempConfig;
            closeClients();
            ldapContext = nextContext;
            loginContext = nextLogin;
            tempJaasConfig = nextTempJaas;
            activeConnection = conn.deepCopy();
            return Collections.singletonMap("ok", true);
        } catch (Exception e) {
            if (nextContext != null) {
                nextContext.close();
            }
            if (nextLogin != null) {
                try { nextLogin.logout(); } catch (Exception ignored) {}
            }
            if (nextTempJaas != null) {
                try { Files.deleteIfExists(nextTempJaas); } catch (Exception ignored) {}
            }
            throw e;
        }
    }

    private static Object testConnection(JsonObject params) throws Exception {
        JsonObject conn = connectionObject(params);
        LdapContext probe = null;
        LoginContext probeLogin = null;
        Path probeTempJaas = null;
        try {
            ContextResult ctx = createContext(conn, probeTempJaas, probeLogin);
            probe = ctx.context;
            probeLogin = ctx.loginContext;
            probeTempJaas = ctx.tempConfig;

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("ok", true);
            result.put("connected", true);

            // Try a simple root DSE search to verify readability
            try {
                SearchControls controls = new SearchControls();
                controls.setSearchScope(SearchControls.OBJECT_SCOPE);
                controls.setReturningAttributes(new String[]{"subschemaSubentry", "supportedLDAPVersion"});
                controls.setCountLimit(1);
                controls.setTimeLimit(5_000);
                NamingEnumeration<SearchResult> results = probe.search("", "(objectClass=*)", controls);
                if (results.hasMore()) {
                    SearchResult rootDse = results.next();
                    Map<String, Object> rootInfo = new LinkedHashMap<>();
                    NamingEnumeration<? extends Attribute> attrs = rootDse.getAttributes().getAll();
                    while (attrs.hasMore()) {
                        Attribute attr = attrs.next();
                        List<String> values = new ArrayList<>();
                        NamingEnumeration<?> vals = attr.getAll();
                        while (vals.hasMore()) {
                            values.add(String.valueOf(vals.next()));
                        }
                        rootInfo.put(attr.getID(), values.size() == 1 ? values.get(0) : values);
                    }
                    result.put("rootDse", rootInfo);
                }
            } catch (Exception e) {
                logger().debug("Root DSE search failed (non-fatal)", e);
                result.put("rootDseSearchable", false);
            }

            return result;
        } finally {
            if (probe != null) {
                probe.close();
            }
            if (probeLogin != null) {
                try { probeLogin.logout(); } catch (Exception ignored) {}
            }
            if (probeTempJaas != null) {
                try { Files.deleteIfExists(probeTempJaas); } catch (Exception ignored) {}
            }
        }
    }

    private static void closeClients() {
        if (ldapContext != null) {
            try { ldapContext.close(); } catch (Exception ignored) {}
            ldapContext = null;
        }
        if (loginContext != null) {
            try { loginContext.logout(); } catch (Exception ignored) {}
            loginContext = null;
        }
        if (tempJaasConfig != null) {
            try { Files.deleteIfExists(tempJaasConfig); } catch (Exception ignored) {}
            tempJaasConfig = null;
        }
        activeConnection = null;
    }

    // -----------------------------------------------------------------------
    // LDAP context creation
    // -----------------------------------------------------------------------

    private static class ContextResult {
        final LdapContext context;
        final LoginContext loginContext;
        final Path tempConfig;

        ContextResult(LdapContext context, LoginContext loginContext, Path tempConfig) {
            this.context = context;
            this.loginContext = loginContext;
            this.tempConfig = tempConfig;
        }
    }

    private static ContextResult createContext(JsonObject conn, Path existingTempPath, LoginContext existingLogin) throws Exception {
        String hostname = stringOrEmpty(conn, "hostname");
        if (hostname.isBlank()) hostname = stringOrEmpty(conn, "host");
        int port = intOrDefault(conn, "port", 389);
        boolean useSsl = boolOrDefault(conn, "ssl", false) || boolOrDefault(conn, "use_ssl", false);
        boolean tlsSkipVerify = boolOrDefault(conn, "tls_skip_verify", false);

        int connectTimeout = intOrDefault(conn, "connect_timeout_ms", DEFAULT_CONNECT_TIMEOUT_MS);
        int responseTimeout = intOrDefault(conn, "response_timeout_ms", DEFAULT_RESPONSE_TIMEOUT_MS);

        String protocol = useSsl ? "ldaps" : "ldap";
        String providerUrl = new URI(protocol, null, hostname, port, null, null, null).toString();

        Hashtable<String, Object> env = new Hashtable<>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.ldap.LdapCtxFactory");
        env.put(Context.PROVIDER_URL, providerUrl);
        env.put("com.sun.jndi.ldap.connect.timeout", String.valueOf(connectTimeout));
        env.put("com.sun.jndi.ldap.read.timeout", String.valueOf(responseTimeout));
        env.put(Context.REFERRAL, "ignore");

        if (tlsSkipVerify) {
            env.put("java.naming.ldap.factory.socket",
                "com.dbx.agent.ldap.TrustAllSSLSocketFactory");
        }

        String securityProtocol = stringOrEmpty(conn, "security_protocol");
        if (securityProtocol.isBlank()) securityProtocol = "simple";

        LoginContext lc = existingLogin;
        Path tempConfig = existingTempPath;

        switch (securityProtocol.toLowerCase(Locale.ROOT)) {
            case "simple" -> {
                String username = stringOrEmpty(conn, "username");
                if (username.isBlank()) username = stringOrEmpty(conn, "bind_dn");
                String password = stringOrEmpty(conn, "password");
                if (password.isBlank()) password = stringOrEmpty(conn, "bind_password");

                env.put(Context.SECURITY_AUTHENTICATION, "simple");
                env.put(Context.SECURITY_PRINCIPAL, username);
                env.put(Context.SECURITY_CREDENTIALS, password);

                return new ContextResult(new InitialLdapContext(env, null), null, null);
            }

            case "gssapi" -> {
                String principal = stringOrEmpty(conn, "principal");
                if (principal.isBlank()) principal = stringOrEmpty(conn, "kerberos_principal");
                String password = stringOrEmpty(conn, "password");
                if (password.isBlank()) password = stringOrEmpty(conn, "kerberos_password");
                String keytabPath = stringOrEmpty(conn, "keytab_path");
                if (keytabPath.isBlank()) keytabPath = stringOrEmpty(conn, "keytab");
                String krb5Conf = stringOrEmpty(conn, "krb5_conf");
                if (krb5Conf.isBlank()) krb5Conf = stringOrEmpty(conn, "krb5_config");

                // Write krb5.conf if provided
                if (!krb5Conf.isBlank()) {
                    Path krb5Path = Files.createTempFile("dbx-ldap-krb5-", ".conf");
                    Files.write(krb5Path, krb5Conf.getBytes(StandardCharsets.UTF_8));
                    krb5Path.toFile().deleteOnExit();
                    System.setProperty("java.security.krb5.conf", krb5Path.toString());
                }

                // Write JAAS config
                String jaasEntryName = "LdapKrb5Login";
                String jaasConfig = buildJaasConfig(jaasEntryName, principal, password, keytabPath);
                tempConfig = Files.createTempFile("dbx-ldap-jaas-", ".conf");
                Files.write(tempConfig, jaasConfig.getBytes(StandardCharsets.UTF_8));
                tempConfig.toFile().deleteOnExit();
                System.setProperty("java.security.auth.login.config", tempConfig.toString());

                env.put(Context.SECURITY_AUTHENTICATION, "GSSAPI");
                env.put(Context.SECURITY_PRINCIPAL, principal);

                final String finalPrincipal = principal;
                final String finalPassword = password;
                final String finalKeytabPath = keytabPath;

                // Create JAAS LoginContext
                Configuration jaasConfiguration = new Configuration() {
                    @Override
                    public AppConfigurationEntry[] getAppConfigurationEntry(String name) {
                        if (!jaasEntryName.equals(name)) return null;
                        Map<String, String> options = new HashMap<>();
                        if (finalKeytabPath != null && !finalKeytabPath.isBlank()) {
                            options.put("useKeyTab", "true");
                            options.put("keyTab", finalKeytabPath);
                            options.put("storeKey", "true");
                            options.put("doNotPrompt", "true");
                            options.put("useTicketCache", "false");
                        } else {
                            options.put("useTicketCache", "false");
                            options.put("storeKey", "false");
                            options.put("doNotPrompt", "false");
                        }
                        options.put("principal", finalPrincipal);
                        options.put("refreshKrb5Config", "true");
                        options.put("debug", "true");
                        return new AppConfigurationEntry[]{
                            new AppConfigurationEntry(
                                "com.sun.security.auth.module.Krb5LoginModule",
                                AppConfigurationEntry.LoginModuleControlFlag.REQUIRED,
                                options
                            )
                        };
                    }
                };

                CallbackHandler callbackHandler = callbacks -> {
                    for (Callback cb : callbacks) {
                        if (cb instanceof NameCallback nc) {
                            nc.setName(finalPrincipal);
                        } else if (cb instanceof PasswordCallback pc) {
                            if (finalPassword != null && !finalPassword.isBlank()) {
                                pc.setPassword(finalPassword.toCharArray());
                            }
                        }
                    }
                };

                lc = new LoginContext(jaasEntryName, null, callbackHandler, jaasConfiguration);
                lc.login();
                Subject subject = lc.getSubject();

                final Hashtable<String, Object> finalEnv = env;
                LdapContext ctx = Subject.callAs(subject, (Callable<LdapContext>) () -> {
                    try {
                        return new InitialLdapContext(finalEnv, null);
                    } catch (NamingException e) {
                        throw new RuntimeException(e);
                    }
                });

                return new ContextResult(ctx, lc, tempConfig);
            }

            case "none" -> {
                env.put(Context.SECURITY_AUTHENTICATION, "none");
                return new ContextResult(new InitialLdapContext(env, null), null, null);
            }

            default -> throw new IllegalArgumentException("Unsupported security protocol: " + securityProtocol
                + ". Use 'simple', 'gssapi', or 'none'.");
        }
    }

    private static String buildJaasConfig(String entryName, String principal, String password, String keytabPath) {
        StringBuilder sb = new StringBuilder();
        sb.append(entryName).append(" {\n");
        sb.append("    com.sun.security.auth.module.Krb5LoginModule required\n");
        if (keytabPath != null && !keytabPath.isBlank()) {
            sb.append("    useKeyTab=true\n");
            sb.append("    keyTab=\"").append(jaasValue(keytabPath)).append("\"\n");
            sb.append("    storeKey=true\n");
            sb.append("    doNotPrompt=true\n");
        } else {
            sb.append("    useTicketCache=false\n");
            sb.append("    storeKey=false\n");
            sb.append("    doNotPrompt=false\n");
        }
        sb.append("    principal=\"").append(jaasValue(principal)).append("\"\n");
        sb.append("    refreshKrb5Config=true\n");
        sb.append("    debug=true;\n");
        sb.append("};\n");
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // LDAP databases (list children under base DN, scope=one)
    // -----------------------------------------------------------------------

    private static Object listDatabases(JsonObject params) throws Exception {
        if (ldapContext == null) {
            throw new IllegalStateException("Not connected. Call connect first.");
        }

        String baseDn = stringOrEmpty(params, "base_dn");
        if (baseDn.isBlank()) baseDn = stringOrEmpty(activeConnection, "base_dn");
        if (baseDn.isBlank()) baseDn = stringOrEmpty(activeConnection, "baseDn");
        if (baseDn.isBlank()) baseDn = "";

        int timeout = intOrDefault(params, "timeout_ms", DEFAULT_RESPONSE_TIMEOUT_MS);

        SearchControls controls = new SearchControls();
        controls.setSearchScope(SearchControls.ONELEVEL_SCOPE);
        controls.setCountLimit(0);
        controls.setTimeLimit(timeout);
        controls.setReturningAttributes(new String[]{"ou", "cn", "dc", "objectClass"});

        NamingEnumeration<SearchResult> results = ldapContext.search(baseDn, "(objectClass=*)", controls);
        List<Map<String, Object>> databases = new ArrayList<>();
        try {
            while (results.hasMore()) {
                SearchResult sr = results.next();
                String dn = sr.getNameInNamespace();
                // Use full DN as the name (Rust only has 'name' field)
                Map<String, Object> db = new LinkedHashMap<>();
                db.put("name", dn);
                databases.add(db);
            }
        } catch (SizeLimitExceededException e) {
            logger().debug("LDAP list_databases size limit exceeded, returning partial results");
        } catch (PartialResultException e) {
            logger().debug("LDAP list_databases partial result (continuation references ignored)");
        } finally {
            results.close();
        }

        return databases;
    }

    // -----------------------------------------------------------------------
    // Validate connection
    // -----------------------------------------------------------------------

    private static Object validateConnection(JsonObject params) throws Exception {
        if (ldapContext == null) {
            throw new IllegalStateException("Not connected");
        }
        // Quick root DSE lookup to verify the connection is still alive
        SearchControls controls = new SearchControls();
        controls.setSearchScope(SearchControls.OBJECT_SCOPE);
        controls.setCountLimit(1);
        controls.setTimeLimit(5_000);
        controls.setReturningAttributes(new String[]{"supportedLDAPVersion"});
        ldapContext.search("", "(objectClass=*)", controls).close();
        return Collections.singletonMap("ok", true);
    }

    // -----------------------------------------------------------------------
    // Connection info
    // -----------------------------------------------------------------------

    private static Object connectionInfo(JsonObject params) throws Exception {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("identifierQuote", "");

        if (ldapContext != null) {
            try {
                SearchControls controls = new SearchControls();
                controls.setSearchScope(SearchControls.OBJECT_SCOPE);
                controls.setCountLimit(1);
                controls.setTimeLimit(5_000);
                controls.setReturningAttributes(new String[]{
                    "supportedLDAPVersion", "vendorName", "vendorVersion",
                    "subschemaSubentry", "namingContexts", "defaultNamingContext"
                });
                NamingEnumeration<SearchResult> results = ldapContext.search("", "(objectClass=*)", controls);
                if (results.hasMore()) {
                    SearchResult rootDse = results.next();
                    Attributes attrs = rootDse.getAttributes();

                    Map<String, Object> dbInfo = new LinkedHashMap<>();
                    dbInfo.put("productName", attrValue(attrs, "vendorName", "LDAP"));
                    dbInfo.put("productVersion", attrValue(attrs, "vendorVersion", ""));

                    List<String> namingContexts = attrValues(attrs, "namingContexts");
                    if (!namingContexts.isEmpty()) {
                        dbInfo.put("currentDatabase", namingContexts.get(0));
                    }

                    List<String> supportedVersions = attrValues(attrs, "supportedLDAPVersion");
                    if (!supportedVersions.isEmpty()) {
                        dbInfo.put("serverComment", "LDAP v" + String.join(", ", supportedVersions));
                    }

                    dbInfo.put("driverName", "dbx-agent-ldap (JNDI)");
                    dbInfo.put("driverVersion", "1.0.0");

                    result.put("databaseInfo", dbInfo);
                }
            } catch (Exception e) {
                logger().debug("Root DSE query for connection_info failed", e);
            }
        }
        return result;
    }

    private static String attrValue(Attributes attrs, String id, String fallback) {
        Attribute attr = attrs.get(id);
        if (attr != null) {
            try {
                Object val = attr.get();
                return val != null ? String.valueOf(val) : fallback;
            } catch (Exception e) {
                return fallback;
            }
        }
        return fallback;
    }

    private static List<String> attrValues(Attributes attrs, String id) {
        List<String> values = new ArrayList<>();
        Attribute attr = attrs.get(id);
        if (attr != null) {
            try {
                NamingEnumeration<?> vals = attr.getAll();
                while (vals.hasMore()) {
                    values.add(String.valueOf(vals.next()));
                }
            } catch (Exception ignored) {}
        }
        return values;
    }

    /**
     * Convert a JNDI garbled binary string back to bytes, char by char.
     */
    private static byte[] stringToBytes(String str) {
        byte[] bytes = new byte[str.length()];
        for (int i = 0; i < str.length(); i++) {
            bytes[i] = (byte) str.charAt(i);
        }
        return bytes;
    }

    private static String hexEncode(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xFF));
        }
        return sb.toString();
    }

    /**
     * Convert AD objectGUID bytes to standard GUID string format.
     * AD stores GUID in mixed-endian: first 3 components little-endian, last 2 big-endian.
     */
    private static String formatGuid(byte[] bytes) {
        // Pad to 16 bytes if shorter (JNDI string fallback may truncate)
        if (bytes.length < 16) {
            byte[] padded = new byte[16];
            System.arraycopy(bytes, 0, padded, 0, Math.min(bytes.length, 16));
            bytes = padded;
        }
        if (bytes.length < 16) return hexEncode(bytes);
        // Data1 (4 bytes, little-endian)
        long data1 = (bytes[3] & 0xFFL) << 24 | (bytes[2] & 0xFFL) << 16 | (bytes[1] & 0xFFL) << 8 | (bytes[0] & 0xFFL);
        // Data2 (2 bytes, little-endian)
        int data2 = (bytes[5] & 0xFF) << 8 | (bytes[4] & 0xFF);
        // Data3 (2 bytes, little-endian)
        int data3 = (bytes[7] & 0xFF) << 8 | (bytes[6] & 0xFF);
        // Data4 (8 bytes, big-endian)
        StringBuilder data4 = new StringBuilder();
        for (int i = 8; i < 16; i++) {
            data4.append(String.format("%02x", bytes[i] & 0xFF));
        }
        return String.format("%08x-%04x-%04x-%s-%s",
            data1, data2, data3,
            data4.substring(0, 4), data4.substring(4));
    }

    /**
     * Convert AD objectSid bytes to SDDL SID string format (S-1-5-...).
     */
    private static String formatSid(byte[] bytes) {
        if (bytes.length < 8) return Base64.getEncoder().encodeToString(bytes);
        int revision = bytes[0] & 0xFF;
        int subAuthorityCount = bytes[1] & 0xFF;
        int expectedLength = 8 + subAuthorityCount * 4;
        if (bytes.length < expectedLength) return Base64.getEncoder().encodeToString(bytes);
        // Identifier authority (6 bytes, big-endian)
        long identifierAuthority = 0;
        for (int i = 2; i < 8; i++) {
            identifierAuthority = (identifierAuthority << 8) | (bytes[i] & 0xFFL);
        }
        StringBuilder sb = new StringBuilder("S-").append(revision).append("-").append(identifierAuthority);
        // Sub-authorities (4 bytes each, little-endian)
        for (int i = 0; i < subAuthorityCount; i++) {
            int offset = 8 + i * 4;
            long subAuth = (bytes[offset + 3] & 0xFFL) << 24
                | (bytes[offset + 2] & 0xFFL) << 16
                | (bytes[offset + 1] & 0xFFL) << 8
                | (bytes[offset] & 0xFFL);
            sb.append("-").append(subAuth);
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // LDAP search
    // -----------------------------------------------------------------------

    private static Object search(JsonObject params) throws Exception {
        if (ldapContext == null) {
            throw new IllegalStateException("Not connected. Call connect first.");
        }

        String baseDn = stringOrEmpty(params, "base_dn");
        if (baseDn.isBlank()) baseDn = stringOrEmpty(params, "baseDn");

        String filter = stringOrEmpty(params, "filter");
        if (filter.isBlank()) {
            throw new IllegalArgumentException("filter is required");
        }

        int sizeLimit = intOrDefault(params, "size_limit", 100);
        if (sizeLimit <= 0) sizeLimit = intOrDefault(params, "sizeLimit", 100);

        List<String> attributes = null;
        JsonElement attrsEl = params.get("attributes");
        if (attrsEl != null && attrsEl.isJsonArray()) {
            attributes = new ArrayList<>();
            for (JsonElement el : attrsEl.getAsJsonArray()) {
                attributes.add(el.getAsString());
            }
        }

        int timeout = intOrDefault(params, "timeout_ms", DEFAULT_RESPONSE_TIMEOUT_MS);

        String scope = stringOrEmpty(params, "scope");
        int searchScope = switch (scope.toLowerCase(Locale.ROOT)) {
            case "base" -> SearchControls.OBJECT_SCOPE;
            case "one" -> SearchControls.ONELEVEL_SCOPE;
            default -> SearchControls.SUBTREE_SCOPE;
        };

        SearchControls controls = new SearchControls();
        controls.setSearchScope(searchScope);
        controls.setCountLimit(sizeLimit);
        controls.setTimeLimit(timeout);
        if (attributes != null && !attributes.isEmpty()) {
            controls.setReturningAttributes(attributes.toArray(new String[0]));
        }

        NamingEnumeration<SearchResult> results = ldapContext.search(baseDn, filter, controls);
        List<Map<String, Object>> entries = new ArrayList<>();
        boolean sizeLimitExceeded = false;
        try {
            while (results.hasMore()) {
                SearchResult sr = results.next();
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("dn", sr.getNameInNamespace());

                Map<String, Object> attrs = new LinkedHashMap<>();
                NamingEnumeration<? extends Attribute> attrEnum = sr.getAttributes().getAll();
                while (attrEnum.hasMore()) {
                    Attribute attr = attrEnum.next();
                    List<String> values = new ArrayList<>();
                    NamingEnumeration<?> vals = attr.getAll();
                    while (vals.hasMore()) {
                        Object val = vals.next();
                        String attrId = attr.getID().toLowerCase(Locale.ROOT);
                        boolean isGuid = attrId.equals("objectguid") || attrId.endsWith("guid");
                        boolean isSid = attrId.equals("objectsid") || attrId.endsWith("sid");

                        if (val instanceof byte[] bytes) {
                            if (isGuid) {
                                values.add(formatGuid(bytes));
                            } else if (isSid) {
                                values.add(formatSid(bytes));
                            } else {
                                values.add(Base64.getEncoder().encodeToString(bytes));
                            }
                        } else if (isGuid && val instanceof String str) {
                            values.add(formatGuid(stringToBytes(str)));
                        } else if (isSid && val instanceof String str) {
                            values.add(formatSid(stringToBytes(str)));
                        } else {
                            values.add(String.valueOf(val));
                        }
                    }
                    attrs.put(attr.getID(), values.size() == 1 ? values.get(0) : values);
                }
                entry.put("attributes", attrs);
                entries.add(entry);
            }
        } catch (SizeLimitExceededException e) {
            sizeLimitExceeded = true;
            logger().debug("LDAP search size limit exceeded, returning {} partial results", entries.size());
        } catch (PartialResultException e) {
            logger().debug("LDAP search partial result (continuation references ignored)");
        } finally {
            results.close();
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("entries", entries);
        result.put("count", entries.size());
        result.put("truncated", sizeLimitExceeded);
        return result;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static String normalizeErrorMessage(Exception e) {
        String message = e.getMessage() == null || e.getMessage().isBlank()
            ? e.getClass().getName()
            : e.getMessage();
        Throwable cause = e.getCause();
        if (cause != null && cause.getMessage() != null && !cause.getMessage().isBlank()
            && !message.contains(cause.getMessage())) {
            message = message + ": " + cause.getMessage();
        }
        if (message.toLowerCase().contains("gssapi") || message.toLowerCase().contains("kerberos")) {
            message = message + ". Hint: For GSSAPI/Kerberos auth, ensure the principal, "
                + "krb5_conf (krb5.conf content), and keytab or password are correctly configured. "
                + "For Simple bind, use security_protocol=simple with username/bind_dn and password.";
        }
        return message;
    }

    private static JsonObject connectionObject(JsonObject params) {
        JsonElement connection = params.get("connection");
        return connection != null && connection.isJsonObject()
            ? connection.getAsJsonObject() : params;
    }

    static String jaasValue(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String stringOrEmpty(JsonObject object, String key) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? "" : element.getAsString();
    }

    private static int intOrDefault(JsonObject object, String key, int fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsInt();
    }

    private static boolean boolOrDefault(JsonObject object, String key, boolean fallback) {
        JsonElement element = object.get(key);
        return element == null || element.isJsonNull() ? fallback : element.getAsBoolean();
    }
}
