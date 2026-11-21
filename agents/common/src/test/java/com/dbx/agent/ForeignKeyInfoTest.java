package com.dbx.agent;

import com.google.gson.Gson;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ForeignKeyInfoTest {
    private final Gson gson = new Gson();

    @Test
    void legacyConstructorKeepsTheExistingJsonShape() {
        ForeignKeyInfo key = new ForeignKeyInfo("FK", "A", "PARENT", "ID");
        assertEquals(JsonParser.parseString("{\"name\":\"FK\",\"column\":\"A\",\"ref_table\":\"PARENT\",\"ref_column\":\"ID\"}"), gson.toJsonTree(key));
        ForeignKeyInfo decoded = gson.fromJson(gson.toJson(key), ForeignKeyInfo.class);
        assertEquals(key, decoded);
        assertNull(decoded.getRef_schema());
        assertNull(decoded.getOn_delete());
    }

    @Test
    void ownerAndDeleteActionSurviveJsonAndParticipateInIdentity() {
        ForeignKeyInfo key = new ForeignKeyInfo("FK", "A", "PARENT", "ID", "Mixed.Owner", "SET NULL");
        var json = gson.toJsonTree(key).getAsJsonObject();
        assertEquals("Mixed.Owner", json.get("ref_schema").getAsString());
        assertEquals("SET NULL", json.get("on_delete").getAsString());
        assertEquals(key, gson.fromJson(json, ForeignKeyInfo.class));
        assertNotEquals(key, new ForeignKeyInfo("FK", "A", "PARENT", "ID", "OTHER", "SET NULL"));
        assertNotEquals(key, new ForeignKeyInfo("FK", "A", "PARENT", "ID", "Mixed.Owner", "CASCADE"));
    }
}
