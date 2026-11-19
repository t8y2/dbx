"""DB2 catalog/write identity proof; run remotely with db2.env loaded (no secrets printed)."""
import json
import os
import subprocess
import uuid

schema = os.environ["DB2INSTANCE"].upper()
base = "DBX_CASE_" + uuid.uuid4().hex[:12].upper()
names = [base, base.lower(), "Dbx_Case_" + base[9:].lower()]
process = subprocess.Popen(
    ["java", "-jar", os.environ["DBX_DB2_AGENT_JAR"]],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, universal_newlines=True,
)
assert json.loads(process.stdout.readline())["ready"]
request_id = 0
created = []
created_schemas = []


def rpc(method, **params):
    global request_id
    request_id += 1
    params["agentSessionId"] = "identifier-proof"
    process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
    process.stdin.flush()
    return json.loads(process.stdout.readline())


def call(method, **params):
    response = rpc(method, **params)
    if "error" in response:
        raise RuntimeError(method + ": " + json.dumps(response["error"]))
    return response["result"]


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def target(name, target_schema=schema):
    return quote(target_schema) + "." + quote(name)


def query(sql, execution_schema=schema):
    return call("execute_query", sql=sql, schema=execution_schema, maxRows=10, timeoutSecs=15)


try:
    call("open_session", host="127.0.0.1", port=50000, database=os.environ["DBNAME"],
         username=os.environ["DB2INSTANCE"], password=os.environ["DB2INST1_PASSWORD"])
    query("CREATE TABLE " + target(base) + " (TEST_TX1ID INTEGER NOT NULL PRIMARY KEY, DESCRIPTION VARCHAR(100))")
    created.append((schema, base))
    query("INSERT INTO " + target(base) + " VALUES (7, 'upper')")
    row = query("select * from " + base.lower())["rows"][0]
    assert int(row[0]) == 7 and row[1] == "upper", row
    assert call("get_columns", schema=schema, table=base.lower()) == []
    failure = rpc("execute_query", sql="UPDATE " + target(base.lower()) + " SET DESCRIPTION='bad' WHERE TEST_TX1ID=7", schema=schema)
    assert "-204" in json.dumps(failure.get("error", {})), failure
    print("BASELINE: unquoted lowercase SELECT succeeds; lowercase catalog lookup misses; quoted lowercase UPDATE returns -204")
    for name, value in zip(names[1:], ["lower", "mixed"]):
        query("CREATE TABLE " + target(name) + " (TEST_TX1ID INTEGER NOT NULL PRIMARY KEY, DESCRIPTION VARCHAR(100))")
        created.append((schema, name))
        query("INSERT INTO " + target(name) + " VALUES (7, '" + value + "')")
    for name, original in zip(names, ["upper", "lower", "mixed"]):
        columns = call("get_columns", schema=schema, table=name)
        assert [column["name"] for column in columns if column["is_primary_key"]] == ["TEST_TX1ID"], columns
        ddl = call("get_table_ddl", schema=schema, table=name)
        assert "TEST_TX1ID" in ddl and "DESCRIPTION" in ddl, ddl
        query("UPDATE " + target(name) + " SET \"DESCRIPTION\"='" + original + "-saved' WHERE \"TEST_TX1ID\"=7")
        row = query("SELECT * FROM " + target(name))["rows"][0]
        assert int(row[0]) == 7 and row[1] == original + "-saved", row
        print("PASS: " + name + " exact catalog identity, primary key, DDL and quoted UPDATE")
    # These are simultaneously existing, distinct physical objects. Unquoted SQL
    # must select the uppercase one even when a lowercase exact spelling exists.
    assert query("select * from " + schema.lower() + "." + base.lower())["rows"][0][1] == "upper-saved"
    print("PASS: unquoted schema/table select uppercase object; quoted lowercase/mixed objects remain distinct")
    namespace = "Dbx_Schema_" + uuid.uuid4().hex[:12]
    namespaces = [namespace.upper(), namespace.lower(), namespace]
    for selected_schema in namespaces:
        query("CREATE SCHEMA " + quote(selected_schema))
        created_schemas.append(selected_schema)
        query("CREATE TABLE " + target(base, selected_schema) + " (TEST_TX1ID INTEGER NOT NULL PRIMARY KEY, DESCRIPTION VARCHAR(100))")
        created.append((selected_schema, base))
        query("INSERT INTO " + target(base, selected_schema) + " VALUES (7, '" + selected_schema + "')")
    for selected_schema in namespaces:
        # DB2's selected execution schema is exact, even for unquoted table SQL.
        row = query("select * from " + base.lower(), selected_schema)["rows"][0]
        assert row[1] == selected_schema, row
        columns = call("get_columns", schema=selected_schema, table=base)
        assert [column["name"] for column in columns if column["is_primary_key"]] == ["TEST_TX1ID"]
        ddl = call("get_table_ddl", schema=selected_schema, table=base)
        assert "TEST_TX1ID" in ddl and "DESCRIPTION" in ddl
        query("UPDATE " + target(base, selected_schema) + " SET DESCRIPTION='" + selected_schema + "-saved' WHERE TEST_TX1ID=7", selected_schema)
    for selected_schema in namespaces:
        assert query("SELECT * FROM " + target(base, selected_schema))["rows"][0][1] == selected_schema + "-saved"
    print("PASS: selected uppercase/lowercase/mixed schemas preserve exact SELECT, catalog, DDL and write targets with same-named tables")
finally:
    try:
        for table_schema, name in reversed(created):
            query("DROP TABLE " + target(name, table_schema))
        for created_schema in reversed(created_schemas):
            query("DROP SCHEMA " + quote(created_schema) + " RESTRICT")
        print("CLEANUP: dropped " + str(len(created)) + " random proof tables")
        print("CLEANUP: dropped " + str(len(created_schemas)) + " random proof schemas")
        call("close_session")
    finally:
        process.stdin.close()
        process.wait(timeout=20)
