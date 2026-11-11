// ChatRoom：每个房间一个 Durable Object（WebSocket Hibernation + SQLite 消息历史）
import { DurableObject } from "cloudflare:workers";

const HISTORY = 100;
const MAX_LEN = 2000;
const KEEP = 5000;

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
    const username = request.headers.get("X-Username");
    const room = request.headers.get("X-Room");
    const ip = request.headers.get("X-Ip") || "";
    this.sql.exec("INSERT OR REPLACE INTO kv(k,v) VALUES('room', ?)", room);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const firstConn = !this.online().includes(username);
    this.ctx.acceptWebSocket(server, [`u:${uid}`]);
    server.serializeAttachment({ uid, username, ip, room });
    server.send(JSON.stringify({ type: "hello", room, me: username, history: this.history(), online: this.online() }));
    if (firstConn) this.broadcast({ type: "presence", online: this.online(), joined: username });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment() || {};
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
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

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {}
    this.afterLeave(ws);
  }
  async webSocketError(ws) { this.afterLeave(ws); }
  afterLeave(ws) {
    const a = ws.deserializeAttachment() || {};
    const online = this.online();
    if (a.username && !online.includes(a.username)) this.broadcast({ type: "presence", online, left: a.username });
  }

  // ---------- 管理 RPC ----------
  async adminMessages(limit = 300) {
    return this.sql.exec("SELECT id, ts, username, text, ip, kind FROM messages ORDER BY id DESC LIMIT ?", Math.min(limit, 1000)).toArray();
  }
  async stats() {
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n;
    return { messages: n, online: this.online() };
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
      try { ws.send(JSON.stringify({ type: "kicked", reason })); ws.close(4003, "kicked"); } catch {}
    }
    this.broadcast({ type: "presence", online: this.online() });
    return true;
  }
  async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "kicked", reason: "房间已被管理员删除" })); ws.close(4004, "room deleted"); } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.init();
    return true;
  }
}
