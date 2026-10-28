package main

import (
	"strconv"
	"testing"
)

func TestPLDebugLegacyNoArgumentsRequiresTheCompleteObservedPlaceholder(t *testing.T) {
	text := func(value string) *string { return &value }
	row := plDebugNativeMetadataRow{"POSITION": text("1"), "SEQUENCE": text("0"), "DATA_LEVEL": text("0"), "IN_OUT": text("IN"), "DEFAULTED": text("N"), "CHAR_LENGTH": text("0"), "CHAR_USED": text("0")}
	for _, key := range []string{"ARGUMENT_NAME", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "TYPE_LINK", "PLS_TYPE", "DEFAULT_LENGTH", "DEFAULT_VALUE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "RADIX", "CHARACTER_SET_NAME"} {
		row[key] = nil
	}
	if !plDebugLegacyNoArgumentsRow(row) {
		t.Fatal("complete observed placeholder was rejected")
	}
	for _, key := range []string{"ARGUMENT_NAME", "DATA_TYPE", "TYPE_LINK", "PLS_TYPE", "DEFAULT_VALUE", "IN_OUT", "SEQUENCE", "CHAR_USED"} {
		copy := plDebugNativeMetadataRow{}
		for k, value := range row {
			copy[k] = value
		}
		copy[key] = text("unexpected")
		if plDebugLegacyNoArgumentsRow(copy) {
			t.Fatalf("ordinary or contradictory parameter accepted as placeholder: %s", key)
		}
	}
	delete(row, "TYPE_LINK")
	if plDebugLegacyNoArgumentsRow(row) {
		t.Fatal("missing evidence was interpreted as confirmed NULL")
	}
}

func plDebugLegacyArgumentFixture() (plDebugNativeCandidate, []plDebugNativeMetadataRow) {
	text := func(value string) *string { return &value }
	root := plDebugNativeArgument{Name: text("V"), Position: 1, Sequence: 1, Mode: "IN OUT", Type: "PL/SQL RECORD", TypeOwner: text("S"), TypeName: text("P"), TypeSubname: text("R"), Defaulted: text("N")}
	number := plDebugNativeArgument{Name: text("N"), Position: 1, Sequence: 2, Level: 1, Mode: "IN OUT", Type: "NUMBER", Defaulted: text("N")}
	character := number
	character.Name, character.Position, character.Sequence, character.Type = text("T"), 2, 3, "VARCHAR2"
	collection := root
	collection.Name, collection.Position, collection.Sequence, collection.Type, collection.TypeSubname = text("W"), 2, 4, "PL/SQL TABLE", text("A")
	element := root
	element.Name, element.Sequence, element.Level = nil, 5, 1
	nestedNumber, nestedCharacter := number, character
	nestedNumber.Sequence, nestedNumber.Level = 6, 2
	nestedCharacter.Sequence, nestedCharacter.Level = 7, 2
	candidate := plDebugNativeCandidate{Arguments: []plDebugNativeArgument{root, number, character, collection, element, nestedNumber, nestedCharacter}}
	return candidate, plDebugLegacyArgumentDetails(candidate)
}

func plDebugLegacyArgumentDetails(candidate plDebugNativeCandidate) []plDebugNativeMetadataRow {
	text := func(value string) *string { return &value }
	details := []plDebugNativeMetadataRow{}
	for _, argument := range candidate.Arguments {
		details = append(details, plDebugNativeMetadataRow{"ARGUMENT_NAME": argument.Name, "POSITION": text(strconv.FormatInt(argument.Position, 10)), "SEQUENCE": text(strconv.FormatInt(argument.Sequence, 10)), "DATA_LEVEL": text(strconv.FormatInt(argument.Level, 10)), "IN_OUT": text(argument.Mode), "DATA_TYPE": text(argument.Type), "TYPE_OWNER": argument.TypeOwner, "TYPE_NAME": argument.TypeName, "TYPE_SUBNAME": argument.TypeSubname, "DEFAULTED": argument.Defaulted})
	}
	return details
}

func TestPLDebugLegacyArgumentTreePreservesExpandedRootAndElementIdentity(t *testing.T) {
	candidate, details := plDebugLegacyArgumentFixture()
	roots, err := plDebugLegacyArgumentTree(candidate, details)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 2 || len(roots[0].children) != 2 || len(roots[1].children) != 1 || len(roots[1].children[0].children) != 2 {
		t.Fatal("expanded record and collection structure changed")
	}
	if roots[1].children[0].argument.Name != nil || roots[1].children[0].argument.TypeSubname == nil || *roots[1].children[0].argument.TypeSubname != "R" || roots[1].children[0].children[1].detail.text("SEQUENCE") != "7" {
		t.Fatal("element identity or raw sequence was replaced")
	}
	if len(candidate.Arguments) != 7 || len(details) != 7 || candidate.Arguments[4].Position != 1 {
		t.Fatal("tree reconstruction removed or renumbered frozen evidence")
	}
}

func TestPLDebugLegacyArgumentTreeRejectsIncompleteOrContradictoryNesting(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*plDebugNativeCandidate)
	}{
		{"level jump", func(c *plDebugNativeCandidate) { c.Arguments[1].Level = 2 }},
		{"duplicate sequence", func(c *plDebugNativeCandidate) { c.Arguments[2].Sequence = 2 }},
		{"duplicate field", func(c *plDebugNativeCandidate) { c.Arguments[2].Name = c.Arguments[1].Name }},
		{"named element", func(c *plDebugNativeCandidate) { c.Arguments[4].Name = c.Arguments[0].Name }},
		{"missing element", func(c *plDebugNativeCandidate) { c.Arguments = c.Arguments[:4] }},
		{"missing type identity", func(c *plDebugNativeCandidate) { c.Arguments[4].TypeOwner = nil }},
		{"scalar parent", func(c *plDebugNativeCandidate) { c.Arguments[0].Type = "NUMBER" }},
		{"field gap", func(c *plDebugNativeCandidate) { c.Arguments[2].Position = 3 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate, _ := plDebugLegacyArgumentFixture()
			test.mutate(&candidate)
			if _, err := plDebugLegacyArgumentTree(candidate, plDebugLegacyArgumentDetails(candidate)); err == nil {
				t.Fatal("incomplete or contradictory tree was accepted")
			}
		})
	}
}

func TestPLDebugLegacyRepeatedTypeComparesDefinitionNotCallContext(t *testing.T) {
	candidate, _ := plDebugLegacyArgumentFixture()
	for i := 4; i < len(candidate.Arguments); i++ {
		candidate.Arguments[i].Mode = "OUT"
		value := "Y"
		candidate.Arguments[i].Defaulted = &value
	}
	details := plDebugLegacyArgumentDetails(candidate)
	if _, err := plDebugLegacyArgumentTree(candidate, details); err != nil {
		t.Fatalf("same type at another level/direction was rejected: %v", err)
	}
	for _, key := range []string{"DATA_TYPE", "PLS_TYPE", "DATA_PRECISION", "CHAR_USED", "TYPE_LINK"} {
		changed := plDebugLegacyArgumentDetails(candidate)
		value := "contradiction"
		changed[6][key] = &value
		if key == "DATA_TYPE" {
			candidate.Arguments[6].Type = value
		}
		if _, err := plDebugLegacyArgumentTree(candidate, changed); err == nil {
			t.Fatalf("repeated type with contradictory %s was accepted", key)
		}
		candidate.Arguments[6].Type = "VARCHAR2"
	}
}
