// 房间命名空间 / 公开房间与加入申请 / 后台监控·移出·解散·可见性 / 头像 / 中文用户名  线上测试
// MAINT_TOKEN_FILE=... node test/rooms.mjs
import fs from "node:fs";
import WebSocket from "ws";
const C = process.env.BASE || "https://chatroom.xyzhzz.com";
const V = process.env.VIDEO_BASE || "https://videochatroom.xyzhzz.com";
const MAINT = fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim();
const sfx = Math.random().toString(36).slice(2, 7);
let pass = 0, failN = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓", n); } else { failN++; console.log("  ✗", n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(base, extra = {}) {
  let cookie = "";
  return {
    get cookie() { return cookie; },
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
    ws(room, b = C) {
      const ws = new WebSocket(b.replace(/^http/, "ws") + `/api/rooms/${encodeURIComponent(room)}/ws`, { headers: { Cookie: cookie, Origin: b } });
      ws.msgs = []; ws.on("message", (d) => ws.msgs.push(JSON.parse(d)));
      ws.opened = new Promise((res) => { ws.once("open", () => res(true)); ws.once("unexpected-response", (_q, r) => res(r.statusCode)); ws.once("error", () => res(0)); });
      ws.j = (o) => ws.send(JSON.stringify(o));
      return ws;
    },
  };
}
async function waitFor(ws, pred, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const m = ws.msgs.find(pred); if (m) return m; await sleep(100); } return null; }
const adm = client(C, { "X-Maint-Token": MAINT });
const made = [];
const PW = "Rooms-pass-" + sfx, RPW = "rpw-" + sfx;
async function reg(base, name) { const c = client(base); const r = await c.req("/api/register", "POST", { username: name, password: PW }); if (r.status === 200) made.push(name); return { c, r }; }
const sockets = [];
const open = async (c, room, b) => { const w = c.ws(room, b); sockets.push(w); const s = await w.opened; return { w, s }; };

let r = await adm.req("/api/admin/reg-config");
if (r.data.enabled) { console.log("  ! 注册口令已开启，测试需要关闭状态，停止"); process.exit(2); }

console.log("页面");
for (const b of [C, V]) {
  const html = await (await fetch(b + "/")).text();
  ok(!/IP\s*地址|记录.*IP|安全审计/.test(html), `${b.replace("https://", "")} 注册页不再显示 IP 记录提示`);
  ok(/data-theme-toggle/.test(html) && /theme\.js/.test(html), `${b.replace("https://", "")} 有主题切换`);
  const mf = await fetch(b + "/avatars/manifest.json"); const j = await mf.json().catch(() => ({}));
  const list = Array.isArray(j) ? j : j.avatars || [];
  ok(mf.status === 200 && list.length >= 20, `${b.replace("https://", "")} 预设头像清单可访问（${list.length} 个${j.placeholder ? "，占位图" : ""}）`);
  const f = list[0] && (list[0].file || list[0].id + ".webp");
  const im = f ? await fetch(b + "/avatars/" + String(f).split("/").pop()) : { status: 0 };
  ok(im.status === 200, `${b.replace("https://", "")} 预设头像图片可加载`);
}

console.log("账号 / 头像");
const A = await reg(C, `房主${sfx}`); ok(A.r.status === 200 && A.r.data.user.avatar === null, "中文用户名注册，默认没有头像");
const B = await reg(V, `rb_${sfx}`); ok(B.r.status === 200, "视频站注册用户B");
const Cc = await reg(C, `rc_${sfx}`); ok(Cc.r.status === 200, "注册用户C");
const a = A.c, b = B.c, c3 = Cc.c;
r = await a.req("/api/avatar", "POST", { avatar: "p:av03" }); ok(r.status === 200 && r.data.user.avatar === "p:av03", "选择预设头像");
r = await b.req("/api/avatar", "POST", { avatar: "c:#F29BBD" }, C); ok(r.status === 200 && r.data.user.avatar === "c:#f29bbd", "选择字母头像 + 自定义颜色（跨站）");
r = await b.req("/api/avatar", "POST", { avatar: "c:red;x" }); ok(r.status === 400, "非法头像值被拒");
r = await b.req("/api/avatar", "POST", { avatar: "p:../x" }); ok(r.status === 400, "非法预设 id 被拒");
r = await b.req("/api/me"); ok(r.data.user.avatar === "c:#f29bbd", "头像保存在账号里，视频站读取一致");
r = await c3.req(`/api/avatars?names=${encodeURIComponent(`房主${sfx},rb_${sfx},rc_${sfx},nobody_${sfx}`)}`);
ok(r.status === 200 && r.data.avatars[`房主${sfx}`] === "p:av03" && r.data.avatars[`rb_${sfx}`] === "c:#f29bbd" && r.data.avatars[`rc_${sfx}`] === null && r.data.avatars[`nobody_${sfx}`] === null, "批量查询头像");
r = await client(C).req("/api/avatars?names=x"); ok(r.status === 401, "未登录不能查询头像");

console.log("房间号命名空间");
const N = `ns-${sfx}`;
r = await a.req("/api/rooms", "POST", { number: N, password: RPW, name: "文字同号" }); ok(r.status === 200, "创建文字房间 " + N);
r = await a.req("/api/rooms", "POST", { number: N, password: RPW, name: "视频同号" }, V); ok(r.status === 200, "同号视频房间也能创建");
r = await a.req("/api/rooms", "POST", { number: N, password: RPW }); ok(r.status === 409, "同类型同号重复创建被拒");
r = await b.req("/api/rooms/join", "POST", { number: N, password: RPW }); ok(r.status === 200, "B 在视频站加入同号视频房");
r = await b.req("/api/rooms", "GET", undefined, C); ok(r.status === 200 && !r.data.rooms.some((x) => x.number === N), "B 的文字房间列表里没有该号（互不影响）");
let o = await open(b, N); ok(o.s === 403, "B 没加入文字房，文字 WebSocket 被拒");
o = await open(a, N); ok(o.s === true && !!(await waitFor(o.w, (m) => m.type === "hello")), "中文用户名房主进入文字房间（WebSocket 正常）");
const hello = o.w.msgs.find((m) => m.type === "hello");
ok(hello && hello.isOwner === true && hello.owner === `房主${sfx}`, "hello 带房主信息（中文名正确）");
const wAt = o.w;
wAt.j({ type: "msg", text: "命名空间测试消息" }); await waitFor(wAt, (m) => m.type === "msg" && m.msg?.text === "命名空间测试消息");
const ov = await open(a, N, V); ok(ov.s === true && !!(await waitFor(ov.w, (m) => m.type === "welcome")), "房主进入同号视频房间");
const wAv = ov.w;
r = await adm.req("/api/admin/rooms?q=" + N);
ok(r.status === 200 && r.data.rows.filter((x) => x.number === N).map((x) => x.kind).sort().join() === "text,video", "后台房间列表同号两条，区分类型");
r = await adm.req(`/api/admin/logs?room=${N}&limit=50`);
ok(r.status === 200 && r.data.rows.some((x) => x.event === "room_create") && r.data.rows.some((x) => x.event === "video_room_create"), "日志区分文字/视频创建");

console.log("公开房间 / 加入申请");
const P = `pub-${sfx}`;
r = await a.req("/api/rooms", "POST", { number: P, name: "公开测试房", visibility: "public" }); ok(r.status === 200, "创建无密码公开文字房间");
r = await c3.req("/api/rooms/public"); const pr = r.data.rooms?.find((x) => x.number === P);
ok(r.status === 200 && pr && pr.creator_name === `房主${sfx}` && pr.kind === "text" && typeof pr.online === "number" && !pr.member, "大厅公开列表：名称/房主/在线人数");
r = await c3.req("/api/rooms/public", "GET", undefined, V); ok(r.status === 200 && !r.data.rooms.some((x) => x.number === P), "视频站公开列表不含文字房间");
r = await c3.req("/api/rooms/join", "POST", { number: P, password: "x" }); ok(r.status === 400, "无密码公开房间不能凭密码进入，提示申请");
o = await open(c3, P); ok(o.s === 403, "未获批前不能进入");
const op = await open(a, P); await waitFor(op.w, (m) => m.type === "hello");
r = await c3.req("/api/rooms/request", "POST", { number: P }); ok(r.status === 200 && r.data.pending, "C 申请加入");
const jr = await waitFor(op.w, (m) => m.type === "join-request"); ok(jr && jr.username === `rc_${sfx}`, "房主实时收到申请通知");
r = await c3.req("/api/rooms/request", "POST", { number: P }); ok(r.status === 200 && r.data.pending, "重复申请不重复创建");
r = await c3.req("/api/rooms/public"); ok(r.data.rooms.find((x) => x.number === P)?.pending, "申请人看到「等待同意」");
r = await b.req("/api/rooms/requests?number=" + P, "GET", undefined, C); ok(r.status === 403, "非房主不能查看申请");
r = await a.req("/api/rooms/requests?number=" + P); const rq = r.data.rows?.find((x) => x.username === `rc_${sfx}`); ok(r.status === 200 && rq, "房主看到待处理列表");
r = await b.req("/api/rooms/requests/decide", "POST", { id: rq.id, approve: true }, C); ok(r.status === 403, "非房主不能审批");
r = await a.req("/api/rooms/requests/decide", "POST", { id: rq.id, approve: true }); ok(r.status === 200 && r.data.status === "approved", "房主同意");
o = await open(c3, P); ok(o.s === true, "获批后可以进入");
r = await b.req("/api/rooms/request", "POST", { number: P }, C); const rqB = r.data.id; ok(r.status === 200 && r.data.pending, "B 申请加入");
r = await adm.req("/api/admin/requests"); ok(r.status === 200 && r.data.rows.some((x) => x.id === rqB && x.kind === "text" && x.ip), "后台看到申请（带类型和 IP）");
r = await a.req("/api/rooms/requests/decide", "POST", { id: rqB, approve: false }); ok(r.status === 200 && r.data.status === "rejected", "房主拒绝");
o = await open(b, P); ok(o.s === 403, "被拒后不能进入");
r = await adm.req(`/api/admin/logs?room=${P}&limit=50`); const ev = new Set(r.data.rows.map((x) => x.event));
ok(["room_request", "room_request_approve", "room_request_reject"].every((e) => ev.has(e)) && r.data.rows.filter((x) => x.event.startsWith("room_request")).every((x) => x.ip), "申请/同意/拒绝写入日志并带 IP");
// 有密码的公开房：密码仍可直接进
const P2 = `pubpw-${sfx}`;
r = await a.req("/api/rooms", "POST", { number: P2, password: RPW, visibility: "public" }, V); ok(r.status === 200, "创建有密码的公开视频房");
r = await b.req("/api/rooms/public"); ok(r.data.rooms.some((x) => x.number === P2 && x.kind === "video"), "视频站公开列表显示");
r = await b.req("/api/rooms/join", "POST", { number: P2, password: RPW }); ok(r.status === 200, "公开房间仍可凭密码直接进入");
r = await c3.req("/api/rooms/request", "POST", { number: P2 }, V); const rqV = r.data.id; ok(r.status === 200 && r.data.pending, "视频房间申请");
r = await adm.req("/api/admin/requests/decide", "POST", { id: rqV, approve: true }); ok(r.status === 200 && r.data.status === "approved", "管理员在后台代为同意");
r = await c3.req("/api/rooms", "GET", undefined, V); ok(r.data.rooms.some((x) => x.number === P2), "获批后出现在视频站「我的房间」");
r = await adm.req(`/api/admin/logs?room=${P2}&scope=video&limit=50`); ok(r.data.rows.some((x) => x.event === "video_request") && r.data.rows.some((x) => x.event === "video_request_approve"), "视频申请写入视频日志");
r = await adm.req(`/api/admin/rooms/video/${P2}/visibility`, "POST", { visibility: "private" }); ok(r.status === 200, "后台改为私密");
r = await b.req("/api/rooms/public"); ok(!r.data.rooms.some((x) => x.number === P2), "改为私密后不在公开列表");
r = await adm.req(`/api/admin/rooms/text/${P}/visibility`, "POST", { visibility: "private" }); ok(r.status === 400, "没有密码的房间不能改成私密");

console.log("后台监控 / 移出 / 解散");
const vc = await open(c3, P); await waitFor(vc.w, (m) => m.type === "hello");
vc.w.j({ type: "voice-join" }); await waitFor(vc.w, (m) => m.type === "voice-welcome", 4000);
r = await adm.req("/api/admin/monitor");
const mt = r.data.rows?.find((x) => x.number === P && x.kind === "text"), mv = r.data.rows?.find((x) => x.number === N && x.kind === "video");
ok(r.status === 200 && mt && mt.members.length >= 2 && mt.members.every((x) => x.ip) && mt.members.some((x) => x.username === `rc_${sfx}` && x.voice), "监控：在线成员带 IP，显示谁在语音");
ok(mt && typeof mt.messages === "number" && mt.lastActivity > 0 && mt.pending === 0, "监控：消息数 / 最近活跃 / 待处理数");
ok(mv && mv.members.some((x) => x.username === `房主${sfx}`) && "video" in mv.members[0], "监控：视频房间在线成员和摄像头状态");
const mn = r.data.rows?.find((x) => x.number === N && x.kind === "text");
r = await adm.req(`/api/admin/rooms/text/${N}/messages?after=0`); const lastId = Math.max(...r.data.rows.map((x) => x.id));
ok(r.status === 200 && r.data.rows.some((x) => x.text === "命名空间测试消息") && mn && mn.messages >= 1, "后台读取文字房间消息");
wAt.j({ type: "msg", text: "实时监看新消息" }); await sleep(800);
r = await adm.req(`/api/admin/rooms/text/${N}/messages?after=${lastId}`); ok(r.data.rows.length === 1 && r.data.rows[0].text === "实时监看新消息", "后台增量拉取新消息（实时监看）");
const idC = (await adm.req("/api/admin/users?q=rc_" + sfx)).data.rows[0].id;
r = await adm.req(`/api/admin/rooms/text/${P}/kick`, "POST", { userId: idC });
ok(r.status === 200 && !!(await waitFor(vc.w, (m) => m.type === "kicked")), "后台把成员移出房间（含语音）");
await sleep(500);
r = await adm.req("/api/admin/monitor"); ok(!r.data.rows.find((x) => x.number === P && x.kind === "text").members.some((x) => x.username === `rc_${sfx}`), "移出后不在在线列表");
o = await open(c3, P); ok(o.s === 403, "移出后需重新申请");
r = await adm.req(`/api/admin/logs?room=${P}&event=admin_kick`); ok(r.data.rows.length >= 1, "移出写入日志");
// 解散（文字房间里有人在语音中 + 视频房间）
wAt.j({ type: "voice-join" }); await sleep(800);
r = await adm.req(`/api/admin/rooms/text/${N}`, "DELETE"); ok(r.status === 200 && !!(await waitFor(wAt, (m) => m.type === "kicked")), "解散文字房间：在线（含语音）成员被踢");
ok(!wAv.msgs.some((m) => m.type === "kicked"), "同号视频房间不受影响");
r = await adm.req("/api/admin/rooms?q=" + N); ok(r.data.rows.length === 1 && r.data.rows[0].kind === "video", "只删除了文字房间");
r = await a.req("/api/rooms", "POST", { number: N, password: RPW }); ok(r.status === 200, "解散后同号文字房间可重新创建（旧记录已清）");
o = await open(a, N); const h2 = await waitFor(o.w, (m) => m.type === "hello"); ok(h2 && !h2.history.some((m) => m.text === "命名空间测试消息"), "解散后历史记录已删除");
r = await adm.req(`/api/admin/rooms/video/${N}`, "DELETE"); ok(r.status === 200 && !!(await waitFor(wAv, (m) => m.type === "kicked")), "解散视频房间：在线成员被踢");
r = await adm.req(`/api/admin/logs?room=${N}&event=admin_delete_room`); ok(r.data.rows.some((x) => x.detail === "解散文字房间") && r.data.rows.some((x) => x.detail === "解散视频房间"), "解散日志区分类型");

console.log("清理");
for (const w of sockets) { try { w.terminate(); } catch {} }
for (const [k, n] of [["text", N], ["text", P], ["video", P2]]) { r = await adm.req(`/api/admin/rooms/${k}/${n}`, "DELETE"); ok(r.status === 200 || r.status === 404, `删除 ${k} ${n}`); }
for (const name of made) {
  const u = (await adm.req("/api/admin/users?q=" + encodeURIComponent(name))).data.rows.find((x) => x.username === name);
  if (u) { r = await adm.req(`/api/admin/users/${u.id}`, "DELETE"); ok(r.status === 200, "删除测试用户 " + name); }
}
r = await adm.req("/api/admin/rooms?q=" + sfx); ok(r.data.rows.length === 0, "测试房间已清除");
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
