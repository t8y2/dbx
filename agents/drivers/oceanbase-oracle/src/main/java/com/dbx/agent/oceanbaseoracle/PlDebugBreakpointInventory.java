package com.dbx.agent.oceanbaseoracle;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Pattern;

/** Verified record boundaries in OB's documented, unescaped breakpoint listing. */
final class PlDebugBreakpointInventory {
    static final String EMPTY = "=+=+ No breakpoint listing available +=+=";

    record Program(String owner, String name, int namespace, int line) {}
    record Entry(int number, Program program, String text, boolean enabled) {}

    private final String raw;
    private final List<Entry> entries;

    private PlDebugBreakpointInventory(String raw, List<Entry> entries) {
        this.raw = raw;
        this.entries = List.copyOf(entries);
    }

    static PlDebugBreakpointInventory empty(String listing) {
        if (!EMPTY.equals(listing)) throw new IllegalStateException("The original breakpoint inventory is not confirmed empty");
        return new PlDebugBreakpointInventory(listing, List.of());
    }

    String raw() { return raw; }
    List<Entry> entries() { return entries; }

    void requireCurrent(String listing) {
        if (!raw.equals(listing)) throw new IllegalStateException("The native breakpoint inventory changed outside the original operation");
    }

    Entry entry(int number) {
        return entries.stream().filter(entry -> entry.number() == number).findFirst()
            .orElseThrow(() -> new IllegalStateException("The native breakpoint number has no confirmed registration"));
    }

    PlDebugBreakpointInventory confirmSet(Program program, int number, String listing) {
        if (number <= 0) throw new IllegalStateException("The native breakpoint number was not returned");
        for (Entry entry : entries) {
            if (entry.number() == number) {
                if (!entry.program().equals(program)) throw new IllegalStateException("The native breakpoint number belongs to a different program registration");
                requireCurrent(listing);
                return this;
            }
        }
        Objects.requireNonNull(program.owner(), "A confirmed native program owner is required");
        Objects.requireNonNull(program.name(), "A confirmed native program name is required");
        String body = body(entries);
        Pattern record = activeRecord(program, number);
        int boundary = 0;
        int insertion = -1;
        String inserted = null;
        if (listing == null) throw new IllegalStateException("The native breakpoint inventory was not returned after SET");
        for (int index = 0; index <= entries.size(); index++) {
            String before = body.substring(0, boundary);
            String after = body.substring(boundary);
            if (listing.length() >= body.length() && listing.startsWith(before) && listing.endsWith(after)) {
                String candidate = listing.substring(boundary, listing.length() - after.length());
                if (record.matcher(candidate).matches()) {
                    if (insertion >= 0) throw new IllegalStateException("The native breakpoint insertion has multiple complete matches");
                    insertion = index;
                    inserted = candidate;
                }
            }
            if (index < entries.size()) boundary += entries.get(index).text().length();
        }
        if (insertion < 0) throw new IllegalStateException("The native breakpoint insertion could not be confirmed without changing the existing inventory");
        List<Entry> updated = new ArrayList<>(entries);
        updated.add(insertion, new Entry(number, program, inserted, true));
        return new PlDebugBreakpointInventory(listing, updated);
    }

    PlDebugBreakpointInventory confirmDelete(int number, String listing) {
        Entry original = entry(number);
        List<Entry> updated = new ArrayList<>(entries);
        updated.remove(original);
        requireExpected(updated, listing);
        return new PlDebugBreakpointInventory(listing, updated);
    }

    PlDebugBreakpointInventory confirmEnabled(int number, boolean enabled, String listing) {
        Entry original = entry(number);
        String suffix = original.enabled() ? " \n" : " Disabled.\n";
        String text = original.text().substring(0, original.text().length() - suffix.length())
            + (enabled ? " \n" : " Disabled.\n");
        List<Entry> updated = new ArrayList<>(entries);
        updated.set(updated.indexOf(original), new Entry(number, original.program(), text, enabled));
        requireExpected(updated, listing);
        return new PlDebugBreakpointInventory(listing, updated);
    }

    private static void requireExpected(List<Entry> entries, String listing) {
        String expected = entries.isEmpty() ? EMPTY : body(entries);
        if (!expected.equals(listing)) throw new IllegalStateException("The native breakpoint mutation did not preserve the complete expected inventory");
    }

    private static String body(List<Entry> entries) {
        StringBuilder text = new StringBuilder();
        for (Entry entry : entries) text.append(entry.text());
        return text.toString();
    }

    private static Pattern activeRecord(Program program, int number) {
        String prefix = String.format(Locale.ROOT, "%3d. ", number) + program.owner() + "." + program.name()
            + ", Line " + program.line() + " [offset (";
        String integer = "[ \\t]*[+-]?[0-9]+";
        return Pattern.compile("\\A" + Pattern.quote(prefix) + integer + "," + integer + "\\),"
            + integer + "\\] \\n\\z");
    }
}
