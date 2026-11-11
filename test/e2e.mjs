// 端到端测试：BASE=https://chatroom.xyzhzz.com node test/e2e.mjs
// 管理员初始密码从 ADMIN_PW_FILE 读取（不打印）；测试结束前把管理员密码改回初始值（再由 reset-admin.sh 恢复强制改密）。
import fs from "node:fs";
import WebSocket from "ws";
const BASE = process.env.BASE || "http://127.0.0.1:8799";
const ORIGIN = process.env.ORIGIN || "https://chatroom.xyzhzz.com";
// 管理员已改密时，可用维护令牌（Worker secret MAINT_TOKEN，测试后删除）代替管理员登录
const MAINT = process.env.MAINT_TOKEN_FILE ? fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim() : null;
const ADMIN_PW = MAINT ? null : process.env.ADMIN_PW_FILE ? fs.readFileSync(process.env.ADMIN_PW_FILE, "utf8").replace(/[\r\n]/g, "") : process.env.ADMIN_PW;
const sfx = Math.random().toString(36).slice(2, 7);
let pass = 0, failN = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  ✓", name); } else { failN++; console.log("  ✗", name); } };

function client(extra = {}) {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async req(path, method = "GET", body) {
      const h = { Origin: ORIGIN, ...extra };
      if (cookie) h.Cookie = cookie;
      if (body !== undefined) h["content-type"] = "application/json";
      const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get("set-cookie");
      if (sc) { const m = sc.match(/hzz_sid=([0-9a-f]*)/); cookie = m && m[1] ? `hzz_sid=${m[1]}` : ""; this.lastSetCookie = sc; }
      let data = {}; try { data = await r.json(); } catch {}
      return { status: r.status, data };
    },
    ws(room) {
      const url = BASE.replace(/^http/, "ws") + `/api/rooms/${encodeURIComponent(room)}/ws`;
      const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: ORIGIN } });
      ws.msgs = []; ws.on("message", (d) => ws.msgs.push(JSON.parse(d)));
      return ws;
    },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsOpen = (ws) => new Promise((res) => { ws.once("open", () => res(true)); ws.once("unexpected-response", (_q, r) => res(r.statusCode)); ws.once("error", () => res(false)); });
async function waitFor(ws, pred, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { const m = ws.msgs.find(pred); if (m) return m; await sleep(100); } return null; }

const u1 = client(), u2 = client(), anon = client(), adm = client(MAINT ? { "X-Maint-Token": MAINT } : {});
const n1 = `t1_${sfx}`, n2 = `t2_${sfx}`, room = `test-${sfx}`;
const PW = "Test-pass-" + sfx + "!x", RPW = "rp-" + sfx;
const ADMIN_NEW = "Tmp-Admin-" + Math.random().toString(36).slice(2) + "#9";

console.log("BASE", BASE);
console.log("账号");
let r = await u1.req("/api/register", "POST", { username: n1, password: PW });
ok(r.status === 200 && u1.cookie, "注册用户1");
ok(/HttpOnly/.test(u1.lastSetCookie) && /Secure/.test(u1.lastSetCookie) && /SameSite=Lax/.test(u1.lastSetCookie), "Cookie 带 HttpOnly/Secure/SameSite");
r = await u2.req("/api/register", "POST", { username: n2, password: PW });
ok(r.status === 200, "注册用户2");
r = await anon.req("/api/register", "POST", { username: n1, password: PW });
ok(r.status === 409, "重复用户名被拒");
r = await anon.req("/api/register", "POST", { username: "xyzhzzmaster", password: PW });
ok(r.status === 400, "管理员用户名不可注册");
r = await anon.req("/api/login", "POST", { username: n1, password: "wrong-password" });
ok(r.status === 401, "错误密码登录失败");
r = await anon.req("/api/login", "POST", { username: n1, password: PW });
ok(r.status === 200 && r.data.user.username === n1, "正确密码登录成功");
r = await anon.req("/api/logout", "POST");
ok(r.status === 200, "退出");
r = await anon.req("/api/me");
ok(r.status === 401, "退出后会话失效");
r = await fetch(BASE + "/api/login", { method: "POST", headers: { Origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ username: n1, password: PW }) });
ok(r.status === 403, "跨站来源 POST 被拒");

console.log("房间");
r = await u1.req("/api/rooms", "POST", { number: room, password: RPW, name: "测试房间" });
ok(r.status === 200, "用户1创建房间");
r = await u2.req("/api/rooms", "POST", { number: room, password: "other" });
ok(r.status === 409 || r.status === 400, "重复房间号被拒");
let w = u2.ws(room); ok((await wsOpen(w)) === 403, "未凭密码加入时 WebSocket 被拒"); w.terminate();
r = await u2.req("/api/rooms/join", "POST", { number: room, password: "wrong-pass" });
ok(r.status === 403, "错误房间密码被拒");
r = await u2.req("/api/rooms/join", "POST", { number: room, password: RPW });
ok(r.status === 200, "正确房间密码加入");
w = anon.ws(room); ok((await wsOpen(w)) === 403, "未登录 WebSocket 被拒"); w.terminate();

console.log("WebSocket");
const w1 = u1.ws(room); ok((await wsOpen(w1)) === true, "用户1连接");
const h1 = await waitFor(w1, (m) => m.type === "hello"); ok(h1 && h1.room === room, "收到 hello");
const w2 = u2.ws(room); ok((await wsOpen(w2)) === true, "用户2连接");
await waitFor(w2, (m) => m.type === "hello");
const pres = await waitFor(w1, (m) => m.type === "presence" && m.online.includes(n2));
ok(pres && pres.online.includes(n1), "在线列表显示两人");
w1.send(JSON.stringify({ type: "msg", text: "你好，" + n2 + " <b>xss</b>", cid: "c1" }));
const got = await waitFor(w2, (m) => m.type === "msg" && m.msg.username === n1);
ok(got && got.msg.text.includes("<b>xss</b>"), "用户2收到用户1消息");
w2.send(JSON.stringify({ type: "msg", text: "收到！" }));
ok(!!(await waitFor(w1, (m) => m.type === "msg" && m.msg.username === n2)), "用户1收到用户2消息");
w2.close(); await sleep(500);
const w2b = u2.ws(room); await wsOpen(w2b);
const h2 = await waitFor(w2b, (m) => m.type === "hello");
ok(h2 && h2.history.length >= 2, "重连后加载历史消息");
r = await u2.req("/api/rooms");
ok(r.status === 200 && r.data.rooms.some((x) => x.number === room), "我的房间列表");

console.log("管理后台");
r = await anon.req("/api/admin/logs");
ok(r.status === 401, "未登录访问后台被拒");
r = await fetch(BASE + "/api/admin/logs", { headers: { "X-Maint-Token": "0".repeat(64) } });
ok(r.status === 401, "错误维护令牌被拒");
r = await u1.req("/api/admin/logs");
ok(r.status === 403, "普通用户访问后台被拒");
if (!MAINT) {
  r = await adm.req("/api/login", "POST", { username: "xyzhzzmaster", password: ADMIN_PW });
  ok(r.status === 200 && r.data.user.isAdmin && r.data.user.mustChange, "管理员初始密码登录，标记需改密");
  r = await adm.req("/api/admin/logs");
  ok(r.status === 403, "改密前后台接口被拒");
  r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_PW, newPassword: "short" });
  ok(r.status === 400, "过短新密码被拒");
  r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_PW, newPassword: ADMIN_NEW });
  ok(r.status === 200 && !r.data.user.mustChange, "强制改密成功");
} else {
  // 用普通用户验证改密流程（管理员密码不动）
  r = await u1.req("/api/password", "POST", { oldPassword: PW, newPassword: "short" });
  ok(r.status === 400, "过短新密码被拒");
  r = await u1.req("/api/password", "POST", { oldPassword: "wrong-old", newPassword: PW + "2" });
  ok(r.status === 400, "原密码错误被拒");
  r = await u1.req("/api/password", "POST", { oldPassword: PW, newPassword: PW + "2" });
  ok(r.status === 200, "用户修改密码成功");
}
r = await adm.req("/api/admin/logs?username=" + n1);
ok(r.status === 200 && r.data.rows.length > 0 && r.data.rows.every((x) => x.username.includes(n1)), "日志按用户筛选");
const reg = r.data.rows.find((x) => x.event === "register");
ok(reg && reg.ip && reg.ua, `日志记录 IP/UA/国家（IP=${reg?.ip ? "有" : "无"}，国家=${reg?.country || "空"}）`);
r = await adm.req("/api/admin/logs?event=room_join_fail&room=" + room);
ok(r.status === 200 && r.data.rows.length >= 1, "房间密码错误事件已记录");
r = await adm.req("/api/admin/logs?event=visit&limit=5");
ok(r.status === 200, "访客日志可查询");
r = await adm.req("/api/admin/users?q=" + sfx);
ok(r.status === 200 && r.data.rows.length === 2, "用户列表搜索");
const id2 = r.data.rows.find((x) => x.username === n2).id, id1 = r.data.rows.find((x) => x.username === n1).id;
r = await adm.req("/api/admin/rooms?q=" + room);
ok(r.status === 200 && r.data.rows[0]?.messages >= 2 && r.data.rows[0].online.length === 2, "房间列表含消息数和在线成员");
r = await adm.req(`/api/admin/rooms/text/${room}/messages`);
ok(r.status === 200 && r.data.rows.length >= 2 && r.data.rows[0].ip !== undefined, "查看房间消息");
const mid = r.data.rows.find((x) => x.username === n2).id;
r = await adm.req(`/api/admin/rooms/text/${room}/messages/${mid}`, "DELETE");
ok(r.status === 200 && !!(await waitFor(w1, (m) => m.type === "deleted" && m.id === mid)), "删除单条消息并实时同步");
r = await adm.req(`/api/admin/users/${id2}/ban`, "POST", { banned: true, reason: "测试" });
ok(r.status === 200 && !!(await waitFor(w2b, (m) => m.type === "kicked")), "封禁用户并踢出房间");
r = await u2.req("/api/me"); ok(r.status === 401, "封禁后会话失效");
r = await u2.req("/api/login", "POST", { username: n2, password: PW }); ok(r.status === 403, "封禁用户无法登录");
r = await adm.req(`/api/admin/users/${id2}/ban`, "POST", { banned: false }); ok(r.status === 200, "解封");
r = await adm.req(`/api/admin/rooms/text/${room}/messages`, "DELETE");
ok(r.status === 200 && !!(await waitFor(w1, (m) => m.type === "cleared")), "清空房间消息");

console.log("清理");
r = await adm.req(`/api/admin/rooms/text/${room}`, "DELETE");
ok(r.status === 200 && !!(await waitFor(w1, (m) => m.type === "kicked")), "删除房间并移出在线成员");
for (const id of [id1, id2]) { r = await adm.req(`/api/admin/users/${id}`, "DELETE"); ok(r.status === 200, "删除测试用户 " + id); }
r = await adm.req("/api/admin/users?q=" + sfx); ok(r.data.rows.length === 0, "测试用户已删除");
r = await adm.req("/api/admin/rooms?q=" + room); ok(r.data.rows.length === 0, "测试房间已删除");
if (!MAINT) {
  r = await adm.req("/api/password", "POST", { oldPassword: ADMIN_NEW, newPassword: ADMIN_PW });
  ok(r.status === 200, "管理员密码改回初始值");
}
for (const s of [w1, w2b]) try { s.terminate(); } catch {}

if (process.env.RATE_TEST === "1") {
  console.log("限流");
  let last; for (let i = 0; i < 11; i++) last = await anon.req("/api/login", "POST", { username: "nouser_" + sfx, password: "x" });
  ok(last.status === 429, "同一用户名连续失败触发限流");
}
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
