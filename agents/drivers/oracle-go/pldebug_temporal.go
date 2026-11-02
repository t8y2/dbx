package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

var plDebugTemporalText = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?$`)

type plDebugNativeTemporalInput struct{ day, seconds string }

func plDebugNativeTemporalComponents(text string, timestamp bool) (plDebugNativeTemporalInput, error) {
	if _, err := plDebugNativeTemporal(text, timestamp); err != nil {
		return plDebugNativeTemporalInput{}, err
	}
	parts := plDebugTemporalText.FindStringSubmatch(text)
	h, _ := strconv.Atoi(parts[4])
	m, _ := strconv.Atoi(parts[5])
	s, _ := strconv.Atoi(parts[6])
	seconds := strconv.Itoa(h*3600 + m*60 + s)
	if parts[7] != "" {
		seconds += "." + parts[7]
	}
	return plDebugNativeTemporalInput{text[:10], seconds}, nil
}

func plDebugNativeTemporal(value string, timestamp bool) (string, error) {
	parts := plDebugTemporalText.FindStringSubmatch(value)
	invalid := errors.New("date/time input requires a Gregorian date in years 0001 through 9999 and exact local time")
	if parts == nil || !timestamp && parts[7] != "" {
		return "", invalid
	}
	numbers := make([]int64, 6)
	for i := range numbers {
		numbers[i], _ = strconv.ParseInt(parts[i+1], 10, 64)
	}
	y, m, d, h, minute, second := numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]
	if y < 1 || m < 1 || m > 12 || d < 1 || h > 23 || minute > 59 || second > 59 {
		return "", invalid
	}
	monthDays := []int64{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if y%4 == 0 && (y%100 != 0 || y%400 == 0) {
		monthDays[1] = 29
	}
	if d > monthDays[m-1] {
		return "", invalid
	}
	return value, nil
}

func plDebugNativeTemporalExport(variable string, timestamp bool) string {
	value := variable
	component := func(field, format string) string {
		return "TO_CHAR(EXTRACT(" + field + " FROM " + value + "), '" + format + "', 'NLS_NUMERIC_CHARACTERS=''.,''')"
	}
	seconds := "FM00"
	if timestamp {
		seconds = "FM00.000000000"
	}
	return fmt.Sprintf("CASE WHEN %s IS NULL THEN NULL WHEN %s < TIMESTAMP '0001-01-01 00:00:00' THEN 'outside_supported_calendar_range' ELSE %s||'-'||%s||'-'||%s||'T'||%s||':'||%s||':'||%s END", variable, variable, component("YEAR", "FM0000"), component("MONTH", "FM00"), component("DAY", "FM00"), component("HOUR", "FM00"), component("MINUTE", "FM00"), component("SECOND", seconds))
}
