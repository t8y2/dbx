package main

import (
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"strings"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
)

type graphVID struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type graphProperty struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value any    `json:"value"`
}

type graphNode struct {
	ID         string          `json:"id"`
	VID        graphVID        `json:"vid"`
	Labels     []string        `json:"labels"`
	Properties []graphProperty `json:"properties"`
}

type graphEdge struct {
	ID         string          `json:"id"`
	VID        graphVID        `json:"vid"`
	Source     string          `json:"source"`
	Target     string          `json:"target"`
	SourceVID  graphVID        `json:"sourceVid"`
	TargetVID  graphVID        `json:"targetVid"`
	Type       string          `json:"type"`
	Properties []graphProperty `json:"properties"`
}

type graphCell struct {
	*nodeCell
	Marker       string      `json:"__dbx_graph_cell"`
	Kind         string      `json:"kind"`
	Display      any         `json:"display"`
	Nodes        []graphNode `json:"nodes"`
	Edges        []graphEdge `json:"edges"`
	DisplayParts []any       `json:"displayParts,omitempty"`
}

func normalizeGraphQueryValue(value any, legacyIDs bool) any {
	display := normalizeQueryValue(value)
	cell := &graphCell{Marker: "neo4j-v1", Kind: strings.ToLower(neo4jTypeName(value)), Display: display, Nodes: []graphNode{}, Edges: []graphEdge{}}
	if node, ok := value.(neo4j.Node); ok {
		tableCell := normalizeNodeCell(node)
		cell.nodeCell = &tableCell
		cell.Kind = "vertex"
	}
	if _, ok := value.(neo4j.Relationship); ok {
		cell.Kind = "edge"
	}
	appendGraphValue(value, cell, legacyIDs)
	if len(cell.Nodes) == 0 && len(cell.Edges) == 0 {
		return display
	}
	if cell.Kind != "vertex" && cell.Kind != "edge" {
		appendGraphDisplay(value, &cell.DisplayParts, legacyIDs)
	}
	return cell
}

// Keep scalar JSON tokens intact while retaining references to editable entities.
func appendDisplayText(parts *[]any, text string) {
	if len(*parts) > 0 {
		if previous, ok := (*parts)[len(*parts)-1].(string); ok && len(previous)+len(text) <= 4096 {
			(*parts)[len(*parts)-1] = previous + text
			return
		}
	}
	*parts = append(*parts, text)
}

func appendGraphDisplay(value any, parts *[]any, legacyIDs bool) {
	switch typed := value.(type) {
	case neo4j.Node:
		*parts = append(*parts, map[string]string{"nodeId": graphIdentity("vertex", graphVIDFor(typed.ElementId, typed.Id, legacyIDs))})
	case neo4j.Relationship:
		*parts = append(*parts, map[string]string{"edgeId": graphIdentity("edge", graphVIDFor(typed.ElementId, typed.Id, legacyIDs))})
	case neo4j.Path:
		appendDisplayText(parts, `{"nodes":`)
		appendGraphDisplay(typed.Nodes, parts, legacyIDs)
		appendDisplayText(parts, `,"relationships":`)
		appendGraphDisplay(typed.Relationships, parts, legacyIDs)
		appendDisplayText(parts, "}")
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		appendDisplayText(parts, "{")
		for index, key := range keys {
			if index > 0 {
				appendDisplayText(parts, ",")
			}
			appendDisplayText(parts, formatJSONValue(key)+":")
			appendGraphDisplay(typed[key], parts, legacyIDs)
		}
		appendDisplayText(parts, "}")
	default:
		value := reflect.ValueOf(value)
		if value.IsValid() && (value.Kind() == reflect.Slice || value.Kind() == reflect.Array) {
			appendDisplayText(parts, "[")
			for i := 0; i < value.Len(); i++ {
				if i > 0 {
					appendDisplayText(parts, ",")
				}
				appendGraphDisplay(value.Index(i).Interface(), parts, legacyIDs)
			}
			appendDisplayText(parts, "]")
		} else {
			appendDisplayText(parts, formatJSONValue(typed))
		}
	}
}

func graphVIDFor(elementID string, legacyID int64, legacyIDs bool) graphVID {
	if legacyIDs {
		return graphVID{Type: "neo4j-id", Value: strconv.FormatInt(legacyID, 10)}
	}
	return graphVID{Type: "neo4j-element-id", Value: elementID}
}

func graphIdentity(kind string, vid graphVID) string {
	encoded, _ := json.Marshal([]string{kind, vid.Type, vid.Value})
	return string(encoded)
}

func graphPlaceholder(elementID string, legacyID int64, legacyIDs bool) graphNode {
	vid := graphVIDFor(elementID, legacyID, legacyIDs)
	return graphNode{ID: graphIdentity("vertex", vid), VID: vid, Labels: []string{}, Properties: []graphProperty{}}
}

func graphProperties(properties map[string]any) []graphProperty {
	result := make([]graphProperty, 0, len(properties))
	for name, value := range properties {
		property := graphProperty{Name: name, Type: neo4jTypeName(value), Value: normalizeQueryValue(value)}
		switch typed := value.(type) {
		case string:
			property.Type = "string"
		case bool:
			property.Type, property.Value = "bool", typed
		case int, int64:
			property.Type = "int"
		case float64:
			property.Type = "float"
		case []byte:
			property.Value = formatJSONValue(typed)
		}
		result = append(result, property)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func appendGraphValue(value any, cell *graphCell, legacyIDs bool) {
	switch typed := value.(type) {
	case neo4j.Node:
		node := graphPlaceholder(typed.ElementId, typed.Id, legacyIDs)
		node.Labels = append(node.Labels, typed.Labels...)
		node.Properties = graphProperties(typed.Props)
		cell.Nodes = append(cell.Nodes, node)
	case neo4j.Relationship:
		source := graphPlaceholder(typed.StartElementId, typed.StartId, legacyIDs)
		target := graphPlaceholder(typed.EndElementId, typed.EndId, legacyIDs)
		vid := graphVIDFor(typed.ElementId, typed.Id, legacyIDs)
		cell.Nodes = append(cell.Nodes, source, target)
		cell.Edges = append(cell.Edges, graphEdge{ID: graphIdentity("edge", vid), VID: vid, Source: source.ID, Target: target.ID, SourceVID: source.VID, TargetVID: target.VID, Type: typed.Type, Properties: graphProperties(typed.Props)})
	case neo4j.Path:
		for _, node := range typed.Nodes {
			appendGraphValue(node, cell, legacyIDs)
		}
		for _, edge := range typed.Relationships {
			appendGraphValue(edge, cell, legacyIDs)
		}
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			appendGraphValue(typed[key], cell, legacyIDs)
		}
	case []byte:
		return
	default:
		value := reflect.ValueOf(value)
		if value.IsValid() && (value.Kind() == reflect.Slice || value.Kind() == reflect.Array) {
			for i := 0; i < value.Len(); i++ {
				appendGraphValue(value.Index(i).Interface(), cell, legacyIDs)
			}
		}
	}
}
