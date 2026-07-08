package com.dbx.agent.kafka;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class KafkaAgentTest {
    @Test
    void normalizesPeekOffsetToEarliestAvailableOffset() {
        assertEquals(5L, KafkaAgent.normalizePeekOffset(0, 5, 10));
    }

    @Test
    void normalizesNegativePeekOffsetToEarliestAvailableOffset() {
        assertEquals(0L, KafkaAgent.normalizePeekOffset(-1, 0, 10));
    }

    @Test
    void keepsPeekOffsetWhenItIsWithinAvailableRange() {
        assertEquals(7L, KafkaAgent.normalizePeekOffset(7, 5, 10));
    }

    @Test
    void returnsNoSeekOffsetWhenRequestedOffsetIsAtOrAfterEnd() {
        assertNull(KafkaAgent.normalizePeekOffset(10, 5, 10));
    }

    @Test
    void returnsNoSeekOffsetWhenTopicHasNoReadableMessages() {
        assertNull(KafkaAgent.normalizePeekOffset(0, 5, 5));
    }
}
