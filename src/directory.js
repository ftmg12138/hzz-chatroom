// Directory：账号、会话、房间登记、访问日志、限流。单实例（idFromName("main")）。
// 设计为可复用：将来 videochatroom Worker 绑定 { class_name="Directory", script_name="chatroom" }
// 后直接调用 RPC（getSession / checkRoomAccess / joinRoom 等）即可共用账号与房间。
import { DurableObject } from "cloudflare:workers";
import { hashPassword, verifyPassword, randomToken, sha256Hex, PBKDF2_ITER } from "./crypto.js";

export const ADMIN_USERNAME = "xyzhzzmaster";
const SESSION_TTL = 30 * 86400 * 1000;
const LOG_KEEP = 100000;
const USER_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{3,20}$/;

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new ApiError(status, msg); };

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => { this.migrate(); });
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_iter INTEGER NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0,
        banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT,
        created_at INTEGER NOT NULL, created_ip TEXT,
        last_login_at INTEGER, last_ip TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, ua TEXT);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS rooms (
        number TEXT PRIMARY KEY COLLATE NOCASE, kind TEXT NOT NULL DEFAULT 'text', name TEXT,
        pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_iter INTEGER NOT NULL,
        creator_id INTEGER, creator_name TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER);
      CREATE TABLE IF NOT EXISTS room_access (
        user_id INTEGER NOT NULL, room TEXT NOT NULL COLLATE NOCASE, granted_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, room));
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, event TEXT NOT NULL,
        user_id INTEGER, username TEXT, room TEXT, ip TEXT, country TEXT, ua TEXT, path TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
      CREATE TABLE IF NOT EXISTS ratelimit (k TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
    `);
  }

  // ---------- 工具 ----------
  one(q, ...a) { const r = this.sql.exec(q, ...a).toArray(); return r[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  meta(k) { return this.one("SELECT v FROM meta WHERE k=?", k)?.v ?? null; }
  setMeta(k, v) { this.sql.exec("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v)); }

  // 管理员初始化：首次或 ADMIN_SEED_VERSION 变化时，用 Worker secret ADMIN_INIT_PASSWORD 重置并强制改密
  async ensureAdmin() {
    const pw = this.env.ADMIN_INIT_PASSWORD;
    if (!pw) return;
    const ver = String(this.env.ADMIN_SEED_VERSION || "1");
    const admin = this.one("SELECT id FROM users WHERE username=?", ADMIN_USERNAME);
    if (admin && this.meta("admin_seed_version") === ver) return;
    const h = await hashPassword(pw);
    if (admin) {
      this.sql.exec("UPDATE users SET pw_hash=?, pw_salt=?, pw_iter=?, is_admin=1, must_change=1, banned=0 WHERE id=?", h.hash, h.salt, h.iter, admin.id);
      this.sql.exec("DELETE FROM sessions WHERE user_id=?", admin.id);
    } else {
      this.sql.exec("INSERT INTO users(username,pw_hash,pw_salt,pw_iter,is_admin,must_change,created_at) VALUES(?,?,?,?,1,1,?)",
        ADMIN_USERNAME, h.hash, h.salt, h.iter, Date.now());
    }
    this.setMeta("admin_seed_version", ver);
  }

  // 固定窗口限流；超过返回 false
  hit(key, limit, windowMs) {
    const now = Date.now();
    const r = this.one("SELECT window_start, count FROM ratelimit WHERE k=?", key);
    if (!r || now - r.window_start > windowMs) {
      this.sql.exec("INSERT INTO ratelimit(k,window_start,count) VALUES(?,?,1) ON CONFLICT(k) DO UPDATE SET window_start=excluded.window_start, count=1", key, now);
      return true;
    }
    if (r.count >= limit) return false;
    this.sql.exec("UPDATE ratelimit SET count=count+1 WHERE k=?", key);
    return true;
  }

  log(ev, c = {}) {
    this.sql.exec("INSERT INTO logs(ts,event,user_id,username,room,ip,country,ua,path,detail) VALUES(?,?,?,?,?,?,?,?,?,?)",
      Date.now(), ev, c.userId ?? null, c.username ?? null, c.room ?? null, c.ip ?? null, c.country ?? null,
      (c.ua || "").slice(0, 400) || null, c.path ?? null, c.detail ?? null);
    if (Math.random() < 0.01) {
      this.sql.exec("DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?", LOG_KEEP);
      this.sql.exec("DELETE FROM ratelimit WHERE window_start < ?", Date.now() - 86400000);
      this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    }
  }

  async wrap(fn) {
    try { return { ok: true, data: await fn() }; }
    catch (e) { if (e instanceof ApiError) return { ok: false, status: e.status, error: e.message }; throw e; }
  }

  publicUser(u) {
    return u && { id: u.id, username: u.username, isAdmin: !!u.is_admin, mustChange: !!u.must_change };
  }

  async newSession(u, c) {
    const token = randomToken(32);
    const now = Date.now();
    this.sql.exec("INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip,ua) VALUES(?,?,?,?,?,?)",
      await sha256Hex(token), u.id, now, now + SESSION_TTL, c.ip ?? null, (c.ua || "").slice(0, 300));
    this.sql.exec("UPDATE users SET last_login_at=?, last_ip=? WHERE id=?", now, c.ip ?? null, u.id);
    return token;
  }

  // ---------- 公共 RPC ----------
  async logVisit(c) { this.log("visit", c); return true; }

  async register(username, password, c) {
    return this.wrap(async () => {
      await this.ensureAdmin();
      username = String(username || "").trim(); password = String(password || "");
      if (!this.hit(`reg:${c.ip}`, 5, 3600e3)) { this.log("register_limited", { ...c, username }); fail(429, "注册过于频繁，请一小时后再试"); }
      if (!USER_RE.test(username)) fail(400, "用户名需 3–20 位，可用中文、字母、数字、下划线");
      if (username.toLowerCase() === ADMIN_USERNAME || /admin|管理员/i.test(username)) fail(400, "该用户名不可用");
      if (password.length < 8 || password.length > 128) fail(400, "密码长度需 8–128 位");
      if (this.one("SELECT id FROM users WHERE username=?", username)) fail(409, "用户名已被占用");
      const h = await hashPassword(password);
      this.sql.exec("INSERT INTO users(username,pw_hash,pw_salt,pw_iter,created_at,created_ip) VALUES(?,?,?,?,?,?)",
        username, h.hash, h.salt, h.iter, Date.now(), c.ip ?? null);
      const u = this.one("SELECT * FROM users WHERE username=?", username);
      this.log("register", { ...c, userId: u.id, username: u.username });
      return { token: await this.newSession(u, c), user: this.publicUser(u) };
    });
  }

  async login(username, password, c) {
    return this.wrap(async () => {
      await this.ensureAdmin();
      username = String(username || "").trim(); password = String(password || "");
      if (!this.hit(`login-ip:${c.ip}`, 20, 600e3) || !this.hit(`login-user:${username.toLowerCase()}`, 10, 600e3)) {
        this.log("login_limited", { ...c, username: username.slice(0, 40) });
        fail(429, "尝试次数过多，请 10 分钟后再试");
      }
      const u = this.one("SELECT * FROM users WHERE username=?", username);
      const ok = u ? await verifyPassword(password, u.pw_hash, u.pw_salt, u.pw_iter)
                   : (await hashPassword(password), false); // 不存在时也算一次，避免时间差枚举
      if (!ok) { this.log("login_fail", { ...c, userId: u?.id, username: username.slice(0, 40) }); fail(401, "用户名或密码错误"); }
      if (u.banned) { this.log("login_banned", { ...c, userId: u.id, username: u.username }); fail(403, "账号已被封禁" + (u.ban_reason ? `：${u.ban_reason}` : "")); }
      this.log(u.is_admin ? "admin_login" : "login", { ...c, userId: u.id, username: u.username });
      return { token: await this.newSession(u, c), user: this.publicUser(u) };
    });
  }

  async logout(token, c) {
    const s = await this.sessionUser(token);
    if (s) { this.sql.exec("DELETE FROM sessions WHERE token_hash=?", await sha256Hex(token)); this.log("logout", { ...c, userId: s.id, username: s.username }); }
    return true;
  }

  async sessionUser(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const u = this.one(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
      await sha256Hex(token), Date.now());
    if (!u || u.banned) return null;
    return u;
  }

  /** 校验会话，返回 { id, username, isAdmin, mustChange } 或 null（供其他 Worker 复用） */
  async getSession(token) { return this.publicUser(await this.sessionUser(token)); }

  async changePassword(token, oldPw, newPw, c) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (!this.hit(`chpw:${u.id}`, 10, 600e3)) fail(429, "操作过于频繁");
      if (!(await verifyPassword(String(oldPw || ""), u.pw_hash, u.pw_salt, u.pw_iter))) fail(400, "原密码错误");
      newPw = String(newPw || "");
      if (newPw.length < (u.is_admin ? 10 : 8) || newPw.length > 128) fail(400, u.is_admin ? "管理员密码至少 10 位" : "新密码至少 8 位");
      if (newPw === oldPw) fail(400, "新密码不能与原密码相同");
      const h = await hashPassword(newPw);
      this.sql.exec("UPDATE users SET pw_hash=?, pw_salt=?, pw_iter=?, must_change=0 WHERE id=?", h.hash, h.salt, h.iter, u.id);
      const th = await sha256Hex(token);
      this.sql.exec("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", u.id, th); // 其他设备下线
      this.log("password_change", { ...c, userId: u.id, username: u.username });
      return { user: this.publicUser({ ...u, must_change: 0 }) };
    });
  }

  // ---------- 房间 ----------
  async createRoom(token, number, password, name, kind, c) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (u.must_change) fail(403, "请先修改密码");
      number = String(number || "").trim(); password = String(password || ""); name = String(name || "").trim().slice(0, 30);
      kind = kind === "video" ? "video" : "text";
      if (!this.hit(`mkroom:${u.id}`, 10, 3600e3)) fail(429, "创建房间过于频繁");
      if (!ROOM_RE.test(number)) fail(400, "房间号需 3–20 位，可用字母、数字、- 和 _");
      if (password.length < 4 || password.length > 64) fail(400, "房间密码需 4–64 位");
      if (this.one("SELECT number FROM rooms WHERE number=?", number)) fail(409, "房间号已存在，请换一个，或直接加入");
      const h = await hashPassword(password);
      const now = Date.now();
      this.sql.exec("INSERT INTO rooms(number,kind,name,pw_hash,pw_salt,pw_iter,creator_id,creator_name,created_at,last_active_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        number, kind, name || null, h.hash, h.salt, h.iter, u.id, u.username, now, now);
      this.sql.exec("INSERT OR REPLACE INTO room_access(user_id,room,granted_at) VALUES(?,?,?)", u.id, number, now);
      this.log("room_create", { ...c, userId: u.id, username: u.username, room: number });
      return { room: { number, name, kind } };
    });
  }

  async joinRoom(token, number, password, c) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (u.must_change) fail(403, "请先修改密码");
      number = String(number || "").trim();
      if (!this.hit(`join-ip:${c.ip}`, 30, 600e3) || !this.hit(`join:${u.id}:${number.toLowerCase()}`, 8, 600e3)) {
        this.log("room_join_limited", { ...c, userId: u.id, username: u.username, room: number.slice(0, 20) });
        fail(429, "尝试次数过多，请 10 分钟后再试");
      }
      const r = this.one("SELECT * FROM rooms WHERE number=?", number);
      const ok = r ? await verifyPassword(String(password || ""), r.pw_hash, r.pw_salt, r.pw_iter) : false;
      if (!ok) { this.log("room_join_fail", { ...c, userId: u.id, username: u.username, room: number.slice(0, 20) }); fail(403, "房间号或房间密码错误"); }
      this.sql.exec("INSERT OR REPLACE INTO room_access(user_id,room,granted_at) VALUES(?,?,?)", u.id, r.number, Date.now());
      this.log("room_join", { ...c, userId: u.id, username: u.username, room: r.number });
      return { room: { number: r.number, name: r.name, kind: r.kind } };
    });
  }

  /** 已登录且已凭密码进入过该房间 → 返回 { user, room }，否则 null */
  async checkRoomAccess(token, number) {
    const u = await this.sessionUser(token);
    if (!u || u.must_change) return null;
    const r = this.one(`SELECT r.number, r.name, r.kind FROM rooms r JOIN room_access a ON a.room=r.number WHERE a.user_id=? AND r.number=?`, u.id, String(number));
    if (!r) return null;
    this.sql.exec("UPDATE rooms SET last_active_at=? WHERE number=?", Date.now(), r.number);
    return { user: this.publicUser(u), room: r };
  }

  async myRooms(token) {
    const u = await this.sessionUser(token);
    if (!u) return null;
    return this.all(`SELECT r.number, r.name, r.kind, r.creator_name, r.last_active_at FROM room_access a JOIN rooms r ON r.number=a.room
                     WHERE a.user_id=? ORDER BY r.last_active_at DESC LIMIT 50`, u.id);
  }

  async leaveRoom(token, number) {
    const u = await this.sessionUser(token);
    if (u) this.sql.exec("DELETE FROM room_access WHERE user_id=? AND room=?", u.id, String(number));
    return true;
  }

  async roomEvent(ev, c) { this.log(ev, c); return true; }

  // ---------- 管理 ----------
  async requireAdmin(token) {
    const u = await this.sessionUser(token);
    if (!u) fail(401, "请先登录");
    if (!u.is_admin) fail(403, "需要管理员权限");
    if (u.must_change) fail(403, "首次登录请先修改密码");
    return u;
  }

  async adminLogs(token, f = {}) {
    return this.wrap(async () => {
      await this.requireAdmin(token);
      const where = [], args = [];
      if (f.event) { where.push("event=?"); args.push(f.event); }
      if (f.username) { where.push("username LIKE ?"); args.push(`%${f.username}%`); }
      if (f.ip) { where.push("ip LIKE ?"); args.push(`%${f.ip}%`); }
      if (f.room) { where.push("room LIKE ?"); args.push(`%${f.room}%`); }
      if (f.q) { where.push("(username LIKE ? OR ip LIKE ? OR room LIKE ? OR ua LIKE ? OR path LIKE ? OR country LIKE ? OR event LIKE ?)"); for (let i = 0; i < 7; i++) args.push(`%${f.q}%`); }
      const baseW = where.length ? "WHERE " + where.join(" AND ") : "";
      const baseArgs = [...args];
      if (f.before) { where.push("id<?"); args.push(Number(f.before)); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
      const rows = this.all(`SELECT * FROM logs ${w} ORDER BY id DESC LIMIT ${limit}`, ...args);
      const total = this.one(`SELECT COUNT(*) AS n FROM logs ${baseW}`, ...baseArgs)?.n ?? 0;
      const events = this.all("SELECT event, COUNT(*) AS n FROM logs GROUP BY event ORDER BY n DESC");
      return { rows, total, events };
    });
  }

  async adminUsers(token, q) {
    return this.wrap(async () => {
      await this.requireAdmin(token);
      const rows = q
        ? this.all("SELECT id,username,is_admin,banned,ban_reason,created_at,created_ip,last_login_at,last_ip FROM users WHERE username LIKE ? OR last_ip LIKE ? OR created_ip LIKE ? ORDER BY id DESC LIMIT 500", `%${q}%`, `%${q}%`, `%${q}%`)
        : this.all("SELECT id,username,is_admin,banned,ban_reason,created_at,created_ip,last_login_at,last_ip FROM users ORDER BY id DESC LIMIT 500");
      return { rows };
    });
  }

  async adminSetBan(token, userId, banned, reason, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      const u = this.one("SELECT * FROM users WHERE id=?", Number(userId));
      if (!u) fail(404, "用户不存在");
      if (u.is_admin) fail(400, "不能封禁管理员");
      this.sql.exec("UPDATE users SET banned=?, ban_reason=? WHERE id=?", banned ? 1 : 0, banned ? String(reason || "").slice(0, 100) || null : null, u.id);
      if (banned) this.sql.exec("DELETE FROM sessions WHERE user_id=?", u.id);
      this.log(banned ? "admin_ban" : "admin_unban", { ...c, userId: a.id, username: a.username, detail: `目标：${u.username}` });
      const rooms = banned ? this.all("SELECT room FROM room_access WHERE user_id=?", u.id).map((r) => r.room) : [];
      return { userId: u.id, rooms };
    });
  }

  async adminDeleteUser(token, userId, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      const u = this.one("SELECT * FROM users WHERE id=?", Number(userId));
      if (!u) fail(404, "用户不存在");
      if (u.is_admin) fail(400, "不能删除管理员");
      const rooms = this.all("SELECT room FROM room_access WHERE user_id=?", u.id).map((r) => r.room);
      this.sql.exec("DELETE FROM sessions WHERE user_id=?", u.id);
      this.sql.exec("DELETE FROM room_access WHERE user_id=?", u.id);
      this.sql.exec("DELETE FROM users WHERE id=?", u.id);
      this.log("admin_delete_user", { ...c, userId: a.id, username: a.username, detail: `目标：${u.username}` });
      return { userId: u.id, rooms };
    });
  }

  async adminRooms(token, q) {
    return this.wrap(async () => {
      await this.requireAdmin(token);
      const base = `SELECT r.number, r.name, r.kind, r.creator_name, r.created_at, r.last_active_at,
                    (SELECT COUNT(*) FROM room_access a WHERE a.room=r.number) AS members FROM rooms r`;
      const rows = q ? this.all(`${base} WHERE r.number LIKE ? OR r.creator_name LIKE ? ORDER BY r.last_active_at DESC LIMIT 500`, `%${q}%`, `%${q}%`)
                     : this.all(`${base} ORDER BY r.last_active_at DESC LIMIT 500`);
      return { rows };
    });
  }

  async adminDeleteRoom(token, number, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      const r = this.one("SELECT number FROM rooms WHERE number=?", String(number));
      if (!r) fail(404, "房间不存在");
      this.sql.exec("DELETE FROM room_access WHERE room=?", r.number);
      this.sql.exec("DELETE FROM rooms WHERE number=?", r.number);
      this.log("admin_delete_room", { ...c, userId: a.id, username: a.username, room: r.number });
      return { number: r.number };
    });
  }

  async adminCheck(token) { return this.wrap(async () => this.publicUser(await this.requireAdmin(token))); }
  async adminAudit(token, ev, c) {
    return this.wrap(async () => { const a = await this.requireAdmin(token); this.log(ev, { ...c, userId: a.id, username: a.username }); return true; });
  }
}
