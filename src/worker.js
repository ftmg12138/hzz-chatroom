// chatroom.xyzhzz.com 入口 Worker：API + 静态资源 + WebSocket 转发
import { Directory } from "./directory.js";
import { ChatRoom } from "./room.js";
import { iceServers } from "./ice.js";
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
// 视频房间 DO 在 videochatroom Worker 中（script_name 绑定 VROOMS），方法与 ChatRoom 的管理 RPC 同名
const anyRoomStub = (env, number, kind) =>
  kind === "video" ? (env.VROOMS ? env.VROOMS.get(env.VROOMS.idFromName(String(number).toLowerCase())) : null) : roomStub(env, number);
const out = (r, extra = {}) => (r.ok ? json({ ...r.data, ...extra }) : err(r.status, r.error));

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
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
    const r = p === "/api/register" ? await D.register(b.username, b.password, c, b.code) : await D.login(b.username, b.password, c);
    if (!r.ok) return err(r.status, r.error);
    return json({ user: r.data.user }, 200, { "Set-Cookie": cookieHeader(env, r.data.token) });
  }
  if (p === "/api/reg-config" && m === "GET") return json(await D.regConfig());
  if (p === "/api/ice" && m === "GET") {
    if (!(await D.getSession(token))) return err(401, "未登录");
    return json(await iceServers(env));
  }
  if (p === "/api/logout" && m === "POST") {
    if (token) await D.logout(token, c);
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(env, null) });
  }
  if (p === "/api/password" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.changePassword(token, b.oldPassword, b.newPassword, c));
  }

  if (p === "/api/avatar" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.setAvatar(token, b.avatar));
  }
  if (p === "/api/theme" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.setTheme(token, b.theme));
  }
  if (p === "/api/avatars" && m === "GET") {
    const map = await D.avatarsFor(token, (url.searchParams.get("names") || "").split(","));
    return map ? json({ avatars: map }) : err(401, "未登录");
  }

  // ---- 房间 ----
  if (p === "/api/rooms" && m === "GET") {
    const rows = await D.myRooms(token);
    return rows ? json({ rooms: rows }) : err(401, "未登录");
  }
  if (p === "/api/rooms" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = await D.createRoom(token, b.number, b.password, b.name, "text", c, b.visibility);
    if (r.ok) await roomStub(env, r.data.room.number).roomMeta(r.data.room.number, false, true).catch(() => {}); // 开始 10 分钟计时（没人进来也会到点关闭）
    return out(r);
  }
  // 公开房间：列表 / 申请加入 / 房主处理申请
  if (p === "/api/rooms/public" && m === "GET") {
    const rows = await D.publicRooms(token, "text");
    if (!rows) return err(401, "未登录");
    await Promise.all(rows.slice(0, 60).map(async (r) => { try { r.online = (await roomStub(env, r.number).stats()).online.length; } catch { r.online = 0; } }));
    return json({ rooms: rows });
  }
  if (p === "/api/rooms/request" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = await D.requestJoin(token, b.number, "text", c);
    if (r.ok && r.data.created) await roomStub(env, r.data.room).notifyUser(r.data.ownerId, { type: "join-request", id: r.data.id, username: r.data.username }).catch(() => {});
    return out(r);
  }
  if (p === "/api/rooms/requests" && m === "GET") return out(await D.listRequests(token, url.searchParams.get("number") || "", "text"));
  if (p === "/api/rooms/requests/decide" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.decideRequest(token, b.id, !!b.approve, c));
  }
  if (p === "/api/rooms/join" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    return out(await D.joinRoom(token, b.number, b.password, c));
  }
  if (p === "/api/rooms/keep" && m === "POST") {
    // 房主（或管理员）设置「保留房间」：开启后不自动关闭；关闭后重新计 10 分钟
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = await D.setRoomKeep(token, b.number, "text", !!b.keep, c);
    if (r.ok) Object.assign(r.data, await roomStub(env, r.data.number).roomMeta(r.data.number, r.data.keep, !r.data.keep));
    return out(r);
  }
  if (p === "/api/rooms/close" && m === "POST") {
    // 房主（或管理员）关闭房间：删除登记，踢出房间里的所有人（含语音频道）
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    const r = await D.closeRoom(token, b.number, "text", c);
    if (r.ok) await roomStub(env, r.data.number).destroy(r.data.byOwner ? "房主已关闭房间" : "房间已被管理员关闭", true);
    return out(r);
  }
  if (p === "/api/rooms/leave" && m === "POST") {
    const b = await body(req); if (!b) return err(400, "请求格式错误");
    await D.leaveRoom(token, b.number, "text");
    return json({ ok: true });
  }
  let mm = p.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  if (mm && m === "GET") {
    if (req.headers.get("Upgrade") !== "websocket") return err(426, "需要 WebSocket");
    if (!originOk(req, env)) return err(403, "来源不被允许");
    const number = decodeURIComponent(mm[1]);
    const acc = await D.checkRoomAccess(token, number);
    if (!acc) return err(403, "无权进入该房间，请先用房间号和密码加入");
    const h = new Headers({ Upgrade: "websocket", "X-Uid": String(acc.user.id), "X-Username": encodeURIComponent(acc.user.username), "X-Room": acc.room.number,
      "X-Ip": c.ip, "X-Country": c.country, "X-UA": encodeURIComponent(c.ua.slice(0, 300).replace(/[\uD800-\uDFFF]/g, "")),
      "X-Owner": String(acc.room.creator_id ?? ""), "X-Owner-Name": encodeURIComponent(acc.room.creator_name || ""), "X-Visibility": acc.room.visibility || "private", "X-Room-Name": encodeURIComponent(acc.room.name || ""),
      "X-Keep": acc.room.keep ? "1" : "0", "X-Admin": acc.user.isAdmin ? "1" : "0" });
    return roomStub(env, acc.room.number).fetch("https://room/ws", { headers: h });
  }

  // ---- 管理后台 ----
  if (p.startsWith("/api/admin/")) {
    // 自动化测试用维护令牌（仅当 secret MAINT_TOKEN 存在时有效）
    const mt = req.headers.get("X-Maint-Token");
    return admin(req, env, url, D, mt ? "maint:" + mt : token, c);
  }
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
  if (p === "/api/admin/reg-config" && m === "GET") return out(await D.adminRegConfig(token));
  if (p === "/api/admin/reg-config" && m === "POST") {
    const b = (await body(req)) || {};
    return out(await D.adminSetRegConfig(token, b.enabled, b.code, c, !!b.clearCode));
  }
  if (p === "/api/admin/users/seen" && m === "POST") { const b = (await body(req)) || {}; return out(await D.adminMarkUsersSeen(token, typeof b.at === "number" ? b.at : undefined)); }
  let mm = p.match(/^\/api\/admin\/users\/(\d+)\/ban$/);
  if (mm && m === "POST") {
    const b = (await body(req)) || {};
    const r = await D.adminSetBan(token, mm[1], !!b.banned, b.reason, c);
    if (r.ok && b.banned) await Promise.all(r.data.rooms.map((x) => anyRoomStub(env, x.number, x.kind)?.kickUser(r.data.userId, "你的账号已被封禁").catch(() => {})));
    return out(r);
  }
  mm = p.match(/^\/api\/admin\/users\/(\d+)$/);
  if (mm && m === "DELETE") {
    const r = await D.adminDeleteUser(token, mm[1], c);
    if (r.ok) await Promise.all(r.data.rooms.map((x) => anyRoomStub(env, x.number, x.kind)?.kickUser(r.data.userId, "账号已被删除").catch(() => {})));
    return out(r);
  }
  if (p === "/api/admin/rooms" && m === "GET") {
    const r = await D.adminRooms(token, q.get("q") || "");
    if (!r.ok) return out(r);
    const rows = r.data.rows;
    await Promise.all(rows.slice(0, 100).map(async (row) => {
      try { const st = anyRoomStub(env, row.number, row.kind); if (st) Object.assign(row, await st.stats()); } catch {}
    }));
    return json({ rows });
  }
  // 实时监控：所有房间的在线成员（含 IP）、语音/视频中的人、消息数、最近活跃
  if (p === "/api/admin/monitor" && m === "GET") {
    const r = await D.adminRooms(token, "");
    if (!r.ok) return out(r);
    const rows = r.data.rows.slice(0, 150);
    await Promise.all(rows.map(async (row) => {
      try { const st = anyRoomStub(env, row.number, row.kind); if (st) Object.assign(row, await st.stats()); } catch { row.members = []; }
      row.lastActivity = Math.max(row.last_active_at || 0, row.lastMsgAt || 0) || null;
    }));
    rows.sort((x, y) => (y.members?.length || 0) - (x.members?.length || 0) || (y.lastActivity || 0) - (x.lastActivity || 0));
    return json({ rows, now: Date.now() });
  }
  if (p === "/api/admin/requests" && m === "GET") return out(await D.adminRequests(token));
  if (p === "/api/admin/requests/decide" && m === "POST") {
    const b = (await body(req)) || {};
    return out(await D.decideRequest(token, b.id, !!b.approve, c));
  }
  mm = p.match(/^\/api\/admin\/rooms\/(text|video)\/([^/]+)(\/messages(?:\/(\d+))?|\/kick|\/visibility)?$/);
  if (mm) {
    const kind = mm[1], number = decodeURIComponent(mm[2]), sub = mm[3] || "";
    const stub = anyRoomStub(env, number, kind);
    if (!stub) return err(503, "视频房间服务未绑定");
    if (!sub && m === "DELETE") {
      // 解散：踢出所有人（文字/语音/视频），删除房间和全部记录
      const r = await D.adminDeleteRoom(token, number, kind, c);
      if (r.ok) await stub.destroy();
      return out(r);
    }
    if (sub === "/kick" && m === "POST") {
      const b = (await body(req)) || {};
      const r = await D.adminKickFromRoom(token, number, kind, b.userId, c);
      if (r.ok) await stub.kickUser(Number(b.userId), "你已被管理员移出该房间");
      return out(r);
    }
    if (sub === "/visibility" && m === "POST") {
      const b = (await body(req)) || {};
      return out(await D.adminSetVisibility(token, number, kind, b.visibility, c));
    }
    if (sub === "/messages" && m === "GET") return json({ rows: await stub.adminMessages(Number(q.get("limit")) || 300, Number(q.get("after")) || 0) });
    if (sub === "/messages" && m === "DELETE") {
      await stub.clearMessages();
      await D.adminAudit(token, "admin_clear_messages", { ...c, room: number, detail: kind === "video" ? "视频房间" : "文字房间" });
      return json({ ok: true });
    }
    if (sub.startsWith("/messages/") && m === "DELETE") {
      await stub.deleteMessage(mm[4]);
      await D.adminAudit(token, "admin_delete_message", { ...c, room: number, detail: `消息 #${mm[4]}` });
      return json({ ok: true });
    }
  }
  return err(404, "接口不存在");
}
