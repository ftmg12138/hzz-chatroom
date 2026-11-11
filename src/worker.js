// chatroom.xyzhzz.com 入口 Worker：API + 静态资源 + WebSocket 转发
import { Directory } from "./directory.js";
import { ChatRoom } from "./room.js";
export { Directory, ChatRoom };

const COOKIE = "hzz_sid";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (status, error) => json({ error }, status);

function ctxOf(req) {
  return {
    ip: req.headers.get("CF-Connecting-IP") || "",
    country: req.cf?.country || "",
    ua: req.headers.get("User-Agent") || "",
    path: new URL(req.url).pathname,
  };
}
function getToken(req) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{64})`));
  return m ? m[1] : null;
}
function cookieHeader(env, token, maxAge = 30 * 86400) {
  const dom = env.COOKIE_DOMAIN ? `; Domain=${env.COOKIE_DOMAIN}` : "";
  return `${COOKIE}=${token || ""}; Path=/${dom}; HttpOnly; Secure; SameSite=Lax; Max-Age=${token ? maxAge : 0}`;
}
function originOk(req, env) {
  const o = req.headers.get("Origin");
  if (!o) return true; // 非浏览器请求（浏览器跨站 POST / WS 一定带 Origin）
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).includes(o);
}
async function body(req) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}
const dir = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
const roomStub = (env, number) => env.ROOMS.get(env.ROOMS.idFromName(String(number).toLowerCase()));
const out = (r, extra = {}) => (r.ok ? json({ ...r.data, ...extra }) : err(r.status, r.error));

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(req, env, url);
      // 静态页面；页面访问写入访客日志
      const res = await env.ASSETS.fetch(req);
      const isPage = req.method === "GET" && (res.headers.get("content-type") || "").includes("text/html");
      if (!isPage) return res;
      ctx.waitUntil(dir(env).logVisit(ctxOf(req)).catch(() => {}));
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
      h.set("cache-control", "no-cache");
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      console.error(e && e.stack || e);
      return err(500, "服务器内部错误");
    }
  },
};

async function api(req, env, url) {
  const p = url.pathname;
  const m = req.method;
  const c = ctxOf(req);
  const D = dir(env);
  const token = getToken(req);
  if (m !== "GET" && m !== "HEAD" && !originOk(req, env)) return err(403, "来源不被允许");

  // ---- 账号 ----
  if (p === "/api/me" && m === "GET") {
    const user = await D.getSession(token);
    return user ? json({ user }) : err(401, "未登录");
  }
  if ((p === "/api/register" || p === "/api/login") && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = p === "/api/register" ? await D.register(b.username, b.password, c) : await D.login(b.username, b.password, c);
    if (!r.ok) return err(r.status, r.error);
    return json({ user: r.data.user }, 200, { "Set-Cookie": cookieHeader(env, r.data.token) });
  }
  if (p === "/api/logout" && m === "POST") {
    if (token) await D.logout(token, c);
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(env, null) });
  }
  if (p === "/api/password" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.changePassword(token, b.oldPassword, b.newPassword, c));
  }

  // ---- 房间 ----
  if (p === "/api/rooms" && m === "GET") {
    const rows = await D.myRooms(token);
    return rows ? json({ rooms: rows }) : err(401, "未登录");
  }
  if (p === "/api/rooms" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.createRoom(token, b.number, b.password, b.name, "text", c));
  }
  if (p === "/api/rooms/join" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.joinRoom(token, b.number, b.password, c));
  }
  if (p === "/api/rooms/leave" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    await D.leaveRoom(token, b.number);
    return json({ ok: true });
  }
  let mm = p.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (mm && m === "GET") {
    if (req.headers.get("Upgrade") !== "websocket") return err(426, "需要 WebSocket");
    if (!originOk(req, env)) return err(403, "来源不被允许");
    const number = decodeURIComponent(mm[1]);
    const acc = await D.checkRoomAccess(token, number);
    if (!acc) return err(403, "无权进入该房间，请先用房间号和密码加入");
    const h = new Headers({ Upgrade: "websocket", "X-Uid": String(acc.user.id), "X-Username": acc.user.username, "X-Room": acc.room.number, "X-Ip": c.ip });
    return roomStub(env, acc.room.number).fetch("https://room/ws", { headers: h });
  }

  // ---- 管理后台 ----
  if (p.startsWith("/api/admin/")) return admin(req, env, url, D, token, c);
  return err(404, "接口不存在");
}

async function admin(req, env, url, D, token, c) {
  const p = url.pathname, m = req.method, q = url.searchParams;
  const chk = await D.adminCheck(token);
  if (!chk.ok) return err(chk.status, chk.error);

  if (p === "/api/admin/logs" && m === "GET") {
    return out(await D.adminLogs(token, Object.fromEntries(q)));
  }
  if (p === "/api/admin/users" && m === "GET") return out(await D.adminUsers(token, q.get("q") || ""));
  let mm = p.match(/^\/api\/admin\/users\/(\d+)\/ban$/);
  if (mm && m === "POST") {
    const b = (await body(req)) || {};
    const r = await D.adminSetBan(token, mm[1], !!b.banned, b.reason, c);
    if (r.ok && b.banned) await Promise.all(r.data.rooms.map((n) => roomStub(env, n).kickUser(r.data.userId, "你的账号已被封禁").catch(() => {})));
    return out(r);
  }
  mm = p.match(/^\/api\/admin\/users\/(\d+)$/);
  if (mm && m === "DELETE") {
    const r = await D.adminDeleteUser(token, mm[1], c);
    if (r.ok) await Promise.all(r.data.rooms.map((n) => roomStub(env, n).kickUser(r.data.userId, "账号已被删除").catch(() => {})));
    return out(r);
  }
  if (p === "/api/admin/rooms" && m === "GET") {
    const r = await D.adminRooms(token, q.get("q") || "");
    if (!r.ok) return out(r);
    const rows = r.data.rows;
    await Promise.all(rows.slice(0, 100).map(async (row) => {
      try { Object.assign(row, await roomStub(env, row.number).stats()); } catch {}
    }));
    return json({ rows });
  }
  mm = p.match(/^\/api\/admin\/rooms\/([^/]+)(\/messages(?:\/(\d+))?)?$/);
  if (mm) {
    const number = decodeURIComponent(mm[1]);
    const stub = roomStub(env, number);
    if (!mm[2] && m === "DELETE") {
      const r = await D.adminDeleteRoom(token, number, c);
      if (r.ok) await stub.destroy();
      return out(r);
    }
    if (mm[2] && !mm[3] && m === "GET") return json({ rows: await stub.adminMessages(Number(q.get("limit")) || 300) });
    if (mm[2] && !mm[3] && m === "DELETE") {
      await stub.clearMessages();
      await D.adminAudit(token, "admin_clear_messages", { ...c, room: number });
      return json({ ok: true });
    }
    if (mm[3] && m === "DELETE") {
      await stub.deleteMessage(mm[3]);
      await D.adminAudit(token, "admin_delete_message", { ...c, room: number, detail: `消息 #${mm[3]}` });
      return json({ ok: true });
    }
  }
  return err(404, "接口不存在");
}
