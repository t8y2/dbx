#!/usr/bin/env python3
"""Deterministic transfer dictionaries and concurrent/lost-response faults via Agent RPC."""
import json
import os
import pathlib
import sys

root = next(parent for parent in pathlib.Path(__file__).parents if parent.name == 'agents')
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with (root / 'requests.jsonl').open('a') as output:
        output.write(json.dumps(request) + '\n')
    mode = json.loads((root / 'transfer.json').read_text())
    method = request['method']
    params = request.get('params', {})
    sql = params.get('sql', '')
    target = params.get('database') == 'TARGET_DB' or params.get('schema') == 'DST'
    schema = 'DST' if target else 'SRC'
    current_path = root / 'target-package.json'
    current = json.loads(current_path.read_text()) if current_path.exists() else {
        'spec': mode['old_spec'], 'body': mode['old_body'], 'status': 'VALID'}
    result = {}
    error = None
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method in ('open_session', 'close_session', 'connect', 'disconnect', 'shutdown', 'cancel'):
        pass
    elif method in ('validate_connection', 'test_connection'):
        result = {'ok': True}
    elif method == 'connection_info':
        result = {'identifierQuote': '"'}
    elif method == 'database_link_secure_v1_info':
        result = {'supported': True}
    elif method == 'list_objects':
        result = [{'name': 'T', 'schema': schema, 'object_type': 'TYPE'}]
    elif method == 'get_object_source':
        body = params['object_type'] in ('PACKAGE_BODY', 'package_body', 'PackageBody')
        source = current['body' if body else 'spec'] if target else mode['source_body' if body else 'source_spec']
        result = {'name': params['name'], 'schema': schema, 'object_type': params['object_type'], 'source': source}
    elif method == 'execute_query':
        rows = []
        if sql.lstrip().upper().startswith('CREATE OR REPLACE PACKAGE'):
            body = 'PACKAGE BODY' in sql.upper()
            current['body' if body else 'spec'] = sql
            fault = mode.get('package_fault')
            if fault == 'concurrent':
                current['body' if body else 'spec'] = mode['concurrent_body' if body else 'concurrent_spec']
            if fault == 'invalid':
                current['status'] = 'INVALID'
            current_path.write_text(json.dumps(current))
            (root / 'package-written').write_text('done')
            if fault == 'lost-response':
                # Actual transport EOF after the write, not a synthetic SQL rejection.
                os._exit(0)
            if fault == 'wait-for-cancel':
                import time
                while not (root / 'cancel-confirmed').exists():
                    time.sleep(0.01)
                error = 'Query cancelled; write outcome is unknown'
        elif 'SESSION_PRIVS' in sql:
            if mode['engine'] == 'oceanbase':
                error = 'ORA-00942: SESSION_PRIVS does not exist'
            else:
                rows = [[privilege] for privilege in mode.get('direct', [])]
        elif 'USER_SYS_PRIVS' in sql:
            rows = [[privilege] for privilege in mode.get('direct', [])]
        elif 'USER_ROLE_PRIVS' in sql or 'DBA_SYS_PRIVS' in sql:
            rows = [['ROLE_WITH_CREATE']]
        elif 'OB_VERSION()' in sql:
            rows = [['4.2.5.6']]
        elif 'V$VERSION' in sql:
            rows = [['4.2.5.6' if mode['engine'] == 'oceanbase' else 'Oracle Database 19c Enterprise Edition 19.0.0.0']]
        elif sql == 'SELECT USER FROM DUAL' or "'CURRENT_USER'" in sql:
            rows = [[schema]]
        elif 'ALL_DB_LINKS' in sql:
            rows = [] if target else [['SRC', 'L', 'REMOTE_USER', 'remote-service']]
        elif 'SELECT OWNER, SYNONYM_NAME' in sql:
            rows = [['SRC', 'S', 'EXT', 'BASE', '']] if "OWNER = 'SRC'" in sql else []
        elif 'SELECT OBJECT_TYPE FROM ALL_OBJECTS' in sql:
            if "OBJECT_NAME = 'BASE'" in sql:
                rows = [['TABLE']]
            elif "OBJECT_NAME = 'P'" in sql:
                rows = [['PACKAGE'], ['PACKAGE BODY']]
        elif 'SELECT STATUS FROM ALL_OBJECTS' in sql:
            if "OBJECT_NAME = 'P'" in sql:
                rows = [[current['status'] if target else 'VALID']]
        elif 'SELECT OBJECT_TYPE, STATUS' in sql:
            rows = [['TYPE', 'VALID']]
        elif 'SELECT T.TYPECODE' in sql:
            rows = [['OBJECT']]
        elif 'SELECT TEXT FROM ALL_SOURCE' in sql:
            rows = [['CREATE OR REPLACE TYPE T AS OBJECT (N NUMBER);']]
        elif 'ALL_ARGUMENTS' in sql:
            rows = []
        elif 'ALL_ERRORS' in sql:
            rows = [[1, 2, 'PLS-00323: declaration mismatch']]
        elif 'ALL_DEPENDENCIES' in sql or 'ALL_TAB_PRIVS' in sql or 'DBA_DEPENDENCIES' in sql:
            rows = []
        else:
            error = 'Unsupported fixture dictionary query: ' + sql
        result = {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0,
                  'truncated': bool(mode.get('truncate_privileges') and ('SESSION_PRIVS' in sql or 'USER_SYS_PRIVS' in sql)),
                  'has_more': bool(mode.get('more_privileges') and ('SESSION_PRIVS' in sql or 'USER_SYS_PRIVS' in sql))}
    else:
        error = 'Unsupported fixture method: ' + method
    response = {'jsonrpc': '2.0', 'id': request['id']}
    if error:
        response['error'] = {'code': -1, 'message': error, 'data': {
            'category': 'sql', 'retryable': False, 'sessionDisposition': 'keep', 'stage': 'execute'}}
    else:
        response['result'] = result
    print(json.dumps(response), flush=True)
