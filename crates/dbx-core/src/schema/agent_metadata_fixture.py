#!/usr/bin/env python3
import json
import pathlib
import sys

root = next(parent for parent in pathlib.Path(__file__).parents if parent.name == 'agents')
sessions = {}
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with (root / 'requests.jsonl').open('a') as requests:
        requests.write(json.dumps(request) + '\n')
    method = request['method']
    params = request.get('params', {})
    session = params.get('agentSessionId')
    result = {}
    error = None
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method in ('open_session', 'connect'):
        sessions[session] = params
    elif method == 'close_session':
        sessions.pop(session, None)
    elif method == 'list_databases':
        failure = root / 'list-error'
        if failure.exists():
            category = failure.read_text()
            error = {'code': -1, 'message': 'fixture ' + category, 'data': {
                'category': category, 'retryable': False,
                'sessionDisposition': {'transport': 'replace_runtime', 'sql': 'keep'}.get(category, 'quarantine'),
                'stage': 'execute'}}
        else:
            result = [{'name': sessions[session].get('sessionRole', 'workload')}]
    response = {'jsonrpc': '2.0', 'id': request['id']}
    response.update({'error': error} if error else {'result': result})
    print(json.dumps(response), flush=True)
