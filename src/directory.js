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
    // v2：文字 / 视频房间号各自独立（主键改为 kind + number），老数据原样迁移
    if (Number(this.meta("schema_version") || 1) < 2) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`
          CREATE TABLE rooms_v2 (
            number TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL DEFAULT 'text', name TEXT,
            pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_iter INTEGER NOT NULL,
            creator_id INTEGER, creator_name TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER,
            PRIMARY KEY (kind, number));
          INSERT INTO rooms_v2 SELECT number, kind, name, pw_hash, pw_salt, pw_iter, creator_id, creator_name, created_at, last_active_at FROM rooms;
          CREATE TABLE room_access_v2 (
            user_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'text', room TEXT NOT NULL COLLATE NOCASE, granted_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, kind, room));
          INSERT OR IGNORE INTO room_access_v2 SELECT a.user_id, COALESCE(r.kind, 'text'), a.room, a.granted_at FROM room_access a LEFT JOIN rooms r ON r.number = a.room;
          DROP TABLE room_access; DROP TABLE rooms;
          ALTER TABLE rooms_v2 RENAME TO rooms;
          ALTER TABLE room_access_v2 RENAME TO room_access;
          CREATE INDEX IF NOT EXISTS room_access_room ON room_access(kind, room);
        `);
        this.setMeta("schema_version", 2);
      });
    }
    // v3：公开 / 私密房间 + 加入申请
    if (Number(this.meta("schema_version")) < 3) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`
          ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
          ALTER TABLE rooms ADD COLUMN has_pw INTEGER NOT NULL DEFAULT 1;
          CREATE TABLE IF NOT EXISTS join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, room TEXT NOT NULL COLLATE NOCASE,
            user_id INTEGER NOT NULL, username TEXT, status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, ip TEXT);
          CREATE INDEX IF NOT EXISTS jr_room ON join_requests(kind, room, status);
        `);
        this.setMeta("schema_version", 3);
      });
    }
    if (Number(this.meta("schema_version")) < 4) {
      // v4：头像（"p:av01" 预设形象 / "c:#rrggbb" 字母头像背景色）
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
        this.setMeta("schema_version", 4);
      });
    }
    if (Number(this.meta("schema_version")) < 5) {
      // v5：界面主题（forest / night / cream / tavern）
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("ALTER TABLE users ADD COLUMN theme TEXT");
        this.setMeta("schema_version", 5);
      });
    }
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
    return u && { id: u.id, username: u.username, isAdmin: !!u.is_admin, mustChange: !!u.must_change, avatar: u.avatar || null, theme: u.theme || null };
  }

  // ---------- 头像 ----------
  async setAvatar(token, avatar) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      avatar = avatar == null || avatar === "" ? null : String(avatar).toLowerCase();
      if (avatar !== null && !/^(p:av\d{2}|c:#[0-9a-f]{6})$/.test(avatar)) fail(400, "头像格式不正确");
      this.sql.exec("UPDATE users SET avatar=? WHERE id=?", avatar, u.id);
      return { user: this.publicUser({ ...u, avatar }) };
    });
  }
  async setTheme(token, theme) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (!["forest", "night", "cream", "tavern"].includes(theme)) fail(400, "未知主题");
      this.sql.exec("UPDATE users SET theme=? WHERE id=?", theme, u.id);
      return { user: this.publicUser({ ...u, theme }) };
    });
  }
  /** 批量查询用户名对应的头像（需登录），用于消息、成员列表等处显示 */
  async avatarsFor(token, names) {
    const u = await this.sessionUser(token);
    if (!u) return null;
    const list = [...new Set((names || []).map((n) => String(n).slice(0, 20)).filter(Boolean))].slice(0, 100);
    const map = {};
    for (const n of list) map[n] = null;
    if (list.length) for (const r of this.all(`SELECT username, avatar FROM users WHERE username IN (${list.map(() => "?").join(",")})`, ...list)) map[r.username] = r.avatar || null;
    return map;
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
  async logVisit(c, ev = "visit") { this.log(ev === "video_visit" ? "video_visit" : "visit", c); return true; }

  // ---------- 注册口令开关 ----------
  regEnabled() { return this.meta("reg_code_enabled") === "1" && !!this.meta("reg_code_hash"); }
  /** 公开：只返回是否需要注册口令 */
  async regConfig() { return { codeRequired: this.regEnabled() }; }

  // 只查看不计数
  peek(key, limit, windowMs) {
    const r = this.one("SELECT window_start, count FROM ratelimit WHERE k=?", key);
    return !(r && Date.now() - r.window_start <= windowMs && r.count >= limit);
  }

  async register(username, password, c, code) {
    return this.wrap(async () => {
      await this.ensureAdmin();
      username = String(username || "").trim(); password = String(password || "");
      if (this.regEnabled()) {
        const key = `regcode-fail:${c.ip}`;
        if (!this.peek(key, 10, 3600e3)) { this.log("register_code_limited", { ...c, username: username.slice(0, 40) }); fail(429, "注册口令错误次数过多，请一小时后再试"); }
        const ok = await verifyPassword(String(code || ""), this.meta("reg_code_hash"), this.meta("reg_code_salt"), Number(this.meta("reg_code_iter")));
        if (!ok) { this.hit(key, 10, 3600e3); this.log("register_code_fail", { ...c, username: username.slice(0, 40) }); fail(403, "注册口令错误"); }
      }
      if (!this.hit(`reg:${c.ip}`, 5, 3600e3)) { this.log("register_limited", { ...c, username }); fail(429, "注册过于频繁，请一小时后再试"); }
      if (!USER_RE.test(username)) fail(400, "用户名需 3–20 位，可用中文、字母、数字、下划线");
      if (username.toLowerCase() === ADMIN_USERNAME || /admin|管理员/i.test(username)) fail(400, "该用户名不可用");
      if (password.length < 8 || password.length > 128) fail(400, "密码长度需 8–128 位");
      if (this.one("SELECT id FROM users WHERE username=?", username)) fail(409, "用户名已被占用");
      const h = await hashPassword(password);
      this.sql.exec("INSERT INTO users(username,pw_hash,pw_salt,pw_iter,created_at,created_ip) VALUES(?,?,?,?,?,?)",
        username, h.hash, h.salt, h.iter, Date.now(), c.ip ?? null);
      const u = this.one("SELECT * FROM users WHERE username=?", username);
      this.log("register", { ...c, userId: u.id, username: u.username, detail: this.regEnabled() ? "口令注册" : null });
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
  async createRoom(token, number, password, name, kind, c, visibility = "private") {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (u.must_change) fail(403, "请先修改密码");
      number = String(number || "").trim(); password = String(password || ""); name = String(name || "").trim().slice(0, 30);
      kind = kind === "video" ? "video" : "text";
      if (!this.hit(`mkroom:${u.id}`, 10, 3600e3)) fail(429, "创建房间过于频繁");
      if (!ROOM_RE.test(number)) fail(400, "房间号需 3–20 位，可用字母、数字、- 和 _");
      visibility = visibility === "public" ? "public" : "private";
      const hasPw = password.length > 0;
      if (visibility === "private" || hasPw) { if (password.length < 4 || password.length > 64) fail(400, visibility === "public" ? "房间密码需 4–64 位（公开房间也可以不设密码）" : "房间密码需 4–64 位"); }
      if (this.one("SELECT number FROM rooms WHERE kind=? AND number=?", kind, number)) fail(409, "房间号已存在，请换一个，或直接加入");
      const h = hasPw ? await hashPassword(password) : { hash: "", salt: "", iter: 0 };
      const now = Date.now();
      this.sql.exec("INSERT INTO rooms(number,kind,name,pw_hash,pw_salt,pw_iter,creator_id,creator_name,created_at,last_active_at,visibility,has_pw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        number, kind, name || null, h.hash, h.salt, h.iter, u.id, u.username, now, now, visibility, hasPw ? 1 : 0);
      this.sql.exec("INSERT OR REPLACE INTO room_access(user_id,kind,room,granted_at) VALUES(?,?,?,?)", u.id, kind, number, now);
      this.log(kind === "video" ? "video_room_create" : "room_create", { ...c, userId: u.id, username: u.username, room: number, detail: visibility === "public" ? "公开房间" : "私密房间" });
      return { room: { number, name, kind, visibility } };
    });
  }

  async joinRoom(token, number, password, c, kind = "text") {
    kind = kind === "video" ? "video" : "text";
    const ev = kind === "video" ? "video_join" : "room_join";
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (u.must_change) fail(403, "请先修改密码");
      number = String(number || "").trim();
      if (!this.hit(`join-ip:${c.ip}`, 30, 600e3) || !this.hit(`join:${u.id}:${number.toLowerCase()}`, 8, 600e3)) {
        this.log(ev + "_limited", { ...c, userId: u.id, username: u.username, room: number.slice(0, 20) });
        fail(429, "尝试次数过多，请 10 分钟后再试");
      }
      const r = this.one("SELECT * FROM rooms WHERE kind=? AND number=?", kind, number);
      if (r && !r.has_pw) fail(400, "该公开房间没有设置密码，请在大厅点「申请加入」");
      const ok = r ? await verifyPassword(String(password || ""), r.pw_hash, r.pw_salt, r.pw_iter) : false;
      if (!ok) {
        this.log(ev + "_fail", { ...c, userId: u.id, username: u.username, room: number.slice(0, 20) }); fail(403, "房间号或房间密码错误"); }
      this.sql.exec("INSERT OR REPLACE INTO room_access(user_id,kind,room,granted_at) VALUES(?,?,?,?)", u.id, kind, r.number, Date.now());
      this.log(ev, { ...c, userId: u.id, username: u.username, room: r.number });
      return { room: { number: r.number, name: r.name, kind: r.kind } };
    });
  }

  /** 已登录且已凭密码进入过该房间 → 返回 { user, room }，否则 null */
  async checkRoomAccess(token, number, kind = "text") {
    const u = await this.sessionUser(token);
    if (!u || u.must_change) return null;
    kind = kind === "video" ? "video" : "text";
    const r = this.one(`SELECT r.number, r.name, r.kind, r.visibility, r.creator_id, r.creator_name FROM rooms r JOIN room_access a ON a.room=r.number AND a.kind=r.kind WHERE a.user_id=? AND r.number=? AND r.kind=?`, u.id, String(number), kind);
    if (!r) return null;
    this.sql.exec("UPDATE rooms SET last_active_at=? WHERE kind=? AND number=?", Date.now(), kind, r.number);
    return { user: this.publicUser(u), room: r };
  }

  async myRooms(token, kind = "text") {
    const u = await this.sessionUser(token);
    if (!u) return null;
    return this.all(`SELECT r.number, r.name, r.kind, r.creator_name, r.last_active_at, r.visibility FROM room_access a JOIN rooms r ON r.number=a.room AND r.kind=a.kind
                     WHERE a.user_id=? AND r.kind=? ORDER BY r.last_active_at DESC LIMIT 50`, u.id, kind === "video" ? "video" : "text");
  }

  async leaveRoom(token, number, kind = "text") {
    const u = await this.sessionUser(token);
    if (u) this.sql.exec("DELETE FROM room_access WHERE user_id=? AND kind=? AND room=?", u.id, kind === "video" ? "video" : "text", String(number));
    return true;
  }

  // ---------- 公开房间 / 加入申请 ----------
  /** 大厅公开房间列表（带我是否已是成员、是否有待处理申请） */
  async publicRooms(token, kind = "text") {
    const u = await this.sessionUser(token);
    if (!u) return null;
    kind = kind === "video" ? "video" : "text";
    return this.all(`SELECT r.number, r.name, r.kind, r.creator_name, r.created_at, r.last_active_at, r.has_pw,
        EXISTS(SELECT 1 FROM room_access a WHERE a.user_id=? AND a.kind=r.kind AND a.room=r.number) AS member,
        EXISTS(SELECT 1 FROM join_requests j WHERE j.user_id=? AND j.kind=r.kind AND j.room=r.number AND j.status='pending') AS pending,
        (SELECT COUNT(*) FROM room_access a WHERE a.kind=r.kind AND a.room=r.number) AS members
      FROM rooms r WHERE r.kind=? AND r.visibility='public' ORDER BY r.last_active_at DESC LIMIT 100`, u.id, u.id, kind);
  }

  async requestJoin(token, number, kind, c) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      if (u.must_change) fail(403, "请先修改密码");
      kind = kind === "video" ? "video" : "text";
      const ev = kind === "video" ? "video_request" : "room_request";
      const r = this.one("SELECT number, creator_id, creator_name, visibility FROM rooms WHERE kind=? AND number=?", kind, String(number));
      if (!r || r.visibility !== "public") fail(404, "房间不存在或不是公开房间");
      if (this.one("SELECT 1 AS x FROM room_access WHERE user_id=? AND kind=? AND room=?", u.id, kind, r.number)) return { member: true, room: r.number };
      if (r.creator_id === u.id) { this.sql.exec("INSERT OR REPLACE INTO room_access(user_id,kind,room,granted_at) VALUES(?,?,?,?)", u.id, kind, r.number, Date.now()); return { member: true, room: r.number }; }
      if (!this.hit(`req:${u.id}`, 20, 3600e3)) fail(429, "申请过于频繁，请稍后再试");
      const ex = this.one("SELECT id FROM join_requests WHERE user_id=? AND kind=? AND room=? AND status='pending'", u.id, kind, r.number);
      if (ex) return { pending: true, id: ex.id, room: r.number, ownerId: r.creator_id };
      this.sql.exec("INSERT INTO join_requests(kind,room,user_id,username,created_at,ip) VALUES(?,?,?,?,?,?)", kind, r.number, u.id, u.username, Date.now(), c.ip ?? null);
      const id = this.sql.exec("SELECT last_insert_rowid() AS id").one().id;
      this.log(ev, { ...c, userId: u.id, username: u.username, room: r.number, detail: `申请加入（房主 ${r.creator_name}）` });
      return { pending: true, id, room: r.number, ownerId: r.creator_id, username: u.username, created: true };
    });
  }

  roomOwnerOrAdmin(u, kind, number) {
    const r = this.one("SELECT number, creator_id FROM rooms WHERE kind=? AND number=?", kind, String(number));
    if (!r) fail(404, "房间不存在");
    if (!u.is_admin && r.creator_id !== u.id) fail(403, "只有房主可以处理申请");
    return r;
  }

  async listRequests(token, number, kind) {
    return this.wrap(async () => {
      const u = this.maintUser(token) || await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      kind = kind === "video" ? "video" : "text";
      const r = this.roomOwnerOrAdmin(u, kind, number);
      return { rows: this.all("SELECT id, user_id, username, created_at, ip FROM join_requests WHERE kind=? AND room=? AND status='pending' ORDER BY id", kind, r.number)
        .map((x) => (u.is_admin ? x : { ...x, ip: undefined })) };
    });
  }

  async decideRequest(token, id, approve, c) {
    return this.wrap(async () => {
      const u = this.maintUser(token) || await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      const q = this.one("SELECT * FROM join_requests WHERE id=?", Number(id));
      if (!q) fail(404, "申请不存在");
      this.roomOwnerOrAdmin(u, q.kind, q.room);
      if (q.status !== "pending") return { id: q.id, status: q.status, userId: q.user_id, room: q.room, kind: q.kind };
      const status = approve ? "approved" : "rejected";
      this.sql.exec("UPDATE join_requests SET status=?, decided_at=?, decided_by=? WHERE id=?", status, Date.now(), u.username, q.id);
      if (approve) this.sql.exec("INSERT OR REPLACE INTO room_access(user_id,kind,room,granted_at) VALUES(?,?,?,?)", q.user_id, q.kind, q.room, Date.now());
      this.log((q.kind === "video" ? "video_" : "room_") + (approve ? "request_approve" : "request_reject"),
        { ...c, userId: u.id, username: u.username, room: q.room, detail: `${approve ? "同意" : "拒绝"} ${q.username} 的申请` });
      return { id: q.id, status, userId: q.user_id, username: q.username, room: q.room, kind: q.kind };
    });
  }

  async adminRequests(token) {
    return this.wrap(async () => {
      await this.requireAdmin(token);
      return { rows: this.all(`SELECT j.id, j.kind, j.room, j.user_id, j.username, j.created_at, j.ip, r.creator_name FROM join_requests j
        LEFT JOIN rooms r ON r.kind=j.kind AND r.number=j.room WHERE j.status='pending' ORDER BY j.id DESC LIMIT 200`) };
    });
  }

  async adminSetVisibility(token, number, kind, visibility, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      kind = kind === "video" ? "video" : "text";
      visibility = visibility === "public" ? "public" : "private";
      const r = this.one("SELECT number, has_pw FROM rooms WHERE kind=? AND number=?", kind, String(number));
      if (!r) fail(404, "房间不存在");
      if (visibility === "private" && !r.has_pw) fail(400, "该房间没有密码，不能改为私密（否则没人能进入）");
      this.sql.exec("UPDATE rooms SET visibility=? WHERE kind=? AND number=?", visibility, kind, r.number);
      this.log("admin_room_visibility", { ...c, userId: a.id, username: a.username, room: r.number, detail: `${kind === "video" ? "视频" : "文字"}房间改为${visibility === "public" ? "公开" : "私密"}` });
      return { visibility };
    });
  }

  async roomEvent(ev, c) { if (/^(video|room|voice)_[a-z_]+$/.test(ev)) this.log(ev, c); return true; }

  // ---------- 管理 ----------
  // 维护令牌：仅当 Worker secret MAINT_TOKEN 存在（≥32 位）时可用，用于自动化测试；测试完删除该 secret 即失效
  maintUser(token) {
    const want = this.env.MAINT_TOKEN;
    if (!want || want.length < 32 || typeof token !== "string" || !token.startsWith("maint:")) return null;
    const got = token.slice(6);
    if (got.length !== want.length) return null;
    let d = 0; for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ want.charCodeAt(i);
    return d === 0 ? { id: 0, username: "维护测试", is_admin: 1, must_change: 0 } : null;
  }

  async requireAdmin(token) {
    const m = this.maintUser(token);
    if (m) return m;
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
      if (f.scope === "video") where.push("event LIKE 'video\\_%' ESCAPE '\\'");
      else if (f.scope === "voice") where.push("event LIKE 'voice\\_%' ESCAPE '\\'");
      else if (f.scope === "register") where.push("event LIKE 'register%'");
      else if (f.scope === "text") where.push("event NOT LIKE 'video\\_%' ESCAPE '\\'");
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

  async adminRegConfig(token) {
    return this.wrap(async () => {
      await this.requireAdmin(token);
      const seen = Number(this.meta("admin_seen_users_at") || 0);
      const newCount = this.one("SELECT COUNT(*) AS n FROM users WHERE is_admin=0 AND created_at>?", seen).n;
      const recent = this.all("SELECT id, username, created_at, created_ip, banned FROM users WHERE is_admin=0 ORDER BY id DESC LIMIT 30");
      const fails = this.one("SELECT COUNT(*) AS n FROM logs WHERE event='register_code_fail' AND ts>?", Date.now() - 86400000).n;
      return { enabled: this.regEnabled(), hasCode: !!this.meta("reg_code_hash"), updatedAt: Number(this.meta("reg_code_updated_at") || 0) || null,
               seenAt: seen || null, newCount, recent, codeFails24h: fails };
    });
  }

  async adminSetRegConfig(token, enabled, code, c, clearCode = false) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      const changes = [];
      if (clearCode) {
        for (const k of ["reg_code_hash", "reg_code_salt", "reg_code_iter", "reg_code_updated_at"]) this.sql.exec("DELETE FROM meta WHERE k=?", k);
        this.setMeta("reg_code_enabled", "0");
        this.log("admin_reg_config", { ...c, userId: a.id, username: a.username, detail: "清除注册口令并关闭" });
        return { enabled: false, hasCode: false };
      }
      if (code !== undefined && code !== null && code !== "") {
        code = String(code);
        if (code.length < 4 || code.length > 64) fail(400, "注册口令需 4–64 位");
        const h = await hashPassword(code);
        this.setMeta("reg_code_hash", h.hash); this.setMeta("reg_code_salt", h.salt); this.setMeta("reg_code_iter", h.iter);
        this.setMeta("reg_code_updated_at", Date.now());
        changes.push("更换注册口令");
      }
      if (enabled !== undefined && enabled !== null) {
        if (enabled && !this.meta("reg_code_hash")) fail(400, "请先设置注册口令");
        if (!!enabled !== (this.meta("reg_code_enabled") === "1")) changes.push(enabled ? "开启注册口令" : "关闭注册口令");
        this.setMeta("reg_code_enabled", enabled ? "1" : "0");
      }
      if (changes.length) this.log("admin_reg_config", { ...c, userId: a.id, username: a.username, detail: changes.join("、") });
      return { enabled: this.regEnabled(), hasCode: !!this.meta("reg_code_hash") };
    });
  }

  async adminMarkUsersSeen(token, at) {
    return this.wrap(async () => { await this.requireAdmin(token); this.setMeta("admin_seen_users_at", Number.isFinite(at) && at >= 0 ? at : Date.now()); return true; });
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
      const rooms = banned ? this.userRooms(u.id) : [];
      return { userId: u.id, rooms };
    });
  }

  async adminDeleteUser(token, userId, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      const u = this.one("SELECT * FROM users WHERE id=?", Number(userId));
      if (!u) fail(404, "用户不存在");
      if (u.is_admin) fail(400, "不能删除管理员");
      const rooms = this.userRooms(u.id);
      this.sql.exec("DELETE FROM sessions WHERE user_id=?", u.id);
      this.sql.exec("DELETE FROM room_access WHERE user_id=?", u.id);
      this.sql.exec("DELETE FROM join_requests WHERE user_id=?", u.id);
      this.sql.exec("DELETE FROM users WHERE id=?", u.id);
      this.log("admin_delete_user", { ...c, userId: a.id, username: a.username, detail: `目标：${u.username}` });
      return { userId: u.id, rooms };
    });
  }

  userRooms(uid) {
    return this.all("SELECT room AS number, kind FROM room_access WHERE user_id=?", uid);
  }

  async adminRooms(token, q) {
    return this.wrap(async () => {
      await this.requireAdmin(token);
      const base = `SELECT r.number, r.name, r.kind, r.creator_id, r.creator_name, r.created_at, r.last_active_at, r.visibility, r.has_pw,
                    (SELECT COUNT(*) FROM join_requests j WHERE j.kind=r.kind AND j.room=r.number AND j.status='pending') AS pending,
                    (SELECT COUNT(*) FROM room_access a WHERE a.room=r.number AND a.kind=r.kind) AS members FROM rooms r`;
      const rows = q ? this.all(`${base} WHERE r.number LIKE ? OR r.creator_name LIKE ? ORDER BY r.last_active_at DESC LIMIT 500`, `%${q}%`, `%${q}%`)
                     : this.all(`${base} ORDER BY r.last_active_at DESC LIMIT 500`);
      return { rows };
    });
  }

  async adminDeleteRoom(token, number, kind, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      kind = kind === "video" ? "video" : "text";
      const r = this.one("SELECT number, kind FROM rooms WHERE kind=? AND number=?", kind, String(number));
      if (!r) fail(404, "房间不存在");
      this.sql.exec("DELETE FROM room_access WHERE kind=? AND room=?", kind, r.number);
      this.sql.exec("DELETE FROM rooms WHERE kind=? AND number=?", kind, r.number);
      this.sql.exec("DELETE FROM join_requests WHERE kind=? AND room=?", kind, r.number);
      this.log("admin_delete_room", { ...c, userId: a.id, username: a.username, room: r.number, detail: kind === "video" ? "解散视频房间" : "解散文字房间" });
      return { number: r.number, kind };
    });
  }

  /** 房主（或管理员）关闭房间：删除房间登记、进入权限和加入申请，房间号随即释放 */
  async closeRoom(token, number, kind, c) {
    return this.wrap(async () => {
      const u = await this.sessionUser(token);
      if (!u) fail(401, "请先登录");
      kind = kind === "video" ? "video" : "text";
      const r = this.one("SELECT number, kind, creator_id, creator_name FROM rooms WHERE kind=? AND number=?", kind, String(number || "").trim());
      if (!r) fail(404, "房间不存在");
      if (!u.is_admin && (r.creator_id == null || r.creator_id !== u.id)) fail(403, "只有房主可以关闭房间");
      this.sql.exec("DELETE FROM room_access WHERE kind=? AND room=?", kind, r.number);
      this.sql.exec("DELETE FROM rooms WHERE kind=? AND number=?", kind, r.number);
      this.sql.exec("DELETE FROM join_requests WHERE kind=? AND room=?", kind, r.number);
      this.log(kind === "video" ? "video_room_close" : "room_close", { ...c, userId: u.id, username: u.username, room: r.number,
        detail: r.creator_id === u.id ? "房主关闭房间" : `管理员关闭房间（房主 ${r.creator_name || "未知"}）` });
      return { number: r.number, kind, byOwner: r.creator_id === u.id };
    });
  }

  /** 把某人移出房间：撤销其进入权限（再进需要重新输入房间密码） */
  async adminKickFromRoom(token, number, kind, userId, c) {
    return this.wrap(async () => {
      const a = await this.requireAdmin(token);
      kind = kind === "video" ? "video" : "text";
      const u = this.one("SELECT id, username FROM users WHERE id=?", Number(userId));
      this.sql.exec("DELETE FROM room_access WHERE user_id=? AND kind=? AND room=?", Number(userId), kind, String(number));
      this.log("admin_kick", { ...c, userId: a.id, username: a.username, room: String(number), detail: `${kind === "video" ? "视频" : "文字"}房间移出：${u ? u.username : userId}` });
      return { userId: Number(userId) };
    });
  }

  async adminRoomExists(token, number, kind) {
    return this.wrap(async () => { await this.requireAdmin(token); return !!this.one("SELECT 1 AS x FROM rooms WHERE kind=? AND number=?", kind === "video" ? "video" : "text", String(number)); });
  }

  async adminCheck(token) { return this.wrap(async () => this.publicUser(await this.requireAdmin(token))); }
  async adminAudit(token, ev, c) {
    return this.wrap(async () => { const a = await this.requireAdmin(token); this.log(ev, { ...c, userId: a.id, username: a.username }); return true; });
  }
}
