package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestRequestedMetadataKindsExcludeUnrelatedDictionaries(t *testing.T) {
	tests := []struct {
		name      string
		kinds     []string
		want      []string
		unrelated []string
	}{
		{"tables", []string{"TABLE"}, []string{"_TABLES", "_MVIEWS"}, []string{"_VIEWS", "_OBJECTS", "_INDEXES", "_SYNONYMS"}},
		{"views", []string{"VIEW"}, []string{"_VIEWS"}, []string{"_TABLES", "_MVIEWS", "_OBJECTS", "_INDEXES", "_SYNONYMS"}},
		{"materialized views", []string{"MATERIALIZED_VIEW"}, []string{"_MVIEWS"}, []string{"_TABLES", "_VIEWS", "_OBJECTS", "_INDEXES", "_SYNONYMS"}},
		{"indexes", []string{"INDEX"}, []string{"_INDEXES", "I.TABLE_OWNER", "I.TABLE_NAME"}, []string{"_TABLES", "_VIEWS", "_MVIEWS", "_OBJECTS", "_SYNONYMS"}},
		{"triggers", []string{"TRIGGER"}, []string{"_OBJECTS", "'TRIGGER'"}, []string{"_TABLES", "_VIEWS", "_MVIEWS", "_INDEXES", "_SYNONYMS", "_SOURCE"}},
		{"routines", []string{"FUNCTION", "PACKAGE_BODY"}, []string{"_OBJECTS", "'FUNCTION'", "'PACKAGE BODY'"}, []string{"_TABLES", "_VIEWS", "_MVIEWS", "_INDEXES", "_SYNONYMS"}},
		{"synonyms", []string{"SYNONYM"}, []string{"_SYNONYMS"}, []string{"_TABLES", "_VIEWS", "_MVIEWS", "_OBJECTS", "_INDEXES"}},
		{"types", []string{"TYPE", "TYPE_BODY"}, []string{"_OBJECTS", "'TYPE'", "'TYPE BODY'"}, []string{"_TABLES", "_VIEWS", "_MVIEWS", "_INDEXES", "_SYNONYMS"}},
	}
	for _, test := range tests {
		for _, ownSchema := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/ownSchema=%t", test.name, ownSchema), func(t *testing.T) {
				constraints := metadataListConstraints{ObjectTypes: test.kinds, Limit: 51, Offset: 100}
				query := oracleListObjectsQuery("APP", constraints)
				if ownSchema {
					query = oracleListSessionUserObjectsQuery(constraints)
				}
				upper := strings.ToUpper(query.SQL)
				for _, want := range test.want {
					if !strings.Contains(upper, want) {
						t.Errorf("requested metadata missing %s: %s", want, query.SQL)
					}
				}
				for _, unrelated := range test.unrelated {
					if strings.Contains(upper, unrelated) {
						t.Errorf("requested kinds %v unnecessarily read %s: %s", test.kinds, unrelated, query.SQL)
					}
				}
				if !strings.Contains(upper, "ROWNUM <=") || !strings.Contains(upper, "DBX_RN >") {
					t.Errorf("requested metadata lost server paging: %s", query.SQL)
				}
			})
		}
	}
}

func TestRequestedTableKindsExcludeUnrelatedDictionaries(t *testing.T) {
	for _, ownSchema := range []bool{false, true} {
		constraints := metadataListConstraints{ObjectTypes: []string{"TABLE"}, Filter: "ord_%", Limit: 20, Offset: 40}
		query := oracleListTablesQuery("APP", constraints)
		if ownSchema {
			query = oracleListSessionUserTablesQuery(constraints)
		}
		upper := strings.ToUpper(query.SQL)
		if strings.Contains(upper, "_VIEWS") || strings.Contains(upper, "_OBJECTS") || strings.Contains(upper, "_INDEXES") {
			t.Errorf("table-only page includes unrelated dictionaries: %s", query.SQL)
		}
		if !strings.Contains(upper, "NOT EXISTS") || !strings.Contains(upper, "MV.MVIEW_NAME = T.TABLE_NAME") {
			t.Errorf("materialized view backing tables must remain excluded: %s", query.SQL)
		}
		if !reflect.DeepEqual(query.Args[len(query.Args)-4:], []any{"%O%R%D%\\_%\\%%", "TABLE", 60, 40}) {
			t.Errorf("filter or paging changed: %#v", query.Args)
		}
	}
}
