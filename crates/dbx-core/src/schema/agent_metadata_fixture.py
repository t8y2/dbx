#!/usr/bin/env python3
import json
import pathlib
import re
import sys
import threading

root = next(parent for parent in pathlib.Path(__file__).parents if parent.name == 'agents')
sessions = {}
output_lock = threading.Lock()
session_locks = {}
cancelled = {}


def respond(request, result=None, error=None):
    response = {'jsonrpc': '2.0', 'id': request['id']}
    response.update({'error': error} if error else {'result': result})
    with output_lock:
        print(json.dumps(response), flush=True)


def rpc_error(category):
    return {'code': -1, 'message': 'fixture ' + category, 'data': {
        'category': category, 'retryable': category == 'connection',
        'sessionDisposition': {'transport': 'replace_runtime', 'sql': 'keep', 'capacity': 'keep'}.get(category, 'quarantine'),
        'stage': 'execute'}}


def handle(request):
    method = request['method']
    params = request.get('params', {})
    session = params.get('agentSessionId')
    result = {}
    error = None
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method in ('open_session', 'connect'):
        capacity = root / 'capacity'
        if capacity.exists() and len(sessions) >= int(capacity.read_text()):
            respond(request, error=rpc_error('capacity'))
            return
        sessions[session] = params
        session_locks[session] = threading.Lock()
        cancelled[session] = threading.Event()
    elif method == 'close_session':
        if session in cancelled:
            cancelled[session].set()
        sessions.pop(session, None)
    elif method == 'list_databases':
        failure = root / 'list-error'
        if failure.exists():
            category = failure.read_text()
            error = rpc_error(category)
        else:
            result = [{'name': sessions[session].get('sessionRole', 'workload')}]
    elif method == 'list_objects':
        failure = root / 'objects-error'
        if failure.exists():
            error = rpc_error(failure.read_text())
        elif (root / 'objects.json').exists():
            result = json.loads((root / 'objects.json').read_text())
        else:
            types = [t.upper() for t in (params.get('object_types') or params.get('objectTypes') or [])]
            if 'TABLE' in types:
                if (root / 'paged-tables').exists():
                    objects = [{'name': 'ORD_%02d' % i, 'schema': params['schema'], 'object_type': 'TABLE'} for i in range(40)]
                else:
                    objects = [{'name': 'ORDERS', 'schema': params['schema'], 'object_type': 'TABLE'}]
            else:
                objects = [{'name': 'Ix%d' % i, 'schema': params['schema'], 'object_type': 'INDEX',
                            'parent_schema': ' Other Owner ', 'parent_name': ' T(a) '} for i in range(5)]
            if params.get('filter'):
                objects = [obj for obj in objects if params['filter'].lower() in obj['name'].lower()]
            start = params.get('offset') or 0
            result = objects[start:][:params.get('limit') or len(objects)]
    elif method == 'get_object_source':
        result = {'name': params['name'], 'object_type': 'VIEW', 'source': 'SELECT 1 AS id;'}
    elif method == 'get_table_comment':
        failure = root / 'comment-error'
        error = rpc_error(failure.read_text()) if failure.exists() else None
        result = None if failure.exists() else "View's comment"
    elif method == 'get_columns':
        result = [{'name': 'id', 'data_type': 'integer', 'is_nullable': True, 'is_primary_key': False,
                   'comment': "Column's comment"}, {'name': 'plain', 'data_type': 'integer', 'is_nullable': True,
                                                    'is_primary_key': False}]
    elif method in ('execute_query', 'get_table_ddl'):
        with session_locks[session]:
            if method == 'get_table_ddl':
                result = 'CREATE TABLE APP.EVENTS (ID INTEGER);'
            else:
                control = root / 'statistics'
                mode = control.read_text() if control.exists() else 'success'
                while mode == 'block' and not (root / 'release-statistics').exists():
                    if cancelled[session].wait(0.01):
                        respond(request, error=rpc_error('canceled'))
                        return
                if mode == 'retry':
                    failed = root / 'failed-session'
                    if not failed.exists():
                        failed.write_text(session)
                    mode = 'connection' if failed.read_text() == session else 'success'
                if 'ALL_TAB_COMMENTS' in params['sql'] and (root / 'comments.json').exists():
                    result = {'columns': ['TABLE_NAME', 'COMMENTS'], 'rows': json.loads((root / 'comments.json').read_text()),
                              'affected_rows': 0, 'execution_time_ms': 0}
                elif mode in ('sql', 'timeout', 'connection'):
                    error = rpc_error(mode)
                elif mode == 'fallback' and ('TABLE_USED_PAGES' in params['sql'] or 'DBA_OB_TABLET_REPLICAS' in params['sql']):
                    error = rpc_error('sql')
                elif 'FROM ALL_OBJECTS' in params.get('sql', ''):
                    sql = params['sql']
                    if (root / 'paged-tables').exists():
                        all_rows = [['ORD_%02d' % i, 'TABLE', 'HR', 'Customer orders %02d' % i, None, None] for i in range(40)]
                    else:
                        all_rows = [['ORDERS', 'TABLE', 'HR', 'Customer orders table', None, None]]
                    if 'DBX_RN >' in sql:
                        m_rn = re.search(r'DBX_RN > (\d+)', sql)
                        m_row = re.search(r'ROWNUM <= (\d+)', sql)
                        start = int(m_rn.group(1)) if m_rn else 0
                        end = int(m_row.group(1)) if m_row else len(all_rows)
                        rows = all_rows[start:end]
                    else:
                        rows = all_rows
                    result = {'columns': ['OBJECT_NAME', 'OBJECT_TYPE', 'OWNER', 'COMMENTS', 'PARENT_SCHEMA', 'PARENT_NAME'],
                              'rows': rows,
                              'affected_rows': 0, 'execution_time_ms': 0}
                elif 'ALL_TAB_COMMENTS' in params.get('sql', ''):
                    if (root / 'paged-tables').exists():
                        rows = [['ORD_%02d' % i, 'Customer orders %02d' % i] for i in range(40)]
                    else:
                        rows = [['ORDERS', 'Customer orders table']]
                    result = {'columns': ['TABLE_NAME', 'COMMENTS'],
                              'rows': rows,
                              'affected_rows': 0, 'execution_time_ms': 0}
                else:
                    result = {'columns': ['TABLE_NAME', 'OWNER', 'NUM_ROWS', 'TOTAL_BYTES'],
                              'rows': [] if mode == 'empty' else [['EVENTS', 'APP', 12, None if mode == 'fallback' else 4096]],
                              'affected_rows': 0, 'execution_time_ms': 0}
    respond(request, result, error)


print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with (root / 'requests.jsonl').open('a') as requests:
        requests.write(json.dumps(request) + '\n')
    threading.Thread(target=handle, args=(request,), daemon=True).start()
