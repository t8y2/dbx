package main

import (
	"fmt"
	"strings"
)

// Build only the requested dictionary branches. Filtering a complete catalog
// UNION afterwards still gives Oracle expensive object/index views to plan and
// join, even for a single page of tables or triggers.
func oracleRequestedMetadataListQuery(schema, typeOwner string, constraints metadataListConstraints, sessionUser, tablesOnly bool) (oracleMetadataListQuery, bool) {
	kinds := normalizedMetadataObjectTypes(constraints.ObjectTypes)
	if len(kinds) == 0 {
		return oracleMetadataListQuery{}, false
	}
	requested := make(map[string]bool, len(kinds))
	for _, kind := range kinds {
		requested[kind] = true
	}
	prefix := "ALL_"
	if sessionUser {
		prefix = "USER_"
	}
	var args []any
	ownerPredicate := func(alias, owner string) string {
		if sessionUser {
			return "1=1"
		}
		args = append(args, owner)
		return fmt.Sprintf("%s.OWNER = :%d", alias, len(args))
	}
	typeColumn := "OBJECT_TYPE"
	selectList := "OBJECT_NAME, OBJECT_TYPE, COMMENTS, PARENT_SCHEMA, PARENT_NAME"
	orderSQL := oracleListObjectsOrderSQL
	parentColumns := ", CAST(NULL AS VARCHAR2(128)) AS PARENT_SCHEMA, CAST(NULL AS VARCHAR2(128)) AS PARENT_NAME"
	if tablesOnly {
		typeColumn = "TABLE_TYPE"
		selectList = "OBJECT_NAME, TABLE_TYPE, COMMENTS"
		orderSQL = oracleListTablesOrderSQL
		parentColumns = ""
	}
	projection := func(name, kind string) string {
		return fmt.Sprintf("SELECT %s AS OBJECT_NAME, '%s' AS %s, CAST(NULL AS VARCHAR2(4000)) AS COMMENTS%s", name, kind, typeColumn, parentColumns)
	}
	var branches []string
	if requested["TABLE"] {
		mvOwner := "mv.OWNER = t.OWNER AND "
		if sessionUser {
			mvOwner = ""
		}
		branches = append(branches, projection("t.TABLE_NAME", "TABLE")+
			" FROM "+prefix+"TABLES t WHERE "+ownerPredicate("t", schema)+" AND t.NESTED = 'NO'"+
			" AND NOT EXISTS (SELECT 1 FROM "+prefix+"MVIEWS mv WHERE "+mvOwner+"mv.MVIEW_NAME = t.TABLE_NAME)")
	}
	if requested["VIEW"] {
		branches = append(branches, projection("v.VIEW_NAME", "VIEW")+
			" FROM "+prefix+"VIEWS v WHERE "+ownerPredicate("v", schema))
	}
	if requested["MATERIALIZED_VIEW"] {
		branches = append(branches, projection("mv.MVIEW_NAME", "MATERIALIZED_VIEW")+
			" FROM "+prefix+"MVIEWS mv WHERE "+ownerPredicate("mv", schema))
	}
	if !tablesOnly {
		addObjects := func(owner string, supported []string) {
			var objectTypes []string
			for _, kind := range supported {
				if requested[kind] {
					// The names come only from this fixed supported list.
					objectTypes = append(objectTypes, "'"+strings.ReplaceAll(kind, "_", " ")+"'")
				}
			}
			if len(objectTypes) == 0 {
				return
			}
			branches = append(branches, "SELECT o.OBJECT_NAME, REPLACE(o.OBJECT_TYPE, ' ', '_') AS OBJECT_TYPE, "+
				"CAST(NULL AS VARCHAR2(4000)) AS COMMENTS"+parentColumns+
				" FROM "+prefix+"OBJECTS o WHERE "+ownerPredicate("o", owner)+
				" AND o.OBJECT_TYPE IN ("+strings.Join(objectTypes, ",")+")")
		}
		addObjects(schema, []string{"PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"})
		addObjects(typeOwner, []string{"TYPE", "TYPE_BODY"})
		if requested["INDEX"] {
			branches = append(branches, "SELECT i.INDEX_NAME AS OBJECT_NAME, 'INDEX' AS OBJECT_TYPE, "+
				"CAST(NULL AS VARCHAR2(4000)) AS COMMENTS, i.TABLE_OWNER AS PARENT_SCHEMA, i.TABLE_NAME AS PARENT_NAME"+
				" FROM "+prefix+"INDEXES i WHERE "+ownerPredicate("i", schema))
		}
		if requested["SYNONYM"] {
			branches = append(branches, projection("s.SYNONYM_NAME", "SYNONYM")+
				" FROM "+prefix+"SYNONYMS s WHERE "+ownerPredicate("s", schema))
		}
	}
	if len(branches) == 0 {
		// Keep the existing handling of unsupported filter values.
		return oracleMetadataListQuery{}, false
	}
	return oracleConstrainedMetadataListQuery(strings.Join(branches, "\nUNION ALL\n"), selectList, typeColumn, orderSQL, args, constraints), true
}
