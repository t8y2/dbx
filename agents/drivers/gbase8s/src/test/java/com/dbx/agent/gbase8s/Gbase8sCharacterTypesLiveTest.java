package com.dbx.agent.gbase8s;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

class Gbase8sCharacterTypesLiveTest {
    @Test
    @EnabledIfEnvironmentVariable(named = "DBX_TEST_GBASE8S_URL", matches = ".+")
    void characterColumnDdlReplaysWithTheSameTypesLengthsAndNullability() throws Exception {
        String source = "dbx_char_" + UUID.randomUUID().toString().replace("-", "");
        String target = source + "_copy";
        Gbase8sAgent agent = new Gbase8sAgent();
        agent.connect(new ConnectParams(
            "", 0, "", System.getenv("DBX_TEST_GBASE8S_USER"), System.getenv("DBX_TEST_GBASE8S_PASSWORD"),
            "", System.getenv("DBX_TEST_GBASE8S_URL"), false
        ));
        List<String> createdTables = new ArrayList<>();
        try (Statement statement = agent.getConnection().createStatement()) {
            try {
                statement.execute("CREATE TABLE " + source + " (payload VARCHAR2(1024), required VARCHAR2(4096) NOT NULL, "
                    + "national NVARCHAR2(64), required_national NVARCHAR2(128) NOT NULL)");
                createdTables.add(source);
                String ddl = agent.getTableDdl("", source);
                Assertions.assertFalse(ddl.contains("UNKNOWN("), ddl);
                Assertions.assertTrue(ddl.contains("VARCHAR2(1024)"), ddl);
                Assertions.assertTrue(ddl.contains("NVARCHAR2(128) NOT NULL"), ddl);
                statement.execute(ddl.replace(source, target));
                createdTables.add(target);
                statement.execute("INSERT INTO " + target + " VALUES ('channel', 'required-value', 'national-value', 'required-national')");
                try (ResultSet rows = statement.executeQuery("SELECT payload, national FROM " + target)) {
                    Assertions.assertTrue(rows.next());
                    Assertions.assertEquals("channel", rows.getString(1));
                    Assertions.assertEquals("national-value", rows.getString(2));
                    Assertions.assertFalse(rows.next());
                }
                List<ColumnInfo> original = agent.getColumns("", source);
                List<ColumnInfo> replayed = agent.getColumns("", target);
                Assertions.assertEquals(List.of("VARCHAR2", "VARCHAR2", "NVARCHAR2", "NVARCHAR2"),
                    original.stream().map(ColumnInfo::getData_type).toList());
                Assertions.assertEquals(List.of(1024, 4096, 64, 128),
                    original.stream().map(ColumnInfo::getCharacter_maximum_length).toList());
                Assertions.assertEquals(original.stream().map(ColumnInfo::getData_type).toList(),
                    replayed.stream().map(ColumnInfo::getData_type).toList());
                Assertions.assertEquals(original.stream().map(ColumnInfo::getCharacter_maximum_length).toList(),
                    replayed.stream().map(ColumnInfo::getCharacter_maximum_length).toList());
                Assertions.assertEquals(List.of(true, false, true, false),
                    replayed.stream().map(ColumnInfo::getIs_nullable).toList());
            } finally {
                Collections.reverse(createdTables);
                for (String name : createdTables) statement.execute("DROP TABLE " + name);
            }
        } finally {
            agent.disconnect();
        }
    }
}
