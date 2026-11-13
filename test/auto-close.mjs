// 房间自动关闭线上测试（文字站 + 视频站）：MAINT_TOKEN_FILE=... node test/auto-close.mjs
// 需要两个 Worker 临时设置 secret IDLE_TEST_MS（如 15000）：只对房间号以 zz-idle- 开头的房间生效，真实房间仍是 10 分钟。测完删除该 secret。
import fs from "node:fs";
import WebSocket from "ws";
import { chromium } from "playwright-core";
const C = process.env.BASE || "https://chatroom.xyzhzz.com";
const V = process.env.VIDEO_BASE || "https://videochatroom.xyzhzz.com";
const MAINT = fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim();
const SHOTS = process.env.SHOTS || "/workspace";
const sfx = Math.random().toString(36).slice(2, 7);
const AUTO = "房间因长时间无人已自动关闭";
let pass = 0, failN = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓", n); } else { failN++; console.log("  ✗", n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base, extra = {}) {
  let cookie = "";
  return {
    get cookie() { return cookie; }, get token() { return cookie.split("=")[1]; },
    async req(path, method = "GET", body, b = base) {
      const h = { Origin: b, ...extra };
      if (cookie) h.Cookie = cookie;
      if (body !== undefined) h["content-type"] = "application/json";
      const r = await fetch(b + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get("set-cookie");
      if (sc) { const m = sc.match(/hzz_sid=([0-9a-f]*)/); cookie = m && m[1] ? `hzz_sid=${m[1]}` : ""; }
      let data = {}; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    },
    ws(room, b) {
      const ws = new WebSocket(b.replace(/^http/, "ws") + `/api/rooms/${encodeURIComponent(room)}/ws`, { headers: { Cookie: cookie, Origin: b } });
      ws.msgs = []; ws.on("message", (d) => ws.msgs.push(JSON.parse(d)));
      ws.opened = new Promise((res) => { ws.once("open", () => res(true)); ws.once("unexpected-response", (_q, r) => res(r.statusCode)); ws.once("error", () => res(0)); });
      return ws;
    },
  };
}
async function waitFor(ws, pred, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const m = ws.msgs.find(pred); if (m) return m; await sleep(100); } return null; }
const last = (ws, type) => [...ws.msgs].reverse().find((m) => m.type === type);
const a = client(C), b = client(C), anon = client(C), adm = client(C, { "X-Maint-Token": MAINT });
const na = `ia_${sfx}`, nb = `ib_${sfx}`, PW = "Idle-pass-" + sfx, RPW = "ir-" + sfx;
const rooms = [];
const exists = async (kind, room) => !!(await adm.req("/api/admin/rooms?q=" + room)).data.rows?.some((x) => x.number === room && x.kind === kind);
const mk = async (kind, base, tag, extra = {}) => { const room = `zz-idle-${tag}${sfx}`; const r = await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "自动关闭测试", ...extra }, base); rooms.push([kind, room]); return [room, r]; };
let IDLE = 15000;

try {
  console.log("迁移：上线前已有的房间全部保留");
  let r = await adm.req("/api/admin/rooms");
  const pre = (r.data.rows || []).filter((x) => !x.number.includes(sfx));
  ok(pre.length > 0 && pre.every((x) => x.keep === 1), `已有房间 ${pre.length} 个全部 keep=1（${pre.map((x) => x.kind + ":" + x.number).join(", ")}）`);
  ok(pre.some((x) => x.number === "test001" && x.kind === "video" && x.keep === 1), "test001 已保留");

  r = await a.req("/api/register", "POST", { username: na, password: PW }); ok(r.status === 200, "注册房主 A");
  r = await b.req("/api/register", "POST", { username: nb, password: PW }); ok(r.status === 200, "注册成员 B");

  for (const [kind, base] of [["text", C], ["video", V]]) {
    const L = kind === "video" ? "视频" : "文字", k = kind[0], hello = kind === "video" ? "welcome" : "hello";
    console.log(`${L}房间`);
    // 真实房间（无测试前缀）始终 10 分钟
    { const room = `idle-real${k}${sfx}`; await a.req("/api/rooms", "POST", { number: room, password: RPW }, base); rooms.push([kind, room]);
      const w = a.ws(room, base); await w.opened; const h = await waitFor(w, (m) => m.type === hello);
      ok(h && h.keep === false && h.idleMs === 600000 && h.idleAt && Math.abs(h.idleAt - Date.now() - 600000) < 30000, "普通房间默认：未保留，10 分钟计时（测试用短时长不影响真实房间）"); w.terminate(); }
    const [rn] = await mk(kind, base, `n${k}`);
    const [ra] = await mk(kind, base, `a${k}`);
    const [r2] = await mk(kind, base, `t${k}`);
    const [rk] = await mk(kind, base, `k${k}`, { visibility: "public" });
    for (const room of [ra, r2, rk]) await b.req("/api/rooms/join", "POST", { number: room, password: RPW }, base);
    // 单人
    const wa = a.ws(ra, base); await wa.opened; const ha = await waitFor(wa, (m) => m.type === hello);
    IDLE = ha?.idleMs || IDLE;
    ok(ha && ha.keep === false && ha.idleAt > Date.now() && ha.idleMs < 600000, `只有 1 人：开始计时（测试时长 ${IDLE / 1000}s）`);
    // 两人
    const w1 = a.ws(r2, base), w2 = b.ws(r2, base); await w1.opened; await w2.opened;
    ok(!!(await waitFor(w1, (m) => m.type === "room-idle" && m.idleAt === null)), "第 2 人进入后取消计时（room-idle idleAt=null）");
    // 保留
    r = await anon.req("/api/rooms/keep", "POST", { number: rk, keep: true }, base); ok(r.status === 401, "未登录设置保留 → 401");
    r = await b.req("/api/rooms/keep", "POST", { number: rk, keep: true }, base); ok(r.status === 403, "非房主设置保留 → 403");
    r = await a.req("/api/rooms/keep", "POST", { number: rk + "x", keep: true }, base); ok(r.status === 404, "不存在的房间 → 404");
    r = await a.req("/api/rooms/keep", "POST", { number: rk, keep: true }, base); ok(r.status === 200 && r.data.keep === true && r.data.idleAt === null, "房主开启保留 → 200，计时取消");
    const wk = a.ws(rk, base); await wk.opened; const hk = await waitFor(wk, (m) => m.type === hello);
    ok(hk && hk.keep === true && hk.idleAt === null, "保留的房间里只有 1 人也不计时");
    await sleep(IDLE + 6000);
    ok(!(await exists(kind, rn)), "创建后一直没人进的房间到点自动删除");
    const ka = last(wa, "kicked");
    ok(ka && ka.closed === true && ka.reason === AUTO, `单人房间到点：把剩下的人移出并提示「${AUTO}」`);
    ok(!(await exists(kind, ra)), "单人房间已删除");
    ok(await exists(kind, r2) && !last(w1, "kicked") && !last(w2, "kicked"), "两人在线的房间不会被关闭");
    ok(await exists(kind, rk) && !last(wk, "kicked"), "保留的房间不会被关闭");
    r = await b.req("/api/rooms/public", "GET", undefined, base); ok(r.data.rooms?.some((x) => x.number === rk), "保留的公开房间仍在公开列表");
    w2.close(); ok(!!(await waitFor(w1, (m) => m.type === "room-idle" && m.idleAt > Date.now(), 5000)), "第 2 人离开后重新开始计时");
    w1.msgs.length = 0; const w2b = b.ws(r2, base); await w2b.opened;
    ok(!!(await waitFor(w1, (m) => m.type === "room-idle" && m.idleAt === null, 5000)), "有人回来后再次取消计时");
    r = await a.req("/api/rooms/keep", "POST", { number: rk, keep: false }, base);
    ok(r.status === 200 && r.data.keep === false && r.data.idleAt > Date.now() + IDLE - 4000, "房主取消保留 → 重新计满一个周期");
    ok(!!(await waitFor(wk, (m) => m.type === "room-idle" && m.keep === false && m.idleAt)), "房间里的人收到状态更新");
    await sleep(IDLE + 6000);
    ok(!!last(wk, "kicked") && !(await exists(kind, rk)), "取消保留后到点自动关闭");
    r = await b.req("/api/rooms/public", "GET", undefined, base); ok(!r.data.rooms?.some((x) => x.number === rk), "已从公开列表消失");
    r = await b.req("/api/rooms", "GET", undefined, base); ok(!r.data.rooms?.some((x) => x.number === rk || x.number === ra), "已从成员的「我的房间」消失");
    if (kind === "video") { r = await b.req(`/api/rooms/${ra}/rtc-token`, "POST", {}, base); ok(r.status === 403, "关闭后不再签发声网 Token"); }
    r = await b.req("/api/rooms", "POST", { number: ra, password: RPW }, base); ok(r.status === 200, "房间号已释放"); rooms.push([kind, ra]);
    r = await adm.req(`/api/admin/logs?room=${rn}&limit=20`);
    ok(r.data.rows?.some((x) => x.event === (kind === "video" ? "video_room_auto_close" : "room_auto_close")), "访问日志记录自动关闭");
    for (const w of [wa, w1, w2b, wk]) w.terminate();
  }

  console.log("前端：保留开关 / 状态提示 / 自动关闭提示（四套主题，桌面 + 手机）");
  const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  async function pageFor(c, mobile) {
    const ctx = await br.newContext({ permissions: ["camera", "microphone"], ...(mobile ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 760 } }) });
    await ctx.addCookies([{ name: "hzz_sid", value: c.token, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    p.on("dialog", (d) => { p.alerted = d.message(); d.dismiss().catch(() => {}); });
    return p;
  }
  async function enter(p, base, room, kind) {
    await p.goto(base + "/#/room/" + encodeURIComponent(room));
    if (kind === "video") { await p.waitForSelector("#v-perm:not(.hidden)"); await p.click("#p-allow"); await p.waitForSelector("#v-room:not(.hidden)"); }
    else await p.waitForSelector("#v-chat:not(.hidden)");
  }
  const hint = (p) => p.evaluate(() => { const h = document.querySelector("#room-hint"); return h && !h.classList.contains("hidden") ? h.textContent : ""; });
  const toasts = (p) => p.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join("|"));
  async function until(fn, ms = 8000) { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(300); } return v; }
  // 每个账号每小时最多建 10 个房间：前端部分换一对新账号（房主 c、成员 d）
  const c = client(C), d = client(C);
  r = await c.req("/api/register", "POST", { username: `ic_${sfx}`, password: PW }); ok(r.status === 200, "注册房主 C（前端测试）");
  r = await d.req("/api/register", "POST", { username: `id_${sfx}`, password: PW }); ok(r.status === 200, "注册成员 D（前端测试）");
  const errs = [];
  for (const theme of ["forest", "night", "cream", "tavern"]) {
    await c.req("/api/theme", "POST", { theme }); await d.req("/api/theme", "POST", { theme });
    for (const [kind, base] of [["text", C], ["video", V]]) {
      const label = `${theme}/${kind === "video" ? "视频" : "文字"}`;
      const room = `zz-idle-u${kind[0]}${theme.slice(0, 2)}${sfx}`;
      r = await c.req("/api/rooms", "POST", { number: room, password: RPW, name: "自动关闭测试" }, base); rooms.push([kind, room]);
      if (r.status !== 200) console.log("    创建失败", r.status, r.data.error);
      await d.req("/api/rooms/join", "POST", { number: room, password: RPW }, base);
      const mobile = kind === "video" ? theme === "night" || theme === "tavern" : theme === "forest" || theme === "cream";
      const pa = await pageFor(c, mobile), pb = await pageFor(d, !mobile);
      await enter(pa, base, room, kind);
      ok((await until(() => hint(pa))).includes("自动关闭"), `${label}${mobile ? "（手机）" : ""}：只有房主一人时显示自动关闭倒计时提示`);
      ok(await pa.isVisible("#keep-btn"), `${label}：房主看到「保留房间」开关`);
      await enter(pb, base, room, kind);
      ok(await until(async () => (await hint(pa)) === "" && (await hint(pb)) === ""), `${label}：两人在线时提示消失`);
      ok(!(await pb.isVisible("#keep-btn")), `${label}：成员看不到保留开关`);
      await pa.click("#keep-btn");
      ok(await until(async () => (await pa.evaluate(() => document.querySelector("#keep-btn").classList.contains("on"))) && (await hint(pb)).includes("已保留")), `${label}：开启保留后按钮高亮，成员看到「已保留」`);
      await sleep(500);
      await pa.screenshot({ path: `${SHOTS}/keep-${theme}-${kind}-owner-${mobile ? "mobile" : "desktop"}.png` });
      await pb.screenshot({ path: `${SHOTS}/keep-${theme}-${kind}-member-${!mobile ? "mobile" : "desktop"}.png` });
      await pa.click("#keep-btn");
      ok(await until(async () => !(await pa.evaluate(() => document.querySelector("#keep-btn").classList.contains("on"))) && (await hint(pb)) === ""), `${label}：取消保留`);
      if ((theme === "forest" && kind === "text") || (theme === "cream" && kind === "video")) {
        await pb.context().close();
        ok((await until(() => hint(pa))).includes("自动关闭"), `${label}：成员离开后房主看到倒计时`);
        await pa.waitForSelector("#v-lobby:not(.hidden)", { timeout: IDLE + 15000 }).catch(() => {});
        ok(await pa.isVisible("#v-lobby") && (await toasts(pa)).includes(AUTO) && !pa.alerted, `${label}：到点自动关闭，回到大厅并提示「${AUTO}」`);
        if (kind === "video") ok(await pa.evaluate(() => window.__vc.ag === null), `${label}：已退出声网频道`);
        await pa.screenshot({ path: `${SHOTS}/auto-close-${theme}-${kind}-notice.png` });
      } else await pb.context().close();
      errs.push(...pa.errs, ...pb.errs);
      await pa.context().close();
    }
  }
  ok(errs.length === 0, "页面无 JS 报错" + (errs.length ? "：" + errs.join("; ") : ""));
  await br.close();
} finally {
  console.log("清理");
  for (const [kind, room] of rooms) await adm.req(`/api/admin/rooms/${kind}/${room}`, "DELETE");
  const u = await adm.req("/api/admin/users?q=" + sfx);
  for (const x of u.data.rows || []) if (x.username.endsWith(sfx)) await adm.req(`/api/admin/users/${x.id}`, "DELETE");
  let r = await adm.req("/api/admin/users?q=" + sfx); ok((r.data.rows || []).length === 0, "测试用户已清除");
  r = await adm.req("/api/admin/rooms?q=" + sfx); ok((r.data.rows || []).length === 0, "测试房间已清除");
  r = await adm.req("/api/admin/rooms"); ok(["test001"].every((n) => r.data.rows.some((x) => x.number === n && x.keep === 1)), "test001 仍在且保留");
}
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
