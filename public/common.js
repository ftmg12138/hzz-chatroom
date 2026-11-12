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

// 确认对话框（随主题配色）：confirmDialog({ title, text, ok, danger }) → Promise<boolean>
window.confirmDialog = (o = {}) => new Promise((resolve) => {
  const wrap = document.createElement("div"); wrap.className = "modal confirm-modal";
  wrap.innerHTML = `<div class="card" role="dialog" aria-modal="true"><h2></h2><p class="sub"></p>
    <div class="row confirm-actions"><button type="button" class="btn ghost" data-no>取消</button><button type="button" class="btn ${o.danger === false ? "" : "danger"}" data-yes></button></div></div>`;
  wrap.querySelector("h2").textContent = o.title || "确定吗？";
  wrap.querySelector(".sub").textContent = o.text || "";
  wrap.querySelector("[data-yes]").textContent = o.ok || "确定";
  const done = (v) => { document.removeEventListener("keydown", onKey); wrap.remove(); resolve(v); };
  const onKey = (e) => { if (e.key === "Escape") done(false); };
  wrap.onclick = (e) => { if (e.target === wrap || e.target.closest("[data-no]")) done(false); else if (e.target.closest("[data-yes]")) done(true); };
  document.addEventListener("keydown", onKey);
  document.body.appendChild(wrap);
  wrap.querySelector("[data-no]").focus();
});

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
// ===== 界面主题（皮肤） =====
window.SITE = document.documentElement.dataset.site || "text";
window.SKINS = {
  forest: { name: "🌿 森林小屋", desc: "清新绿意 · 侧栏布局 · 叶片装饰", tagline: "在绿意里，慢慢聊",
    eyebrow: "🌿 今日好时光", heroTitle: "找个角落，和朋友聊聊天", heroText: "创建一个房间邀请朋友进来，或者看看大厅里正在热聊的公开房间。",
    helpTitle: "第一次来？", helpText: "创建房间，把房间号和密码发给朋友；设为公开，大家就能申请加入。",
    authTitle: "欢迎回到森林小屋", authText: "文字、语音、视频——和朋友待在同一片绿荫下。", heroTitleV: "见个面吧，就在这片绿荫下", heroTextV: "2–4 人的小视频房间，点对点直连。约上朋友，开一个只属于你们的房间。", myV: "我的视频房间", pubV: "公开视频房间", statTitle: "此刻的大厅", my: "我的房间", pub: "公开房间", feed: "最近动态" },
  night: { name: "🌙 星夜梦境", desc: "深蓝紫夜空 · 顶部导航 · 玻璃卡片", tagline: "星光下，说说心里话",
    eyebrow: "✨ 今夜星光正好", heroTitle: "在星空下，和懂你的人说说话", heroText: "每个房间都是一颗星。点亮一颗属于你们的，或者去看看别人的星座。",
    helpTitle: "迷路了？", helpText: "创建房间就像点亮一颗星，把房间号告诉朋友就能相聚。",
    authTitle: "星光为你留了一盏灯", authText: "夜深了，总有人还醒着，想和你聊聊。", heroTitleV: "隔着星河，也能看见你的笑", heroTextV: "最多 4 人的视频房间，画面直连不经服务器。今晚，和谁一起看星星？", myV: "我的视频星球", pubV: "公开视频星座", statTitle: "今夜星图", my: "我的星球", pub: "公开星座", feed: "流星动态" },
  cream: { name: "💛 奶油萌宠", desc: "奶油蜜桃色 · 图标轨道 · 泡泡卡片 · 奶蛙", tagline: "软软的房间，暖暖的聊天",
    eyebrow: "💛 奶蛙在等你", heroTitle: "软软的房间，暖暖地聊天", heroText: "带上你的小伙伴，一起开个茶话会吧！公开房间里也有新朋友哦～",
    helpTitle: "奶蛙小贴士", helpText: "创建房间后把房间号发给朋友，或者设为公开让大家来敲门～",
    authTitle: "奶蛙说：欢迎回家！", authText: "小狐狸和熊猫已经在沙发上等你啦。", heroTitleV: "面对面，奶蛙也想挥挥手", heroTextV: "最多 4 个小伙伴一起视频，软软地说说今天发生的事吧～", myV: "我的视频小窝", pubV: "大家的视频茶话会", statTitle: "奶蛙的小本本", my: "我的小窝", pub: "大家的茶话会", feed: "小伙伴动态" },
  tavern: { name: "🍺 西幻酒馆", desc: "羊皮纸 · 木质招牌 · 公会告示板", tagline: "冒险者的落脚处",
    eyebrow: "⚜ 公会告示", heroTitle: "推开酒馆大门，同伴正等着你", heroText: "在告示板上挑一份委托加入，或者张贴你自己的告示，召集同伴。",
    helpTitle: "新来的冒险者？", helpText: "张贴告示（创建房间），把暗号告诉同伴即可入席。",
    authTitle: "欢迎来到冒险者酒馆", authText: "炉火正旺，麦酒管够，今晚的故事由你开始。", heroTitleV: "围坐炉火边，与同伴面对面", heroTextV: "每张圆桌最多四位冒险者，魔法水晶球直连彼此的画面。", myV: "我的圆桌", pubV: "公会招募中的圆桌", statTitle: "酒馆今晚", my: "我的据点", pub: "公会告示板", feed: "酒馆传闻" },
};
window.skinNow = () => document.documentElement.dataset.skin || "forest";
window.applySkin = (k, save = true) => {
  if (!SKINS[k]) k = "forest";
  document.documentElement.dataset.skin = k;
  if (save) try { localStorage.setItem("hzz-skin", k); } catch {}
  const t = SKINS[k];
  $$("[data-sk]").forEach((el) => { const v = t[el.dataset.sk + (window.SITE === "video" && t[el.dataset.sk + "V"] ? "V" : "")]; if (v != null) el.textContent = v; });
  $$("[data-skin-set]").forEach((b) => b.classList.toggle("on", b.dataset.skinSet === k));
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = { forest: "#f2f6f1", night: "#0c0e24", cream: "#fff4e8", tavern: "#2a1b10" }[k];
  document.dispatchEvent(new CustomEvent("skinchange", { detail: k }));
};
// 登录后按账号里保存的主题同步（没有保存过则把本机选择写回账号）
window.syncSkin = (user) => {
  if (!user) return;
  if (user.theme && user.theme !== skinNow()) applySkin(user.theme);
  else if (!user.theme && skinNow() !== "forest") { user.theme = skinNow(); api("/api/theme", { method: "POST", body: { theme: user.theme } }).catch(() => {}); }
};
window.setSkin = async (k) => {
  applySkin(k);
  if (window.__me) try { const { user } = await api("/api/theme", { method: "POST", body: { theme: k } }); window.__me.theme = user.theme; } catch {}
};
window.openSkinPicker = () => {
  const wrap = document.createElement("div"); wrap.className = "modal skin-modal";
  wrap.innerHTML = `<div class="card"><div class="row"><h2>选择界面主题</h2><button class="btn ghost sm nogrow" data-x>关闭</button></div>
    <p class="sub mt0">每套主题的布局、背景和插画都不一样${window.__me ? "，会保存到你的账号，两个站点同步" : "（登录后会保存到账号）"}。</p>
    <div class="skin-grid">${Object.entries(SKINS).map(([k, t]) => `<button class="skin-opt${k === skinNow() ? " on" : ""}" data-k="${k}"><div class="pv"></div><div class="tx"><b>${t.name}</b><span>${t.desc}</span></div></button>`).join("")}</div></div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener("click", (e) => {
    const o = e.target.closest(".skin-opt");
    if (o) { setSkin(o.dataset.k); wrap.querySelectorAll(".skin-opt").forEach((x) => x.classList.toggle("on", x === o)); setTimeout(() => wrap.remove(), 220); return; }
    if (e.target === wrap || e.target.closest("[data-x]")) wrap.remove();
  });
};
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-theme]")) { openSkinPicker(); return; }
  const c = e.target.closest("[data-skin-set]"); if (c) setSkin(c.dataset.skinSet);
});
document.addEventListener("DOMContentLoaded", () => applySkin(skinNow(), false));
// 房间封面：按房间号稳定选一张
window.coverOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 33 + ch.codePointAt(0)) >>> 0; return "cv" + (h % 3 + 1); };
window.ago = (ts) => { if (!ts) return ""; const d = (Date.now() - ts) / 1000; return d < 60 ? "刚刚" : d < 3600 ? Math.floor(d / 60) + " 分钟前" : d < 86400 ? Math.floor(d / 3600) + " 小时前" : Math.floor(d / 86400) + " 天前"; };
window.toast = (t, ms = 2600) => { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), ms); };

// ===== 大厅（两个站点共用）：房间卡片、动态、统计、搜索、导航 =====
window.Lobby = {
  cards(list, mode, opt = {}) {
    const vid = opt.kind === "video";
    let prev = "";
    return list.map((r, i) => {
      let cv = coverOf(r.number + (vid ? "v" : "")); if (cv === prev) cv = "cv" + ((+cv[2]) % 3 + 1); prev = cv;
      const owner = r.creator_name || "—", isPub = mode === "pub" || r.visibility === "public";
      const q = `${r.number} ${r.name || ""} ${owner}`.toLowerCase();
      const live = typeof r.online === "number" ? `<span class="live"><span class="live-dot"></span>${r.online}${vid ? "/4" : ""} 在线</span>` : "";
      const act = mode === "my"
        ? `<a class="btn sm" href="#/room/${encodeURIComponent(r.number)}">${vid ? "进入视频" : "进入"}</a><button class="btn ghost sm" data-leave="${esc(r.number)}" title="从列表移除">移除</button>`
        : r.member ? `<a class="btn sm" href="#/room/${encodeURIComponent(r.number)}">进入</a>`
        : r.pending ? `<button class="btn soft sm" disabled>⏳ 等待房主同意</button>`
        : `<button class="btn soft sm" data-req="${esc(r.number)}">✋ 申请加入</button>`;
      return `<div class="rcard" data-q="${esc(q)}">
        <div class="cover ${cv}"><div class="tags">${vid ? '<span class="tag">🎥 视频</span>' : '<span class="tag">💬 文字</span>'}<span class="tag">${isPub ? "🌿 公开" : "🔒 私密"}</span></div>${live}</div>
        <div class="rc-body"><div class="rc-name" title="${esc(r.name || r.number)}">${esc(r.name || r.number)}</div>
          <div class="rc-owner">${avatar(owner, true)}<span>房主 <b>${esc(owner)}</b></span></div>
          <div class="rc-meta"><span># ${esc(r.number)}</span>${r.members != null ? `<span>👥 ${r.members} 位成员</span>` : ""}${r.last_active_at ? `<span>🕒 ${esc(ago(r.last_active_at))}</span>` : ""}</div>
          <div class="rc-actions">${act}</div></div></div>`;
    }).join("");
  },
  feed(my, pub) {
    const seen = new Set(), all = [];
    for (const r of [...pub.map((x) => ({ visibility: "public", ...x })), ...my]) { if (seen.has(r.number)) continue; seen.add(r.number); all.push(r); }
    all.sort((a, b) => (b.last_active_at || 0) - (a.last_active_at || 0));
    return all.slice(0, 6).map((r) => `<li>${avatar(r.creator_name || "?")}<div class="ft"><b>${esc(r.creator_name || "—")}</b> 的「${esc(r.name || r.number)}」<span class="sub">${typeof r.online === "number" ? `${r.online} 人在线 · ` : ""}${r.visibility === "public" ? "公开" : "私密"}</span></div><span class="when">${esc(ago(r.last_active_at))}</span></li>`).join("")
      || `<li class="empty">还没有动态，去创建第一个房间吧 ✨</li>`;
  },
  search() {
    const q = ($("#l-search")?.value || "").trim().toLowerCase();
    $$("#l-rooms .rcard, #l-pub .rcard").forEach((c) => c.classList.toggle("hidden", !!q && !c.dataset.q.includes(q)));
  },
};
document.addEventListener("input", (e) => { if (e.target.id === "l-search") Lobby.search(); });
document.addEventListener("click", (e) => {
  const app = e.target.closest(".app");
  const n = e.target.closest("[data-nav]");
  if (n) {
    e.preventDefault();
    const id = n.dataset.nav, el = id === "top" ? null : document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); else window.scrollTo({ top: 0, behavior: "smooth" });
    $$(`[data-nav]`).forEach((x) => x.classList.toggle("on", x.dataset.nav === id));
    app && app.classList.remove("nav-open");
    return;
  }
  if (e.target.closest("[data-nav-open]")) { app && app.classList.add("nav-open"); return; }
  if (e.target.closest("[data-nav-close]")) { app && app.classList.remove("nav-open"); return; }
  const g = e.target.closest("[data-go]");
  if (g) {
    const t = document.querySelector(`[data-rtab="${g.dataset.go}"]`); if (t) t.click();
    const f = document.getElementById("roomform"); if (f) f.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => document.getElementById("r-num")?.focus({ preventScroll: true }), 350);
    app && app.classList.remove("nav-open");
  }
});
