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
    elif method == 'list_databases':
        failure = root / 'list-error'
        if failure.exists():
            category = failure.read_text()
            error = rpc_error(category)
        else:
            result = [{'name': sessions[session].get('sessionRole', 'workload')}]
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
                if mode in ('sql', 'timeout', 'connection'):
                    error = rpc_error(mode)
                elif mode == 'fallback' and 'TABLE_USED_PAGES' in params['sql']:
                    error = rpc_error('sql')
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
