// ChatRoom：每个房间一个 Durable Object（WebSocket Hibernation + SQLite 消息历史）
import { DurableObject } from "cloudflare:workers";

const HISTORY = 100;
const MAX_LEN = 2000;
const KEEP = 5000;
export const VOICE_MAX = 8; // 语音频道人数上限（音频 mesh：每人需与其余每人各建一条连接）

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
    this.rate = new Map();
  }
  init() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER, username TEXT,
      text TEXT NOT NULL, ip TEXT, kind TEXT NOT NULL DEFAULT 'msg');
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`);
  }

  sessions() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).map((ws) => ({ ws, a: ws.deserializeAttachment() || {} }));
  }
  online() {
    const seen = new Map();
    for (const { a } of this.sessions()) if (a.uid) seen.set(a.uid, a.username);
    return [...seen.values()].sort();
  }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const { ws } of this.sessions()) { try { ws.send(s); } catch {} }
  }
  history(limit = HISTORY) {
    return this.sql.exec("SELECT id, ts, username, text, kind FROM messages ORDER BY id DESC LIMIT ?", limit).toArray().reverse();
  }
  addSystem(text) {
    const ts = Date.now();
    this.sql.exec("INSERT INTO messages(ts, text, kind) VALUES(?,?, 'system')", ts, text);
    const id = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
    return { id, ts, text, kind: "system" };
  }

  async fetch(request) {
    // 由 Worker 在校验会话和房间权限后转发，带上可信头
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const uid = Number(request.headers.get("X-Uid"));
    const username = decodeURIComponent(request.headers.get("X-Username") || "");
    const room = request.headers.get("X-Room");
    const ip = request.headers.get("X-Ip") || "";
    const country = request.headers.get("X-Country") || "";
    const ua = decodeURIComponent(request.headers.get("X-UA") || "");
    this.sql.exec("INSERT OR REPLACE INTO kv(k,v) VALUES('room', ?)", room);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const firstConn = !this.online().includes(username);
    this.ctx.acceptWebSocket(server, [`u:${uid}`]);
    const sid = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ uid, username, ip, country, ua, room, sid, voice: false, muted: false });
    const ownerId = Number(request.headers.get("X-Owner")) || null;
    const roomInfo = { owner: decodeURIComponent(request.headers.get("X-Owner-Name") || ""), isOwner: ownerId === uid, visibility: request.headers.get("X-Visibility") || "private",
      name: decodeURIComponent(request.headers.get("X-Room-Name") || "") };
    server.send(JSON.stringify({ type: "hello", room, me: username, history: this.history(), online: this.online(), voice: this.voiceList(), voiceMax: VOICE_MAX, ...roomInfo }));
    if (firstConn) this.broadcast({ type: "presence", online: this.online(), joined: username });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment() || {};
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (typeof m.type === "string" && m.type.startsWith("voice-")) return this.voiceMessage(ws, a, m);
    if (m.type !== "msg") return;
    const text = String(m.text || "").replace(/\r\n/g, "\n").trim();
    if (!text) return;
    if (text.length > MAX_LEN) { ws.send(JSON.stringify({ type: "error", error: `消息过长（最多 ${MAX_LEN} 字）` })); return; }
    // 简单限流：每用户 10 秒内最多 15 条
    const now = Date.now();
    const arr = (this.rate.get(a.uid) || []).filter((t) => now - t < 10000);
    if (arr.length >= 15) { ws.send(JSON.stringify({ type: "error", error: "发送太快了，稍等一下" })); return; }
    arr.push(now); this.rate.set(a.uid, arr);
    this.sql.exec("INSERT INTO messages(ts,user_id,username,text,ip) VALUES(?,?,?,?,?)", now, a.uid, a.username, text, a.ip);
    const id = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
    if (id % 200 === 0) this.sql.exec("DELETE FROM messages WHERE id <= ?", id - KEEP);
    this.broadcast({ type: "msg", msg: { id, ts: now, username: a.username, text, kind: "msg" }, cid: m.cid });
  }

  // ---------- 语音频道（音频 mesh；本 DO 只转发信令） ----------
  voiceMembers() { return this.sessions().filter((s) => s.a.voice); }
  voiceList() { return this.voiceMembers().map((s) => ({ sid: s.a.sid, username: s.a.username, muted: !!s.a.muted })); }
  sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  voiceMessage(ws, a, m) {
    if (m.type === "voice-join") {
      if (a.voice) return;
      const members = this.voiceMembers();
      if (members.length >= VOICE_MAX) return this.sendTo(ws, { type: "voice-full", error: `语音频道已满（最多 ${VOICE_MAX} 人）` });
      a.voice = true; a.muted = !!m.muted; a.voiceAt = Date.now();
      ws.serializeAttachment(a);
      this.sendTo(ws, { type: "voice-welcome", you: a.sid, peers: members.map((s) => ({ sid: s.a.sid, username: s.a.username, muted: !!s.a.muted })) });
      for (const s of members) this.sendTo(s.ws, { type: "voice-peer-join", sid: a.sid, username: a.username });
      this.broadcast({ type: "voice-update", voice: this.voiceList() });
      this.voiceLog("voice_join", a);
      return;
    }
    if (!a.voice) return;
    if (m.type === "voice-leave") return this.voiceLeave(ws, a);
    if (m.type === "voice-mute") {
      a.muted = !!m.muted; ws.serializeAttachment(a);
      this.broadcast({ type: "voice-update", voice: this.voiceList() });
      return;
    }
    if (m.type === "voice-signal") {
      if (typeof m.data !== "object" || JSON.stringify(m.data).length > 32 * 1024) return;
      const t = this.voiceMembers().find((s) => s.a.sid === m.to);
      if (t) this.sendTo(t.ws, { type: "voice-signal", from: a.sid, username: a.username, data: m.data });
    }
  }
  voiceLeave(ws, a, why) {
    if (!a.voice) return;
    a.voice = false;
    try { ws.serializeAttachment(a); } catch {}
    for (const s of this.voiceMembers()) if (s.ws !== ws) this.sendTo(s.ws, { type: "voice-peer-leave", sid: a.sid, username: a.username });
    this.broadcast({ type: "voice-update", voice: this.voiceList().filter((v) => v.sid !== a.sid) });
    const secs = a.voiceAt ? Math.round((Date.now() - a.voiceAt) / 1000) : null;
    this.voiceLog("voice_leave", a, [why, secs != null ? `语音 ${secs} 秒` : null].filter(Boolean).join(" · "));
  }
  voiceLog(ev, a, detail) {
    const D = this.env.DIRECTORY; if (!D) return;
    this.ctx.waitUntil(D.get(D.idFromName("main")).roomEvent(ev, {
      userId: a.uid, username: a.username, room: a.room, ip: a.ip, country: a.country, ua: a.ua, path: "voice", detail: detail || null,
    }).catch(() => {}));
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
    this.afterLeave(ws);
  }
  async webSocketError(ws) { this.afterLeave(ws); }
  afterLeave(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.voice) this.voiceLeave(ws, a, "断开");
    const online = this.online();
    if (a.username && !online.includes(a.username)) this.broadcast({ type: "presence", online, left: a.username });
  }

  // ---------- 管理 RPC ----------
  async adminMessages(limit = 300, afterId = 0) {
    return this.sql.exec("SELECT id, ts, username, text, ip, kind FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?", Number(afterId) || 0, Math.min(limit, 1000)).toArray();
  }
  async stats() {
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n;
    const lastMsgAt = this.sql.exec("SELECT MAX(ts) AS t FROM messages").one().t || null;
    const members = this.sessions().filter((x) => x.a.uid).map((x) => ({ uid: x.a.uid, username: x.a.username, ip: x.a.ip, country: x.a.country, voice: !!x.a.voice, muted: !!x.a.muted }));
    return { messages: n, lastMsgAt, online: this.online(), voice: this.voiceList().map((v) => v.username), members };
  }
  /** 给房间里某个用户的所有连接推送消息（如：有人申请加入，通知房主） */
  async notifyUser(uid, obj) {
    for (const ws of this.ctx.getWebSockets(`u:${uid}`)) this.sendTo(ws, obj);
    return true;
  }
  async deleteMessage(id) {
    this.sql.exec("DELETE FROM messages WHERE id=?", Number(id));
    this.broadcast({ type: "deleted", id: Number(id) });
    return true;
  }
  async clearMessages() {
    this.sql.exec("DELETE FROM messages");
    const sys = this.addSystem("管理员清空了聊天记录");
    this.broadcast({ type: "cleared", msg: sys });
    return true;
  }
  async kickUser(uid, reason = "你已被移出房间") {
    for (const ws of this.ctx.getWebSockets(`u:${uid}`)) {
      const a = ws.deserializeAttachment() || {};
      if (a.voice) this.voiceLeave(ws, a, "被管理员移出");
      try { ws.send(JSON.stringify({ type: "kicked", reason })); ws.close(4003, "kicked"); } catch {}
    }
    this.broadcast({ type: "presence", online: this.online() });
    return true;
  }
  async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.voice) this.voiceLeave(ws, a, "房间被删除");
      try { ws.send(JSON.stringify({ type: "kicked", reason: "房间已被管理员删除" })); ws.close(4004, "room deleted"); } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.init();
    return true;
  }
}
