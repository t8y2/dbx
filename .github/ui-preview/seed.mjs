// Fills the UI preview's sandbox (run.sh) with data to show: a fresh dbx-web
// has no connections, so a change to the sidebar, the grid, query history or
// the ER diagram has nothing to draw. Made up, every bit of it, and never
// real.
//
//   node seed.mjs dbs <dir> [--as <path on the server>]  — two SQLite
//     databases with fixed, deterministic content (python3 writes them, so
//     the files are identical byte-for-byte on every run);
//   node seed.mjs api <base-url> <dir> [--as <path on the server>]
//     — saves the connections (SQLite: the file path is the host), connects,
//       runs real queries through the gateway so history and result caches
//       are genuine, then adds a saved-SQL library and a few more history
//       entries the UI can list.
//
// The connections point at files as the dbx-web process sees them: pass
// --as when the databases are generated on another machine than the one
// dbx-web runs on (local testing over an SSH tunnel).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (n) => process.argv[n];
const opt = (name, d) => {
  const i = process.argv.indexOf(name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};

const DBS = [
  {
    file: "dbx-shop.sqlite",
    name: "商店 Shop (SQLite)",
    note: "订单、商品与客户示例库",
    tables: "customers · products · orders · audit_log（含视图 v_daily_revenue、外键与触发器）",
    warm: ["SELECT * FROM orders ORDER BY created_at DESC LIMIT 50", "SELECT c.city, COUNT(*) AS orders, SUM(o.amount) AS revenue\nFROM orders o JOIN customers c ON c.id = o.customer_id\nGROUP BY c.city ORDER BY revenue DESC", "SELECT category, COUNT(*) AS n, ROUND(AVG(price), 2) AS avg_price\nFROM products WHERE listed = 1 GROUP BY category ORDER BY n DESC"],
  },
  {
    file: "dbx-analytics.sqlite",
    name: "分析 Analytics (SQLite)",
    note: "事件流与每日指标",
    tables: "events（5000 行，看分页）· daily_stats（90 天）",
    warm: ["SELECT event_type, COUNT(*) AS n, ROUND(AVG(duration_ms)) AS avg_ms\nFROM events GROUP BY event_type ORDER BY n DESC", "SELECT date(ts) AS day, COUNT(DISTINCT user_id) AS dau\nFROM events GROUP BY day ORDER BY day DESC LIMIT 14", "SELECT * FROM daily_stats ORDER BY stat_date DESC LIMIT 30"],
  },
];

// Deterministic content: the same LCG magpie's seed uses, so two previews of
// one PR differ only by the PR.
function python(dir) {
  const py = `
import os, sqlite3, random, datetime
rng = random.Random(20261008)
def d(days, hours=0):
    return (datetime.datetime(2026, 10, 8, 12, 0, 0) - datetime.timedelta(days=days, hours=hours)).strftime("%Y-%m-%d %H:%M:%S")

shop = sqlite3.connect(os.path.join(${JSON.stringify(dir)}, "dbx-shop.sqlite"))
shop.executescript("""
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, city TEXT, level TEXT, created_at TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, price REAL, stock INTEGER, listed INTEGER DEFAULT 1);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), product_id INTEGER REFERENCES products(id),
  quantity INTEGER, amount REAL, status TEXT, created_at TEXT);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts TEXT, what TEXT);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE VIEW v_daily_revenue AS SELECT date(created_at) AS day, COUNT(*) AS orders, ROUND(SUM(amount), 2) AS revenue FROM orders GROUP BY date(created_at);
CREATE TRIGGER trg_orders_audit AFTER INSERT ON orders BEGIN INSERT INTO audit_log(ts, what) VALUES (datetime('now'), 'order ' || NEW.id); END;
""")
cities = ["上海", "北京", "深圳", "杭州", "成都", "广州", "武汉", "南京"]
surnames = ["王", "李", "张", "刘", "陈", "杨", "赵", "周", "吴", "徐"]
givens = ["晓东", "思远", "雨桐", "子墨", "一鸣", "嘉怡", "浩然", "若彤", "俊杰", "梦琪"]
levels = ["bronze", "silver", "gold"]
for i in range(1, 201):
    shop.execute("INSERT INTO customers VALUES (?,?,?,?,?,?)",
        (i, rng.choice(surnames) + rng.choice(givens), f"user{i}@example.com", rng.choice(cities), rng.choice(levels), d(rng.randint(30, 400), rng.randint(0, 23))))
cats = ["键盘", "显示器", "鼠标", "硬盘", "内存", "耳机", "摄像头", "扩展坞"]
for i in range(1, 121):
    shop.execute("INSERT INTO products VALUES (?,?,?,?,?,?)",
        (i, f"{rng.choice(cats)} {chr(65 + i % 26)}{i:03d}", rng.choice(cats), round(rng.uniform(49, 4999), 2), rng.randint(0, 500), 1 if rng.random() > 0.1 else 0))
statuses = ["paid", "shipped", "done", "refund"]
for i in range(1, 501):
    q = rng.randint(1, 3)
    price = rng.uniform(49, 4999)
    shop.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?)",
        (i, rng.randint(1, 200), rng.randint(1, 120), q, round(q * price, 2), rng.choice(statuses) if rng.random() > 0.15 else "pending", d(rng.randint(0, 90), rng.randint(0, 23))))
shop.commit()

an = sqlite3.connect(os.path.join(${JSON.stringify(dir)}, "dbx-analytics.sqlite"))
an.executescript("""
CREATE TABLE events (id INTEGER PRIMARY KEY, ts TEXT, user_id INTEGER, event_type TEXT, page TEXT, duration_ms INTEGER);
CREATE TABLE daily_stats (stat_date TEXT PRIMARY KEY, dau INTEGER, revenue REAL, new_users INTEGER);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_type ON events(event_type);
""")
types = ["page_view", "click", "scroll", "search", "submit", "error"]
pages = ["/", "/grid", "/editor", "/history", "/settings", "/diagram"]
day = datetime.date(2026, 10, 8)
for i in range(1, 5001):
    back = rng.randint(0, 29)
    ts = datetime.datetime(2026, 10, 8, rng.randint(0, 23), rng.randint(0, 59), rng.randint(0, 59)) - datetime.timedelta(days=back)
    an.execute("INSERT INTO events VALUES (?,?,?,?,?,?)", (i, ts.strftime("%Y-%m-%d %H:%M:%S"), rng.randint(1, 400), rng.choice(types) if rng.random() > 0.02 else "error", rng.choice(pages), rng.randint(50, 180000) if rng.random() > 0.1 else None))
for k in range(90):
    date = (day - datetime.timedelta(days=k)).strftime("%Y-%m-%d")
    an.execute("INSERT INTO daily_stats VALUES (?,?,?,?)", (date, rng.randint(180, 420), round(rng.uniform(800, 5200), 2), rng.randint(3, 26)))
an.commit()
print("ok")
`;
  execFileSync("python3", ["-c", py], { stdio: ["ignore", "inherit", "inherit"] });
}

async function api(base, p, init = {}) {
  const res = await fetch(base.replace(/\/$/, "") + p, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || "GET"} ${p}: ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function seedApi() {
  const base = arg(3);
  const dir = path.resolve(arg(4));
  const as = path.resolve(opt("--as", dir));
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  const conns = DBS.map((db, i) => ({
    id: `seed-${db.file.replace(".sqlite", "")}`,
    name: db.name,
    note: db.note,
    db_type: "sqlite",
    driver_label: "SQLite",
    host: path.join(as, db.file),
    port: 0,
    username: "",
    password: "",
    database: "main",
    color: i === 0 ? "#2f6fed" : "#8f4bd6",
  }));
  await api(base, "/api/connection/save", { method: "POST", body: JSON.stringify({ configs: conns, removed_ids: [] }) });
  console.log("[ui-preview] saved", conns.length, "connections");

  for (const c of conns) {
    await api(base, "/api/connection/connect", { method: "POST", body: JSON.stringify({ config: c, client_attempt: 1 }) });
    const info = await api(base, `/api/connection/info?connection_id=${encodeURIComponent(c.id)}`).catch((e) => (console.log("[ui-preview] connection info:", e.message), null));
    const database = info?.current_database || info?.databases?.[0] || "main";
    const db = DBS.find((x) => c.host.endsWith(x.file));
    for (const sql of db.warm) {
      const r = await api(base, "/api/query/execute", {
        method: "POST",
        body: JSON.stringify({ connectionId: c.id, database, sql, maxRows: 200 }),
      }).catch((e) => (console.log("[ui-preview] warm query failed:", e.message), null));
      if (r) console.log("[ui-preview] ran", sql.split("\n")[0].slice(0, 60));
    }
  }

  // A saved-SQL library, so the SQL library panel has folders and files.
  const folder = await api(base, "/api/saved-sql/folders", {
    method: "POST",
    body: JSON.stringify({ id: "seed-folder-daily", name: "常用查询", createdAt: iso(36e5 * 72), updatedAt: iso(36e5 * 5) }),
  }).catch(() => null);
  const saved = [
    { id: "seed-sql-1", name: "各城市营收 Top", sql: "SELECT c.city, COUNT(*) AS orders, ROUND(SUM(o.amount), 2) AS revenue\nFROM orders o JOIN customers c ON c.id = o.customer_id\nGROUP BY c.city ORDER BY revenue DESC" },
    { id: "seed-sql-2", name: "近 14 天 DAU", sql: "SELECT date(ts) AS day, COUNT(DISTINCT user_id) AS dau\nFROM events GROUP BY day ORDER BY day DESC LIMIT 14" },
    { id: "seed-sql-3", name: "低库存商品", sql: "SELECT name, category, stock FROM products WHERE stock < 20 AND listed = 1 ORDER BY stock" },
  ];
  for (const [i, s] of saved.entries()) {
    await api(base, "/api/saved-sql", {
      method: "POST",
      body: JSON.stringify({
        ...s, connectionId: conns[i % conns.length].id, folderId: folder?.id || "seed-folder-daily",
        database: "main", orderIndex: i, openCount: 3 + i, createdAt: iso(36e5 * (70 - i)), updatedAt: iso(36e5 * (24 - i * 6)),
      }),
    }).catch((e) => console.log("[ui-preview] saved-sql:", e.message));
  }
  console.log("[ui-preview] saved-sql library seeded");

  // A few more history entries besides the real ones above: spread over the
  // last three days, one failure included, so the history list pages.
  const extra = [
    [conns[0], "SELECT COUNT(*) FROM orders WHERE status = 'pending'", 12, true],
    [conns[0], "SELECT * FROM v_daily_revenue ORDER BY day DESC LIMIT 7", 18, true],
    [conns[0], "UPDATE products SET stock = stock - 1 WHERE id = 42", 6, false],
    [conns[1], "SELECT stat_date, dau, revenue FROM daily_stats ORDER BY stat_date DESC LIMIT 30", 15, true],
    [conns[1], "SELECT page, COUNT(*) FROM events WHERE event_type = 'error' GROUP BY page", 22, true],
    [conns[1], "DELETE FROM events WHERE id < 0", 4, false],
  ];
  for (const [c, sql, ms, ok] of extra) {
    await api(base, "/api/history/save", {
      method: "POST",
      body: JSON.stringify({
        entry: {
          id: `seed-h-${Math.random().toString(36).slice(2, 10)}`, connection_id: c.id, connection_name: c.name,
          database: "main", sql, executed_at: iso(36e5 * (2 + Math.random() * 60)), execution_time_ms: ms, success: ok,
          error: ok ? null : "demo entry: would have modified rows (not really run)", activity_kind: "query", source: "editor",
        },
      }),
    }).catch((e) => console.log("[ui-preview] history:", e.message));
  }
  console.log("[ui-preview] history seeded");
}

const cmd = process.argv[2];
if (cmd === "dbs") {
  const dir = path.resolve(arg(3));
  fs.mkdirSync(dir, { recursive: true });
  python(dir);
  // a small importable file, for import/mapping dialogs (record.mjs's
  // "upload" step resolves names inside this directory)
  fs.writeFileSync(path.join(dir, "sample.csv"),
    "name,category,price,stock\n" +
    Array.from({ length: 8 }, (_, i) => `键盘 K${i + 100},键盘,${(199 + i * 23).toFixed(2)},${40 - i * 3}`).join("\n") + "\n");
  console.log("[ui-preview] databases written to", dir);
} else if (cmd === "api") {
  seedApi().catch((e) => { console.error(e); process.exit(1); });
} else {
  console.error("usage: seed.mjs dbs <dir> | seed.mjs api <base-url> <dir> [--as <server path>]");
  process.exit(1);
}
