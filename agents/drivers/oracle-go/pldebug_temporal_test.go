package main

import "testing"

func TestPLDebugNativeTemporalExactCalendarComponents(t *testing.T) {
	for _, test := range []struct {
		text      string
		timestamp bool
		seconds   string
	}{
		{"1970-01-01T00:00:00", false, "0"},
		{"1969-12-31T23:59:59.999999999", true, "86399.999999999"},
		{"1970-01-01T00:00:00.000000001", true, "0.000000001"},
		{"0001-01-01T00:00:00", false, "0"},
		{"9999-12-31T23:59:59.123456789", true, "86399.123456789"},
		{"2000-02-29T00:00:00", false, "0"},
	} {
		got, err := plDebugNativeTemporalComponents(test.text, test.timestamp)
		if err != nil || got.seconds != test.seconds || got.day != test.text[:10] {
			t.Errorf("%s: %+v, %v", test.text, got, err)
		}
	}
	for _, text := range []string{"0000-01-01T00:00:00", "1900-02-29T00:00:00", "2024-02-30T00:00:00", "2024-00-01T00:00:00", "2024-01-01T24:00:00", "2024-01-01T00:60:00", "2024-01-01T00:00:60", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00.1234567890"} {
		if _, err := plDebugNativeTemporal(text, true); err == nil {
			t.Errorf("invalid wall clock accepted: %s", text)
		}
	}
	if _, err := plDebugNativeTemporal("2024-01-01T00:00:00.1", false); err == nil {
		t.Fatal("DATE accepted fractional seconds")
	}
}
