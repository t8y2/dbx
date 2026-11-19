package main

import "encoding/json"

func (encoder plDebugCompositeEncoder) objectHeader(node plDebugNativeTypeNode) string {
	p := encoder.prefix
	identity, _ := json.Marshal(node.Reference)
	declared := "COALESCE(DECLARED_REF," + plDebugSQLLiteral(string(identity)) + ")"
	sql := " IF V IS NULL THEN " + p + "APP('{\"kind\":\"object\",\"state\":\"null\",\"declaredType\":'||" + declared + "||',\"actualType\":null,\"fields\":null,\"complete\":true}'); RETURN; END IF;\n"
	if node.Definition.text("FINAL") == "NO" {
		sql += " IF V IS OF (ONLY " + node.Reference.declaration() + ") THEN NULL;\n"
		graph := plDebugNativeTypeGraph{Nodes: encoder.nodes}
		for _, candidate := range encoder.nodes {
			if candidate.Reference.key() == node.Reference.key() || !plDebugNativeObjectAssignable(graph, candidate.Reference, node.Reference) {
				continue
			}
			kind := candidate.Reference.declaration()
			sql += " ELSIF V IS OF (ONLY " + kind + ") THEN\n DECLARE CHILD " + kind + "; BEGIN CHILD:=TREAT(V AS " + kind + "); IF CHILD IS NULL THEN RAISE_APPLICATION_ERROR(-20993,'Object subtype conversion returned NULL'); END IF;\n " + encoder.procedures[candidate.Reference.key()] + "(CHILD,D," + declared + "); RETURN; END;\n"
		}
		sql += " ELSE " + p + "ERRORS:=" + p + "ERRORS+1; " + p + "APP('{\"kind\":\"object\",\"state\":\"partial\",\"error\":\"actual_type_unresolved\",\"declaredType\":'||" + declared + "||',\"actualType\":null,\"fields\":null,\"complete\":false}'); RETURN; END IF;\n"
	}
	return sql + " " + p + "APP('{\"kind\":\"object\",\"declaredType\":'||" + declared + "||" + plDebugSQLLiteral(",\"actualType\":"+string(identity)+",\"fields\":{") + ");\n"
}
