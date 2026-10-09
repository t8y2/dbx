#!/usr/bin/env python3
import json
import pathlib
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
    elif method == 'get_object_source':
        sources = json.loads((root / 'transfer-sources').read_text())
        source = sources.get(params['name'], {'error': 'object source missing'})
        if 'error' in source:
            error = rpc_error('sql')
            error['message'] = source['error']
        else:
            result = {'name': params['name'], 'schema': 'SRC', 'object_type': params['object_type'], 'source': source['source']}
    elif method == 'get_columns' and (root / 'transfer-sources').exists():
        result = [{'name': 'Alias', 'data_type': 'NUMBER', 'is_nullable': True,
                   'column_default': None, 'is_primary_key': False, 'extra': ''}]
    elif method == 'list_databases':
        failure = root / 'list-error'
        if failure.exists():
            category = failure.read_text()
            error = rpc_error(category)
        else:
            result = [{'name': sessions[session].get('sessionRole', 'workload')}]
    elif method == 'completion_assistant_search_v1':
        reply = json.loads((root / 'completion-reply.json').read_text())
        result = reply.get('result')
        error = reply.get('error')
    elif method == 'execute_query' and (root / 'transfer-sources').exists():
        sql = params['sql']
        failure = root / 'transfer-fail-sql'
        if 'DBMS_METADATA.GET_DDL' in sql:
            native = root / 'transfer-native-ddl'
            if native.exists():
                result = {'columns': ['DDL'], 'rows': [[native.read_text()]], 'affected_rows': 0, 'execution_time_ms': 0}
            else:
                error = rpc_error('sql')
                error['message'] = 'DBMS_METADATA unavailable; dictionary source is readable'
        elif failure.exists() and failure.read_text() in sql:
            error = rpc_error('sql')
            error['message'] = 'fixture target DDL permission failure'
        else:
            result = {'columns': [], 'rows': [], 'affected_rows': 0, 'execution_time_ms': 0}
    elif method in ('execute_query', 'get_table_ddl'):
        with session_locks[session]:
            if method == 'get_table_ddl':
                ddl = root / 'table-ddl'
                failure = root / 'table-ddl-error'
                if failure.exists():
                    error = rpc_error('sql')
                    error['message'] = failure.read_text()
                else:
                    result = ddl.read_text() if ddl.exists() else 'CREATE TABLE APP.EVENTS (ID INTEGER);'
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
                if mode in ('sql', 'timeout', 'connection'):
                    error = rpc_error(mode)
                elif mode == 'fallback' and 'TABLE_USED_PAGES' in params['sql']:
                    error = rpc_error('sql')
                elif mode.startswith('ob-'):
                    if 'DBA_OB_TABLE_SPACE_USAGE' in params['sql'] or 'DBA_OB_TABLE_LOCATIONS' in params['sql']:
                        legacy = 'DBA_OB_TABLE_LOCATIONS' in params['sql']
                        if mode.startswith('ob-space') and mode != 'ob-space-denied' and (legacy or mode != 'ob-space-legacy'):
                            rows = [['Empty', 'Mixed Owner', 0, 0], ['STALE', 'Mixed Owner', 64, 8192]]
                            if legacy:
                                rows = [['Empty', 'Mixed Owner', 'USER TABLE', 0, 0],
                                        ['STALE', 'Mixed Owner', 'USER TABLE', 64, 8192],
                                        ['STALE', 'Mixed Owner', 'INDEX', 20, 4096],
                                        ['STALE', 'Mixed Owner', 'LOB AUX TABLE', None, None]]
                            result = {'columns': [], 'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0}
                        else:
                            error = rpc_error('sql')
                            error['message'] = 'ORA-01031: insufficient privileges' if mode == 'ob-space-denied' else 'ORA-00942: table or view does not exist'
                    elif mode in ('ob-error', 'ob-space-no-rows'):
                        error = rpc_error('sql')
                        error['message'] = 'ORA-01031: insufficient privileges'
                    else:
                        rows = [['Empty', 'Mixed Owner', 0, '2026-10-08 10:00:00', 'NO'],
                                ['STALE', 'Mixed Owner', 125, '2026-09-01 11:00:00', 'YES'],
                                ['Uncollected', 'Mixed Owner', None, None, None]]
                        if mode == 'ob-pages':
                            rows = [[f'T{i:04}', 'APP', i, None, None] for i in range(1000)] if 'TABLE_NAME >' not in params['sql'] else [['T1000', 'APP', 1000, None, None]]
                        result = {'columns': ['TABLE_NAME', 'OWNER', 'NUM_ROWS', 'LAST_ANALYZED', 'STALE_STATS'],
                                  'rows': rows, 'affected_rows': 0, 'execution_time_ms': 0,
                                  'truncated': mode == 'ob-truncated'}
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
