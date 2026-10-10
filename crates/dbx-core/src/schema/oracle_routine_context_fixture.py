#!/usr/bin/env python3
"""Oracle routine dictionaries over the actual Agent JSON-RPC transport."""
import json
import pathlib
import sys

root = next(parent for parent in pathlib.Path(__file__).parents if parent.name == 'agents')
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with (root / 'requests.jsonl').open('a') as output:
        output.write(json.dumps(request) + '\n')
    mode = json.loads((root / 'routine.json').read_text())
    method = request['method']
    params = request.get('params', {})
    sql = params.get('sql', '')
    source = "'SRC'" in sql
    prefix = 'source' if source else 'target'
    rows = []
    error = None
    result = {}
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method == 'execute_query':
        if 'V$VERSION' in sql:
            rows = mode.get('oracle_versions', [['Oracle Database 19c Enterprise Edition']])
        elif 'OB_VERSION()' in sql:
            rows = mode.get('ob_versions', [['4.2.5.0']])
        elif 'EDITIONS_ENABLED' in sql:
            rows = [[mode.get('editions', 'N')]]
        elif 'EDITION_NAME' in sql:
            rows = [['TYPE', None], ['TYPE BODY', None]]
        elif 'SELECT OBJECT_NAME, OBJECT_TYPE, STATUS FROM ALL_OBJECTS' in sql:
            rows = mode.get('routine_objects', [])
        elif 'SELECT STATUS' in sql:
            status = mode.get(prefix + '_status', 'VALID' if source else None)
            if "OBJECT_TYPE = 'TYPE'" in sql and mode.get('target_spec_status', 'VALID') is not None and not source:
                status = mode.get('target_spec_status', 'VALID')
            rows = [] if status is None else [[status]]
        elif 'SELECT OBJECT_TYPE, STATUS' in sql:
            rows = [['TYPE', mode.get('paired_status', 'VALID')], ['TYPE BODY', 'VALID']]
        elif 'SELECT TEXT FROM ALL_SOURCE' in sql or 'DBMS_METADATA.GET_DDL' in sql:
            kind = 'body' if "'TYPE BODY'" in sql or "'TYPE_BODY'" in sql else 'spec'
            fallback = 'CREATE OR REPLACE TYPE BODY T AS MEMBER FUNCTION F RETURN NUMBER IS BEGIN RETURN 1; END; END;' if kind == 'body' else 'CREATE OR REPLACE TYPE T AS OBJECT (N NUMBER);'
            rows = [[mode.get(prefix + '_' + kind, fallback)]]
        elif 'DBA_DEPENDENCIES' in sql:
            rows = mode.get('incoming', [])
        elif 'DBA_TAB_COLUMNS' in sql:
            rows = mode.get('columns', [])
        elif 'DBA_OBJECT_TABLES' in sql:
            rows = mode.get('object_tables', [])
        elif 'REFERENCED_LINK_NAME' in sql:
            rows = mode.get('paired_dependencies', [])
        if mode.get('fail_contains') and mode['fail_contains'] in sql:
            error = {'code': -1, 'message': 'ORA-01031: insufficient privileges', 'data': {
                'category': 'sql', 'retryable': False, 'sessionDisposition': 'keep', 'stage': 'execute'}}
        result = {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0,
                  'truncated': bool(mode.get('truncate_contains') and mode['truncate_contains'] in sql),
                  'has_more': bool(mode.get('more_contains') and mode['more_contains'] in sql)}
    elif method == 'get_object_source':
        result = {'name': params['name'], 'schema': params.get('schema'), 'object_type': params['object_type'],
                  'source': mode.get('routine_source', 'CREATE OR REPLACE PACKAGE P AS PROCEDURE RUN; END;')}
    elif method == 'list_objects':
        result = []
    response = {'jsonrpc': '2.0', 'id': request['id']}
    response.update({'error': error} if error else {'result': result})
    print(json.dumps(response), flush=True)
