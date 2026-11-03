package com.dbx.agent.gbase8c;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * 对真实 GBase 8c 实例跑的端到端冒烟，覆盖「本 Agent 相对基类新增/覆写的每一处」。
 *
 * <p>需要环境变量 {@code DBX_TEST_GBASE8C_URL}（完整 {@code jdbc:gbase8c://…} URL）、
 * {@code DBX_TEST_GBASE8C_USER}、{@code DBX_TEST_GBASE8C_PASSWORD}；可选
 * {@code DBX_TEST_GBASE8C_SCHEMA}（默认 {@code public}）与
 * {@code DBX_TEST_GBASE8C_DATABASE}（默认 {@code postgres}）。
 *
 * <p>依赖：厂商 JDBC 驱动必须能从 classpath 解析（放到
 * {@code agents/drivers/gbase8c/libs/} 即可，该目录被 {@code agents/.gitignore} 忽略）。
 * 环境变量缺失时整个用例被跳过，与 {@code gbase8s/Gbase8sCharacterTypesLiveTest} 一致。
 */
class Gbase8cAgentLiveTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_TEST_GBASE8C_URL", matches = ".+")
    void drivesMetadataQueryAndSchemaSwitchingAgainstALiveServer() throws Exception {
        String schema = envOr("DBX_TEST_GBASE8C_SCHEMA", "public");
        String suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
        String parent = "dbx_g8c_parent_" + suffix;
        String child = "dbx_g8c_child_" + suffix;
        Gbase8cAgent agent = new Gbase8cAgent();
        agent.connect(new ConnectParams(
            "",
            0,
            envOr("DBX_TEST_GBASE8C_DATABASE", "postgres"),
            System.getenv("DBX_TEST_GBASE8C_USER"),
            System.getenv("DBX_TEST_GBASE8C_PASSWORD"),
            "",
            System.getenv("DBX_TEST_GBASE8C_URL"),
            false
        ));
        List<String> created = new ArrayList<>();
        try (Statement statement = agent.getConnection().createStatement()) {
            try {
                statement.execute("CREATE TABLE " + schema + "." + parent + " (id int PRIMARY KEY, name varchar(20) NOT NULL)");
                created.add(parent);
                statement.execute("CREATE TABLE " + schema + "." + child
                    + " (cid int PRIMARY KEY, pid int REFERENCES " + schema + "." + parent + " (id))");
                created.add(child);
                statement.execute("INSERT INTO " + schema + "." + parent + " VALUES (1, 'one'), (2, 'two')");
                statement.execute("COMMENT ON TABLE " + schema + "." + parent + " IS 'smoke table'");

                // 1. 库列表：驱动的 getCatalogs() 只返回当前库，必须由 listDatabases 覆写改查 pg_database。
                List<String> databases = agent.listDatabases().stream().map(DatabaseInfo::getName).toList();
                Assertions.assertTrue(databases.size() > 1, "expected every database, got " + databases);
                Assertions.assertTrue(databases.contains("postgres"), databases.toString());

                // 2. schema 列表：openGauss 自带的系统 schema 必须被 excludedSchemas 过滤掉。
                List<String> schemas = agent.listSchemas();
                Assertions.assertTrue(schemas.contains(schema), schemas.toString());
                for (String hidden : List.of("dbe_perf", "cstore", "db4ai", "sqladvisor", "pkg_service", "snapshot")) {
                    Assertions.assertFalse(
                        schemas.stream().anyMatch(name -> name.equalsIgnoreCase(hidden)),
                        "system schema leaked: " + hidden + " in " + schemas
                    );
                }

                // 3. 表列表：tableTypes 白名单必须把系统对象与索引行挡在外面（默认白名单会多出 331 行）。
                List<TableInfo> tables = agent.listTables(schema);
                List<String> names = tables.stream().map(TableInfo::getName).toList();
                Assertions.assertTrue(names.contains(parent) && names.contains(child), names.toString());
                Set<String> types = tables.stream().map(TableInfo::getTable_type).collect(Collectors.toSet());
                Assertions.assertTrue(
                    types.stream().allMatch(type -> "TABLE".equals(type) || "VIEW".equals(type)),
                    "unexpected table types: " + types
                );
                Assertions.assertTrue(
                    tables.stream().noneMatch(table -> table.getName().startsWith("gs_") || table.getName().startsWith("sql_")),
                    "system object leaked: " + names
                );
                Assertions.assertTrue(
                    tables.stream().filter(table -> table.getName().equals(parent)).findFirst().orElseThrow()
                        .getComment().contains("smoke table"),
                    "table comment should come back through REMARKS"
                );

                // 4. 列 / 主键 / 索引 / 外键
                List<ColumnInfo> columns = agent.getColumns(schema, parent);
                Assertions.assertEquals(List.of("id", "name"), columns.stream().map(ColumnInfo::getName).toList());
                Assertions.assertTrue(
                    columns.stream().filter(column -> column.getName().equals("id")).findFirst().orElseThrow()
                        .getIs_primary_key(),
                    "id should be reported as a primary key column"
                );
                List<IndexInfo> indexes = agent.listIndexes(schema, parent);
                // 实测：厂商驱动的 getIndexInfo 把主键索引报成普通唯一索引（is_primary=false），
                // 与 getPrimaryKeys 的 PK_NAME 对不上；主键本身由 columns 的 is_primary_key 报告，
                // 上面已断言。所以这里只断言索引与它的列确实被列出来。
                IndexInfo primaryKeyIndex = indexes.stream()
                    .filter(index -> index.getName().equals(parent + "_pkey"))
                    .findFirst()
                    .orElseThrow(() -> new AssertionError("primary key index missing: " + indexes));
                Assertions.assertEquals(List.of("id"), primaryKeyIndex.getColumns(), indexes.toString());
                Assertions.assertTrue(primaryKeyIndex.getIs_unique(), indexes.toString());
                List<ForeignKeyInfo> foreignKeys = agent.listForeignKeys(schema, child);
                Assertions.assertEquals(1, foreignKeys.size(), foreignKeys.toString());
                Assertions.assertEquals(parent, foreignKeys.get(0).getRef_table(), foreignKeys.toString());

                // 5. 标识符引号与 schema 切换：实测 A/B/C/PG 四种兼容模式都是双引号 + SET search_path。
                Assertions.assertEquals("SET search_path TO \"" + schema + "\"", agent.setSchemaSQL(schema));
                Assertions.assertEquals("\"", agent.getIdentifierQuote());

                // 6. 查询执行
                QueryResult result = agent.executeQuery(
                    "SELECT id, name FROM " + schema + "." + parent + " ORDER BY id",
                    null,
                    new ExecuteQueryOptions()
                );
                Assertions.assertEquals(List.of("id", "name"), result.getColumns());
                Assertions.assertEquals(2, result.getRows().size(), result.getRows().toString());

                // 7. 对象列表（ConfiguredJdbcAgent 路径，objectSource 关闭不影响对象浏览）
                List<ObjectInfo> objects = agent.listObjects(schema);
                Assertions.assertTrue(
                    objects.stream().anyMatch(object -> object.getName().equals(parent)),
                    objects.toString()
                );

                // 8. 数据网格的写入路径：capabilities.tableDataEdit 走 executeTransaction
                //    （显式事务 + Statement.executeUpdate）。实测驱动 supportsTransactions()=true，
                //    三条 DML 共用一次提交，返回累计受影响行数（UPDATE 1 + DELETE 0 + INSERT 1）。
                QueryResult write = agent.executeTransaction(
                    List.of(
                        "UPDATE " + schema + "." + parent + " SET name = 'one-updated' WHERE id = 1",
                        "DELETE FROM " + schema + "." + child + " WHERE cid = 99",
                        "INSERT INTO " + schema + "." + child + " VALUES (10, 1)"
                    ),
                    schema
                );
                Assertions.assertEquals(2, write.getAffected_rows(), "update + insert should report 2 affected rows");

                QueryResult reread = agent.executeQuery(
                    "SELECT count(*) FROM " + schema + "." + child,
                    null,
                    new ExecuteQueryOptions()
                );
                Assertions.assertEquals("1", String.valueOf(reread.getRows().get(0).get(0)), reread.getRows().toString());
            } finally {
                Collections.reverse(created);
                for (String name : created) {
                    try (Statement cleanup = agent.getConnection().createStatement()) {
                        cleanup.execute("DROP TABLE IF EXISTS " + schema + "." + name + " CASCADE");
                    } catch (Exception ignored) {
                        // Best-effort cleanup: the smoke database is disposable.
                    }
                }
            }
        } finally {
            agent.disconnect();
        }
    }

    private static String envOr(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
