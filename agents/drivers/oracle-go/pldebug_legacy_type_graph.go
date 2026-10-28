package main

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
)

type plDebugLegacyDictionaryLayout struct {
	Version int64  `json:"version"`
	Release int64  `json:"release"`
	Layout  string `json:"layout"`
}

func (l *plDebugNativeTypeLoader) legacyDictionaryLayout() (*plDebugLegacyDictionaryLayout, error) {
	var version, release sql.NullInt64
	_, err := l.conn.ExecContext(l.ctx, "BEGIN :1:=SYS.DBMS_DB_VERSION.VERSION; :2:=SYS.DBMS_DB_VERSION.RELEASE; END;", plDebugOutArg(l.oci, &version), plDebugOutArg(l.oci, &release))
	if l.ctx.Err() != nil {
		return nil, l.ctx.Err()
	}
	if err != nil {
		return nil, err
	}
	if !version.Valid || !release.Valid || version.Int64 < 1 || release.Int64 < 0 {
		return nil, errors.New("Oracle dictionary version could not be confirmed")
	}
	if version.Int64 >= 12 {
		return nil, nil
	}
	if version.Int64 != 11 || release.Int64 != 2 {
		return nil, errors.New("expanded Oracle dictionary version needs a verified legacy adapter")
	}
	return &plDebugLegacyDictionaryLayout{Version: version.Int64, Release: release.Int64, Layout: "expanded-all-arguments"}, nil
}

type plDebugLegacyTypeOrigin struct {
	Source   string `json:"source"`
	Sequence int64  `json:"sequence"`
}

func plDebugLegacyArgumentTypeRef(argument plDebugNativeArgument) (*plDebugNativeTypeRef, error) {
	argument.Level = 0
	return plDebugNativeArgumentTypeRef(argument)
}

func plDebugLegacyDerivedPart(node *plDebugLegacyArgumentNode, prefix string) (plDebugNativeMetadataRow, error) {
	row := plDebugNativeMetadataRow{}
	ref, err := plDebugLegacyArgumentTypeRef(node.argument)
	if err != nil {
		return nil, err
	}
	if ref != nil {
		row[prefix+"OWNER"] = &ref.Owner
		row[prefix+"PACKAGE"] = ref.PackageName
		row[prefix+"NAME"] = &ref.TypeName
	} else {
		value := node.argument.Type
		row[prefix+"NAME"] = &value
		row[prefix+"OWNER"] = nil
		row[prefix+"PACKAGE"] = nil
	}
	row[prefix+"MOD"] = nil
	for _, pair := range [][2]string{{"DATA_LENGTH", "LENGTH"}, {"DATA_PRECISION", "PRECISION"}, {"DATA_SCALE", "SCALE"}, {"CHAR_LENGTH", "CHAR_LENGTH"}, {"CHAR_USED", "CHAR_USED"}, {"CHARACTER_SET_NAME", "CHARACTER_SET_NAME"}} {
		if value, exists := node.detail[pair[0]]; exists {
			row[pair[1]] = value
		}
	}
	return row, nil
}

func plDebugLegacyCollectionElementMatches(tokens []plDebugNativeSourceToken, element *plDebugLegacyArgumentNode, source plDebugNativeSource) bool {
	ref, err := plDebugLegacyArgumentTypeRef(element.argument)
	if err != nil {
		return false
	}
	if ref != nil {
		parts := []string{}
		for i, token := range tokens {
			if i%2 == 0 {
				if !token.Identifier {
					return false
				}
				parts = append(parts, token.Text)
			} else if !token.word(".") {
				return false
			}
		}
		if len(tokens)%2 == 0 {
			return false
		}
		actual := strings.Join(parts, "\x00")
		if ref.PackageName != nil {
			return actual == ref.Owner+"\x00"+*ref.PackageName+"\x00"+ref.TypeName || ref.Owner == source.Owner && (actual == *ref.PackageName+"\x00"+ref.TypeName || *ref.PackageName == source.Name && actual == ref.TypeName)
		}
		return actual == ref.Owner+"\x00"+ref.TypeName || ref.Owner == source.Owner && actual == ref.TypeName
	}
	words := []string{}
	depth := 0
	for _, token := range tokens {
		if token.word("(") {
			depth++
			continue
		}
		if token.word(")") {
			depth--
			if depth < 0 {
				return false
			}
			continue
		}
		if depth > 0 {
			continue
		}
		if !token.Identifier || token.Quoted {
			return false
		}
		words = append(words, token.Text)
	}
	if depth != 0 {
		return false
	}
	normalize := func(name string) string {
		switch name {
		case "PLS_INTEGER", "BINARY_INTEGER", "PL/SQL PLS INTEGER", "PL/SQL BINARY INTEGER":
			return "INTEGER"
		case "PL/SQL BOOLEAN":
			return "BOOLEAN"
		}
		return plDebugNativeScalarTypeName(name)
	}
	declared := normalize(strings.Join(words, " "))
	return declared == normalize(element.argument.Type) || element.detail.text("PLS_TYPE") != "" && declared == normalize(element.detail.text("PLS_TYPE"))
}

func plDebugLegacyDerivedType(tree *plDebugLegacyArgumentNode, source plDebugNativeSource) (plDebugNativeTypeNode, error) {
	var node plDebugNativeTypeNode
	ref, err := plDebugNativeArgumentTypeRef(tree.argument)
	if err != nil || ref == nil || ref.PackageName == nil || ref.Owner != source.Owner || *ref.PackageName != source.Name {
		return node, errors.New("legacy derived type source identity is inconsistent")
	}
	text := func(value string) *string { return &value }
	node = plDebugNativeTypeNode{Reference: *ref, Definition: plDebugNativeMetadataRow{}, Attributes: []plDebugNativeMetadataRow{}, Collections: []plDebugNativeMetadataRow{}, LegacyOrigin: &plDebugLegacyTypeOrigin{Source: "argument-tree", Sequence: tree.argument.Sequence}}
	if tree.argument.Type == "PL/SQL RECORD" {
		node.Definition["TYPECODE"] = text("PL/SQL RECORD")
		for _, child := range tree.children {
			row, e := plDebugLegacyDerivedPart(child, "ATTR_TYPE_")
			if e != nil {
				return node, e
			}
			row["ATTR_NAME"] = child.argument.Name
			row["ATTR_NO"] = text(strconv.FormatInt(child.argument.Position, 10))
			node.Attributes = append(node.Attributes, row)
		}
		return node, nil
	}
	if len(tree.children) != 1 {
		return node, errors.New("legacy collection element is incomplete")
	}
	declaration, err := plDebugLegacyCollectionFromSource(source, ref.TypeName)
	if err != nil {
		return node, err
	}
	expected := map[string]string{"PL/SQL INDEX TABLE": "PL/SQL TABLE", "TABLE": "TABLE", "VARRAY": "VARRAY"}[declaration.kind]
	if tree.argument.Type != expected || !plDebugLegacyCollectionElementMatches(declaration.element, tree.children[0], source) {
		return node, errors.New("legacy compiled collection declaration contradicts expanded arguments")
	}
	row, err := plDebugLegacyDerivedPart(tree.children[0], "ELEM_TYPE_")
	if err != nil {
		return node, err
	}
	kind := declaration.kind
	if kind == "VARRAY" {
		kind = "VARYING ARRAY"
	}
	row["COLL_TYPE"] = text(kind)
	row["INDEX_BY"] = nil
	row["UPPER_BOUND"] = nil
	if declaration.indexType != "" {
		row["INDEX_BY"] = text(declaration.indexType)
	}
	if declaration.upperBound != "" {
		row["UPPER_BOUND"] = text(declaration.upperBound)
	}
	if declaration.indexLength != "" {
		row["INDEX_LENGTH"] = text(declaration.indexLength)
	}
	if declaration.indexLengthUnit != "" {
		row["INDEX_LENGTH_UNIT"] = text(declaration.indexLengthUnit)
	}
	if declaration.elementNotNull {
		row["NULLS_STORED"] = text("NO")
	} else {
		row["NULLS_STORED"] = text("YES")
	}
	node.Definition["TYPECODE"] = text("COLLECTION")
	node.Collections = append(node.Collections, row)
	return node, nil
}
