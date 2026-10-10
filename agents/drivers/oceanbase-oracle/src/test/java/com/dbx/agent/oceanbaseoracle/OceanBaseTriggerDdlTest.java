package com.dbx.agent.oceanbaseoracle;

import java.sql.SQLException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class OceanBaseTriggerDdlTest {
    @Test
    void preservesQuotedIdentifiersCommentsWhenAndFullBody() throws Exception {
        String body = "\nREFERENCING NEW AS n OLD AS o\nFOR EACH ROW WHEN (n.id > 0)\nBEGIN\n"
            + "  INSERT INTO logs VALUES ('ON t; TRIGGER audit');\n  :n.id := :o.id;\nEND;";
        String source = "CREATE /* TRIGGER fake ON fake */ OR REPLACE TRIGGER \"Tr\"\"g\" BEFORE UPDATE OF \"ON\" ON \"Ta\"\"ble\"" + body;
        String ddl = OceanBaseTriggerDdl.render(source, "Other", "Tr\"g", "Mixed", "Ta\"ble", "DISABLED");
        Assertions.assertTrue(ddl.contains("TRIGGER \"Other\".\"Tr\"\"g\" BEFORE UPDATE OF \"ON\" ON \"Mixed\".\"Ta\"\"ble\"" + body), ddl);
        Assertions.assertTrue(ddl.endsWith("\n/\nALTER TRIGGER \"Other\".\"Tr\"\"g\" DISABLE;"), ddl);
    }

    @ParameterizedTest
    @ValueSource(strings = {"ENABLE", "ENABLED", "DISABLE", "DISABLED"})
    void acceptsDocumentedAndObservedStatusSpellings(String status) throws Exception {
        String ddl = OceanBaseTriggerDdl.render("CREATE TRIGGER app.audit AFTER INSERT ON app.t BEGIN NULL; END;\n/", "APP", "AUDIT", "APP", "T", status);
        Assertions.assertTrue(ddl.endsWith(status.startsWith("ENABLE") ? "ENABLE;" : "DISABLE;"), ddl);
        Assertions.assertEquals(1, ddl.split("\n/\n", -1).length - 1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "UNKNOWN"})
    void rejectsUnknownEnableState(String status) {
        Assertions.assertThrows(SQLException.class, () -> OceanBaseTriggerDdl.render(
            "CREATE TRIGGER audit BEFORE INSERT ON t BEGIN NULL; END;", "APP", "AUDIT", "APP", "T", status));
    }

    @ParameterizedTest
    @ValueSource(strings = {"CREATE TRIGGER other.audit BEFORE INSERT ON app.t BEGIN NULL; END;",
        "CREATE TRIGGER audit BEFORE INSERT ON other.t BEGIN NULL; END;", "BEGIN NULL; END;"})
    void refusesMismatchedOrIncompleteSource(String source) {
        Assertions.assertThrows(SQLException.class, () -> OceanBaseTriggerDdl.render(source, "APP", "AUDIT", "APP", "T", "ENABLED"));
    }
}
