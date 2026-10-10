#!/usr/bin/env python3
"""Regression-test a DBX MCP binary through the actual Caddy deployment example.

Requires Python 3.10+, aiohttp, cryptography, and a supplied Caddy executable.
Only synthetic profile/claims and 127.0.0.1 listeners are used. Public ACME,
admin API, HTTP/3, and trust installation are disabled in the fixture. Its CA
is trusted only by this process. All keys/profiles are generated per run in a
temporary owner-only directory and destroyed afterward; none are committed.
No real identity provider, public ingress, or ChatGPT connection is exercised.

Usage: python3 scripts/test-mcp-https.py /path/to/dbx-mcp     --caddy /path/to/caddy --report /tmp/dbx-https.json

"""
import argparse
import asyncio
import base64
import contextlib
import datetime
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import ssl
import tempfile
import time
import aiohttp
from aiohttp.abc import AbstractResolver
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

HOST = "dbx.example.test"
ISSUER = "https://identity.example.test/realms/fixture"
checks = {}


def b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def intb(i):
    return b64(i.to_bytes((i.bit_length() + 7) // 8, "big"))


def write(p, value):
    p.write_bytes(value if isinstance(value, bytes) else value.encode())
    p.chmod(0o600)


def certs(d):
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Ephemeral DBX smoke CA")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_cert_sign=True,
                crl_sign=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                content_commitment=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, HOST)]))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(HOST)]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    write(d / "ca.pem", ca.public_bytes(serialization.Encoding.PEM))
    write(d / "server.pem", cert.public_bytes(serialization.Encoding.PEM))
    write(
        d / "server.key",
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ),
    )
    return (d / "ca.pem", d / "server.pem", d / "server.key")


class Resolver(AbstractResolver):

    async def resolve(self, host, port=0, family=socket.AF_INET):
        return [
            {
                "hostname": host,
                "host": "127.0.0.1",
                "port": port,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": 0,
            }
        ]

    async def close(self):
        pass


def check(name, cond, detail=None):
    checks[name] = {"passed": bool(cond)}
    if detail is not None:
        checks[name]["detail"] = detail
    if not cond:
        raise AssertionError(f"{name}: {detail}")
    print("PASS", name, flush=True)


def rpc_payload(method, id=1, params=None):
    p = {"jsonrpc": "2.0", "method": method}
    if id is not None:
        p["id"] = id
    if params is not None:
        p["params"] = params
    return p


def result(text):
    if text.startswith("event:") or text.startswith("data:") or "\ndata:" in text:
        return json.loads(
            next((s[5:].strip() for s in text.splitlines() if s.startswith("data:") and s[5:].strip()))
        )
    return json.loads(text)


def validate_template(template):
    """Do not run arbitrary Caddy configuration under a loopback-only promise."""
    allowed = re.compile(
        r"(?:[{}]|servers\s*\{|enable_full_duplex|timeouts\s*\{|"
        r"(?:read_header|read_body|idle)\s+[0-9]+(?:ms|s|m)|"
        r"dbx\.example\.com\s*\{|"
        r"@mcp\s+path\s+/mcp\s+/mcp/\*\s+/\.well-known/oauth-protected-resource/mcp|"
        r"handle(?:\s+@mcp)?\s*\{|"
        r"reverse_proxy(?:\s+@mcp)?\s+127\.0\.0\.1:5225\s*\{|"
        r"flush_interval\s+-1|respond\s+404)"
    )
    statements = [line.split("#", 1)[0].strip() for line in template.splitlines()]
    if any(line and not allowed.fullmatch(line) for line in statements):
        raise ValueError(
            "Unsupported Caddy template directive; refusing to start a non-fixture configuration"
        )
    if sum(line.startswith("servers") for line in statements) > 1:
        raise ValueError("Fixture supports at most one global server-options block")
    if sum(line.startswith("dbx.example.com") for line in statements) != 1:
        raise ValueError("Fixture requires exactly one dbx.example.com site")
    if sum(line.startswith("reverse_proxy") for line in statements) != 1:
        raise ValueError("Fixture requires exactly one loopback upstream")


async def stop_process(process, stop_signal):
    """Also runs if startup fails before the protocol assertions begin."""
    if process.returncode is None:
        process.send_signal(stop_signal)
    try:
        await asyncio.wait_for(process.wait(), 10)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


async def run(binary, report, protocol, caddy, caddyfile):
    report.update(
        binary=str(binary),
        binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
        date_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        public_ingress_tested=False,
        native_tls=False,
        proxy="Caddy HTTPS reverse proxy, both listeners 127.0.0.1",
        system_trust_changed=False,
    )
    with tempfile.TemporaryDirectory(prefix="dbx-https-fixture-") as tmp:
        async with contextlib.AsyncExitStack() as cleanup:
            d = pathlib.Path(tmp)
            d.chmod(0o700)
            ca, cert, key = certs(d)
            client_ssl = ssl.create_default_context(cafile=str(ca))
            fixture_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            public = fixture_key.public_key().public_numbers()
            write(
                d / "jwks.json",
                json.dumps(
                    {
                        "keys": [
                            {
                                "kty": "RSA",
                                "alg": "RS256",
                                "use": "sig",
                                "kid": "fixture",
                                "n": intb(public.n),
                                "e": intb(public.e),
                            }
                        ]
                    }
                ),
            )
            write(d / "profile.key", b64(os.urandom(32)))
            (d / "profile").mkdir(mode=0o700)
            (d / "home").mkdir(mode=0o700)
            with socket.socket() as backend_socket, socket.socket() as tls_socket:
                backend_socket.bind(("127.0.0.1", 0))
                tls_socket.bind(("127.0.0.1", 0))
                backend_port = backend_socket.getsockname()[1]
                tls_port = tls_socket.getsockname()[1]
            origin = f"https://{HOST}:{tls_port}"
            resource = origin + "/mcp"
            caddy_proc = None
            caddy_log = None
            if caddy:
                report["proxy"] = "Caddy " + str(caddy) + "; both listeners 127.0.0.1"
                report["caddy_sha256"] = hashlib.sha256(caddy.read_bytes()).hexdigest()
                template_source = caddyfile.read_text()
                validate_template(template_source)
                template_source = "\n".join(
                    line.split("#", 1)[0].strip()
                    for line in template_source.splitlines()
                    if line.split("#", 1)[0].strip()
                )
                template = template_source.replace("dbx.example.com", f"https://{HOST}:{tls_port}").replace(
                    "127.0.0.1:5225", f"127.0.0.1:{backend_port}"
                )
                options = "    default_sni dbx.example.test\n    admin off\n    auto_https off\n    skip_install_trust\n"
                if not re.search(r"(?m)^servers\s*\{$", template):
                    options += "    servers {\n        protocols h1\n    }\n"
                if template.startswith("{\n"):
                    template = template.replace("{\n", "{\n" + options, 1)
                    template = re.sub(r"(?m)^servers\s*\{$", "servers {\n    protocols h1", template, count=1)
                    settings = ""
                else:
                    settings = "{\n" + options + "}\n"
                template = re.sub(
                    rf"(?m)^https://{re.escape(HOST)}:{tls_port}\s*\{{$",
                    f"https://{HOST}:{tls_port} {{\n    bind 127.0.0.1\n    tls {cert} {key}",
                    template,
                    count=1,
                )
                write(d / "Caddyfile", settings + template)
                caddy_log = cleanup.enter_context(open(d / "caddy.log", "wb"))
                caddy_proc = await asyncio.create_subprocess_exec(
                    str(caddy),
                    "run",
                    "--config",
                    str(d / "Caddyfile"),
                    "--adapter",
                    "caddyfile",
                    env={
                        **os.environ,
                        "HOME": str(d / "home"),
                        "XDG_CONFIG_HOME": str(d / "home" / "config"),
                        "XDG_DATA_HOME": str(d / "home" / "data"),
                    },
                    stdout=caddy_log,
                    stderr=caddy_log,
                )
                cleanup.push_async_callback(stop_process, caddy_proc, signal.SIGTERM)
                report["caddy_template"] = str(caddyfile)
            write(
                d / "oauth.json",
                json.dumps(
                    {
                        "issuer": ISSUER,
                        "resource": resource,
                        "jwks_file": "jwks.json",
                        "allowed_subjects": ["fixture-owner", "fixture-other"],
                        "required_scope": "dbx:mcp",
                    }
                ),
            )
            env = {k: v for k, v in os.environ.items() if not k.startswith("DBX_")}
            env.update(
                HOME=str(d / "home"),
                XDG_DATA_HOME=str(d / "home" / "data"),
                DBX_DATA_DIR=str(d / "profile"),
                DBX_SECRET_KEY_FILE=str(d / "profile.key"),
                DBX_MCP_OAUTH_CONFIG_FILE=str(d / "oauth.json"),
                DBX_MCP_HTTP_ALLOWED_HOSTS=f"{HOST}:{tls_port}",
                DBX_MCP_HTTP_ALLOWED_ORIGINS=origin,
            )
            stderr = cleanup.enter_context(open(d / "stderr.log", "wb"))
            proc = await asyncio.create_subprocess_exec(
                str(binary),
                "--http",
                "--http-port",
                str(backend_port),
                env=env,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=stderr,
            )

            cleanup.push_async_callback(stop_process, proc, signal.SIGINT)

            async def token(**changes):
                claims = {
                    "iss": ISSUER,
                    "aud": resource,
                    "sub": "fixture-owner",
                    "scope": "dbx:mcp",
                    "exp": int(time.time()) + 120,
                }
                claims.update(changes)
                unsigned = (
                    b64(
                        json.dumps(
                            {"alg": "RS256", "typ": "at+jwt", "kid": "fixture"}, separators=(",", ":")
                        ).encode()
                    )
                    + "."
                    + b64(json.dumps(claims, separators=(",", ":")).encode())
                )
                return (
                    unsigned
                    + "."
                    + b64(fixture_key.sign(unsigned.encode(), padding.PKCS1v15(), hashes.SHA256()))
                )

            base_headers = {
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            }
            init = rpc_payload(
                "initialize",
                params={
                    "protocolVersion": protocol,
                    "capabilities": {},
                    "clientInfo": {"name": "dbx-https-smoke", "version": "1.0"},
                },
            )
            try:
                connector = aiohttp.TCPConnector(resolver=Resolver(), ssl=client_ssl)
                async with aiohttp.ClientSession(
                    connector=connector, timeout=aiohttp.ClientTimeout(total=15)
                ) as client:
                    for _ in range(100):
                        if proc.returncode is not None:
                            raise RuntimeError("DBX exited: " + (d / "stderr.log").read_text())
                        if caddy_proc and caddy_proc.returncode is not None:
                            raise RuntimeError("Caddy exited: " + (d / "caddy.log").read_text())
                        try:
                            async with client.get(f"http://127.0.0.1:{backend_port}/healthz") as ready:
                                await ready.read()
                                if ready.status != 200:
                                    await asyncio.sleep(0.05)
                                    continue
                            async with client.get(origin + "/.well-known/oauth-protected-resource/mcp") as r:
                                status = r.status
                                body = await r.text()
                                check(
                                    "discovery_route_reachable",
                                    status == 200,
                                    {"status": status, "body": body},
                                )
                                metadata = json.loads(body)
                            break
                        except aiohttp.ClientConnectionError:
                            await asyncio.sleep(0.05)
                    else:
                        raise RuntimeError("DBX not ready")
                    check(
                        "https_resource_metadata",
                        status == 200
                        and metadata
                        == {
                            "resource": resource,
                            "authorization_servers": [ISSUER],
                            "scopes_supported": ["dbx:mcp"],
                            "bearer_methods_supported": ["header"],
                        },
                        metadata,
                    )
                    _, w = await asyncio.open_connection(
                        "127.0.0.1", tls_port, ssl=client_ssl, server_hostname=HOST
                    )
                    report["tls_negotiated"] = w.get_extra_info("ssl_object").version()
                    w.close()
                    await w.wait_closed()
                    check(
                        "trusted_ca_hostname_tls",
                        report["tls_negotiated"] in ["TLSv1.2", "TLSv1.3"],
                        report["tls_negotiated"],
                    )
                    for tls_version in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
                        ctx = ssl.create_default_context(cafile=str(ca))
                        ctx.minimum_version = ctx.maximum_version = tls_version
                        _, writer = await asyncio.open_connection(
                            "127.0.0.1", tls_port, ssl=ctx, server_hostname=HOST
                        )
                        negotiated = writer.get_extra_info("ssl_object").version()
                        writer.close()
                        await writer.wait_closed()
                        check(
                            "supports_" + tls_version.name, negotiated in ("TLSv1.2", "TLSv1.3"), negotiated
                        )
                    for name, ctx, sni in [
                        ("wrong_ca", ssl.create_default_context(), HOST),
                        ("wrong_hostname", client_ssl, "127.0.0.1"),
                    ]:
                        try:
                            _, w = await asyncio.open_connection(
                                "127.0.0.1", tls_port, ssl=ctx, server_hostname=sni
                            )
                            w.close()
                            await w.wait_closed()
                            rejected = False
                        except ssl.SSLCertVerificationError:
                            rejected = True
                        check("reject_" + name, rejected)

                    async def post(payload, bearer=None, headers=None):
                        h = base_headers.copy()
                        if bearer is not None:
                            h["Authorization"] = "Bearer " + bearer
                        if headers:
                            h.update(headers)
                        async with client.post(resource, json=payload, headers=h) as r:
                            return (r.status, {k.lower(): v for k, v in r.headers.items()}, await r.text())

                    status, h, body = await post(init)
                    expected = f'Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource/mcp", scope="dbx:mcp"'
                    check(
                        "missing_bearer_https_challenge",
                        status == 401 and h.get("www-authenticate") == expected,
                        {"status": status, "challenge": h.get("www-authenticate")},
                    )
                    invalids = [
                        ("malformed", "bad-fixture-token", 401),
                        ("expired", await token(exp=int(time.time()) - 1), 401),
                        ("future_nbf", await token(nbf=int(time.time()) + 300), 401),
                        ("wrong_issuer", await token(iss="https://wrong.example.test"), 401),
                        ("wrong_audience", await token(aud="https://wrong.example.test/mcp"), 401),
                        ("plaintext_audience", await token(aud=resource.replace("https:", "http:")), 401),
                        ("wrong_scope", await token(scope="read"), 403),
                        ("wrong_subject", await token(sub="unapproved"), 403),
                    ]
                    good = await token()
                    direct_headers = {
                        **base_headers,
                        "Host": f"{HOST}:{tls_port}",
                        "Authorization": "Bearer " + good,
                    }
                    async with client.post(
                        f"http://127.0.0.1:{backend_port}/mcp", headers=direct_headers, json=init
                    ) as r:
                        direct_result = result(await r.text())
                        direct_sid = r.headers.get("Mcp-Session-Id")
                        check(
                            "loopback_http_initialize",
                            r.status == 200 and bool(direct_sid) and ("result" in direct_result),
                            {"status": r.status},
                        )
                    async with client.delete(
                        f"http://127.0.0.1:{backend_port}/mcp",
                        headers={**direct_headers, "Mcp-Session-Id": direct_sid},
                    ) as r:
                        await r.read()
                        check("loopback_http_delete", r.status == 202, {"status": r.status})
                    async with client.post(
                        f"http://127.0.0.1:{backend_port}/mcp",
                        headers={**direct_headers, "Host": "evil.example.test"},
                        json=init,
                    ) as r:
                        await r.read()
                        check("backend_rejects_host", r.status == 403, {"status": r.status})
                    parts = good.split(".")
                    parts[2] = b64(b"\x00" * 256)
                    invalids.append(("wrong_signature", ".".join(parts), 401))
                    for label, bearer, expected_status in invalids:
                        status, _, _ = await post(init, bearer)
                        check("reject_" + label, status == expected_status, {"status": status})
                    status, _, _ = await post(init, good, {"Origin": "https://evil.example.test"})
                    check("reject_origin", status == 403, {"status": status})
                    status, h, body = await post(init, good, {"Host": "evil.example.test"})
                    check(
                        "unknown_host_not_proxied",
                        status in (403, 421)
                        or (status == 200 and body == "" and ("mcp-session-id" not in h)),
                        {"status": status},
                    )
                    for path in ["/", "/healthz", "/readyz", "/not-an-mcp-route"]:
                        async with client.get(origin + path) as r:
                            await r.read()
                            check("private_route_" + path, r.status == 404, {"status": r.status})
                    for label, bearer, length, expected_status, min_time in [
                        ("missing_auth", None, 1000, 401, 0),
                        ("oversize", good, 2 * 1024 * 1024, 413, 0),
                        ("slow_body", good, 1000, 408, 4),
                    ]:
                        reader, writer = await asyncio.open_connection(
                            "127.0.0.1", tls_port, ssl=client_ssl, server_hostname=HOST
                        )
                        request = f"POST /mcp HTTP/1.1\r\nHost: {HOST}:{tls_port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {length}\r\n"
                        if bearer:
                            request += "Authorization: Bearer " + bearer + "\r\n"
                        body = b"x" * (1024 * 1024 + 1) if label == "oversize" else b"{"
                        start = time.monotonic()
                        writer.write((request + "\r\n").encode() + body)
                        await writer.drain()
                        try:
                            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 8)
                        finally:
                            writer.close()
                            with contextlib.suppress(ConnectionError, ssl.SSLError):
                                await writer.wait_closed()
                        elapsed = time.monotonic() - start
                        status = int(head.split(b" ", 2)[1])
                        check(
                            "early_" + label,
                            status == expected_status and min_time <= elapsed < 8,
                            {"status": status, "seconds": round(elapsed, 3)},
                        )
                    status, h, body = await post(init, good, {"Origin": origin})
                    initialized = result(body)
                    sid = h.get("mcp-session-id")
                    version = initialized.get("result", {}).get("protocolVersion")
                    check(
                        "https_initialize_session",
                        status == 200 and bool(sid) and ("result" in initialized) and (version == protocol),
                        {
                            "status": status,
                            "protocol_version": version,
                            "server": initialized.get("result", {}).get("serverInfo"),
                        },
                    )
                    session_headers = {"Mcp-Session-Id": sid, "MCP-Protocol-Version": version}
                    status, _, _ = await post(
                        rpc_payload("notifications/initialized", None), good, session_headers
                    )
                    check("https_initialized_notification", status == 202, {"status": status})
                    status, h, body = await post(rpc_payload("tools/list", 2), good, session_headers)
                    tools = result(body).get("result", {}).get("tools", [])
                    check(
                        "https_tools_list",
                        status == 200 and any((t["name"] == "dbx_list_connections" for t in tools)),
                        {"status": status, "tool_count": len(tools), "content_type": h.get("content-type")},
                    )
                    status, h, body = await post(
                        rpc_payload("tools/call", 3, {"name": "dbx_list_connections", "arguments": {}}),
                        good,
                        session_headers,
                    )
                    called = result(body)
                    check(
                        "https_tool_call_empty_fixture",
                        status == 200
                        and not called.get("result", {}).get("isError", False)
                        and called.get("result", {}).get("content")
                        == [{"type": "text", "text": "No connections configured in DBX."}],
                        {"status": status, "result": called.get("result")},
                    )
                    status, _, _ = await post(
                        rpc_payload("tools/list", 4), await token(sub="fixture-other"), session_headers
                    )
                    check("reject_cross_principal_session", status == 403, {"status": status})
                    h = {**base_headers, **session_headers, "Authorization": "Bearer " + good}
                    async with client.post(resource, data=b"x" * (1024 * 1024 + 1), headers=h) as r:
                        await r.read()
                        status = r.status
                    check("reject_oversize_body", status == 413, {"status": status})
                    get_headers = {
                        **session_headers,
                        "Authorization": "Bearer " + good,
                        "Accept": "text/event-stream",
                    }
                    async with client.get(resource, headers=get_headers) as stream:
                        check(
                            "https_get_sse",
                            stream.status == 200
                            and stream.headers.get("Content-Type", "").startswith("text/event-stream"),
                            {"status": stream.status},
                        )
                        await asyncio.sleep(0.2)
                        check("sse_stays_open_until_delete", not stream.content.is_eof())
                        async with client.delete(
                            resource, headers={**session_headers, "Authorization": "Bearer " + good}
                        ) as r:
                            await r.read()
                            status = r.status
                        check("https_session_delete", status == 202, {"status": status})
                        try:
                            await asyncio.wait_for(stream.read(), 5)
                            ended = True
                        except asyncio.TimeoutError:
                            ended = False
                        check("delete_closes_sse", ended)
                    status, _, _ = await post(rpc_payload("tools/list", 5), good, session_headers)
                    check("reject_deleted_session", status == 404, {"status": status})
                    async with client.get(
                        origin + "/.well-known/oauth-protected-resource/mcp",
                        headers={
                            "Forwarded": "host=evil.example.test;proto=http",
                            "X-Forwarded-Host": "evil.example.test",
                            "X-Forwarded-Proto": "http",
                        },
                    ) as r:
                        forwarded_metadata = await r.json()
                    check("forwarded_headers_cannot_change_public_urls", forwarded_metadata == metadata)
            finally:
                if proc.returncode is None:
                    proc.send_signal(signal.SIGINT)
                try:
                    await asyncio.wait_for(proc.wait(), 10)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
                stderr.close()
                report["service_exit_code"] = proc.returncode
                if caddy_proc:
                    if caddy_proc.returncode is None:
                        caddy_proc.terminate()
                    try:
                        await asyncio.wait_for(caddy_proc.wait(), 10)
                    except asyncio.TimeoutError:
                        caddy_proc.kill()
                        await caddy_proc.wait()
                    caddy_log.close()
                    report["caddy_exit_code"] = caddy_proc.returncode
    report["fixture_profiles_destroyed"] = True
    report["checks"] = checks


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("binary", type=pathlib.Path)
    p.add_argument("--report", type=pathlib.Path, required=True)
    p.add_argument("--protocol", choices=("2025-06-18", "2025-11-25"), default="2025-11-25")
    p.add_argument("--caddy", type=pathlib.Path, required=True)
    p.add_argument(
        "--caddyfile",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parents[1] / "deploy/mcp/Caddyfile.example",
    )
    a = p.parse_args()
    for executable in (a.binary, a.caddy):
        if not executable.is_file() or not os.access(executable, os.X_OK):
            p.error(str(executable) + " must be an existing executable")
    report = {}
    try:
        asyncio.run(run(a.binary.resolve(), report, a.protocol, a.caddy.resolve(), a.caddyfile.resolve()))
        report["passed"] = True
    except Exception as e:
        report["passed"] = False
        report["error"] = str(e)
        raise
    finally:
        report["checks"] = checks
        a.report.write_text(json.dumps(report, indent=2) + "\n")
