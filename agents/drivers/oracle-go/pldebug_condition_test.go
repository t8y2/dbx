package main

import (
	"errors"
	"testing"
)

func TestPLDebugNativeConditionUsesFiniteGrammarAndExactValues(t *testing.T) {
	for _, test := range []struct{ expression, actual, state, want string }{
		{"N == 9007199254740993", "9007199254740993", "value", "true"},
		{"N == 9007199254740992", "9007199254740993", "value", "false"},
		{"N >= 1.0000000000000000000000000000000000001", "1.0000000000000000000000000000000000000", "value", "false"},
		{"N < -1.25e-3", "-0.001251", "value", "true"},
		{"N == NULL", "", "null", "true"},
		{"N != null", "NULL", "value", "true"},
		{"N == 'NULL'", "NULL", "value", "true"},
		{"N == ''", "", "empty", "true"},
		{"N == 'it''s 中'", "it's 中", "value", "true"},
		{"N == 1", "", "out_of_scope", "unparseable"},
		{"N > NULL", "", "null", "unparseable"},
		{"N == 0", "", "empty", "unparseable"},
		{"N == 1", "", "unknown", "unparseable"},
		{"N > 'text'", "text", "value", "unparseable"},
	} {
		t.Run(test.expression+"/"+test.actual, func(t *testing.T) {
			result, err := plDebugEvaluateCondition(test.expression, func(name string) (plDebugNativeVariable, error) {
				if name != "N" {
					t.Fatal("condition changed the native variable name")
				}
				return plDebugNativeVariable{Name: name, State: test.state, Value: &test.actual}, nil
			})
			if err != nil || result.State != test.want {
				t.Fatalf("%+v %v", result, err)
			}
		})
	}
	for _, expression := range []string{"N == f()", "N == 1 OR 1==1", "(N) == 1", "N == 1e999999999", "N == 1/2"} {
		result, err := plDebugEvaluateCondition(expression, func(string) (plDebugNativeVariable, error) {
			t.Fatal("invalid grammar attempted a native read")
			return plDebugNativeVariable{}, nil
		})
		if err != nil || result.State != "unparseable" {
			t.Fatal("invalid grammar did not stop")
		}
	}
	want := errors.New("original controller read failed")
	if _, err := plDebugEvaluateCondition("N == 1", func(string) (plDebugNativeVariable, error) { return plDebugNativeVariable{}, want }); !errors.Is(err, want) {
		t.Fatal("controller failure was converted to false")
	}
}
