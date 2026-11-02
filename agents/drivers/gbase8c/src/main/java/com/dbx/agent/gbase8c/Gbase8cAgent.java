package com.dbx.agent.gbase8c;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * 南大通用 GBase 8c Agent。
 *
 * <p>GBase 8c 的内核是 openGauss（PostgreSQL 9.2 世代），元数据本可以手写
 * {@code pg_catalog} 查询，但真机实测 {@code JOIN LATERAL} 不支持、
 * {@code pg_catalog.to_regclass} 不存在，两者分别打死 {@code PostgresLikeAgent}
 * 的三条热路径（primaryKeys / listIndexes / listForeignKeys）与视图源码，所以这里走
 * 厂商 JDBC 驱动的 {@link java.sql.DatabaseMetaData}（{@link ConfiguredJdbcAgent} 路线）。
 *
 * <p>厂商驱动必须由用户自备：{@code jdbc:gbase8c://} + {@code com.gbase8c.Driver}
 * 是其唯一入口（它拒绝 {@code jdbc:postgresql://}），而该 jar 不在任何公开 Maven 仓库。
 */
public final class Gbase8cAgent extends ConfiguredJdbcAgent {
    /**
     * GBase 8c 自带的系统 schema。
     *
     * <p>实测 {@code getSchemas()} 会返回 19 个 schema，其中 17 个是 openGauss/GaussDB
     * 内部使用的；只有 {@code public} 与用户自己建的 schema 才用户可见。名单必须大写，
     * 因为 {@code StandardJdbcMetadata} 用 {@code name.toUpperCase(Locale.ROOT)} 比对。
     */
    static final Set<String> GBASE8C_EXCLUDED_SCHEMAS = Set.of(
        "AUDITADMIN",
        "AUDITUSER",
        "BLOCKCHAIN",
        "COVERAGE",
        "CSTORE",
        "DB4AI",
        "DBE_PERF",
        "DBE_PLDEBUGGER",
        "DBE_PLDEVELOPER",
        "DBE_SQL_UTIL",
        "INFORMATION_SCHEMA",
        "PG_CATALOG",
        "PKG_SERVICE",
        "SECURITYADMIN",
        "SNAPSHOT",
        "SQLADVISOR",
        "SYSADMIN"
    );

    /**
     * 只向驱动索取 TABLE / VIEW。
     *
     * <p>{@link JdbcAgentProfile} 的默认白名单含 {@code SYSTEM TABLE} 与 {@code SYSTEM VIEW}，
     * 而厂商驱动确实会交出来：实测跨 schema 共 531 个对象，其中 331 个是系统对象
     * （{@code pg_catalog.gs_*}、{@code information_schema.sql_*}）。驱动遵守 types 参数
     * （只传 {@code TABLE}/{@code VIEW} 时索引行与系统对象都不出现），所以收窄白名单即可，
     * 不需要覆写 {@code listTables}。
     */
    static final List<String> GBASE8C_TABLE_TYPES = List.of("TABLE", "VIEW");

    /**
     * 库列表必须自己查。
     *
     * <p>继承路径是 {@code StandardJdbcMetadata.listDatabases} 的
     * {@code conn.getMetaData().getCatalogs()}，而厂商驱动对它的实现只返回当前连接的库
     * （实测 1 行，服务器上却有 7 个库），因此改查 {@code pg_database}。
     * {@code datistemplate = false} 与 {@code PostgresLikeAgent} 保持一致。
     */
    static final String LIST_DATABASES_SQL =
        "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate = false ORDER BY datname";

    public static final JdbcAgentProfile GBASE8C_PROFILE = new JdbcAgentProfile(
        "com.gbase8c.Driver",
        "jdbc:gbase8c://{host}:{port}/{database}",
        5432,
        false,
        GBASE8C_EXCLUDED_SCHEMAS,
        GBASE8C_TABLE_TYPES,
        // 驱动自己的 getIdentifierQuoteString() 在 A/B/C/PG 四种兼容模式下都返回双引号，
        // 且实测双引号标识符四种模式都可用、反引号四种模式全部报语法错，所以这个回落值就是正解：
        // 不要把它接到 gaussdbIdentifierQuote 的 M|B|MYSQL → 反引号 映射上。
        "\"",
        "SET search_path TO",
        // 末尾四个位置参数依次是：catalogFallbackEnabled=true（驱动 getSchemas(catalog) 不可靠时
        // 回落 getSchemas(null)）、nativeTableDdlSupported=false、objectSourceSupported=false
        // （ConfiguredJdbcAgent.getObjectSource 抛 UnsupportedOperationException）、
        // triggersSupported=false。三者与 plugins/connection-types/gbase8c.yaml 的能力矩阵一致。
        true,
        false,
        false,
        false
    );

    public Gbase8cAgent() {
        super(GBASE8C_PROFILE);
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            try (PreparedStatement statement = requireConnection().prepareStatement(LIST_DATABASES_SQL);
                 ResultSet resultSet = statement.executeQuery()) {
                while (resultSet.next()) {
                    result.add(new DatabaseInfo(resultSet.getString("datname")));
                }
            }
            return result;
        });
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(Gbase8cAgent::new).run();
    }
}
