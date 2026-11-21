package main

import (
	"errors"
	"strconv"
	"unicode/utf8"
)

func plDebugValidateTypedUnicode(raw string) error {
	invalid := errors.New("typed debugger request contains invalid Unicode")
	if !utf8.ValidString(raw) {
		return invalid
	}
	unit := func(start int) (uint64, error) {
		if start+4 > len(raw) {
			return 0, invalid
		}
		return strconv.ParseUint(raw[start:start+4], 16, 16)
	}
	quoted := false
	for index := 0; index < len(raw); index++ {
		if raw[index] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || raw[index] != '\\' {
			continue
		}
		index++
		if index >= len(raw) {
			return invalid
		}
		if raw[index] != 'u' {
			continue
		}
		value, err := unit(index + 1)
		if err != nil {
			return invalid
		}
		index += 4
		if value >= 0xDC00 && value <= 0xDFFF {
			return invalid
		}
		if value < 0xD800 || value > 0xDBFF {
			continue
		}
		if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
			return invalid
		}
		low, err := unit(index + 3)
		if err != nil || low < 0xDC00 || low > 0xDFFF {
			return invalid
		}
		index += 6
	}
	return nil
}
