"""JSON-RPC boundary fixture; tests call production snapshot/preview/apply."""
import json
import re
import sys
from pathlib import Path

transcript = Path(sys.argv[1])
config = json.loads(sys.argv[2])
queries = []
revoked = False
permission_reads = 0
actor = config.get("actor", "Admin")
grantor = config.get("grantor", "Owner")


def result(rows, columns=()):
    if rows and isinstance(rows[0], dict):
        columns = list(rows[0])
        rows = [[row.get(column) for column in columns] for row in rows]
    return {"columns": list(columns), "rows": rows, "affected_rows": 0,
            "execution_time_ms": 0, "truncated": False, "has_more": False}


def query(sql):
    global revoked, permission_reads
    # Old OB implementation must fail rather than accidentally pass the fixture.
    if "SESSION_PRIVS" in sql or "SESSION_ROLES" in sql:
        if "SYS.SESSION_PRIVS" not in sql:
            raise ValueError("ORA-00942 SESSION_PRIVS does not exist")
        if config.get("permissionError"):
            raise ValueError("ORA-01031 private-driver-detail")
        return result([{"PRIVILEGE": "GRANT ANY OBJECT PRIVILEGE"}] if config.get("directPrivilege") else [], ["PRIVILEGE"])
    if "FROM SYS.USER_SYS_PRIVS" in sql:
        permission_reads += 1
        if config.get("permissionError"):
            raise ValueError("ORA-01031 private-driver-detail")
        if config.get("permissionLostAfterPreview") and permission_reads > 1:
            return result([], ["USERNAME", "PRIVILEGE"])
        return result([{"USERNAME": actor, "PRIVILEGE": "GRANT ANY OBJECT PRIVILEGE"}] if config.get("directPrivilege") else [], ["USERNAME", "PRIVILEGE"])
    if "FROM SYS.DBA_SYS_PRIVS" in sql:
        if config.get("permissionError") or config.get("roleDictionaryError"):
            raise ValueError("ORA-01031 private-driver-detail")
        rows = []
        if config.get("directPrivilege") and not config.get("permissionLostAfterPreview"):
            rows.append({"GRANTEE": actor, "PRIVILEGE": "GRANT ANY OBJECT PRIVILEGE"})
        if config.get("rolePrivilege"):
            rows.append({"GRANTEE": "R", "PRIVILEGE": "GRANT ANY OBJECT PRIVILEGE"})
        return result(rows, ["GRANTEE", "PRIVILEGE"])
    if "FROM DBA_ROLES" in sql:
        return result([{"ROLE": "R", "PASSWORD_REQUIRED": "NO"}])
    if "FROM DBA_ROLE_PRIVS" in sql:
        return result([] if config.get("noRoleGrant") else [{"GRANTEE": actor, "GRANTED_ROLE": "R", "ADMIN_OPTION": "NO", "DEFAULT_ROLE": "YES"}])
    if "FROM DBA_USERS" in sql:
        name = re.search(r"USERNAME = '((?:''|[^'])*)'", sql).group(1).replace("''", "'")
        return result([{"USERNAME": name, "USER_ID": "42", "CREATED": "2026-01-01 00:00:00"}] if name == "U" else [])
    if sql == "SELECT USER AS ACTOR FROM DUAL":
        return result([{"ACTOR": actor}])
    if "FROM DBA_SYS_PRIVS" in sql:
        return result([], ["GRANTEE", "PRIVILEGE", "ADMIN_OPTION"])
    if "FROM DBA_OBJECTS" in sql:
        return result([{"OWNER": "Owner", "OBJECT_NAME": "T", "OBJECT_TYPE": "TABLE", "OBJECT_ID": "99"}])
    if "FROM DBA_DEPENDENCIES" in sql or "FROM DBA_COL_PRIVS" in sql:
        return result([])
    if "FROM DBA_TAB_PRIVS" in sql:
        return result([] if revoked else [{"GRANTEE": "U", "OWNER": "Owner", "TABLE_NAME": "T", "GRANTOR": grantor, "PRIVILEGE": "SELECT", "GRANTABLE": "NO"}])
    if sql == 'REVOKE SELECT ON "Owner"."T" FROM "U"':
        revoked = True
        return result([])
    raise ValueError("Unexpected SQL in Agent boundary fixture: " + sql)


print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    sql = request["params"]["sql"]
    queries.append(sql)
    transcript.write_text(json.dumps(queries), encoding="utf-8")
    response = {"jsonrpc": "2.0", "id": request["id"]}
    try:
        response["result"] = query(sql)
    except ValueError as error:
        response["error"] = {"code": -1, "message": str(error)}
    print(json.dumps(response), flush=True)
