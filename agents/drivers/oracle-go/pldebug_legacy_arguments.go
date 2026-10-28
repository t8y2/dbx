package main

import (
	"errors"
	"fmt"
	"reflect"
)

type plDebugLegacyArgumentNode struct {
	argument plDebugNativeArgument
	detail   plDebugNativeMetadataRow
	children []*plDebugLegacyArgumentNode
}

func plDebugLegacyNoArgumentsRow(row plDebugNativeMetadataRow) bool {
	for key, expected := range map[string]string{"POSITION": "1", "SEQUENCE": "0", "DATA_LEVEL": "0", "IN_OUT": "IN", "DEFAULTED": "N", "CHAR_LENGTH": "0", "CHAR_USED": "0"} {
		if row.text(key) != expected {
			return false
		}
	}
	for _, key := range []string{"ARGUMENT_NAME", "DATA_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "TYPE_LINK", "PLS_TYPE", "DEFAULT_LENGTH", "DEFAULT_VALUE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "RADIX", "CHARACTER_SET_NAME"} {
		value, present := row[key]
		if !present || value != nil {
			return false
		}
	}
	return true
}

func plDebugLegacyArgumentTree(candidate plDebugNativeCandidate, details []plDebugNativeMetadataRow) ([]*plDebugLegacyArgumentNode, error) {
	if !plDebugNativeArgumentDetailsMatch(candidate, details) {
		return nil, errors.New("legacy argument evidence does not match the selected signature")
	}
	roots := []*plDebugLegacyArgumentNode{}
	stack := []*plDebugLegacyArgumentNode{}
	var previous int64 = -1
	for index, argument := range candidate.Arguments {
		if argument.Sequence <= previous || argument.Level < 0 || argument.Level > 16 || argument.Level > int64(len(stack)) {
			return nil, errors.New("legacy argument sequence or nesting is incomplete")
		}
		previous = argument.Sequence
		node := &plDebugLegacyArgumentNode{argument: argument, detail: details[index]}
		stack = stack[:argument.Level]
		if len(stack) == 0 {
			for _, root := range roots {
				if root.argument.Position == argument.Position {
					return nil, errors.New("duplicate legacy root argument position")
				}
			}
			roots = append(roots, node)
		} else {
			parent := stack[len(stack)-1]
			if !parent.argument.composite() {
				return nil, errors.New("legacy scalar argument has nested metadata")
			}
			if argument.Position < 1 {
				return nil, errors.New("legacy nested argument position is incomplete")
			}
			for _, sibling := range parent.children {
				if sibling.argument.Position == argument.Position || argument.Name != nil && sibling.argument.Name != nil && *argument.Name == *sibling.argument.Name {
					return nil, errors.New("duplicate legacy field position or name")
				}
			}
			if parent.argument.Type == "PL/SQL RECORD" || parent.argument.Type == "OBJECT" {
				if argument.Name == nil || *argument.Name == "" {
					return nil, errors.New("legacy record field name is incomplete")
				}
			} else if argument.Name != nil || argument.Position != 1 || len(parent.children) != 0 {
				return nil, errors.New("legacy collection element metadata is inconsistent")
			}
			parent.children = append(parent.children, node)
		}
		stack = append(stack, node)
	}
	definitions := map[string]*plDebugLegacyArgumentNode{}
	var validate func(*plDebugLegacyArgumentNode) error
	validate = func(node *plDebugLegacyArgumentNode) error {
		if node.argument.composite() {
			ref, err := plDebugNativeArgumentTypeRef(node.argument)
			if err != nil || ref == nil {
				return errors.New("legacy composite declared identity is incomplete")
			}
			// SQL types continue through the existing SQL dictionary loader.
			if ref.PackageName != nil && len(node.children) == 0 {
				return fmt.Errorf("legacy package type %s has no expanded definition", ref.TypeName)
			}
			if ref.PackageName != nil {
				if previous, exists := definitions[ref.key()]; exists {
					if !plDebugLegacySameDefinition(previous, node, false) {
						return fmt.Errorf("legacy package type %s has contradictory expanded definitions", ref.TypeName)
					}
				} else {
					definitions[ref.key()] = node
				}
			}
		}
		for index, child := range node.children {
			if child.argument.Position != int64(index+1) {
				return errors.New("legacy nested field positions are not contiguous")
			}
			if err := validate(child); err != nil {
				return err
			}
		}
		return nil
	}
	for _, root := range roots {
		if err := validate(root); err != nil {
			return nil, err
		}
	}
	return roots, nil
}

func plDebugLegacySameDefinition(a, b *plDebugLegacyArgumentNode, field bool) bool {
	if len(a.children) != len(b.children) || field && (a.argument.Position != b.argument.Position || !reflect.DeepEqual(a.argument.Name, b.argument.Name)) {
		return false
	}
	for _, key := range []string{"DATA_TYPE", "PLS_TYPE", "TYPE_OWNER", "TYPE_NAME", "TYPE_SUBNAME", "TYPE_LINK", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "RADIX", "CHAR_LENGTH", "CHAR_USED", "CHARACTER_SET_NAME"} {
		av, ap := a.detail[key]
		bv, bp := b.detail[key]
		if ap != bp || !reflect.DeepEqual(av, bv) {
			return false
		}
	}
	for i := range a.children {
		if !plDebugLegacySameDefinition(a.children[i], b.children[i], true) {
			return false
		}
	}
	return true
}
