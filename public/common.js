// 公共小工具
window.$ = (s, r = document) => r.querySelector(s);
window.$$ = (s, r = document) => [...r.querySelectorAll(s)];
window.api = async function (path, opts = {}) {
  const init = { method: opts.method || "GET", credentials: "same-origin", headers: {} };
  if (opts.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  const res = await fetch(path, init);
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error(data.error || `请求失败（${res.status}）`); e.status = res.status; throw e; }
  return data;
};
window.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTokyo = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
window.tokyo = (ts) => (ts ? fmtTokyo.format(new Date(ts)).replace(/\//g, "-") : "—");
window.timeShort = (ts) => {
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return d.toLocaleString("zh-CN", same ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
window.setMsg = (el, text, kind = "err") => { el.textContent = text || ""; el.className = "msg " + (text ? kind : ""); };
window.busy = async (btn, fn) => { btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; } };
