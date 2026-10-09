package com.dbx.agent.sundb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.MultiSessionJsonRpcServer;

/**
 * 科蓝 SUNDB Agent。
 *
 * <p>SUNDB 不是 MySQL 兼容库：服务端会以 16062（SQLState 42000）拒绝
 * {@code SHOW DATABASES}、{@code SHOW INDEX} 这类 MySQL 专有语句，因此元数据
 * 统一交给厂商 JDBC 驱动实现的 {@link java.sql.DatabaseMetaData}（驱动内部使用
 * SUNDB 的 {@code INFORMATION_SCHEMA.DBC_*} 视图）读取，不再手写 MySQL 风格的
 * information_schema 查询。schema 切换沿用驱动的 {@code SET SCHEMA}。
 */
public final class SundbAgent extends ConfiguredJdbcAgent {
    /** 默认端口与 plugins/connection-types/sundb.yaml 的 defaultPort 保持一致。 */
    public static final JdbcAgentProfile SUNDB_PROFILE = new JdbcAgentProfile(
        "csii.sundb.jdbc.SundbDriver",
        "jdbc:sundb://{host}:{port}/{database}",
        22581
    );

    public SundbAgent() {
        super(SUNDB_PROFILE);
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(SundbAgent::new).run();
    }
}
