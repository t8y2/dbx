package main

import (
	"sort"

	nebula "github.com/vesoft-inc/nebula-go/v3"
)

func appendDisplayText(parts *[]any, text string) {
	if len(*parts) > 0 {
		if previous, ok := (*parts)[len(*parts)-1].(string); ok && len(previous)+len(text) <= 4096 {
			(*parts)[len(*parts)-1] = previous + text
			return
		}
	}
	*parts = append(*parts, text)
}

// Retain scalar text and ordered references instead of reparsing displayed nGQL.
func appendGraphDisplay(value *nebula.ValueWrapper, parts *[]any) {
	switch {
	case value.IsVertex():
		if node, err := value.AsNode(); err == nil {
			*parts = append(*parts, map[string]string{"nodeId": graphPlaceholder(node.GetID()).ID})
			return
		}
	case value.IsEdge():
		if edge, err := value.AsRelationship(); err == nil {
			*parts = append(*parts, map[string]string{"edgeId": graphEdgeFromNebula(edge).ID})
			return
		}
	case value.IsPath():
		if path, err := value.AsPath(); err == nil {
			nodes, edges := path.GetNodes(), path.GetRelationships()
			if len(nodes) == len(edges)+1 {
				appendDisplayText(parts, "<")
				*parts = append(*parts, map[string]string{"nodeId": graphPlaceholder(nodes[0].GetID()).ID})
				for index, edge := range edges {
					identity := graphEdgeFromNebula(edge)
					forward := graphPlaceholder(nodes[index].GetID()).ID == identity.Source
					if forward {
						appendDisplayText(parts, "-")
					} else {
						appendDisplayText(parts, "<-")
					}
					*parts = append(*parts, map[string]any{"edgeId": identity.ID, "path": true})
					if forward {
						appendDisplayText(parts, "->")
					} else {
						appendDisplayText(parts, "-")
					}
					*parts = append(*parts, map[string]string{"nodeId": graphPlaceholder(nodes[index+1].GetID()).ID})
				}
				appendDisplayText(parts, ">")
				return
			}
		}
	case value.IsList():
		if values, err := value.AsList(); err == nil {
			appendGraphDisplayList(values, parts, "[", "]")
			return
		}
	case value.IsSet():
		if values, err := value.AsDedupList(); err == nil {
			appendGraphDisplayList(values, parts, "{", "}")
			return
		}
	case value.IsMap():
		if values, err := value.AsMap(); err == nil {
			keys := make([]string, 0, len(values))
			for key := range values {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			appendDisplayText(parts, "{")
			for index, key := range keys {
				if index > 0 {
					appendDisplayText(parts, ", ")
				}
				appendDisplayText(parts, key+": ")
				item := values[key]
				appendGraphDisplay(&item, parts)
			}
			appendDisplayText(parts, "}")
			return
		}
	}
	if value.IsFloat() {
		appendDisplayText(parts, normalizeValue(value).(string))
	} else {
		appendDisplayText(parts, value.String())
	}
}

func appendGraphDisplayList(values []nebula.ValueWrapper, parts *[]any, open, close string) {
	appendDisplayText(parts, open)
	for index := range values {
		if index > 0 {
			appendDisplayText(parts, ", ")
		}
		appendGraphDisplay(&values[index], parts)
	}
	appendDisplayText(parts, close)
}
