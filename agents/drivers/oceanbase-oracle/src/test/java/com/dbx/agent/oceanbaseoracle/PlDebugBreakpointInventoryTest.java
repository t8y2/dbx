package com.dbx.agent.oceanbaseoracle;

import org.junit.jupiter.api.Test;
import java.util.Locale;
import static org.junit.jupiter.api.Assertions.*;

class PlDebugBreakpointInventoryTest {
    private static final PlDebugBreakpointInventory.Program ROOT =
        new PlDebugBreakpointInventory.Program("SYS", "__anonymous_block__", 1, 12);

    private static String record(int number, PlDebugBreakpointInventory.Program program) {
        return String.format(Locale.ROOT, "%3d. ", number) + program.owner() + "." + program.name()
            + ", Line " + program.line() + " [offset (\t0,  0),  0] \n";
    }

    @Test
    void confirmsTheObservedNativeLifecycleWithoutReinterpretingObjectNames() {
        var empty = PlDebugBreakpointInventory.empty(PlDebugBreakpointInventory.EMPTY);
        String first = record(1, ROOT);
        var created = empty.confirmSet(ROOT, 1, first);
        assertEquals(0, empty.entries().size());
        assertEquals(first, created.entry(1).text());
        assertSame(created, created.confirmSet(ROOT, 1, first), "Duplicate native SET must preserve the original registration");
        String disabled = first.substring(0, first.length() - 2) + " Disabled.\n";
        var paused = created.confirmEnabled(1, false, disabled);
        assertFalse(paused.entry(1).enabled());
        assertTrue(created.entry(1).enabled());
        var enabled = paused.confirmEnabled(1, true, first);
        assertTrue(enabled.entry(1).enabled());
        var deleted = enabled.confirmDelete(1, PlDebugBreakpointInventory.EMPTY);
        assertEquals(PlDebugBreakpointInventory.EMPTY, deleted.raw());
        assertTrue(deleted.entries().isEmpty());
        assertEquals(2, deleted.confirmSet(ROOT, 2, record(2, ROOT)).entry(2).number());
    }

    @Test
    void buildsBoundariesOnlyFromUniqueWholeRecordInsertions() {
        var unusual = new PlDebugBreakpointInventory.Program("Mixed.Owner", " Name\n  7. fake, Line 8 [offset (\t0,  0),  0] Disabled.\n", 2, 9);
        var last = new PlDebugBreakpointInventory.Program("O", "=+=+ No breakpoint listing available +=+=", 1, 1);
        String original = record(1234, unusual);
        String middleText = original.substring(0, original.lastIndexOf("[offset (")) + "[offset ( -21, +9),  84] \n";
        var middle = PlDebugBreakpointInventory.empty(PlDebugBreakpointInventory.EMPTY).confirmSet(unusual, 1234, middleText);
        var withFirst = middle.confirmSet(ROOT, 1, record(1, ROOT) + middleText);
        var withLast = withFirst.confirmSet(last, 50, withFirst.raw() + record(50, last));
        assertEquals(3, withLast.entries().size());
        assertEquals(unusual, withLast.entries().get(1).program());
        assertEquals(middleText, withLast.entries().get(1).text());
        var withoutMiddle = withLast.confirmDelete(1234, record(1, ROOT) + record(50, last));
        assertEquals(2, withoutMiddle.entries().size());
        assertThrows(UnsupportedOperationException.class, () -> withLast.entries().clear());
    }

    @Test
    void rejectsUnconfirmedEmptyForeignChangesAndIncompletePostWriteObservations() {
        for (String raw : new String[] {null, "", "[]", " " + PlDebugBreakpointInventory.EMPTY,
                PlDebugBreakpointInventory.EMPTY + "\n", record(1, ROOT)}) {
            assertThrows(IllegalStateException.class, () -> PlDebugBreakpointInventory.empty(raw));
        }
        var empty = PlDebugBreakpointInventory.empty(PlDebugBreakpointInventory.EMPTY);
        assertThrows(IllegalStateException.class, () -> empty.confirmSet(ROOT, 0, record(1, ROOT)));
        assertThrows(IllegalStateException.class, () -> empty.confirmSet(ROOT, 1, null));
        assertThrows(IllegalStateException.class, () -> empty.confirmSet(ROOT, 1, PlDebugBreakpointInventory.EMPTY));
        assertThrows(IllegalStateException.class, () -> empty.confirmSet(ROOT, 1, record(1, ROOT).stripTrailing()));
        var created = empty.confirmSet(ROOT, 1, record(1, ROOT));
        assertThrows(IllegalStateException.class, () -> created.requireCurrent(PlDebugBreakpointInventory.EMPTY));
        assertThrows(IllegalStateException.class, () -> created.requireCurrent(created.raw() + record(2, ROOT)));
        assertThrows(IllegalStateException.class, () -> created.confirmSet(ROOT, 2, record(2, ROOT)));
        assertThrows(IllegalStateException.class, () -> created.confirmDelete(1, ""));
        assertThrows(IllegalStateException.class, () -> created.confirmEnabled(1, false, created.raw()));
        assertThrows(IllegalStateException.class, () -> created.confirmEnabled(1, false, created.raw().replace("Line 12", "Line 13")));
        assertThrows(IllegalStateException.class, () -> created.confirmDelete(99, PlDebugBreakpointInventory.EMPTY));
    }

    @Test
    void doesNotMergeDifferentNativeIdentitiesWithTheSamePrintedName() {
        var first = new PlDebugBreakpointInventory.Program("A.B", "C", 1, 12);
        var colliding = new PlDebugBreakpointInventory.Program("A", "B.C", 1, 12);
        var created = PlDebugBreakpointInventory.empty(PlDebugBreakpointInventory.EMPTY).confirmSet(first, 1, record(1, first));
        assertEquals(record(1, first), record(1, colliding));
        assertThrows(IllegalStateException.class, () -> created.confirmSet(colliding, 1, created.raw()));
        var body = new PlDebugBreakpointInventory.Program(first.owner(), first.name(), 2, first.line());
        assertThrows(IllegalStateException.class, () -> created.confirmSet(body, 1, created.raw()));
        var separate = created.confirmSet(colliding, 2, created.raw() + record(2, colliding));
        assertEquals(first, separate.entry(1).program());
        assertEquals(colliding, separate.entry(2).program());
    }

    @Test
    void offsetMatchingCannotSwallowAnotherRecordOrAnUnexpectedStatus() {
        var empty = PlDebugBreakpointInventory.empty(PlDebugBreakpointInventory.EMPTY);
        for (String malformed : new String[] {
            record(1, ROOT).replace("(\t0,  0)", "(\n  2. Other, Line 4, 0)"),
            record(1, ROOT).replace("0]", "anything]"),
            record(1, ROOT).replace("] \n", "] Disabled.\n"),
            record(1, ROOT) + record(2, ROOT),
            record(1, ROOT).replace("Line 12", "Line 13")
        }) assertThrows(IllegalStateException.class, () -> empty.confirmSet(ROOT, 1, malformed));
    }
}
