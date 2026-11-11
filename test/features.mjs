// 注册口令开关 + 语音频道 线上测试：MAINT_TOKEN_FILE=... node test/features.mjs
import fs from "node:fs";
import WebSocket from "ws";
import { RTCPeerConnection } from "werift";
import { chromium } from "playwright-core";
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
    ws(room) {
      const ws = new WebSocket(C.replace(/^http/, "ws") + `/api/rooms/${encodeURIComponent(room)}/ws`, { headers: { Cookie: cookie, Origin: C } });
      ws.msgs = []; ws.on("message", (d) => ws.msgs.push(JSON.parse(d)));
      ws.opened = new Promise((res) => { ws.once("open", () => res(true)); ws.once("unexpected-response", (_q, r) => res(r.statusCode)); });
      ws.j = (o) => ws.send(JSON.stringify(o));
      return ws;
    },
  };
}
async function waitFor(ws, pred, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const m = ws.msgs.find(pred); if (m) return m; await sleep(100); } return null; }
const last = (ws, type) => [...ws.msgs].reverse().find((m) => m.type === type);
const adm = client(C, { "X-Maint-Token": MAINT });
const anon = client(C);
const made = [];
async function reg(base, name, code) { const c = client(base); const r = await c.req("/api/register", "POST", { username: name, password: "Feat-pass-" + sfx, code }); if (r.status === 200) made.push(name); return { c, r }; }

let r = await adm.req("/api/admin/reg-config");
ok(r.status === 200, "维护令牌读取注册设置");
const before = r.data;
if (before.enabled || before.hasCode) { console.log("  ! 管理员已设置注册口令，为免覆盖，停止测试"); process.exit(2); }
console.log("注册口令");
r = await anon.req("/api/reg-config"); ok(r.status === 200 && r.data.codeRequired === false && Object.keys(r.data).join() === "codeRequired", "公开接口只返回开关状态（当前关闭）");
r = await adm.req("/api/admin/reg-config", "POST", { clearCode: true }); ok(r.status === 200 && !r.data.hasCode, "清除口令");
r = await adm.req("/api/admin/reg-config", "POST", { enabled: true }); ok(r.status === 400, "未设置口令不能开启");
r = await adm.req("/api/admin/reg-config", "POST", { code: "ab" }); ok(r.status === 400, "过短口令被拒");
const CODE = "Code-" + Math.random().toString(36).slice(2, 10);
r = await adm.req("/api/admin/reg-config", "POST", { code: CODE, enabled: true }); ok(r.status === 200 && r.data.enabled, "设置口令并开启");
r = await anon.req("/api/reg-config"); ok(r.data.codeRequired === true, "chatroom 公开状态：需要口令");
r = await anon.req("/api/reg-config", "GET", undefined, V); ok(r.data.codeRequired === true, "videochatroom 公开状态：需要口令");
let x = await reg(C, `rc0_${sfx}`); ok(x.r.status === 403, "chatroom 不填口令注册被拒");
x = await reg(C, `rc1_${sfx}`, "wrong-code"); ok(x.r.status === 403, "chatroom 错误口令被拒");
x = await reg(V, `rv1_${sfx}`, "wrong-code-2"); ok(x.r.status === 403, "videochatroom 错误口令被拒");
x = await reg(C, `rc2_${sfx}`, CODE); ok(x.r.status === 200, "chatroom 正确口令注册成功");
x = await reg(V, `rv2_${sfx}`, CODE); ok(x.r.status === 200, "videochatroom 正确口令注册成功");
r = await adm.req(`/api/admin/logs?scope=register&q=${sfx}&limit=50`);
const evs = r.data.rows.map((e) => e.event);
ok(evs.filter((e) => e === "register_code_fail").length >= 3 && r.data.rows.every((e) => e.ip), "口令错误尝试写入日志（带 IP）");
ok(r.data.rows.some((e) => e.event === "register" && e.detail === "口令注册"), "口令注册成功写入日志");
r = await adm.req(`/api/admin/logs?q=${encodeURIComponent(CODE)}`); ok(r.data.total === 0, "日志中不包含口令明文");
r = await adm.req("/api/admin/reg-config");
ok(r.data.newCount >= 2 && r.data.recent.some((u) => u.username === `rc2_${sfx}`) && r.data.codeFails24h >= 3, `后台显示新注册（${r.data.newCount} 新）和 24 小时口令错误次数`);
// 错误口令限流（每 IP 每小时 10 次；本机出口 IP 可能轮换，故只做尽力验证）
let lim = 0; for (let i = 0; i < 12; i++) { const y = await reg(C, `rl${i}_${sfx}`, "bad"); if (y.r.status === 429) lim++; }
console.log(`    （连续 12 次错误口令中 ${lim} 次被限流）`);
r = await adm.req("/api/admin/users/seen", "POST"); r = await adm.req("/api/admin/reg-config"); ok(r.data.newCount === 0, "标为已读后新注册计数清零");
r = await adm.req("/api/admin/reg-config", "POST", { enabled: false }); ok(r.status === 200 && !r.data.enabled, "关闭开关");
r = await anon.req("/api/reg-config"); ok(r.data.codeRequired === false, "关闭后公开状态为不需要口令");
x = await reg(C, `rc3_${sfx}`); ok(x.r.status === 200, "关闭后无需口令即可注册");

console.log("语音频道");
const u1 = (await reg(C, `vo1_${sfx}`)).c, u2 = (await reg(C, `vo2_${sfx}`)).c, u3 = (await reg(C, `vo3_${sfx}`)).c;
const room = `voice-${sfx}`;
r = await u1.req("/api/rooms", "POST", { number: room, password: "pw-" + sfx }); ok(r.status === 200, "创建文字房间");
for (const u of [u2, u3]) await u.req("/api/rooms/join", "POST", { number: room, password: "pw-" + sfx });
r = await u1.req("/api/ice"); ok(r.status === 200 && r.data.iceServers.length && r.data.turn === false, "chatroom /api/ice（仅 STUN）");
r = await anon.req("/api/ice"); ok(r.status === 401, "未登录不能取 ICE");
const w1 = u1.ws(room), w2 = u2.ws(room), w3 = u3.ws(room);
await Promise.all([w1.opened, w2.opened, w3.opened]);
const h3 = await waitFor(w3, (m) => m.type === "hello"); ok(h3 && Array.isArray(h3.voice) && h3.voiceMax === 8, "hello 带语音名单和上限 8");
// werift 客户端处理语音信令
function voiceRtc(ws) {
  const pcs = new Map();
  const mk = (sid) => { const pc = new RTCPeerConnection({ iceServers: [] }); pc.onicecandidate = ({ candidate }) => candidate && ws.j({ type: "voice-signal", to: sid, data: { candidate: candidate.toJSON() } }); pcs.set(sid, { pc, q: [] }); return pcs.get(sid); };
  ws.on("message", async (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "voice-welcome") for (const p of m.peers) {
      const { pc } = mk(p.sid); pc.addTransceiver("audio", { direction: "sendrecv" });
      await pc.setLocalDescription(await pc.createOffer());
      ws.j({ type: "voice-signal", to: p.sid, data: { sdp: { type: "offer", sdp: pc.localDescription.sdp } } });
    }
    if (m.type === "voice-signal") {
      const e = pcs.get(m.from) || mk(m.from), d = m.data;
      if (d.sdp) {
        await e.pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === "offer") { await e.pc.setLocalDescription(await e.pc.createAnswer()); ws.j({ type: "voice-signal", to: m.from, data: { sdp: { type: "answer", sdp: e.pc.localDescription.sdp } } }); }
        for (const c of e.q.splice(0)) await e.pc.addIceCandidate(c).catch(() => {});
      } else if (d.candidate) { if (e.pc.remoteDescription) await e.pc.addIceCandidate(d.candidate).catch(() => {}); else e.q.push(d.candidate); }
    }
  });
  return { pcs, states: () => [...pcs.values()].map((e) => e.pc.connectionState), close: () => [...pcs.values()].forEach((e) => e.pc.close().catch(() => {})) };
}
const rt1 = voiceRtc(w1), rt2 = voiceRtc(w2);
w1.j({ type: "voice-join" });
const wel1 = await waitFor(w1, (m) => m.type === "voice-welcome"); ok(wel1 && wel1.peers.length === 0, "用户1 加入语音");
ok(!!(await waitFor(w3, (m) => m.type === "voice-update" && m.voice.length === 1)), "非语音成员也能看到语音名单");
w2.j({ type: "voice-join" });
const wel2 = await waitFor(w2, (m) => m.type === "voice-welcome"); ok(wel2 && wel2.peers.length === 1 && wel2.peers[0].username === `vo1_${sfx}`, "用户2 加入语音，收到已有成员");
ok(!!(await waitFor(w1, (m) => m.type === "voice-peer-join")), "用户1 收到新成员通知");
let s1 = [], s2 = [];
for (let i = 0; i < 40; i++) { s1 = rt1.states(); s2 = rt2.states(); if (s1[0] === "connected" && s2[0] === "connected") break; await sleep(500); }
ok(s1[0] === "connected" && s2[0] === "connected", `语音信令经房间 DO 完成，两端 connected（${s1}/${s2}）`);
w3.msgs.length = 0;
w2.j({ type: "voice-mute", muted: true });
ok(!!(await waitFor(w3, (m) => m.type === "voice-update" && m.voice.some((v) => v.username === `vo2_${sfx}` && v.muted))), "静音状态同步给房间所有人");
// 上限：再开 6 个 u3 连接加入语音（共 8），第 9 个被拒
const extra = [];
for (let i = 0; i < 6; i++) { const s = u3.ws(room); await s.opened; s.j({ type: "voice-join" }); extra.push(s); }
for (const s of extra) await waitFor(s, (m) => m.type === "voice-welcome");
const full = await waitFor(w3, (m) => m.type === "voice-update" && m.voice.length === 8); ok(!!full, "语音频道达到 8 人");
w3.j({ type: "voice-join" }); const vf = await waitFor(w3, (m) => m.type === "voice-full"); ok(vf && vf.error.includes("8"), "第 9 人收到「语音频道已满」");
for (const s of extra) s.j({ type: "voice-leave" });
ok(!!(await waitFor(w1, (m) => m.type === "voice-update" && m.voice.length === 2, 8000)), "离开语音后名单更新");
extra.forEach((s) => s.close());
// 封禁踢出语音
r = await adm.req("/api/admin/rooms?q=" + room); ok(r.data.rows[0]?.voice?.length === 2, "后台房间列表显示语音中的成员");
r = await adm.req("/api/admin/users?q=vo2_" + sfx); const id2 = r.data.rows[0].id;
w1.msgs.length = 0;
r = await adm.req(`/api/admin/users/${id2}/ban`, "POST", { banned: true, reason: "测试" });
ok(r.status === 200 && !!(await waitFor(w2, (m) => m.type === "kicked")), "封禁用户被踢出房间");
ok(!!(await waitFor(w1, (m) => m.type === "voice-peer-leave")) && !!(await waitFor(w1, (m) => m.type === "voice-update" && m.voice.length === 1)), "封禁用户同时被移出语音频道");
await sleep(1500);
r = await adm.req(`/api/admin/logs?scope=voice&room=${room}&limit=100`);
const ve = r.data.rows;
ok(ve.some((e) => e.event === "voice_join" && e.ip) && ve.some((e) => e.event === "voice_leave" && (e.detail || "").includes("被管理员移出")), "语音加入/离开写入日志（带 IP，含踢出原因）");
rt1.close(); rt2.close();

console.log("界面（无头 Chrome，假麦克风）");
const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const ctx = await br.newContext({ bypassCSP: true, permissions: ["microphone"], viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await ctx.addCookies([{ name: "hzz_sid", value: u3.token, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto(C + "/#/room/" + room); await p.waitForSelector("#v-chat:not(.hidden)"); await sleep(1200);
ok((await p.textContent("#vc-count")).trim() === "1", "顶栏显示语音人数");
await p.click("#vc-toggle"); await p.click("#vc-join");
await p.waitForSelector("#vc-leave:not(.hidden)", { timeout: 8000 });
await sleep(800);
ok(await p.evaluate(() => document.querySelectorAll(".vc-chip").length === 2 && !!document.querySelector(".vc-chip.me")), "加入语音后显示两人（含自己）");
await p.click("#vc-mute"); await sleep(800);
ok(await p.evaluate(() => document.querySelector(".vc-chip.me").textContent.includes("🔇")), "静音按钮生效");
await p.click("#vc-mute"); await sleep(1500);
const speaking = await p.evaluate(() => document.querySelectorAll(".vc-chip.speaking").length);
console.log("    （说话指示：假麦克风下有 " + speaking + " 个高亮）");
await p.screenshot({ path: "/workspace/chatroom-shot-voice.png" });
await p.click("#vc-leave"); await sleep(800);
ok(await p.evaluate(() => !document.querySelector(".vc-chip.me")), "离开语音");
// 注册口令输入框随开关显示
const p2 = await (await br.newContext({ bypassCSP: true })).newPage();
await adm.req("/api/admin/reg-config", "POST", { code: CODE, enabled: true });
await p2.goto(C + "/"); await p2.click('[data-tab="register"]'); await sleep(800);
ok(await p2.isVisible("#a-code"), "开启时注册页显示口令输入框");
await adm.req("/api/admin/reg-config", "POST", { clearCode: true });
await p2.reload(); await p2.click('[data-tab="register"]'); await sleep(800);
ok(!(await p2.isVisible("#a-code")), "关闭时不显示口令输入框");
ok(errs.length === 0, "页面无 JS 报错" + (errs.length ? "：" + errs.join(";") : ""));
await br.close();
w1.close(); w3.close();

console.log("清理");
r = await adm.req(`/api/admin/rooms/text/${room}`, "DELETE"); ok(r.status === 200, "删除测试房间");
r = await adm.req("/api/admin/users?q=" + sfx);
for (const u of r.data.rows) await adm.req(`/api/admin/users/${u.id}`, "DELETE");
r = await adm.req("/api/admin/users?q=" + sfx); ok(r.data.rows.length === 0, "测试用户已删除");
r = await adm.req("/api/admin/reg-config"); ok(!r.data.enabled && !r.data.hasCode, "注册口令开关为关闭（测试口令已清除）");
await adm.req("/api/admin/users/seen", "POST", { at: before.seenAt || 0 }); // 恢复管理员原来的「已读」位置
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
