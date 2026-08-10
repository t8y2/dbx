package com.dbx.agent;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class AgentProtocol {
    public static final int PROTOCOL_VERSION = 1;
    public static final int MULTI_SESSION_PROTOCOL_VERSION = 2;

    public static final String METHOD_HANDSHAKE = "handshake";
    public static final String METHOD_CONNECT = "connect";
    public static final String METHOD_OPEN_SESSION = "open_session";
    public static final String METHOD_CLOSE_SESSION = "close_session";
    public static final String METHOD_VALIDATE_SESSION = "validate_session";
    public static final String METHOD_CANCEL_SESSION = "cancel_session";
    public static final String METHOD_TEST_CONNECTION = "test_connection";
    public static final String METHOD_VALIDATE_CONNECTION = "validate_connection";
    public static final String METHOD_CONNECTION_INFO = "connection_info";
    public static final String METHOD_LIST_DATABASES = "list_databases";
    public static final String METHOD_LIST_SCHEMAS = "list_schemas";
    public static final String METHOD_LIST_TABLES = "list_tables";
    public static final String METHOD_LIST_OBJECTS = "list_objects";
    public static final String METHOD_LIST_DATA_TYPES = "list_data_types";
    public static final String METHOD_COMPLETION_ASSISTANT_SEARCH_V1 = "completion_assistant_search_v1";
    public static final String METHOD_GET_OBJECT_SOURCE = "get_object_source";
    public static final String METHOD_GET_TABLE_DDL = "get_table_ddl";
    public static final String METHOD_GET_COLUMNS = "get_columns";
    public static final String METHOD_LIST_INDEXES = "list_indexes";
    public static final String METHOD_LIST_FOREIGN_KEYS = "list_foreign_keys";
    public static final String METHOD_LIST_TRIGGERS = "list_triggers";
    public static final String METHOD_LIST_CONSTRAINTS = "list_constraints";
    public static final String METHOD_LIST_PARTITIONS = "list_partitions";
    public static final String METHOD_LIST_SUBPARTITIONS = "list_subpartitions";
    public static final String METHOD_EXECUTE_QUERY = "execute_query";
    public static final String METHOD_EXECUTE_QUERY_PAGE = "execute_query_page";
    public static final String METHOD_FETCH_QUERY_PAGE = "fetch_query_page";
    public static final String METHOD_CLOSE_QUERY_SESSION = "close_query_session";
    public static final String METHOD_START_TABLE_READ = "start_table_read";
    public static final String METHOD_FETCH_TABLE_READ_PAGE = "fetch_table_read_page";
    public static final String METHOD_CLOSE_TABLE_READ_SESSION = "close_table_read_session";
    public static final String METHOD_GET_EXPLAIN_INFO = "get_explain_info";
    public static final String METHOD_EXECUTE_BATCH = "execute_batch";
    public static final String METHOD_EXECUTE_TRANSACTION = "execute_transaction";
    public static final String METHOD_DISCONNECT = "disconnect";
    public static final String METHOD_SHUTDOWN = "shutdown";

    public static final String MONGO_METHOD_LIST_DATABASES = "list_databases";
    public static final String MONGO_METHOD_LIST_COLLECTIONS = "list_collections";
    public static final String MONGO_METHOD_FIND_DOCUMENTS = "find_documents";
    public static final String MONGO_METHOD_FIND_ONE = "find_one";
    public static final String MONGO_METHOD_EXPLAIN_FIND = "explain_find";
    public static final String MONGO_METHOD_AGGREGATE_DOCUMENTS = "aggregate_documents";
    /**
     * MongoDB read path that returns documents as relaxed Extended JSON for transfer.
     */
    public static final String MONGO_METHOD_FIND_DOCUMENTS_EXTENDED_JSON = "find_documents_extended_json";
    public static final String MONGO_METHOD_COUNT_DOCUMENTS = "count_documents";
    public static final String MONGO_METHOD_SERVER_VERSION = "server_version";
    public static final String MONGO_METHOD_CREATE_INDEX = "create_index";
    public static final String MONGO_METHOD_CREATE_USER = "create_user";
    public static final String MONGO_METHOD_DROP_INDEXES = "drop_indexes";
    public static final String MONGO_METHOD_DROP_COLLECTION = "drop_collection";
    public static final String MONGO_METHOD_DROP_DATABASE = "drop_database";
    public static final String MONGO_METHOD_INSERT_DOCUMENT = "insert_document";
    public static final String MONGO_METHOD_UPDATE_DOCUMENT = "update_document";
    public static final String MONGO_METHOD_UPDATE_DOCUMENTS = "update_documents";
    public static final String MONGO_METHOD_DELETE_DOCUMENT = "delete_document";
    public static final String MONGO_METHOD_DELETE_DOCUMENTS = "delete_documents";

    public static final String KV_METHOD_LIST_PREFIX = "kv_list_prefix";
    public static final String KV_METHOD_GET = "kv_get";
    public static final String KV_METHOD_PUT = "kv_put";
    public static final String KV_METHOD_DELETE = "kv_delete";
    public static final String KV_METHOD_RENAME = "kv_rename";
    public static final String KV_METHOD_HISTORY = "kv_history";
    public static final String KV_METHOD_STATUS = "kv_status";
    public static final String ETCD_METHOD_COMPACT = "etcd_compact";
    public static final String ETCD_METHOD_DEFRAG = "etcd_defrag";
    public static final String ETCD_METHOD_WATCH_START = "etcd_watch_start";
    public static final String ETCD_METHOD_WATCH_POLL = "etcd_watch_poll";
    public static final String ETCD_METHOD_WATCH_STOP = "etcd_watch_stop";
    public static final String ETCD_METHOD_LEASE_LIST = "etcd_lease_list";
    public static final String ETCD_METHOD_LEASE_GET = "etcd_lease_get";
    public static final String ETCD_METHOD_LEASE_GRANT = "etcd_lease_grant";
    public static final String ETCD_METHOD_LEASE_KEEPALIVE = "etcd_lease_keepalive_once";
    public static final String ETCD_METHOD_LEASE_REVOKE = "etcd_lease_revoke";
    public static final String ETCD_METHOD_AUTH_USER_LIST = "etcd_auth_user_list";
    public static final String ETCD_METHOD_AUTH_USER_GET = "etcd_auth_user_get";
    public static final String ETCD_METHOD_AUTH_USER_ADD = "etcd_auth_user_add";
    public static final String ETCD_METHOD_AUTH_USER_DELETE = "etcd_auth_user_delete";
    public static final String ETCD_METHOD_AUTH_USER_CHANGE_PASSWORD = "etcd_auth_user_change_password";
    public static final String ETCD_METHOD_AUTH_USER_GRANT_ROLE = "etcd_auth_user_grant_role";
    public static final String ETCD_METHOD_AUTH_USER_REVOKE_ROLE = "etcd_auth_user_revoke_role";
    public static final String ETCD_METHOD_AUTH_ROLE_LIST = "etcd_auth_role_list";
    public static final String ETCD_METHOD_AUTH_ROLE_GET = "etcd_auth_role_get";
    public static final String ETCD_METHOD_AUTH_ROLE_ADD = "etcd_auth_role_add";
    public static final String ETCD_METHOD_AUTH_ROLE_DELETE = "etcd_auth_role_delete";
    public static final String ETCD_METHOD_AUTH_ROLE_GRANT_PERMISSION = "etcd_auth_role_grant_permission";
    public static final String ETCD_METHOD_AUTH_ROLE_REVOKE_PERMISSION = "etcd_auth_role_revoke_permission";

    public static final String CAPABILITY_CONNECT = "connect";
    public static final String CAPABILITY_TEST_CONNECTION = "test_connection";
    public static final String CAPABILITY_METADATA = "metadata";
    public static final String CAPABILITY_QUERY = "query";
    public static final String CAPABILITY_PAGED_QUERY = "paged_query";
    public static final String CAPABILITY_TRANSACTION = "transaction";
    public static final String CAPABILITY_DDL = "ddl";
    public static final String CAPABILITY_KV = "kv";
    public static final String CAPABILITY_KV_TTL = "kv_ttl";
    public static final String CAPABILITY_KV_CAS = "kv_cas";
    public static final String CAPABILITY_KV_LIST_VALUES = "kv_list_values";
    public static final String CAPABILITY_KV_STATUS = "kv_status";
    public static final String CAPABILITY_KV_HISTORY = "kv_history";
    public static final String CAPABILITY_ETCD_COMPACTION = "etcd_compaction";
    public static final String CAPABILITY_ETCD_DEFRAG = "etcd_defrag";
    public static final String CAPABILITY_ETCD_WATCH = "etcd_watch";
    public static final String CAPABILITY_ETCD_LEASE = "etcd_lease";
    public static final String CAPABILITY_ETCD_AUTH = "etcd_auth";
    public static final String CAPABILITY_MONGO_DROP_DATABASE = "mongo_drop_database";
    public static final String CAPABILITY_MULTI_SESSION = "multi_session";
    public static final String CAPABILITY_STRUCTURED_ERROR_V1 = "structured_error_v1";

    public static final List<String> CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        CAPABILITY_CONNECT,
        CAPABILITY_TEST_CONNECTION,
        CAPABILITY_METADATA,
        CAPABILITY_QUERY,
        CAPABILITY_PAGED_QUERY,
        CAPABILITY_TRANSACTION,
        CAPABILITY_DDL
    ));

    public static final List<String> ALL_CAPABILITIES = Collections.unmodifiableList(Arrays.asList(
        CAPABILITY_CONNECT,
        CAPABILITY_TEST_CONNECTION,
        CAPABILITY_METADATA,
        CAPABILITY_QUERY,
        CAPABILITY_PAGED_QUERY,
        CAPABILITY_TRANSACTION,
        CAPABILITY_DDL,
        CAPABILITY_KV,
        CAPABILITY_KV_TTL,
        CAPABILITY_KV_CAS,
        CAPABILITY_KV_LIST_VALUES,
        CAPABILITY_KV_STATUS,
        CAPABILITY_KV_HISTORY,
        CAPABILITY_ETCD_COMPACTION,
        CAPABILITY_ETCD_DEFRAG,
        CAPABILITY_ETCD_WATCH,
        CAPABILITY_ETCD_LEASE,
        CAPABILITY_ETCD_AUTH,
        CAPABILITY_MONGO_DROP_DATABASE
    ));

    public static final List<String> MULTI_SESSION_CAPABILITIES;
    public static final List<String> MULTI_SESSION_ALL_CAPABILITIES;
    public static final List<String> MONGO_LEGACY_CAPABILITIES;
    public static final List<String> MONGO_LEGACY_MULTI_SESSION_CAPABILITIES;
    public static final List<String> MULTI_SESSION_JDBC_CAPABILITIES;
    public static final List<String> MULTI_SESSION_JDBC_ALL_CAPABILITIES;

    public static final List<String> COMMON_METHODS = Collections.unmodifiableList(Arrays.asList(
        METHOD_HANDSHAKE,
        METHOD_CONNECT,
        METHOD_TEST_CONNECTION,
        METHOD_VALIDATE_CONNECTION,
        METHOD_CONNECTION_INFO,
        METHOD_LIST_DATABASES,
        METHOD_LIST_SCHEMAS,
        METHOD_LIST_TABLES,
        METHOD_LIST_OBJECTS,
        METHOD_LIST_DATA_TYPES,
        METHOD_COMPLETION_ASSISTANT_SEARCH_V1,
        METHOD_GET_OBJECT_SOURCE,
        METHOD_GET_TABLE_DDL,
        METHOD_GET_COLUMNS,
        METHOD_LIST_INDEXES,
        METHOD_LIST_FOREIGN_KEYS,
        METHOD_LIST_TRIGGERS,
        METHOD_LIST_CONSTRAINTS,
        METHOD_LIST_PARTITIONS,
        METHOD_LIST_SUBPARTITIONS,
        METHOD_EXECUTE_QUERY,
        METHOD_EXECUTE_QUERY_PAGE,
        METHOD_FETCH_QUERY_PAGE,
        METHOD_CLOSE_QUERY_SESSION,
        METHOD_START_TABLE_READ,
        METHOD_FETCH_TABLE_READ_PAGE,
        METHOD_CLOSE_TABLE_READ_SESSION,
        METHOD_GET_EXPLAIN_INFO,
        METHOD_EXECUTE_BATCH,
        METHOD_EXECUTE_TRANSACTION,
        METHOD_DISCONNECT,
        METHOD_SHUTDOWN
    ));

    public static final List<String> MULTI_SESSION_METHODS;

    static {
        List<String> capabilities = new java.util.ArrayList<>(CAPABILITIES);
        capabilities.add(CAPABILITY_MULTI_SESSION);
        MULTI_SESSION_CAPABILITIES = Collections.unmodifiableList(capabilities);

        List<String> allCapabilities = new java.util.ArrayList<>(ALL_CAPABILITIES);
        allCapabilities.add(CAPABILITY_MULTI_SESSION);
        MULTI_SESSION_ALL_CAPABILITIES = Collections.unmodifiableList(allCapabilities);

        List<String> mongoCapabilities = new java.util.ArrayList<>(CAPABILITIES);
        mongoCapabilities.add(CAPABILITY_MONGO_DROP_DATABASE);
        MONGO_LEGACY_CAPABILITIES = Collections.unmodifiableList(mongoCapabilities);

        List<String> mongoMultiSessionCapabilities = new java.util.ArrayList<>(MULTI_SESSION_CAPABILITIES);
        mongoMultiSessionCapabilities.add(CAPABILITY_MONGO_DROP_DATABASE);
        MONGO_LEGACY_MULTI_SESSION_CAPABILITIES = Collections.unmodifiableList(mongoMultiSessionCapabilities);

        List<String> jdbcCapabilities = new java.util.ArrayList<>(MULTI_SESSION_CAPABILITIES);
        jdbcCapabilities.add(CAPABILITY_STRUCTURED_ERROR_V1);
        MULTI_SESSION_JDBC_CAPABILITIES = Collections.unmodifiableList(jdbcCapabilities);

        List<String> jdbcAllCapabilities = new java.util.ArrayList<>(MULTI_SESSION_ALL_CAPABILITIES);
        jdbcAllCapabilities.add(CAPABILITY_STRUCTURED_ERROR_V1);
        MULTI_SESSION_JDBC_ALL_CAPABILITIES = Collections.unmodifiableList(jdbcAllCapabilities);

        List<String> methods = new java.util.ArrayList<>(COMMON_METHODS);
        int insertAt = methods.indexOf(METHOD_CONNECT) + 1;
        methods.addAll(insertAt, Arrays.asList(
            METHOD_OPEN_SESSION,
            METHOD_CLOSE_SESSION,
            METHOD_VALIDATE_SESSION,
            METHOD_CANCEL_SESSION
        ));
        MULTI_SESSION_METHODS = Collections.unmodifiableList(methods);
    }

    public static final List<String> MONGO_LEGACY_METHODS = Collections.unmodifiableList(Arrays.asList(
        MONGO_METHOD_LIST_DATABASES,
        MONGO_METHOD_LIST_COLLECTIONS,
        MONGO_METHOD_FIND_DOCUMENTS,
        MONGO_METHOD_FIND_ONE,
        MONGO_METHOD_EXPLAIN_FIND,
        MONGO_METHOD_AGGREGATE_DOCUMENTS,
        MONGO_METHOD_FIND_DOCUMENTS_EXTENDED_JSON,
        MONGO_METHOD_COUNT_DOCUMENTS,
        MONGO_METHOD_SERVER_VERSION,
        MONGO_METHOD_CREATE_INDEX,
        MONGO_METHOD_CREATE_USER,
        MONGO_METHOD_DROP_INDEXES,
        MONGO_METHOD_DROP_COLLECTION,
        MONGO_METHOD_DROP_DATABASE,
        MONGO_METHOD_INSERT_DOCUMENT,
        MONGO_METHOD_UPDATE_DOCUMENT,
        MONGO_METHOD_UPDATE_DOCUMENTS,
        MONGO_METHOD_DELETE_DOCUMENT,
        MONGO_METHOD_DELETE_DOCUMENTS
    ));

    public static final List<String> KV_METHODS = Collections.unmodifiableList(Arrays.asList(
        KV_METHOD_LIST_PREFIX,
        KV_METHOD_GET,
        KV_METHOD_PUT,
        KV_METHOD_DELETE,
        KV_METHOD_RENAME,
        KV_METHOD_HISTORY,
        KV_METHOD_STATUS,
        ETCD_METHOD_COMPACT,
        ETCD_METHOD_DEFRAG,
        ETCD_METHOD_WATCH_START,
        ETCD_METHOD_WATCH_POLL,
        ETCD_METHOD_WATCH_STOP,
        ETCD_METHOD_LEASE_LIST,
        ETCD_METHOD_LEASE_GET,
        ETCD_METHOD_LEASE_GRANT,
        ETCD_METHOD_LEASE_KEEPALIVE,
        ETCD_METHOD_LEASE_REVOKE,
        ETCD_METHOD_AUTH_USER_LIST,
        ETCD_METHOD_AUTH_USER_GET,
        ETCD_METHOD_AUTH_USER_ADD,
        ETCD_METHOD_AUTH_USER_DELETE,
        ETCD_METHOD_AUTH_USER_CHANGE_PASSWORD,
        ETCD_METHOD_AUTH_USER_GRANT_ROLE,
        ETCD_METHOD_AUTH_USER_REVOKE_ROLE,
        ETCD_METHOD_AUTH_ROLE_LIST,
        ETCD_METHOD_AUTH_ROLE_GET,
        ETCD_METHOD_AUTH_ROLE_ADD,
        ETCD_METHOD_AUTH_ROLE_DELETE,
        ETCD_METHOD_AUTH_ROLE_GRANT_PERMISSION,
        ETCD_METHOD_AUTH_ROLE_REVOKE_PERMISSION
    ));

    private AgentProtocol() {
    }

    public static HandshakeResult handshakeResult() {
        return new HandshakeResult(PROTOCOL_VERSION, PROTOCOL_VERSION, CAPABILITIES);
    }

    public static HandshakeResult multiSessionHandshakeResult() {
        return new HandshakeResult(
            MULTI_SESSION_PROTOCOL_VERSION,
            MULTI_SESSION_PROTOCOL_VERSION,
            MULTI_SESSION_CAPABILITIES
        );
    }

    public static HandshakeResult mongoLegacyHandshakeResult() {
        return new HandshakeResult(PROTOCOL_VERSION, PROTOCOL_VERSION, MONGO_LEGACY_CAPABILITIES);
    }

    public static HandshakeResult mongoLegacyMultiSessionHandshakeResult() {
        return new HandshakeResult(
            MULTI_SESSION_PROTOCOL_VERSION,
            MULTI_SESSION_PROTOCOL_VERSION,
            MONGO_LEGACY_MULTI_SESSION_CAPABILITIES
        );
    }

    /**
     * Handshake for pooled JDBC Agents that emit the v1 structured error contract.
     * Generic/custom v2 handlers must continue using multiSessionHandshakeResult().
     */
    public static HandshakeResult multiSessionJdbcHandshakeResult() {
        return new HandshakeResult(
            MULTI_SESSION_PROTOCOL_VERSION,
            MULTI_SESSION_PROTOCOL_VERSION,
            MULTI_SESSION_JDBC_CAPABILITIES
        );
    }

    public static final class HandshakeResult {
        private final int protocolVersion;
        private final int agentProtocolVersion;
        private final List<String> capabilities;

        private HandshakeResult(int protocolVersion, int agentProtocolVersion, List<String> capabilities) {
            this.protocolVersion = protocolVersion;
            this.agentProtocolVersion = agentProtocolVersion;
            this.capabilities = capabilities;
        }
    }
}
