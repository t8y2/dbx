package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func (s *server) routineCatalog() (string, string) {
	if s.mode.postgresCatalog {
		return "pg_catalog", "pg"
	}
	return "sys_catalog", "sys"
}

// Retry only missing catalog capabilities. Permission, transport and scan
// failures must not turn a partially loaded routine list into a success.
func (s *server) routineQuery(withIdentity bool, build func(kind, filter, identity string) string) (*sql.Rows, error) {
	return s.routineQueryContext(context.Background(), withIdentity, build)
}

func (s *server) routineQueryContext(ctx context.Context, withIdentity bool, build func(kind, filter, identity string) string) (*sql.Rows, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	_, prefix := s.routineCatalog()
	for {
		kind := "CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'f' THEN 'FUNCTION' END"
		filter := "p.prokind IN ('p', 'f')"
		if s.routineKindUnsupported {
			// Preserve the pre-prokind Kingbase catalog behavior only after the
			// server explicitly reports that the modern discriminator is absent.
			kind = "CASE WHEN p.prorettype = 2278 THEN 'PROCEDURE' ELSE 'FUNCTION' END"
			filter = "true"
		}
		identityFunction := prefix + "_get_function_identity_arguments"
		identity := identityFunction + "(p.oid)"
		if s.routineIdentityFallback == 1 {
			identityFunction = "pg_get_function_identity_arguments"
			identity = identityFunction + "(p.oid)"
		} else if s.routineIdentityFallback == 2 {
			identityFunction = "oidvectortypes"
			identity = identityFunction + "(p.proargtypes)"
		}
		rows, err := db.QueryContext(ctx, build(kind, filter, identity))
		if err == nil {
			return rows, nil
		}
		if !s.routineKindUnsupported && isUndefinedColumn(err, "prokind") {
			s.routineKindUnsupported = true
			continue
		}
		if withIdentity && s.routineIdentityFallback < 2 && isUndefinedFunction(err, identityFunction) {
			if identityFunction == "sys_get_function_identity_arguments" {
				s.routineIdentityFallback = 1
			} else {
				s.routineIdentityFallback = 2
			}
			continue
		}
		return nil, err
	}
}

func (s *server) listRoutineObjects(schema string) ([]objectInfo, error) {
	catalog, prefix := s.routineCatalog()
	rows, err := s.routineQuery(true, func(kind, filter, identity string) string {
		return fmt.Sprintf(`SELECT p.proname, %s, d.description, %s AS signature
FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid = p.pronamespace
LEFT JOIN %s.%s_description d ON d.objoid = p.oid AND d.objsubid = 0
WHERE n.nspname = %s AND %s ORDER BY p.proname, signature`, kind, identity, catalog, prefix, catalog, prefix, catalog, prefix, quoteLiteral(schema), filter)
	})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []objectInfo{}
	for rows.Next() {
		var name, kind, signature string
		var comment sql.NullString
		if err := rows.Scan(&name, &kind, &comment, &signature); err != nil {
			return nil, err
		}
		// Empty identifies the zero-argument overload and must survive JSON.
		result = append(result, objectInfo{Name: name, ObjectType: kind, Schema: schema, Comment: nullStringPtr(comment), Signature: &signature})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *server) getRoutineSource(schema, name, kind string, signature *string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), metadataTimeout)
	defer cancel()
	catalog, prefix := s.routineCatalog()
	function := prefix + "_get_functiondef"
	if s.usePgFunctionDefinition {
		function = "pg_get_functiondef"
	}
	querySource := func(definitionFunction string) (string, error) {
		rows, err := s.routineQueryContext(ctx, signature != nil, func(kindExpression, filter, identity string) string {
			if signature != nil {
				filter += " AND " + identity + " = " + quoteLiteral(*signature)
			}
			return fmt.Sprintf("SELECT %s(p.oid) FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid=p.pronamespace WHERE n.nspname=%s AND p.proname=%s AND (%s)=%s AND %s ORDER BY p.oid LIMIT 2", definitionFunction, catalog, prefix, catalog, prefix, quoteLiteral(schema), quoteLiteral(name), kindExpression, quoteLiteral(kind), filter)
		})
		if err != nil {
			return "", err
		}
		defer rows.Close()
		var source sql.NullString
		count := 0
		for rows.Next() {
			if err := rows.Scan(&source); err != nil {
				return "", err
			}
			count++
		}
		if err := rows.Err(); err != nil {
			return "", err
		}
		if count > 1 {
			return "", fmt.Errorf("routine %q.%q is ambiguous; signature is required to select an overload", schema, name)
		}
		if count == 0 || !source.Valid || strings.TrimSpace(source.String) == "" {
			return "", fmt.Errorf("routine %q.%q with the requested type and signature does not exist or its source is unavailable", schema, name)
		}
		return source.String, nil
	}
	if s.useLegacyRoutineDefinition {
		return s.getLegacyRoutineSource(ctx, schema, name, kind, signature)
	}
	source, err := querySource(function)
	if err != nil && function == "sys_get_functiondef" && isUndefinedFunction(err, function) {
		s.usePgFunctionDefinition = true
		function = "pg_get_functiondef"
		source, err = querySource(function)
	}
	if err != nil && !s.mode.postgresCatalog && function == "pg_get_functiondef" && isUndefinedFunction(err, function) {
		s.useLegacyRoutineDefinition = true
		return s.getLegacyRoutineSource(ctx, schema, name, kind, signature)
	}
	return source, err
}

func (s *server) getLegacyRoutineSource(ctx context.Context, schema, name, kind string, signature *string) (string, error) {
	catalog, prefix := s.routineCatalog()
	countMatches := func(matchSignature bool) (int, error) {
		rows, err := s.routineQueryContext(ctx, matchSignature, func(kindExpression, filter, identity string) string {
			if matchSignature {
				filter += " AND " + identity + " = " + quoteLiteral(*signature)
			}
			return fmt.Sprintf("SELECT COUNT(*) FROM %s.%s_proc p JOIN %s.%s_namespace n ON n.oid=p.pronamespace WHERE n.nspname=%s AND p.proname=%s AND (%s)=%s AND %s", catalog, prefix, catalog, prefix, quoteLiteral(schema), quoteLiteral(name), kindExpression, quoteLiteral(kind), filter)
		})
		if err != nil {
			return 0, err
		}
		defer rows.Close()
		var count int
		for rows.Next() {
			if err := rows.Scan(&count); err != nil {
				return 0, err
			}
		}
		return count, rows.Err()
	}
	// The V7 DDL API takes only a name. Even a supplied signature cannot make
	// that API choose between overloads, so only a unique routine is safe.
	count, err := countMatches(false)
	if err != nil {
		return "", err
	}
	if count > 1 {
		return "", fmt.Errorf("legacy routine source API cannot select overloaded routine %q.%q", schema, name)
	}
	if count == 1 && signature != nil {
		count, err = countMatches(true)
		if err != nil {
			return "", err
		}
	}
	if count != 1 {
		return "", fmt.Errorf("routine %q.%q with the requested type and signature does not exist", schema, name)
	}
	function := "GET_FUNC_DDL"
	if kind == "PROCEDURE" {
		function = "GET_PROCEDURE_DDL"
	}
	query := fmt.Sprintf("SELECT DBMS_METADATA.%s(CAST(%s AS varchar(128)), CAST(%s AS varchar(128)))", function, quoteLiteral(name), quoteLiteral(schema))
	var source sql.NullString
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}
	if err := db.QueryRowContext(ctx, query).Scan(&source); err != nil {
		return "", err
	}
	if !source.Valid || strings.TrimSpace(source.String) == "" {
		return "", fmt.Errorf("routine %q.%q source is unavailable", schema, name)
	}
	return source.String, nil
}
