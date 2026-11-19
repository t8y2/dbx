package main

import (
	"errors"
	"regexp"
	"strings"
)

var plDebugYearMonthInterval = regexp.MustCompile(`^([+-]?)([0-9]{1,9})-(0[0-9]|1[01])$`)
var plDebugDaySecondInterval = regexp.MustCompile(`^([+-]?)([0-9]{1,9}) ((?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:\.([0-9]{1,9}))?$`)

func plDebugNativeIntervalText(value string, daySecond bool) (string, error) {
	pattern := plDebugYearMonthInterval
	if daySecond {
		pattern = plDebugDaySecondInterval
	}
	parts := pattern.FindStringSubmatch(value)
	if parts == nil {
		return "", errors.New("interval input requires a signed SQL interval with at most nine leading and fractional digits")
	}
	sign := parts[1]
	if sign == "" {
		sign = "+"
	}
	leading := strings.Repeat("0", 9-len(parts[2])) + parts[2]
	if !daySecond {
		return sign + leading + "-" + parts[3], nil
	}
	fraction := parts[4] + strings.Repeat("0", 9-len(parts[4]))
	return sign + leading + " " + parts[3] + "." + fraction, nil
}

func (encoder plDebugCompositeEncoder) intervalDeclarations() (string, string) {
	needed := map[string]bool{}
	for _, node := range encoder.nodes {
		for _, row := range node.Attributes {
			needed[row.text("ATTR_TYPE_NAME")] = true
		}
		for _, row := range node.Collections {
			needed[row.text("ELEM_TYPE_NAME")] = true
		}
	}
	sql := ""
	types := ""
	for _, interval := range []struct{ kind, subtype, declaration, envelope string }{{"INTERVAL YEAR TO MONTH", "YM9", "INTERVAL YEAR(9) TO MONTH", "interval_year_month"}, {"INTERVAL DAY TO SECOND", "DS9", "INTERVAL DAY(9) TO SECOND(9)", "interval_day_second"}} {
		if !needed[interval.kind] {
			continue
		}
		types += "SUBTYPE " + encoder.prefix + interval.subtype + " IS " + interval.declaration + ";\n"
		sql += "PROCEDURE " + encoder.prefix + interval.subtype + "_VALUE(V IN " + encoder.prefix + interval.subtype + ") IS L0 INTEGER:=SYS.DBMS_LOB.GETLENGTH(" + encoder.prefix + "JSON); B0 INTEGER:=" + encoder.budget + "; OK BOOLEAN; BEGIN\n " + encoder.prefix + "GUARD; IF V IS NULL THEN " + encoder.prefix + "APP('{\"kind\":\"" + interval.envelope + "\",\"state\":\"null\",\"value\":null}'); ELSE " + encoder.prefix + "APP('{\"kind\":\"" + interval.envelope + "\",\"state\":\"value\",\"value\":'); OK:=" + encoder.prefix + "Q(REPLACE(TO_CHAR(V),',','.')); IF NOT OK THEN RAISE_APPLICATION_ERROR(-20996,'budget'); END IF; " + encoder.prefix + "CLOSE_J('}'); END IF; EXCEPTION WHEN OTHERS THEN " + encoder.prefix + "FAIL(SQLCODE,L0,B0); END;\n"
	}
	return types, sql
}
