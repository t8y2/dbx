package com.dbx.agent;

import com.google.gson.Gson;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class TriggerInfoTest {
    @Test
    void legacyAndNullOwnersRemainUnknown() {
        Gson gson = new Gson();
        for (String json : new String[]{
            "{\"name\":\"AUDIT\",\"event\":\"INSERT\",\"timing\":\"AFTER\"}",
            "{\"name\":\"AUDIT\",\"owner\":null,\"event\":\"INSERT\",\"timing\":\"AFTER\"}"
        }) {
            TriggerInfo trigger = gson.fromJson(json, TriggerInfo.class);
            assertNull(trigger.getOwner());
            assertFalse(gson.toJsonTree(trigger).getAsJsonObject().has("owner"));
        }
        assertNull(new TriggerInfo("AUDIT", "INSERT", "AFTER").getOwner());
    }

    @Test
    void catalogOwnerRoundTripsAndParticipatesInIdentity() {
        Gson gson = new Gson();
        TriggerInfo trigger = new TriggerInfo("AUDIT", "INSERT", "AFTER", "Other\"Owner");
        assertEquals(trigger, gson.fromJson(gson.toJson(trigger), TriggerInfo.class));
        assertNotEquals(trigger, new TriggerInfo("AUDIT", "INSERT", "AFTER", "APP"));
    }
}
