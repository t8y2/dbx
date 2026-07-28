package com.dbx.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class MetadataListConstraintsTest {
    @Test
    void fuzzyLikePatternKeepsBackslashAsDefaultEscapeCharacter() {
        MetadataListConstraints constraints = new MetadataListConstraints("a_%~\\", null, null, null);

        assertEquals("%a%\\_%\\%%~%\\\\%", constraints.fuzzyLikePattern());
    }

    @Test
    void fuzzyLikePatternSupportsDatabaseSpecificEscapeCharacter() {
        MetadataListConstraints constraints = new MetadataListConstraints("a_%~\\", null, null, null);

        assertEquals("%a%~_%~%%~~%\\%", constraints.fuzzyLikePattern('~'));
    }
}
