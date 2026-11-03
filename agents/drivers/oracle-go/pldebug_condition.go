package main

import (
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

var plDebugConditionExpression = regexp.MustCompile(`^([A-Za-z_][\w$#]*(?:\.[\w$#]+)?)\s*(==|!=|>=|<=|>|<)\s*(.+)$`)
var plDebugConditionNumber = regexp.MustCompile(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$`)
var plDebugConditionString = regexp.MustCompile(`^'(?:[^']|'')*'$`)

type plDebugConditionVerdict struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

func plDebugConditionNumeric(raw string) (*big.Rat, bool) {
	match := plDebugConditionNumber.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return nil, false
	}
	if match[1] != "" {
		exponent, err := strconv.Atoi(match[1])
		if err != nil || exponent < -4096 || exponent > 4096 {
			return nil, false
		}
	}
	return new(big.Rat).SetString(strings.TrimSpace(raw))
}

// Adapted from the author's finite Store evaluator; values stay in the original frame.
func plDebugEvaluateCondition(expression string, read func(string) (plDebugNativeVariable, error)) (plDebugConditionVerdict, error) {
	unknown := func(reason string) (plDebugConditionVerdict, error) {
		return plDebugConditionVerdict{State: "unparseable", Reason: reason}, nil
	}
	if len(expression) > 4096 {
		return unknown("condition exceeds the 4096-byte limit")
	}
	match := plDebugConditionExpression.FindStringSubmatch(strings.TrimSpace(expression))
	if match == nil {
		return unknown("expected variable operator literal")
	}
	name, operator, literal := match[1], match[2], strings.TrimSpace(match[3])
	null := strings.EqualFold(literal, "NULL")
	number, numeric := plDebugConditionNumeric(literal)
	text := plDebugConditionString.MatchString(literal)
	if !null && !numeric && !text {
		return unknown("unsupported literal or numeric exponent outside -4096..4096")
	}
	value, err := read(name)
	if err != nil {
		return plDebugConditionVerdict{}, err
	}
	if value.State != "value" && value.State != "empty" && value.State != "null" {
		return unknown(fmt.Sprintf("variable %s could not be read in the stopped frame", name))
	}
	comparison := 0
	if null {
		if operator != "==" && operator != "!=" {
			return unknown("NULL supports only == and !=")
		}
		if value.State != "null" {
			comparison = 1
		}
	} else {
		if value.State == "null" || value.Value == nil {
			return unknown(fmt.Sprintf("variable %s is NULL or has no scalar payload", name))
		}
		if numeric {
			actual, ok := plDebugConditionNumeric(*value.Value)
			if !ok {
				return unknown(fmt.Sprintf("variable %s is not an exact numeric scalar", name))
			}
			comparison = actual.Cmp(number)
		} else {
			if operator != "==" && operator != "!=" {
				return unknown("string literals support only == and !=")
			}
			comparison = strings.Compare(*value.Value, strings.ReplaceAll(literal[1:len(literal)-1], "''", "'"))
		}
	}
	matched := false
	switch operator {
	case "==":
		matched = comparison == 0
	case "!=":
		matched = comparison != 0
	case ">":
		matched = comparison > 0
	case "<":
		matched = comparison < 0
	case ">=":
		matched = comparison >= 0
	case "<=":
		matched = comparison <= 0
	}
	state := "false"
	if matched {
		state = "true"
	}
	return plDebugConditionVerdict{State: state}, nil
}
