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
// ===== 头像系统 =====
// 账号里保存 "p:av01"（预设虚拟形象，图片清单见 /avatars/manifest.json）或 "c:#rrggbb"（首字 + 纯色背景）；
// 未设置时按用户名稳定分配柔和色。CSP 禁止内联 style，颜色用 CSSOM 设置，图片走同源静态资源。
window.AV_PALETTE = ["#7c83fd", "#a78bfa", "#f29bbd", "#f6a37b", "#5cc8ad", "#64b5f6", "#f2c94c", "#ec6a84", "#8bc34a", "#9aa0b5", "#4db6ac", "#ba68c8"];
window.avColor = (name) => { let h = 0; for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0; return "c" + (h % 6); };
window.avInitial = (name) => (Array.from(String(name || "?").trim())[0] || "?").toUpperCase();
const AVC = new Map(); const avQ = new Set(); let avT = null, avManifest = null, avManifestP = null;
window.avManifestLoad = () => avManifestP || (avManifestP = fetch("/avatars/manifest.json", { cache: "no-cache" }).then((r) => r.json()).then((d) => {
  const list = Array.isArray(d) ? d : d.avatars || d.items || [];
  avManifest = list.map((x, i) => typeof x === "string" ? { id: x.replace(/\.\w+$/, ""), file: x } : { id: x.id || `av${String(i + 1).padStart(2, "0")}`, file: x.file || x.filename || x.src || x.path || `${x.id}.webp`, name: x.name || x.name_zh || x.label || x.title || "" })
    .map((x) => ({ ...x, file: String(x.file).split("/").pop() }));
  hydrateAll(); return avManifest;
}).catch(() => (avManifest = [])));
const avFile = (id) => { const m = avManifest && avManifest.find((x) => x.id === id); return "/avatars/" + (m ? m.file : id + ".webp"); };
window.avSet = (name, spec) => { AVC.set(String(name), spec || null); hydrateAll(String(name)); };
window.avatar = (name, sm, extra = "") => {
  const n = String(name || "?");
  if (!AVC.has(n) && n !== "?" && n !== "系统") { avQ.add(n); clearTimeout(avT); avT = setTimeout(avFetch, 60); }
  return `<span class="av ${sm ? "sm " : ""}${extra} ${avColor(n)}" data-avn="${esc(n)}">${esc(avInitial(n))}</span>`;
};
async function avFetch() {
  const names = [...avQ].filter((n) => !AVC.has(n)); avQ.clear();
  for (let i = 0; i < names.length; i += 80) {
    const part = names.slice(i, i + 80);
    try { const { avatars } = await api("/api/avatars?names=" + encodeURIComponent(part.join(","))); for (const n of part) AVC.set(n, avatars[n] || null); }
    catch { for (const n of part) AVC.set(n, null); }
  }
  hydrateAll();
}
const lum = (hex) => { const v = parseInt(hex.slice(1), 16); const c = [v >> 16, (v >> 8) & 255, v & 255].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
window.avApply = (el, spec, name) => {
  spec = spec || null;
  if (el.dataset.avd === String(spec)) return;
  el.dataset.avd = String(spec);
  el.style.background = ""; el.style.color = ""; el.classList.remove("img");
  if (spec && spec.startsWith("p:")) {
    if (!avManifest) { avManifestLoad(); delete el.dataset.avd; return; }
    const img = document.createElement("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.src = avFile(spec.slice(2));
    img.onerror = () => { img.remove(); el.classList.remove("img"); el.textContent = avInitial(name); };
    el.textContent = ""; el.appendChild(img); el.classList.add("img");
  } else {
    el.textContent = avInitial(name);
    if (spec && spec.startsWith("c:")) { const c = spec.slice(2); el.style.background = c; el.style.color = lum(c) > 0.55 ? "#2b2d42" : "#fff"; }
  }
};
function hydrateAll(only) {
  for (const el of document.querySelectorAll("[data-avn]")) {
    const n = el.dataset.avn; if (only && n !== only) continue;
    if (AVC.has(n)) avApply(el, AVC.get(n), n);
  }
}
new MutationObserver(() => { clearTimeout(window.__avH); window.__avH = setTimeout(() => hydrateAll(), 0); }).observe(document.documentElement, { childList: true, subtree: true });

// 头像选择面板：openAvatarPicker(me, { welcome }) → Promise<user|null>
window.openAvatarPicker = (me, opt = {}) => new Promise((resolve) => {
  avManifestLoad();
  const cur = AVC.has(me.username) ? AVC.get(me.username) : me.avatar || null;
  let sel = cur || "c:" + AV_PALETTE[0], mode = cur ? (cur.startsWith("p:") ? "preset" : "letter") : "preset";
  const wrap = document.createElement("div"); wrap.className = "modal av-modal";
  wrap.innerHTML = `<div class="card av-picker">
    <h2>${opt.welcome ? "🎉 注册成功！选一个头像吧" : "设置头像"}</h2>
    <p class="sub">${opt.welcome ? "头像会显示在消息、成员列表、语音和视频里，之后随时可以在「头像」里修改。" : "头像会显示在消息、成员列表、语音和视频里，两个站点同步。"}</p>
    <div class="av-preview">${avatar(me.username, false, "xl")}<div><b>${esc(me.username)}</b><div class="sub" id="avp-desc"></div></div></div>
    <div class="tabs"><button type="button" data-avtab="preset">🧸 虚拟形象</button><button type="button" data-avtab="letter">🔤 字母头像</button></div>
    <div class="av-pane" data-pane="preset"><div class="av-grid" id="avp-grid"><div class="empty">加载中…</div></div><p class="sub hidden" id="avp-ph">预设形象正在更新中，当前为占位图。</p></div>
    <div class="av-pane" data-pane="letter">
      <div class="sub">用户名首字「${esc(avInitial(me.username))}」+ 背景色</div>
      <div class="av-swatches" id="avp-sw"></div>
      <label class="av-custom">自定义颜色 <input type="color" id="avp-color"></label>
    </div>
    <div class="row av-actions"><button type="button" class="btn ghost" id="avp-cancel">${opt.welcome ? "先跳过" : "取消"}</button><button type="button" class="btn" id="avp-save">保存头像</button></div>
    <div class="msg" id="avp-msg"></div></div>`;
  document.body.appendChild(wrap);
  const prev = wrap.querySelector(".av-preview .av"); prev.removeAttribute("data-avn");
  const render = () => {
    prev.dataset.avd = "x"; avApply(prev, sel, me.username);
    wrap.querySelectorAll("[data-avtab]").forEach((b) => b.classList.toggle("on", b.dataset.avtab === mode));
    wrap.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== mode));
    wrap.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("on", b.dataset.pick === sel));
    wrap.querySelector("#avp-desc").textContent = sel.startsWith("p:") ? "虚拟形象" : "字母头像 · " + sel.slice(2);
    if (sel.startsWith("c:")) wrap.querySelector("#avp-color").value = sel.slice(2);
  };
  const sw = wrap.querySelector("#avp-sw");
  for (const c of AV_PALETTE) { const b = document.createElement("button"); b.type = "button"; b.className = "av-sw"; b.dataset.pick = "c:" + c; b.title = c; b.style.background = c; sw.appendChild(b); }
  avManifestLoad().then((list) => {
    const g = wrap.querySelector("#avp-grid"); g.innerHTML = list.length ? "" : `<div class="empty">暂无预设形象</div>`;
    for (const a of list) { const b = document.createElement("button"); b.type = "button"; b.className = "av-opt"; b.dataset.pick = "p:" + a.id; b.title = a.name || a.id; const img = document.createElement("img"); img.alt = a.name || a.id; img.loading = "lazy"; img.src = "/avatars/" + a.file; b.appendChild(img); g.appendChild(b); }
    wrap.querySelector("#avp-ph").classList.toggle("hidden", !list.some((a) => /\.svg$/.test(a.file)));
    if (!cur && mode === "preset" && !sel.startsWith("p:") && list[0]) sel = "p:" + list[0].id;
    render();
  });
  wrap.addEventListener("click", (e) => {
    const t = e.target.closest("[data-avtab]"); if (t) { mode = t.dataset.avtab; if (mode === "letter" && !sel.startsWith("c:")) sel = "c:" + AV_PALETTE[0]; if (mode === "preset" && !sel.startsWith("p:") && avManifest && avManifest[0]) sel = "p:" + avManifest[0].id; render(); return; }
    const p = e.target.closest("[data-pick]"); if (p) { sel = p.dataset.pick; render(); return; }
    if (e.target === wrap) close(null);
  });
  wrap.querySelector("#avp-color").oninput = (e) => { sel = "c:" + e.target.value.toLowerCase(); render(); };
  const close = (u) => { wrap.remove(); resolve(u); };
  wrap.querySelector("#avp-cancel").onclick = () => close(null);
  wrap.querySelector("#avp-save").onclick = (e) => busy(e.target, async () => {
    try { const { user } = await api("/api/avatar", { method: "POST", body: { avatar: sel } }); avSet(user.username, user.avatar); toast("头像已更新"); close(user); }
    catch (er) { setMsg(wrap.querySelector("#avp-msg"), er.message); }
  });
  render();
});
// 主题切换（按钮带 data-theme-toggle）
window.applyThemeIcon = () => { const dark = document.documentElement.dataset.theme === "dark"; $$("[data-theme-toggle]").forEach((b) => { b.textContent = dark ? "☀️" : "🌙"; b.title = dark ? "切换到浅色" : "切换到深色"; }); };
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-toggle]"); if (!b) return;
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next; try { localStorage.setItem("hzz-theme", next); } catch {}
  applyThemeIcon();
});
document.addEventListener("DOMContentLoaded", () => applyThemeIcon());
window.toast = (t, ms = 2600) => { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), ms); };
