package com.dbx.agent.oscar;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.Locale;

/**
 * 神通 OSCAR v7 agent。
 *
 * <p>神通是 Oracle 兼容的国产数据库，系统视图（ALL_VIEWS/ALL_SOURCE/ALL_TRIGGERS/ALL_SEQUENCES 等）
 * 与 Oracle 基本一致，但有两处关键差异（实测 v7.0.8，见 issue #5505）：
 * <ul>
 *   <li>{@code DBMS_METADATA.GET_DDL} 不可用（"Namespace DBMS_METADATA does not exist"），
 *       故视图/过程/函数/触发器源码改用 ALL_VIEWS.TEXT、ALL_SOURCE.TEXT、ALL_TRIGGERS.TRIGGER_BODY 读取。</li>
 *   <li>{@code SET SCHEMA "x"} 与 {@code ALTER SESSION SET CURRENT_SCHEMA} 均不被 parser 接受，
 *       schema 切换改用 PG 风格的 {@code SET SEARCH_PATH TO "x"}（已验证可用，且不影响 ALL_* 视图的 OWNER 过滤）。</li>
 * </ul>
 *
 * <p>建表/表结构编辑由 DBX 核心的 Oracle 方言 SQL 生成器负责（神通实测支持 ALTER TABLE
 * ADD/MODIFY/DROP/RENAME COLUMN、DROP/ADD PRIMARY KEY、COMMENT ON、CREATE/DROP INDEX），
 * 本 agent 仅需提供元数据（继承 ConfiguredJdbcAgent 的标准 JDBC metadata）与对象源码。
 */
public final class OscarAgent extends ConfiguredJdbcAgent {
    public static final JdbcAgentProfile OSCAR_PROFILE = new JdbcAgentProfile(
        "com.oscar.Driver",
        "jdbc:oscar://{host}:{port}/{database}",
        2003
    );

    public OscarAgent() {
        super(OSCAR_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(OscarAgent::new).run();
    }

    /**
     * 神通用 {@code SET SEARCH_PATH TO "schema"} 切换默认 schema（PG 风格），
     * 不支持 Oracle 的 {@code ALTER SESSION SET CURRENT_SCHEMA} 或 Dameng 的 {@code SET SCHEMA "x"}。
     * 切换后 ALL_* 视图仍按 OWNER 正确过滤，不影响 owner 语义。
     */
    @Override
    public String setSchemaSQL(String schema) {
        if (schema == null || schema.trim().isEmpty()) {
            return "";
        }
        return "SET SEARCH_PATH TO " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    /**
     * 读取视图/过程/函数/触发器/序列等对象的 DDL 源码。
     *
     * <p>神通不支持 DBMS_METADATA.GET_DDL，按对象类型走对应系统视图：
     * <ul>
     *   <li>VIEW → ALL_VIEWS.TEXT（返回完整 SELECT 语句）</li>
     *   <li>PROCEDURE/FUNCTION/PACKAGE/PACKAGE_BODY/TYPE/TYPE_BODY → ALL_SOURCE.TEXT 按 LINE 排序拼接</li>
     *   <li>TRIGGER → ALL_TRIGGERS.TRIGGER_BODY</li>
     *   <li>SEQUENCE → 由 ALL_SEQUENCES 元数据重建 CREATE SEQUENCE 语句</li>
     *   <li>MATERIALIZED_VIEW → 神通无 ALL_MVIEWS，返回空源码且不可编辑</li>
     * </ul>
     */
    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String type = objectType == null ? "" : objectType.trim().toUpperCase(Locale.ROOT);
        return unchecked(() -> {
            String source = switch (type) {
                case "VIEW" -> readViewSource(schema, name);
                case "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY" -> readSourceText(schema, name, type);
                case "TRIGGER" -> readTriggerSource(schema, name);
                case "SEQUENCE" -> readSequenceSource(schema, name);
                // 神通 v7 无物化视图系统视图（ALL_MVIEWS 不存在）；返回空源码，标记不可编辑，避免 UI 误判为可改。
                case "MATERIALIZED_VIEW" -> "";
                default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
            };
            boolean editable = !"MATERIALIZED_VIEW".equals(type);
            return new ObjectSource(name, objectType, schema, source, editable);
        });
    }

    private String readViewSource(String schema, String name) throws Exception {
        // ALL_VIEWS.TEXT 已包含完整视图定义（神通实测返回带 schema 限定的 SELECT 语句）。
        String sql = "SELECT TEXT FROM ALL_VIEWS WHERE OWNER = ? AND VIEW_NAME = ?";
        return scalarText(sql, schema, name);
    }

    private String readSourceText(String schema, String name, String type) throws Exception {
        // ALL_SOURCE 按 LINE 存储过程/函数/包/类型的源码行，需按 LINE 排序拼接。
        // 神通与 Oracle 的关键差异（实测 v7.0.8）：function 也以 TYPE='PROCEDURE' 存储（不区分 FUNCTION），
        // 包体随包一起存为 TYPE='PACKAGE'，类型体随类型存为 TYPE='TYPE'。故按 objectType 归并到实际 TYPE 值。
        String sourceType = switch (type) {
            case "PROCEDURE", "FUNCTION" -> "PROCEDURE";
            case "PACKAGE", "PACKAGE_BODY" -> "PACKAGE";
            case "TYPE", "TYPE_BODY" -> "TYPE";
            default -> type;
        };
        String sql = "SELECT TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = ? ORDER BY LINE";
        StringBuilder sb = new StringBuilder();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, name);
            stmt.setString(3, sourceType);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String line = rs.getString(1);
                    if (line != null) {
                        sb.append(line);
                    }
                }
            }
        }
        return sb.toString();
    }

    private String readTriggerSource(String schema, String name) throws Exception {
        String sql = "SELECT TRIGGER_BODY FROM ALL_TRIGGERS WHERE OWNER = ? AND TRIGGER_NAME = ?";
        return scalarText(sql, schema, name);
    }

    private String readSequenceSource(String schema, String name) throws Exception {
        // 神通无 DBMS_METADATA，序列源码由 ALL_SEQUENCES 元数据重建为 CREATE SEQUENCE 语句。
        String sql = "SELECT MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE "
            + "FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = ? AND SEQUENCE_NAME = ?";
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, name);
            try (ResultSet rs = stmt.executeQuery()) {
                if (!rs.next()) {
                    return "";
                }
                String ref = JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(name);
                StringBuilder sb = new StringBuilder("CREATE SEQUENCE ").append(ref);
                String minValue = rs.getString("MIN_VALUE");
                String maxValue = rs.getString("MAX_VALUE");
                String increment = rs.getString("INCREMENT_BY");
                if (increment != null && !"1".equals(increment.trim())) {
                    sb.append(" INCREMENT BY ").append(increment.trim());
                }
                if (minValue != null && !"1".equals(minValue.trim())) {
                    sb.append(" MINVALUE ").append(minValue.trim());
                }
                if (maxValue != null) {
                    sb.append(" MAXVALUE ").append(maxValue.trim());
                }
                String cache = rs.getString("CACHE_SIZE");
                if (cache != null && !"0".equals(cache.trim())) {
                    sb.append(" CACHE ").append(cache.trim());
                } else {
                    sb.append(" NOCACHE");
                }
                if ("Y".equalsIgnoreCase(rs.getString("CYCLE_FLAG"))) {
                    sb.append(" CYCLE");
                } else {
                    sb.append(" NOCYCLE");
                }
                if ("Y".equalsIgnoreCase(rs.getString("ORDER_FLAG"))) {
                    sb.append(" ORDER");
                } else {
                    sb.append(" NOORDER");
                }
                sb.append(";");
                return sb.toString();
            }
        }
    }

    /** 读取单行单列文本值（视图/触发器源码），空结果返回空串。 */
    private String scalarText(String sql, String schema, String name) throws Exception {
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, name);
            try (ResultSet rs = stmt.executeQuery()) {
                if (!rs.next()) {
                    return "";
                }
                String value = rs.getString(1);
                return value == null ? "" : value;
            }
        }
    }
}
