package com.dbx.agent;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class AgentProtocol {
    public static final int PROTOCOL_VERSION = 1;

    public static final String METHOD_HANDSHAKE = "handshake";
    public static final String METHOD_CONNECT = "connect";
    public static final String METHOD_TEST_CONNECTION = "test_connection";
    public static final String METHOD_VALIDATE_CONNECTION = "validate_connection";
    public static final String METHOD_LIST_DATABASES = "list_databases";
    public static final String METHOD_LIST_SCHEMAS = "list_schemas";
    public static final String METHOD_LIST_TABLES = "list_tables";
    public static final String METHOD_LIST_OBJECTS = "list_objects";
    public static final String METHOD_COMPLETION_ASSISTANT_SEARCH_V1 = "completion_assistant_search_v1";
    public static final String METHOD_GET_OBJECT_SOURCE = "get_object_source";
    public static final String METHOD_GET_TABLE_DDL = "get_table_ddl";
    public static final String METHOD_GET_COLUMNS = "get_columns";
    public static final String METHOD_LIST_INDEXES = "list_indexes";
    public static final String METHOD_LIST_FOREIGN_KEYS = "list_foreign_keys";
    public static final String METHOD_LIST_TRIGGERS = "list_triggers";
    public static final String METHOD_EXECUTE_QUERY = "execute_query";
    public static final String METHOD_EXECUTE_QUERY_PAGE = "execute_query_page";
    public static final String METHOD_FETCH_QUERY_PAGE = "fetch_query_page";
    public static final String METHOD_CLOSE_QUERY_SESSION = "close_query_session";
    public static final String METHOD_GET_EXPLAIN_INFO = "get_explain_info";
    public static final String METHOD_EXECUTE_TRANSACTION = "execute_transaction";
    public static final String METHOD_DISCONNECT = "disconnect";
    public static final String METHOD_SHUTDOWN = "shutdown";

    public static final String MONGO_METHOD_LIST_DATABASES = "list_databases";
    public static final String MONGO_METHOD_LIST_COLLECTIONS = "list_collections";
    public static final String MONGO_METHOD_FIND_DOCUMENTS = "find_documents";
    public static final String MONGO_METHOD_INSERT_DOCUMENT = "insert_document";
    public static final String MONGO_METHOD_UPDATE_DOCUMENT = "update_document";
    public static final String MONGO_METHOD_DELETE_DOCUMENT = "delete_document";

    public static final String KV_METHOD_LIST_PREFIX = "kv_list_prefix";
    public static final String KV_METHOD_GET = "kv_get";
    public static final String KV_METHOD_PUT = "kv_put";
    public static final String KV_METHOD_DELETE = "kv_delete";

    public static final String CAPABILITY_CONNECT = "connect";
    public static final String CAPABILITY_TEST_CONNECTION = "test_connection";
    public static final String CAPABILITY_METADATA = "metadata";
    public static final String CAPABILITY_QUERY = "query";
    public static final String CAPABILITY_PAGED_QUERY = "paged_query";
    public static final String CAPABILITY_TRANSACTION = "transaction";
    public static final String CAPABILITY_DDL = "ddl";
    public static final String CAPABILITY_KV = "kv";

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
        CAPABILITY_KV
    ));

    public static final List<String> COMMON_METHODS = Collections.unmodifiableList(Arrays.asList(
        METHOD_HANDSHAKE,
        METHOD_CONNECT,
        METHOD_TEST_CONNECTION,
        METHOD_VALIDATE_CONNECTION,
        METHOD_LIST_DATABASES,
        METHOD_LIST_SCHEMAS,
        METHOD_LIST_TABLES,
        METHOD_LIST_OBJECTS,
        METHOD_COMPLETION_ASSISTANT_SEARCH_V1,
        METHOD_GET_OBJECT_SOURCE,
        METHOD_GET_TABLE_DDL,
        METHOD_GET_COLUMNS,
        METHOD_LIST_INDEXES,
        METHOD_LIST_FOREIGN_KEYS,
        METHOD_LIST_TRIGGERS,
        METHOD_EXECUTE_QUERY,
        METHOD_EXECUTE_QUERY_PAGE,
        METHOD_FETCH_QUERY_PAGE,
        METHOD_CLOSE_QUERY_SESSION,
        METHOD_GET_EXPLAIN_INFO,
        METHOD_EXECUTE_TRANSACTION,
        METHOD_DISCONNECT,
        METHOD_SHUTDOWN
    ));

    public static final List<String> MONGO_LEGACY_METHODS = Collections.unmodifiableList(Arrays.asList(
        MONGO_METHOD_LIST_DATABASES,
        MONGO_METHOD_LIST_COLLECTIONS,
        MONGO_METHOD_FIND_DOCUMENTS,
        MONGO_METHOD_INSERT_DOCUMENT,
        MONGO_METHOD_UPDATE_DOCUMENT,
        MONGO_METHOD_DELETE_DOCUMENT
    ));

    public static final List<String> KV_METHODS = Collections.unmodifiableList(Arrays.asList(
        KV_METHOD_LIST_PREFIX,
        KV_METHOD_GET,
        KV_METHOD_PUT,
        KV_METHOD_DELETE
    ));

    private AgentProtocol() {
    }

    public static HandshakeResult handshakeResult() {
        return new HandshakeResult(PROTOCOL_VERSION, PROTOCOL_VERSION, CAPABILITIES);
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
