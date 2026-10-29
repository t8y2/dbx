#!/usr/bin/env python3
import json, sys, time, urllib.request
prs = [int(p) for p in sys.argv[1].split(",")]
out = sys.argv[2]
tok = open(r'D:/workspace/kaifa/jilu/.gh-token').read().strip()
def api(path):
    req = urllib.request.Request("https://api.github.com" + path)
    req.add_header("Authorization", f"Bearer {tok}")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())
def snapshot(pr):
    head = api(f"/repos/t8y2/dbx/pulls/{pr}")["head"]["sha"]
    raw = api(f"/repos/t8y2/dbx/commits/{head}/check-runs?per_page=100")["check_runs"]
    latest = {}
    for c in raw:
        if c["name"] not in latest or c["id"] > latest[c["name"]]["id"]:
            latest[c["name"]] = c
    all_runs = list(latest.values())
    real = [c for c in all_runs if c["conclusion"] != "skipped" and c["name"] != "cancel"]
    pending = [c["name"] for c in real if c["status"] != "completed"]
    fails = [c["name"] for c in real if c["status"] == "completed" and c["conclusion"] not in ("success", "neutral")]
    return pending, fails, len(all_runs) >= 10
done = {}
while True:
    lines = [time.strftime("%H:%M:%S")]
    for pr in prs:
        if pr in done: continue
        try: pending, fails, has_run = snapshot(pr)
        except Exception as exc:
            lines.append(f"  #{pr}: error {exc}"); continue
        if not pending and has_run: done[pr] = "ALL_GREEN" if not fails else "FAILURES: " + ",".join(fails)
        lines.append(f"  #{pr}: pending={len(pending)} fails={fails}")
    msg = "\n".join(lines); print(msg, flush=True)
    with open(out, "a", encoding="utf-8") as fh: fh.write(msg + "\n")
    if len(done) == len(prs):
        print("FINAL:", json.dumps({f"#{k}": v for k, v in done.items()}), flush=True)
        with open(out, "a", encoding="utf-8") as fh: fh.write("FINAL: " + json.dumps({f"#{k}": v for k, v in done.items()}) + "\n")
        break
    time.sleep(90)
