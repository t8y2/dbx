package main

import "testing"

func TestPLDebugIntervalInputPreservesNineDigitComponents(t *testing.T) {
	for _, test := range []struct {
		value, want string
		daySecond   bool
	}{
		{"-999999999-11", "-999999999-11", false}, {"1-02", "+000000001-02", false},
		{"-999999999 23:59:59.123456789", "-999999999 23:59:59.123456789", true},
		{"0 00:00:00.000000001", "+000000000 00:00:00.000000001", true},
		{"1 01:02:03", "+000000001 01:02:03.000000000", true},
	} {
		actual, err := plDebugNativeIntervalText(test.value, test.daySecond)
		if err != nil || actual != test.want {
			t.Fatalf("interval components changed: %q %v", actual, err)
		}
	}
	for _, value := range []string{"1-12", "1000000000-00", "P1Y2M", "1-2 trailing"} {
		if _, err := plDebugNativeIntervalText(value, false); err == nil {
			t.Fatal("invalid or noncanonical year/month input accepted")
		}
	}
	for _, value := range []string{"1 24:00:00", "1 00:60:00", "1 00:00:60", "1 00:00:00.1234567890", "1 00:00:00,5", "1000000000 00:00:00"} {
		if _, err := plDebugNativeIntervalText(value, true); err == nil {
			t.Fatal("invalid day/second input accepted")
		}
	}
}
