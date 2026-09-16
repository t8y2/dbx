// Self-contained static 404: the top-level not-found has no root layout in this
// app (multiple root-layout groups), so global.css is not guaranteed to load —
// especially in `next dev`. Keep all styling inline and use zero client JS.
const button = {
  display: "inline-flex",
  height: "40px",
  alignItems: "center",
  padding: "0 18px",
  borderRadius: "8px",
  fontSize: "13px",
  fontWeight: 650,
  textDecoration: "none",
} as const;

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#08080a",
        color: "#ededf0",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        textAlign: "center",
        padding: "24px",
        margin: 0,
      }}
    >
      {/* No root layout on this route, so global.css may be absent (next dev):
          reset the default body margin/background inline instead. */}
      <style dangerouslySetInnerHTML={{ __html: "html,body{margin:0;padding:0;background:#08080a}" }} />
      <div>
        <p style={{ margin: 0, fontSize: "clamp(72px, 14vw, 140px)", fontWeight: 800, lineHeight: 1, letterSpacing: "-0.03em" }}>404</p>
        <h1 style={{ margin: "18px 0 8px", fontSize: 21, fontWeight: 720 }}>页面不存在</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "#9c9ea3" }}>Page not found — 这个链接指向的页面不存在或已被移动。</p>
        <div style={{ marginTop: 28, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12 }}>
          <a href="/cn" style={{ ...button, background: "#f0f1f4", color: "#0a0b0e" }}>
            返回首页
          </a>
          <a href="/cn/plugins" style={{ ...button, border: "1px solid rgba(173,176,182,0.3)", color: "#9c9ea3" }}>
            插件中心
          </a>
          <a href="/cn/docs/what-is-dbx" style={{ ...button, border: "1px solid rgba(173,176,182,0.3)", color: "#9c9ea3" }}>
            文档
          </a>
        </div>
      </div>
    </main>
  );
}
