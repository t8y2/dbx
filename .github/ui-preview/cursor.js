// Drawn into every page the recorder opens, so the video shows where the
// mouse is, the path it took and each click: an arrow on top of everything,
// its trail fading behind it, a ring where a button went down. The recorder
// sets captions with window.__uiPreviewCaption(text). None of it takes
// pointer events, so the app under it behaves as it would.
(() => {
  if (window.__uiPreviewCursor) return;
  window.__uiPreviewCursor = true;
  const TRAIL_MS = 1400;
  const ns = "http://www.w3.org/2000/svg";
  let root, canvas, ctx, arrow, caption;
  const points = []; // {x, y, t}
  const rings = []; // {x, y, t}
  let x = -100, y = -100, down = false;

  function mount() {
    if (root?.isConnected) return;
    root = document.createElement("div");
    root.setAttribute("data-ui-preview", "");
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;";
    canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;";
    ctx = canvas.getContext("2d");
    arrow = document.createElementNS(ns, "svg");
    arrow.setAttribute("width", "26");
    arrow.setAttribute("height", "26");
    arrow.setAttribute("viewBox", "0 0 26 26");
    arrow.style.cssText = "position:absolute;left:0;top:0;transform-origin:3px 3px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));transition:scale .08s;";
    arrow.innerHTML = '<path d="M3 2.5v18.2l4.6-4.4 3.1 7.2 3.3-1.4-3.1-7.1h6.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>';
    caption = document.createElement("div");
    caption.style.cssText = "position:absolute;left:50%;bottom:18px;translate:-50% 0;max-width:80%;padding:7px 14px;border-radius:9px;background:rgba(17,17,17,.82);color:#fff;font:500 14px/1.4 -apple-system,'Segoe UI','Noto Sans CJK SC','PingFang SC',sans-serif;opacity:0;transition:opacity .2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    root.append(canvas, arrow, caption);
    document.documentElement.append(root);
    size();
  }
  function size() {
    const r = devicePixelRatio || 1;
    canvas.width = innerWidth * r;
    canvas.height = innerHeight * r;
    ctx.setTransform(r, 0, 0, r, 0, 0);
  }

  function frame() {
    mount();
    const now = performance.now();
    while (points.length && now - points[0].t > TRAIL_MS) points.shift();
    while (rings.length && now - rings[0].t > 900) rings.shift();
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    // the path: each segment as faint as it is old
    ctx.lineCap = ctx.lineJoin = "round";
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const age = (now - b.t) / TRAIL_MS;
      ctx.strokeStyle = `rgba(255, 59, 48, ${0.75 * (1 - age)})`;
      ctx.lineWidth = 3.5 * (1 - age) + 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // a click: a ring that opens and fades, a dot where it landed
    for (const r of rings) {
      const k = (now - r.t) / 900;
      ctx.strokeStyle = `rgba(255, 59, 48, ${1 - k})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 8 + 26 * Math.sqrt(k), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255, 59, 48, ${0.9 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (down) {
      ctx.fillStyle = "rgba(255, 59, 48, .35)";
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
    }
    arrow.style.translate = `${x - 3}px ${y - 3}px`;
    arrow.style.scale = down ? "0.85" : "1";
    requestAnimationFrame(frame);
  }

  const opts = { capture: true, passive: true };
  addEventListener("mousemove", (e) => {
    x = e.clientX; y = e.clientY;
    points.push({ x, y, t: performance.now() });
  }, opts);
  addEventListener("mousedown", (e) => {
    x = e.clientX; y = e.clientY; down = true;
    rings.push({ x, y, t: performance.now() });
  }, opts);
  addEventListener("mouseup", () => { down = false; }, opts);
  addEventListener("resize", () => canvas && size());

  window.__uiPreviewCaption = (text) => {
    mount();
    caption.textContent = text || "";
    caption.style.opacity = text ? "1" : "0";
  };
  // the recorder's last known spot, carried across a page load
  window.__uiPreviewAt = (px, py) => { x = px; y = py; };

  if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => requestAnimationFrame(frame));
  else requestAnimationFrame(frame);
})();
