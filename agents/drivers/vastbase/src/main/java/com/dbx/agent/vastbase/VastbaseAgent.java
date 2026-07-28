package com.dbx.agent.vastbase;

import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.PostgresLikeAgent;
import com.dbx.agent.PostgresLikeAgentProfile;

public final class VastbaseAgent extends PostgresLikeAgent {
    public static final PostgresLikeAgentProfile VASTBASE_PROFILE = new PostgresLikeAgentProfile(
        "cn.com.vastbase.Driver",
        "jdbc:vastbase://{host}:{port}/{database}"
    );

    public VastbaseAgent() {
        super(VASTBASE_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(VastbaseAgent::new).run();
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        ObjectSource result = super.getObjectSource(schema, name, objectType);
        String source = unwrapRecordText(result.getSource());
        return new ObjectSource(result.getName(), result.getObject_type(), result.getSchema(), source);
    }

    /**
     * Vastbase 的 pg_get_functiondef 在 SQL Server 兼容模式下返回的是
     * PostgreSQL 行记录文本格式 {@code (1,"source text")} 而非纯文本。
     * 此方法剥离行记录包装，提取实际的源码内容。
     */
    static String unwrapRecordText(String source) {
        if (source == null || source.isEmpty()) {
            return source;
        }
        String trimmed = source.trim();
        if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
            return source;
        }
        // 格式: (field1,field2,...)，第一个字段通常是整数，第二个是源码文本
        String inner = trimmed.substring(1, trimmed.length() - 1);
        int commaIdx = inner.indexOf(',');
        if (commaIdx <= 0) {
            // 单字段行记录: (source_text)
            return unquoteRecordField(inner);
        }
        // 多字段行记录: 跳过第一个字段，提取第二个字段及之后的内容
        String rest = inner.substring(commaIdx + 1);
        return unquoteRecordField(rest);
    }

    private static String unquoteRecordField(String value) {
        String trimmed = value.trim();
        if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            return trimmed.substring(1, trimmed.length() - 1).replace("\"\"", "\"");
        }
        return trimmed;
    }
}
