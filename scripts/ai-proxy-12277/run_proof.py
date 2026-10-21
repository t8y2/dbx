"""Windows driver: SSH-hosted mocks, loopback forwards, fresh DBX process per case."""
import base64
import argparse
import datetime
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
import urllib.parse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BINARY = ROOT / 'target/ai-proxy-12277/debug/dbx-ai-proxy-12277-proof.exe'
PROXY_KEYS = {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port(family=socket.AF_INET):
    with socket.socket(family) as sock:
        sock.bind(('::1' if family == socket.AF_INET6 else '127.0.0.1', 0))
        return sock.getsockname()[1]


def stats(port):
    with opener.open('http://127.0.0.1:{}/_stats'.format(port), timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suite', choices=['environment', 'remaining', 'real-clash'], default='environment')
    parser.add_argument('--expect', choices=['baseline', 'fixed'], default='fixed')
    parser.add_argument('--real-proxy', help='Existing local Clash HTTP proxy; never changes Clash configuration')
    args = parser.parse_args()
    suite = args.suite
    import winreg
    settings_path = r'Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    def registry_snapshot():
        values = {}
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, settings_path) as key:
            for name in ('ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'):
                try:
                    values[name] = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    values[name] = None
        return values
    original_settings = registry_snapshot()
    real_peer = None
    if suite == 'real-clash':
        real_url = urllib.parse.urlsplit(args.real_proxy or '')
        if real_url.scheme != 'http' or real_url.hostname != '127.0.0.1' or not real_url.port or real_url.username:
            parser.error('--real-proxy must be an existing unauthenticated http://127.0.0.1:PORT listener')
        if args.expect != 'fixed':
            parser.error('real-clash suite validates fixed behavior only')
        real_peer = '127.0.0.1:{}'.format(real_url.port)
    encoded = base64.b64encode((HERE / 'remote_mock.py').read_bytes()).decode('ascii')
    command = 'python3 -u -c "import base64;exec(base64.b64decode(\'{}\'))"'.format(encoded)
    remote = subprocess.Popen(
        ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'aliyun', command],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
    tunnel = None
    try:
        line = remote.stdout.readline()
        if not line:
            raise RuntimeError('remote mock startup failed: ' + remote.stderr.read())
        ports = json.loads(line)
        model_port, proxy_port, ipv6_port, explicit_port = free_port(), free_port(), free_port(socket.AF_INET6), free_port()
        tunnel = subprocess.Popen([
            'ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ConnectTimeout=10',
            '-L', '127.0.0.1:{}:127.0.0.1:{}'.format(model_port, ports['model']),
            '-L', '127.0.0.1:{}:127.0.0.1:{}'.format(proxy_port, ports['proxy']),
            '-L', '[::1]:{}:127.0.0.1:{}'.format(ipv6_port, ports['model']),
            '-L', '127.0.0.1:{}:127.0.0.1:{}'.format(explicit_port, ports['proxy-explicit']),
            'aliyun'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(100):
            if tunnel.poll() is not None:
                raise RuntimeError('SSH tunnel failed: ' + tunnel.stderr.read().decode())
            try:
                stats(model_port)
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        else:
            raise RuntimeError('SSH tunnel did not become ready')
        endpoint = 'http://127.0.0.1:{}/v1'.format(model_port)
        ipv6_endpoint = 'http://[::1]:{}/v1'.format(ipv6_port)
        proxy = 'http://127.0.0.1:{}'.format(proxy_port)
        explicit_proxy = 'http://127.0.0.1:{}'.format(explicit_port)
        clean_env = {k: v for k, v in os.environ.items() if k.lower() not in PROXY_KEYS and not k.startswith('DBX_PROOF_')}
        proxy_env = dict(clean_env, HTTP_PROXY=proxy, HTTPS_PROXY=proxy, ALL_PROXY=proxy)
        cases = [
            ('baseline-no-env-proxy', endpoint, 'default', clean_env, '', 200, 'model'),
            ('proxy-disabled-ipv4', endpoint, 'default', proxy_env, '', 502, 'proxy'),
            ('explicit-proxy-skipped-ipv4', endpoint, 'explicit', proxy_env, 'invalid proxy url', 502, 'proxy'),
            ('exact-no-proxy-ipv4', endpoint, 'default', dict(proxy_env, NO_PROXY='127.0.0.1,localhost,::1'), '', 200, 'model'),
            ('windows-style-wildcard-env', endpoint, 'default', dict(proxy_env, NO_PROXY='127.*'), '', 502, 'proxy'),
            ('cidr-no-proxy-ipv4', endpoint, 'default', dict(proxy_env, NO_PROXY='127.0.0.0/8'), '', 200, 'model'),
            ('proxy-disabled-localhost', endpoint.replace('127.0.0.1', 'localhost'), 'default', proxy_env, '', 502, 'proxy'),
            ('proxy-disabled-ipv6', ipv6_endpoint, 'default', proxy_env, '', 502, 'proxy'),
            ('exact-no-proxy-ipv6', ipv6_endpoint, 'default', dict(proxy_env, NO_PROXY='::1'), '', 200, 'model'),
            ('stream-proxy-disabled', endpoint, 'stream', proxy_env, '', 502, 'proxy'),
            ('stream-exact-no-proxy', endpoint, 'stream', dict(proxy_env, NO_PROXY='127.0.0.1'), '', 200, 'model'),
            ('no-proxy-builder-control', endpoint, 'direct-control', proxy_env, '', 200, 'model'),
            ('public-explicit-proxy-control', 'http://dbx-repro.invalid/v1', 'explicit', clean_env, proxy, 502, 'proxy'),
        ]
        if suite == 'remaining':
            system_env = dict(clean_env, DBX_PROOF_SYSTEM_PROXY='127.0.0.1:{}'.format(proxy_port))
            wildcard = dict(system_env, DBX_PROOF_PROXY_OVERRIDE='localhost;127.*;10.*;172.16.*;<local>')
            exact = dict(system_env, DBX_PROOF_PROXY_OVERRIDE='localhost;127.0.0.1;::1')
            localhost_endpoint = endpoint.replace('127.0.0.1', 'localhost')
            cases = [
                ('system-no-bypass-ipv4', endpoint, 'default', system_env, '', 502, 'proxy'),
                ('system-wildcard-ipv4', endpoint, 'default', wildcard, '', 502, 'proxy'),
                ('system-exact-ipv4', endpoint, 'default', exact, '', 200, 'model'),
                ('system-cidr-ipv4', endpoint, 'default', dict(system_env, DBX_PROOF_PROXY_OVERRIDE='127.0.0.0/8'), '', 200, 'model'),
                ('system-wildcard-localhost', localhost_endpoint, 'default', wildcard, '', 200, 'model'),
                ('system-no-bypass-localhost', localhost_endpoint, 'default', system_env, '', 502, 'proxy'),
                ('system-no-bypass-ipv6', ipv6_endpoint, 'default', system_env, '', 502, 'proxy'),
                ('system-exact-ipv6', ipv6_endpoint, 'default', exact, '', 200, 'model'),
                ('system-stream-wildcard', endpoint, 'stream', wildcard, '', 502, 'proxy'),
                ('system-stream-exact', endpoint, 'stream', exact, '', 200, 'model'),
                ('system-disabled-ipv4', endpoint, 'default', dict(system_env, DBX_PROOF_SYSTEM_ENABLED='0'), '', 200, 'model'),
                ('system-disabled-ipv6', ipv6_endpoint, 'default', dict(system_env, DBX_PROOF_SYSTEM_ENABLED='0'), '', 200, 'model'),
                ('system-no-proxy-env-ipv4', endpoint, 'default', dict(wildcard, NO_PROXY='127.0.0.1'), '', 200, 'model'),
                ('system-no-proxy-env-ipv6', ipv6_endpoint, 'default', dict(system_env, NO_PROXY='::1'), '', 200, 'model'),
                ('system-no-proxy-builder-control', endpoint, 'direct-control', wildcard, '', 200, 'model'),
                ('system-explicit-loopback-ipv4', endpoint, 'explicit', system_env, explicit_proxy, 502, 'proxy'),
                ('system-explicit-loopback-localhost', localhost_endpoint, 'explicit', system_env, explicit_proxy, 502, 'proxy'),
                ('system-explicit-loopback-ipv6', ipv6_endpoint, 'explicit', system_env, explicit_proxy, 502, 'proxy-explicit'),
                ('system-exact-explicit-ipv4', endpoint, 'explicit', exact, explicit_proxy, 200, 'model'),
                ('system-exact-explicit-ipv6', ipv6_endpoint, 'explicit', exact, explicit_proxy, 502, 'proxy-explicit'),
                ('explicit-only-ipv4', endpoint, 'explicit', dict(system_env, DBX_PROOF_SYSTEM_ENABLED='0'), explicit_proxy, 200, 'model'),
                ('explicit-only-ipv6', ipv6_endpoint, 'explicit', dict(system_env, DBX_PROOF_SYSTEM_ENABLED='0'), explicit_proxy, 502, 'proxy-explicit'),
                ('system-public-proxy', 'http://dbx-repro.invalid/v1', 'default', system_env, '', 502, 'proxy'),
                ('system-public-explicit-priority', 'http://dbx-repro.invalid/v1', 'explicit', system_env, explicit_proxy, 502, 'proxy-explicit'),
                ('environment-over-system-priority', endpoint, 'default', dict(system_env, HTTP_PROXY=explicit_proxy), '', 502, 'proxy-explicit'),
            ]
            for mode in ('core-models', 'core-test', 'core-complete', 'core-stream'):
                for label, url, env, ok, role in [
                    ('system-wildcard', endpoint, wildcard, False, 'proxy'),
                    ('system-exact', endpoint, exact, True, 'model'),
                    ('system-ipv6-no-bypass', ipv6_endpoint, system_env, False, 'proxy'),
                    ('system-ipv6-exact', ipv6_endpoint, exact, True, 'model'),
                    ('environment-proxy', endpoint, proxy_env, False, 'proxy'),
                    ('environment-no-proxy', endpoint, dict(proxy_env, NO_PROXY='127.0.0.1'), True, 'model'),
                ]:
                    cases.append((mode + '-' + label, url, mode, env, '', ok, role))
        if suite == 'real-clash':
            real_env = dict(clean_env, HTTP_PROXY=args.real_proxy, HTTPS_PROXY=args.real_proxy, ALL_PROXY=args.real_proxy)
            inherited_env = {k: v for k, v in os.environ.items() if not k.startswith('DBX_PROOF_')}
            system_env = dict(clean_env, DBX_PROOF_SYSTEM_PROXY=real_peer,
                              DBX_PROOF_PROXY_OVERRIDE=(original_settings.get('ProxyOverride') or [''])[0])
            cases = [('real-clash-forced-proxy-control', endpoint, 'proxy-control', clean_env, args.real_proxy, None, 'real-clash')]
            urls = [('ipv4', endpoint), ('localhost', endpoint.replace('127.0.0.1', 'localhost')), ('ipv6', ipv6_endpoint)]
            for label, url in urls:
                cases.extend([
                    ('real-clash-inherited-' + label, url, 'default', inherited_env, '', 200, 'model'),
                    ('real-clash-env-no-bypass-' + label, url, 'default', real_env, '', 200, 'model'),
                    ('real-clash-explicit-' + label, url, 'explicit', real_env, args.real_proxy, 200, 'model'),
                    ('real-clash-system-reader-' + label, url, 'default', system_env, '', 200, 'model'),
                ])
            cases.extend([
                ('real-clash-env-wildcard', endpoint, 'default', dict(real_env, NO_PROXY='127.*'), '', 200, 'model'),
                ('real-clash-system-no-bypass-ipv4', endpoint, 'default', dict(system_env, DBX_PROOF_PROXY_OVERRIDE=''), '', 200, 'model'),
                ('real-clash-system-no-bypass-ipv6', ipv6_endpoint, 'default', dict(system_env, DBX_PROOF_PROXY_OVERRIDE=''), '', 200, 'model'),
                ('real-clash-stream-ipv4', endpoint, 'stream', real_env, '', 200, 'model'),
                ('real-clash-stream-ipv6', ipv6_endpoint, 'stream', real_env, '', 200, 'model'),
            ])
            for mode in ('core-models', 'core-test', 'core-complete', 'core-stream'):
                for label, url, env in [
                    ('env-ipv4', endpoint, real_env),
                    ('system-ipv4', endpoint, system_env),
                    ('explicit-ipv6', ipv6_endpoint, dict(real_env, DBX_PROOF_EXPLICIT='1')),
                ]:
                    cases.append(('real-clash-' + mode + '-' + label, url, mode, env, args.real_proxy, True, 'model'))
        results = []
        for name, url, mode, env, explicit, expected_status, expected_role in cases:
            if args.expect == 'fixed' and mode != 'proxy-control' and url in (endpoint, ipv6_endpoint, endpoint.replace('127.0.0.1', 'localhost')):
                expected_status = True if mode.startswith('core-') else 200
                expected_role = 'model'
            before = len(stats(model_port))
            proc = subprocess.run([str(BINARY), url, mode, explicit], env=env,
                                  capture_output=True, text=True, encoding='utf-8', timeout=20)
            if proc.returncode or proc.stderr:
                result = {'process_exit': proc.returncode, 'stderr': proc.stderr, 'stdout': proc.stdout}
            else:
                result = json.loads(proc.stdout)
            hits = stats(model_port)[before:]
            result.update(case=name, endpoint=url, hits=hits)
            result['registry_fixture'] = {k: v for k, v in env.items() if k.startswith('DBX_PROOF_')}
            result['proxy_environment'] = {k: v for k, v in env.items() if k.lower() in PROXY_KEYS}
            result['expected_status_or_success'] = expected_status
            result['expected_role'] = expected_role
            transport_ok = len(hits) == 1 and hits[0]['role'] == expected_role
            if mode == 'proxy-control':
                # Prove the real listener was used. Its policy may forward or reject loopback.
                result['observed_expected'] = result.get('peer') == real_peer and isinstance(result.get('status'), int)
                result['observed_expected'] &= (len(hits) == 1 and hits[0]['role'] == 'model') if result.get('status') == 200 else len(hits) == 0
            elif mode.startswith('core-'):
                result['observed_expected'] = result.get('ok') == expected_status and transport_ok
                if expected_status and result.get('ok') is True:
                    if mode == 'core-models':
                        result['observed_expected'] &= result['result'][0]['id'] == 'local-repro'
                    elif mode == 'core-test':
                        result['observed_expected'] &= result['result']['success'] is True
                    elif mode == 'core-complete':
                        result['observed_expected'] &= result['result']['text'] == 'ok'
                    else:
                        chunks = result['result']['chunks']
                        result['observed_expected'] &= ''.join(chunk['delta'] for chunk in chunks) == 'ok' and any(chunk['done'] for chunk in chunks)
                else:
                    # Model listing decodes JSON before checking HTTP status, so
                    # a plain-text 502 can surface as a decode error instead.
                    result['observed_expected'] &= bool(result.get('error'))
            else:
                expected_peer = ('[::1]:{}'.format(ipv6_port) if url == ipv6_endpoint else '127.0.0.1:{}'.format(model_port)) if expected_role == 'model' else '127.0.0.1:{}'.format(explicit_port if expected_role == 'proxy-explicit' else proxy_port)
                result['observed_expected'] = result.get('status') == expected_status and transport_ok and result.get('peer') == expected_peer
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        report = {
            'time_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'remote': 'aliyun', 'remote_ports': ports,
            'local_model_port': model_port, 'local_proxy_port': proxy_port,
            'real_system_proxy_modified': False,
            'system_proxy_snapshot_before': original_settings,
            'system_proxy_snapshot_after': registry_snapshot(),
            'suite': suite,
            'expectation': args.expect,
            'real_proxy': args.real_proxy if suite == 'real-clash' else None,
            'note': 'Real Clash suite uses the already-running local proxy without changing its configuration. System scenarios use actual Windows registry reader with process-local HKCU remapping. No GUI interaction or TUN toggling.',
            'results': results,
        }
        output = ROOT / ('target/ai-proxy-12277/{}-{}-results.json'.format(args.expect, suite))
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        if not all(result['observed_expected'] for result in results):
            raise RuntimeError('At least one result differs from the expected baseline; inspect ' + str(output))
        if registry_snapshot() != original_settings:
            raise RuntimeError('Real Internet Settings unexpectedly changed')
        print('REPORT=' + str(output), flush=True)
    finally:
        if tunnel is not None:
            tunnel.terminate()
            tunnel.wait(timeout=10)
        if remote.stdin:
            remote.stdin.close()
        try:
            remote.wait(timeout=10)
        except subprocess.TimeoutExpired:
            remote.terminate()
            remote.wait(timeout=10)


if __name__ == '__main__':
    main()
