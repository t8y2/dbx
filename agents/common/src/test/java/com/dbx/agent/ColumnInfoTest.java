package com.dbx.agent;

import com.google.gson.Gson;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class ColumnInfoTest {
    @Test
    void serializesOptionalCharacterSetAndCollationFields() {
        ColumnInfo column = new ColumnInfo(
            "name",
            "varchar(64)",
            true,
            "'guest'",
            false,
            null,
            null,
            null,
            null,
            64,
            "utf8mb4",
            "utf8mb4_bin"
        );

        String json = new Gson().toJson(column);

        Assertions.assertTrue(json.contains("\"character_set\":\"utf8mb4\""), json);
        Assertions.assertTrue(json.contains("\"collation\":\"utf8mb4_bin\""), json);
    }
}
