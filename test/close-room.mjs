// 房主关闭房间（文字站 + 视频站）线上测试：MAINT_TOKEN_FILE=... node test/close-room.mjs
// API 权限（401/403/404）、踢出在线成员并提示、公开列表/我的房间消失、房间号释放、前端按钮+确认框（四套主题，桌面+手机截图）、视频端立即退出声网
import fs from "node:fs";
import WebSocket from "ws";
import { chromium } from "playwright-core";
const C = process.env.BASE || "https://chatroom.xyzhzz.com";
const V = process.env.VIDEO_BASE || "https://videochatroom.xyzhzz.com";
const MAINT = fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim();
const SHOTS = process.env.SHOTS || "/workspace";
const sfx = Math.random().toString(36).slice(2, 7);
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
const a = client(C), b = client(C), anon = client(C), adm = client(C, { "X-Maint-Token": MAINT });
const na = `ca_${sfx}`, nb = `cb_${sfx}`, PW = "Close-pass-" + sfx, RPW = "cr-" + sfx;
const rooms = []; // [kind, number] 供清理

try {
  let r = await a.req("/api/register", "POST", { username: na, password: PW }); ok(r.status === 200, "注册房主 A");
  r = await b.req("/api/register", "POST", { username: nb, password: PW }); ok(r.status === 200, "注册成员 B");

  for (const [kind, base] of [["text", C], ["video", V]]) {
    const label = kind === "video" ? "视频" : "文字", room = `close-${kind[0]}-${sfx}`;
    console.log(`${label}房间 API`);
    r = await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "关闭测试", visibility: "public" }, base); ok(r.status === 200, `A 创建公开${label}房间`); rooms.push([kind, room]);
    r = await b.req("/api/rooms/join", "POST", { number: room, password: RPW }, base); ok(r.status === 200, "B 凭密码加入");
    r = await b.req("/api/rooms/public", "GET", undefined, base); ok(r.data.rooms?.some((x) => x.number === room), "公开列表里有该房间");
    r = await anon.req("/api/rooms/close", "POST", { number: room }, base); ok(r.status === 401, "未登录关闭 → 401");
    r = await b.req("/api/rooms/close", "POST", { number: room }, base); ok(r.status === 403, "非房主关闭 → 403");
    r = await a.req("/api/rooms/close", "POST", { number: room + "-nope" }, base); ok(r.status === 404, "不存在的房间 → 404");
    const otherKind = kind === "video" ? C : V;
    r = await a.req("/api/rooms/close", "POST", { number: room }, otherKind); ok(r.status === 404, "在另一个站点不能关闭这个房间（命名空间独立）");
    const wa = a.ws(room, base), wb = b.ws(room, base);
    ok((await wa.opened) === true && (await wb.opened) === true, "A、B 都在房间里（WebSocket 已连）");
    await waitFor(wb, (m) => m.type === "welcome" || m.type === "hello");
    if (kind === "video") ok((await waitFor(wa, (m) => m.type === "welcome"))?.isOwner === true, "A 在 welcome 中被识别为房主");
    else ok((await waitFor(wa, (m) => m.type === "hello"))?.isOwner === true, "A 在 hello 中被识别为房主");
    r = await a.req("/api/rooms/close", "POST", { number: room }, base); ok(r.status === 200, "房主关闭房间 → 200");
    const kb = await waitFor(wb, (m) => m.type === "kicked");
    ok(kb && kb.closed === true && kb.reason === "房主已关闭房间", "B 收到「房主已关闭房间」并被移出");
    ok(!!(await waitFor(wa, (m) => m.type === "kicked")), "A 自己的连接也被关闭");
    wa.terminate(); wb.terminate();
    r = await b.req("/api/rooms/public", "GET", undefined, base); ok(!r.data.rooms?.some((x) => x.number === room), "公开列表里已没有该房间");
    r = await b.req("/api/rooms", "GET", undefined, base); ok(!r.data.rooms?.some((x) => x.number === room), "B 的「我的房间」里已没有该房间");
    r = await b.req("/api/rooms/join", "POST", { number: room, password: RPW }, base); ok(r.status === 403 || r.status === 404, "关闭后不能再凭密码加入");
    const w2 = b.ws(room, base); ok((await w2.opened) === 403, "关闭后 WebSocket 被拒"); w2.terminate();
    if (kind === "video") { r = await b.req(`/api/rooms/${room}/rtc-token`, "POST", {}, base); ok(r.status === 403, "关闭后不再签发声网 Token"); }
    r = await b.req("/api/rooms", "POST", { number: room, password: RPW }, base); ok(r.status === 200, "房间号已释放，可被重新创建");
    r = await adm.req(`/api/admin/rooms/${kind}/${room}`, "DELETE"); ok(r.status === 200, "管理员解散（后台原有功能）仍可用");
    r = await adm.req(`/api/admin/logs?room=${room}&limit=50`);
    ok(r.data.rows?.some((x) => x.event === (kind === "video" ? "video_room_close" : "room_close") && x.username === na), "访问日志记录了房主关闭事件");
  }

  console.log("前端：按钮 / 确认框 / 被踢提示（四套主题，桌面 + 手机）");
  const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  async function pageFor(c, mobile) {
    const ctx = await br.newContext({ permissions: ["camera", "microphone"], ...(mobile ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 760 } }) });
    await ctx.addCookies([{ name: "hzz_sid", value: c.token, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    const p = await ctx.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(e.message));
    p.on("dialog", (d) => { p.alerted = d.message(); d.dismiss().catch(() => {}); });
    return p;
  }
  const toasts = (p) => p.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join("|"));
  const errs = [];
  for (const theme of ["forest", "night", "cream", "tavern"]) {
    await a.req("/api/theme", "POST", { theme }); await b.req("/api/theme", "POST", { theme });
    for (const [kind, base] of [["text", C], ["video", V]]) {
      const room = `close-ui-${kind[0]}${theme.slice(0, 2)}-${sfx}`, label = `${theme}/${kind === "video" ? "视频" : "文字"}`;
      await a.req("/api/rooms", "POST", { number: room, password: RPW, name: "关闭测试" }, base); rooms.push([kind, room]);
      await b.req("/api/rooms/join", "POST", { number: room, password: RPW }, base);
      const mobile = kind === "video" ? theme === "night" || theme === "tavern" : theme === "forest" || theme === "cream";
      const pa = await pageFor(a, mobile), pb = await pageFor(b, !mobile);
      for (const p of [pa, pb]) {
        await p.goto(base + "/#/room/" + encodeURIComponent(room));
        if (kind === "video") { await p.waitForSelector("#v-perm:not(.hidden)"); await p.click("#p-allow"); await p.waitForSelector("#v-room:not(.hidden)"); }
        else await p.waitForSelector("#v-chat:not(.hidden)");
      }
      if (kind === "video") {
        const t = Date.now(); while (Date.now() - t < 25000 && !(await pb.evaluate(() => window.__vc.agState === "CONNECTED"))) await sleep(400);
      }
      await pa.waitForSelector("#close-room-btn:not(.hidden)", { timeout: 8000 }).catch(() => {});
      ok(await pa.isVisible("#close-room-btn"), `${label}${mobile ? "（手机）" : ""}：房主看到「关闭房间」按钮`);
      ok(!(await pb.isVisible("#close-room-btn")), `${label}：非房主看不到按钮`);
      await pa.click("#close-room-btn"); await pa.waitForSelector(".confirm-modal"); await sleep(600); // 等弹出动画结束再截图
      await pa.screenshot({ path: `${SHOTS}/close-room-${theme}-${kind}-${mobile ? "mobile" : "desktop"}.png` });
      await pa.click(".confirm-modal [data-no]"); await sleep(400);
      ok(!(await pa.$(".confirm-modal")) && (await pa.isVisible(kind === "video" ? "#v-room" : "#v-chat")), `${label}：取消后仍在房间`);
      await pa.click("#close-room-btn"); await pa.click(".confirm-modal [data-yes]");
      await pa.waitForSelector("#v-lobby:not(.hidden)", { timeout: 8000 }).catch(() => {});
      await pb.waitForSelector("#v-lobby:not(.hidden)", { timeout: 8000 }).catch(() => {});
      ok(await pa.isVisible("#v-lobby") && (await toasts(pa)).includes("房间已关闭"), `${label}：确认后房主回到大厅`);
      ok(await pb.isVisible("#v-lobby") && (await toasts(pb)).includes("房主已关闭房间") && !pb.alerted, `${label}：成员回到大厅并看到「房主已关闭房间」提示（不弹阻塞框）`);
      if (kind === "video") ok(await pa.evaluate(() => window.__vc.ag === null) && await pb.evaluate(() => window.__vc.ag === null), `${label}：双方已退出声网频道`);
      if (theme === "cream" && kind === "text") await pb.screenshot({ path: `${SHOTS}/close-room-member-notice.png` });
      errs.push(...pa.errs, ...pb.errs);
      await pa.context().close(); await pb.context().close();
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
}
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
