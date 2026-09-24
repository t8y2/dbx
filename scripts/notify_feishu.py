#!/usr/bin/env python3
"""Release workflow step: push a Feishu interactive card for a published release.

Usage:
  python3 scripts/notify_feishu.py <tag>            # send to FEISHU_CHAT_ID
  python3 scripts/notify_feishu.py <tag> --user ou_xxx   # override to a P2P target (for testing)

Requires env: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_CHAT_ID (only for chat mode),
GITHUB_TOKEN via `gh` for release notes.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

REPO = "t8y2/dbx"
CNB_TAG_URL = "https://cnb.cool/dbxio.com/dbx/-/releases/tag/{tag}"
GH_TAG_URL = "https://github.com/t8y2/dbx/releases/tag/{tag}"

SECTION_META = [
    ("新功能", "✨ 新功能"),
    ("改进", "🔧 改进"),
    ("修复", "🐛 修复"),
]
HIGHLIGHT_LIMIT = 5

TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
SEND_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={kind}"


def gh_release(tag: str) -> dict:
    out = subprocess.run(
        ["gh", "release", "view", tag, "--repo", REPO,
         "--json", "name,body,isPrerelease,publishedAt"],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def parse_sections(body: str) -> dict:
    sections = {}
    current = None
    for line in body.splitlines():
        m = re.match(r"^###\s+(\S+)", line)
        if m:
            current = m.group(1)
            sections.setdefault(current, [])
            continue
        if current and line.startswith("- "):
            item = line[2:].strip()
            item = re.sub(r"\s*\(contributed by @[^)]*\)", "", item)
            item = re.sub(r"\s*\(PR \[#\d+\]\([^)]*\)\)", "", item)
            if item:
                sections[current].append(item)
    return sections


def build_card(tag: str, rel: dict, sections: dict) -> dict:
    name = rel.get("name") or f"DBX {tag}"
    prerelease = rel.get("isPrerelease")
    title = f"🚀 {name}{'(预发布)' if prerelease else ''}"
    total = sum(len(sections.get(k, [])) for k, _ in SECTION_META)

    elements = []
    for idx, (key, label) in enumerate(SECTION_META):
        items = sections.get(key, [])
        if not items:
            continue
        shown = items[:HIGHLIGHT_LIMIT]
        parts = [f"**{label}** · {len(items)} 项"]
        parts += [f"- {it}" for it in shown]
        elements.append({"tag": "markdown", "content": "\n".join(parts)})
        if len(items) > len(shown):
            elements.append({
                "tag": "collapsible_panel",
                "expanded": False,
                "header": {
                    "title": {"tag": "plain_text", "content": f"展开全部 {len(items)} 条"},
                    "background_color": "grey",
                },
                "elements": [{"tag": "markdown",
                              "content": "\n".join(f"- {it}" for it in items[len(shown):])}],
            })
        if idx < len(SECTION_META) - 1:
            elements.append({"tag": "hr"})

    elements += [
        {"tag": "column_set", "flex_mode": "stretch", "columns": [
            {"tag": "column", "width": "weighted", "weight": 1, "padding": "0", "elements": [
                {"tag": "button", "text": {"tag": "plain_text", "content": f"完整更新日志({total} 项)"},
                 "type": "primary", "url": GH_TAG_URL.format(tag=tag)}]},
            {"tag": "column", "width": "weighted", "weight": 1, "padding": "0", "elements": [
                {"tag": "button", "text": {"tag": "plain_text", "content": "国内镜像下载"},
                 "type": "default", "url": CNB_TAG_URL.format(tag=tag)}]},
        ]},
    ]
    return {"schema": "2.0",
            "config": {"update_multi": True},
            "header": {"template": "blue",
                       "title": {"tag": "plain_text", "content": title}},
            "body": {"elements": elements}}


def feishu_post(url: str, payload: dict, token: str = "") -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def send(kind: str, receive_id: str, card: dict) -> None:
    app_id, app_secret = os.environ["FEISHU_APP_ID"], os.environ["FEISHU_APP_SECRET"]
    tok = feishu_post(TOKEN_URL, {"app_id": app_id, "app_secret": app_secret})
    if tok.get("code") != 0:
        print("token error:", tok.get("msg"), file=sys.stderr)
        sys.exit(1)
    res = feishu_post(SEND_URL.format(kind=kind), {
        "receive_id": receive_id,
        "msg_type": "interactive",
        "content": json.dumps(card, ensure_ascii=False),
    }, token=tok["tenant_access_token"])
    if res.get("code") != 0:
        print("send error:", res.get("code"), res.get("msg"), file=sys.stderr)
        sys.exit(1)
    print("feishu card sent to", receive_id)


def main() -> None:
    tag = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "--user":
        kind, receive_id = "open_id", sys.argv[3]
    else:
        kind, receive_id = "chat_id", os.environ["FEISHU_CHAT_ID"]
    rel = gh_release(tag)
    sections = parse_sections(rel["body"])
    send(kind, receive_id, build_card(tag, rel, sections))


if __name__ == "__main__":
    main()
