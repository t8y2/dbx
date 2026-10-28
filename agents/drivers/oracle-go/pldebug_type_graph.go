package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
)

// Oracle dictionary identities differ from OceanBase's EXT argument layout.
type plDebugNativeTypeRef struct {
	Owner       string  `json:"owner"`
	PackageName *string `json:"packageName"`
	TypeName    string  `json:"typeName"`
}

func (r plDebugNativeTypeRef) key() string { encoded, _ := json.Marshal(r); return string(encoded) }
func (r plDebugNativeTypeRef) declaration() string {
	value := quoteIdentifier(r.Owner) + "."
	if r.PackageName != nil {
		value += quoteIdentifier(*r.PackageName) + "."
	}
	return value + quoteIdentifier(r.TypeName)
}

func plDebugNativeArgumentTypeRef(a plDebugNativeArgument) (*plDebugNativeTypeRef, error) {
	if a.scalar() {
		return nil, nil
	}
	if a.TypeOwner == nil || *a.TypeOwner == "" || a.TypeName == nil || *a.TypeName == "" {
		return nil, errors.New("incomplete Oracle declared type identity")
	}
	r := plDebugNativeTypeRef{Owner: *a.TypeOwner, TypeName: *a.TypeName}
	if a.TypeSubname != nil {
		if *a.TypeSubname == "" {
			return nil, errors.New("empty Oracle package type identity")
		}
		container := *a.TypeName
		r.PackageName = &container
		r.TypeName = *a.TypeSubname
	}
	return &r, nil
}

type plDebugNativeMetadataRow map[string]*string

func (r plDebugNativeMetadataRow) text(key string) string {
	if r[key] == nil {
		return ""
	}
	return *r[key]
}

type plDebugNativeTypeNode struct {
	LegacyOrigin          *plDebugLegacyTypeOrigin             `json:"legacyOrigin,omitempty"`
	Reference             plDebugNativeTypeRef                 `json:"reference"`
	Definition            plDebugNativeMetadataRow             `json:"definition"`
	Attributes            []plDebugNativeMetadataRow           `json:"attributes"`
	Collections           []plDebugNativeMetadataRow           `json:"collections"`
	Methods               []plDebugNativeMetadataRow           `json:"methods,omitempty"`
	MethodParameters      []plDebugNativeMetadataRow           `json:"methodParameters,omitempty"`
	ConstructorSource     *plDebugNativeConstructorDescription `json:"constructorSource,omitempty"`
	ConstructorReferences []plDebugNativeTypeVisibility        `json:"constructorReferences,omitempty"`
	ObjectAccess          *plDebugNativeTypeAccess             `json:"objectAccess,omitempty"`
	ConstructorCalls      *plDebugNativeConstructorCallables   `json:"constructorCalls,omitempty"`
}

type plDebugNativeTypeAccess struct {
	State      string `json:"state"`
	VendorCode *int   `json:"vendorCode,omitempty"`
}

func plDebugNativeCheckTypeReference(ctx context.Context, conn *sql.Conn, ref plDebugNativeTypeRef) (plDebugNativeTypeAccess, error) {
	if err := ctx.Err(); err != nil {
		return plDebugNativeTypeAccess{}, err
	}
	_, err := conn.ExecContext(ctx, "DECLARE TYPE DBXPD_ACCESS IS RECORD(X "+ref.declaration()+"); BEGIN NULL; END;")
	if ctx.Err() != nil {
		return plDebugNativeTypeAccess{}, ctx.Err()
	}
	if err == nil {
		return plDebugNativeTypeAccess{State: "type_only_verified"}, nil
	}
	if ctx.Err() != nil {
		return plDebugNativeTypeAccess{}, ctx.Err()
	}
	code := regexp.MustCompile(`ORA-([0-9]+)`).FindStringSubmatch(err.Error())
	if len(code) != 2 {
		return plDebugNativeTypeAccess{}, err
	}
	number, e := strconv.Atoi(code[1])
	if e != nil {
		return plDebugNativeTypeAccess{}, err
	}
	switch number {
	case 1031, 942, 4043, 6550, 4063:
		return plDebugNativeTypeAccess{State: "type_only_failed", VendorCode: &number}, nil
	default:
		return plDebugNativeTypeAccess{}, err
	}
}

type plDebugNativeTypeVisibility struct {
	Reference plDebugNativeTypeRef `json:"reference"`
	Visible   bool                 `json:"visible"`
}
type plDebugNativeTypeVersion struct {
	CompiledSource *string `json:"compiledSource,omitempty"`
	Reference      struct {
		Owner string `json:"owner"`
		Name  string `json:"name"`
	} `json:"reference"`
	Objects []plDebugNativeMetadataRow `json:"objects"`
	Source  []plDebugNativeMetadataRow `json:"source"`
}
type plDebugNativeTypeGraph struct {
	Nodes    []plDebugNativeTypeNode    `json:"nodes"`
	Versions []plDebugNativeTypeVersion `json:"versions"`
}
type plDebugNativeTypeLoader struct {
	ctx           context.Context
	conn          *sql.Conn
	oci           bool
	legacyTrees   map[string]*plDebugLegacyArgumentNode
	legacySources map[string]plDebugNativeSource
	bytes, rows   int
}

func (l *plDebugNativeTypeLoader) query(query string, args ...any) ([]plDebugNativeMetadataRow, error) {
	rows, err := l.conn.QueryContext(l.ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	result := []plDebugNativeMetadataRow{}
	for rows.Next() {
		if err = l.ctx.Err(); err != nil {
			return nil, err
		}
		l.rows++
		if l.rows > 8192 {
			return nil, errors.New("declared type metadata row budget exceeded")
		}
		values := make([]sql.NullString, len(columns))
		dest := make([]any, len(columns))
		for i := range values {
			dest[i] = &values[i]
		}
		if err = rows.Scan(dest...); err != nil {
			return nil, err
		}
		row := plDebugNativeMetadataRow{}
		for i, key := range columns {
			if _, duplicate := row[key]; duplicate {
				return nil, errors.New("duplicate declared type metadata column")
			}
			if values[i].Valid && values[i].String != "" {
				value := values[i].String
				if strings.EqualFold(columnTypes[i].DatabaseTypeName(), "RAW") {
					value = strings.ToUpper(hex.EncodeToString([]byte(value)))
				}
				l.bytes += len(value)
				if l.bytes > 1048576 {
					return nil, errors.New("declared type metadata byte budget exceeded")
				}
				row[key] = &value
			} else {
				row[key] = nil
			}
		}
		result = append(result, row)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	return result, nil
}

func (l *plDebugNativeTypeLoader) typeRows(ref plDebugNativeTypeRef, suffix, order string) ([]plDebugNativeMetadataRow, error) {
	if l.legacyTrees != nil && ref.PackageName != nil {
		tree := l.legacyTrees[ref.key()]
		if tree == nil {
			return nil, errors.New("legacy package type has no expanded argument evidence")
		}
		source, ok := l.legacySources[ref.Owner+"\x00"+*ref.PackageName]
		if !ok {
			return nil, errors.New("legacy package compiled source was not frozen")
		}
		node, err := plDebugLegacyDerivedType(tree, source)
		if err != nil {
			return nil, err
		}
		switch suffix {
		case "TYPES":
			return []plDebugNativeMetadataRow{node.Definition}, nil
		case "TYPE_ATTRS":
			return node.Attributes, nil
		case "COLL_TYPES":
			return node.Collections, nil
		default:
			return nil, errors.New("unrecognized legacy type metadata section")
		}
	}
	// suffix/order are local constants, never supplied by a client or dictionary row.
	view := "ALL_" + suffix
	args := []any{ref.Owner, ref.TypeName}
	where := "OWNER=:1 AND TYPE_NAME=:2"
	if ref.PackageName != nil {
		view = "ALL_PLSQL_" + suffix
		where += " AND PACKAGE_NAME=:3"
		args = append(args, *ref.PackageName)
	}
	return l.query("SELECT * FROM SYS."+view+" WHERE "+where+order, args...)
}

func (l *plDebugNativeTypeLoader) version(ref plDebugNativeTypeRef) (plDebugNativeTypeVersion, error) {
	name := ref.TypeName
	kind := "TYPE"
	if ref.PackageName != nil {
		name = *ref.PackageName
		kind = "PACKAGE"
	}
	v, err := l.containerVersion(ref.Owner, name, kind)
	if err != nil || l.legacyTrees == nil || ref.PackageName == nil {
		return v, err
	}
	text, _, err := l.compiledSource(ref.Owner, name)
	if err != nil {
		return v, err
	}
	v.CompiledSource = &text
	key := ref.Owner + "\x00" + name
	if l.legacySources == nil {
		l.legacySources = map[string]plDebugNativeSource{}
	}
	if _, exists := l.legacySources[key]; !exists {
		source := plDebugNativeSource{Owner: ref.Owner, Name: name, ObjectType: "PACKAGE"}
		for i, line := range strings.Split(text, "\n") {
			source.Lines = append(source.Lines, plDebugNativeSourceLine{Number: int64(i + 1), Text: line})
		}
		l.legacySources[key] = source
	}
	return v, nil
}

func (l *plDebugNativeTypeLoader) containerVersion(owner, name, kind string) (plDebugNativeTypeVersion, error) {
	var v plDebugNativeTypeVersion
	v.Reference.Owner = owner
	v.Reference.Name = name
	var err error
	v.Objects, err = l.query("SELECT TO_CHAR(OBJECT_ID,'TM9','NLS_NUMERIC_CHARACTERS=''.,''') OBJECT_ID,OBJECT_TYPE,STATUS,TO_CHAR(LAST_DDL_TIME,'YYYY-MM-DD HH24:MI:SS') LAST_DDL_TIME FROM SYS.ALL_OBJECTS WHERE OWNER=:1 AND OBJECT_NAME=:2 AND OBJECT_TYPE IN (:3,:4) ORDER BY OBJECT_TYPE,OBJECT_ID", owner, name, kind, kind+" BODY")
	if err != nil {
		return v, err
	}
	valid := false
	kinds := map[string]bool{}
	for _, row := range v.Objects {
		objectKind := row.text("OBJECT_TYPE")
		if objectKind == "" || kinds[objectKind] {
			return v, errors.New("duplicate declared container object identity")
		}
		kinds[objectKind] = true
		if row.text("STATUS") != "VALID" {
			return v, errors.New("declared type container is not VALID")
		}
		if row.text("OBJECT_TYPE") == kind {
			if valid {
				return v, errors.New("contradictory declared type container identities")
			}
			valid = true
		}
	}
	if !valid {
		return v, errors.New("declared type container is not visible")
	}
	v.Source, err = l.query("SELECT TYPE,LINE,TEXT FROM SYS.ALL_SOURCE WHERE OWNER=:1 AND NAME=:2 AND TYPE IN (:3,:4) ORDER BY TYPE,LINE", owner, name, kind, kind+" BODY")
	if err != nil {
		return v, err
	}
	lines := map[string]int{}
	for _, row := range v.Source {
		sourceKind := row.text("TYPE")
		number, e := strconv.Atoi(row.text("LINE"))
		if e != nil || !kinds[sourceKind] || number != lines[sourceKind]+1 || row["TEXT"] == nil {
			return v, errors.New("declared container source contains missing, duplicate or incomplete lines")
		}
		lines[sourceKind]++
	}
	for objectKind := range kinds {
		if lines[objectKind] == 0 {
			return v, errors.New("declared container source is not completely visible; refresh its prepared preview")
		}
	}
	return v, err
}

func plDebugLoadNativeTypeGraph(ctx context.Context, conn *sql.Conn, roots []plDebugNativeTypeRef) (plDebugNativeTypeGraph, error) {
	return plDebugLoadNativeTypeGraphWithPreparation(ctx, conn, roots, false)
}

func plDebugLoadNativeTypeGraphWithPreparation(ctx context.Context, conn *sql.Conn, roots []plDebugNativeTypeRef, prepare bool) (plDebugNativeTypeGraph, error) {
	l := plDebugNativeTypeLoader{ctx: ctx, conn: conn}
	return plDebugLoadNativeTypeGraphOnLoader(&l, roots, prepare)
}

func plDebugLoadNativeTypeGraphOnLoader(l *plDebugNativeTypeLoader, roots []plDebugNativeTypeRef, prepare bool) (plDebugNativeTypeGraph, error) {
	ctx, conn := l.ctx, l.conn
	graph := plDebugNativeTypeGraph{Nodes: []plDebugNativeTypeNode{}, Versions: []plDebugNativeTypeVersion{}}
	type pending struct {
		ref   plDebugNativeTypeRef
		depth int
	}
	queue := []pending{}
	for _, ref := range roots {
		queue = append(queue, pending{ref, 0})
	}
	seen := map[string]bool{}
	versions := map[string]plDebugNativeTypeRef{}
	subtypes := map[string][]plDebugNativeMetadataRow{}
	constructorVisibility := map[string]plDebugNativeTypeVisibility{}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		ref := next.ref
		if seen[ref.key()] {
			continue
		}
		if ref.Owner == "" || ref.TypeName == "" || ref.PackageName != nil && *ref.PackageName == "" {
			return graph, errors.New("incomplete declared type identity")
		}
		if next.depth > 16 || len(seen) >= 256 {
			return graph, errors.New("declared type graph budget exceeded")
		}
		versionKey := ref.Owner + "\x00" + ref.TypeName
		if ref.PackageName != nil {
			versionKey = ref.Owner + "\x00" + *ref.PackageName
		}
		if _, ok := versions[versionKey]; !ok {
			v, err := l.version(ref)
			if err != nil {
				return graph, err
			}
			versions[versionKey] = ref
			graph.Versions = append(graph.Versions, v)
		}
		headers, err := l.typeRows(ref, "TYPES", "")
		if err != nil {
			return graph, err
		}
		if len(headers) == 0 && prepare && ref.PackageName != nil {
			access, e := plDebugNativeCheckTypeReference(ctx, conn, ref)
			if e != nil {
				return graph, e
			}
			if access.State != "type_only_verified" {
				return graph, errors.New("declared package type reference preparation failed")
			}
			headers, err = l.typeRows(ref, "TYPES", "")
			if err != nil {
				return graph, err
			}
		}
		if len(headers) != 1 {
			return graph, errors.New("declared type metadata is incomplete or contradictory")
		}
		kind := headers[0].text("TYPECODE")
		if kind != "PL/SQL RECORD" && kind != "COLLECTION" && kind != "OBJECT" {
			return graph, fmt.Errorf("Oracle declared type graph adapter is not yet implemented for %s", kind)
		}
		attrs, err := l.typeRows(ref, "TYPE_ATTRS", " ORDER BY ATTR_NO")
		if err != nil {
			return graph, err
		}
		collections, err := l.typeRows(ref, "COLL_TYPES", "")
		if err != nil {
			return graph, err
		}
		if kind == "COLLECTION" && (len(collections) != 1 || len(attrs) != 0) || kind != "COLLECTION" && len(collections) != 0 {
			return graph, errors.New("contradictory declared type shape")
		}
		seen[ref.key()] = true
		node := plDebugNativeTypeNode{Reference: ref, Definition: headers[0], Attributes: attrs, Collections: collections}
		if l.legacyTrees != nil && ref.PackageName != nil {
			node.LegacyOrigin = &plDebugLegacyTypeOrigin{Source: "argument-tree", Sequence: l.legacyTrees[ref.key()].argument.Sequence}
		}
		if kind == "OBJECT" {
			if ref.PackageName != nil {
				return graph, errors.New("Oracle SQL OBJECT cannot have a package type identity")
			}
			for _, version := range graph.Versions {
				if version.Reference.Owner == ref.Owner && version.Reference.Name == ref.TypeName {
					description := plDebugDescribeNativeConstructors(ref, version.Source)
					node.ConstructorSource = &description
					break
				}
			}
			if node.ConstructorSource != nil && node.ConstructorSource.State == "syntax_parsed" {
				for _, constructor := range node.ConstructorSource.Constructors {
					for _, parameter := range constructor.Parameters {
						visible := []plDebugNativeTypeRef{}
						for _, candidate := range plDebugNativeConstructorReferenceCandidates(ref, parameter) {
							entry, known := constructorVisibility[candidate.key()]
							if !known {
								rows, e := l.typeRows(candidate, "TYPES", "")
								if e != nil {
									return graph, e
								}
								if len(rows) > 1 {
									return graph, errors.New("contradictory constructor type visibility")
								}
								entry = plDebugNativeTypeVisibility{candidate, len(rows) == 1}
								constructorVisibility[candidate.key()] = entry
							}
							node.ConstructorReferences = append(node.ConstructorReferences, entry)
							if entry.Visible {
								visible = append(visible, candidate)
							}
						}
						if len(visible) == 1 {
							queue = append(queue, pending{visible[0], next.depth + 1})
						}
					}
				}
			}
			node.Methods, err = l.query("SELECT * FROM SYS.ALL_TYPE_METHODS WHERE OWNER=:1 AND TYPE_NAME=:2 ORDER BY METHOD_NO", ref.Owner, ref.TypeName)
			if err != nil {
				return graph, err
			}
			node.MethodParameters, err = l.query("SELECT * FROM SYS.ALL_METHOD_PARAMS WHERE OWNER=:1 AND TYPE_NAME=:2 ORDER BY METHOD_NO,PARAM_NO", ref.Owner, ref.TypeName)
			if err != nil {
				return graph, err
			}
			parentOwner, parentName := headers[0]["SUPERTYPE_OWNER"], headers[0]["SUPERTYPE_NAME"]
			if parentOwner != nil || parentName != nil {
				if parentOwner == nil || parentName == nil {
					return graph, errors.New("incomplete Oracle supertype identity")
				}
				queue = append(queue, pending{plDebugNativeTypeRef{Owner: *parentOwner, TypeName: *parentName}, next.depth + 1})
			}
			if headers[0].text("FINAL") == "NO" {
				members, e := l.query("SELECT OWNER,TYPE_NAME FROM SYS.ALL_TYPES WHERE SUPERTYPE_OWNER=:1 AND SUPERTYPE_NAME=:2 ORDER BY OWNER,TYPE_NAME", ref.Owner, ref.TypeName)
				if e != nil {
					return graph, e
				}
				subtypes[ref.key()] = members
				for _, member := range members {
					if member.text("OWNER") == "" || member.text("TYPE_NAME") == "" {
						return graph, errors.New("incomplete Oracle subtype membership")
					}
					queue = append(queue, pending{plDebugNativeTypeRef{Owner: member.text("OWNER"), TypeName: member.text("TYPE_NAME")}, next.depth + 1})
				}
			}
		}
		graph.Nodes = append(graph.Nodes, node)
		for _, part := range []struct {
			rows   []plDebugNativeMetadataRow
			prefix string
		}{{attrs, "ATTR_TYPE_"}, {collections, "ELEM_TYPE_"}} {
			for _, row := range part.rows {
				owner, name, pack := row[part.prefix+"OWNER"], row[part.prefix+"NAME"], row[part.prefix+"PACKAGE"]
				if owner == nil && pack == nil {
					continue
				}
				if owner == nil || name == nil || *name == "" {
					return graph, errors.New("incomplete nested declared type identity")
				}
				queue = append(queue, pending{plDebugNativeTypeRef{*owner, pack, *name}, next.depth + 1})
			}
		}
	}
	for index := range graph.Nodes {
		node := &graph.Nodes[index]
		if (node.Definition.text("TYPECODE") == "OBJECT" || node.LegacyOrigin != nil) && prepare {
			access, err := plDebugNativeCheckTypeReference(ctx, conn, node.Reference)
			if err != nil {
				return graph, err
			}
			node.ObjectAccess = &access
			if node.LegacyOrigin != nil && access.State != "type_only_verified" {
				return graph, errors.New("legacy declared package type reference preparation failed")
			}
		}
	}
	for index := range graph.Nodes {
		node := &graph.Nodes[index]
		if node.Definition.text("TYPECODE") == "OBJECT" {
			calls := plDebugNativeObjectCallables(graph, *node)
			node.ConstructorCalls = &calls
		}
	}
	for _, entry := range constructorVisibility {
		rows, err := l.typeRows(entry.Reference, "TYPES", "")
		if err != nil {
			return graph, err
		}
		if len(rows) > 1 || entry.Visible != (len(rows) == 1) {
			return graph, errors.New("constructor type visibility changed during metadata inspection")
		}
	}
	for _, node := range graph.Nodes {
		if before, ok := subtypes[node.Reference.key()]; ok {
			after, err := l.query("SELECT OWNER,TYPE_NAME FROM SYS.ALL_TYPES WHERE SUPERTYPE_OWNER=:1 AND SUPERTYPE_NAME=:2 ORDER BY OWNER,TYPE_NAME", node.Reference.Owner, node.Reference.TypeName)
			if err != nil {
				return graph, err
			}
			if !reflect.DeepEqual(before, after) {
				return graph, errors.New("Oracle subtype membership changed during metadata inspection")
			}
		}
	}
	for _, before := range graph.Versions {
		key := before.Reference.Owner + "\x00" + before.Reference.Name
		after, err := l.version(versions[key])
		if err != nil {
			return graph, err
		}
		if !reflect.DeepEqual(before, after) {
			return graph, errors.New("declared type source changed during metadata inspection")
		}
	}
	return graph, nil
}
