// 界面主题（皮肤）线上测试：保存到账号、两站同步、白名单校验、来源校验、静态资源、浏览器渲染
// MAINT_TOKEN_FILE=... node test/theme.mjs   （SHOTS=1 时额外保存截图到 /workspace/live-theme-*.png）
import fs from "node:fs";
import { chromium } from "playwright-core";
const C = process.env.BASE || "https://chatroom.xyzhzz.com";
const V = process.env.VIDEO_BASE || "https://videochatroom.xyzhzz.com";
const MAINT = fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim();
const sfx = Math.random().toString(36).slice(2, 7);
let pass = 0, failN = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓", n); } else { failN++; console.log("  ✗", n); } };
async function req(base, path, { method = "GET", body, cookie = "", origin = base, extra = {} } = {}) {
  const h = { Origin: origin, ...extra }; if (cookie) h.Cookie = cookie; if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie"); let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, data: d, sid: sc && (sc.match(/hzz_sid=([0-9a-f]+)/) || [])[1] };
}
const name = "主题测" + sfx, PW = "Theme-pass-" + sfx;
let r = await req(C, "/api/register", { method: "POST", body: { username: name, password: PW } });
ok(r.status === 200 && r.data.user && r.data.user.theme === null, "新用户默认没有保存主题（前端默认森林）");
const sid = r.sid, cookie = "hzz_sid=" + sid;
console.log("API");
r = await req(C, "/api/theme", { method: "POST", body: { theme: "night" }, cookie }); ok(r.status === 200 && r.data.user.theme === "night", "chatroom 保存主题 night");
r = await req(V, "/api/me", { cookie }); ok(r.data.user && r.data.user.theme === "night", "videochatroom 读到同一主题 night");
r = await req(V, "/api/theme", { method: "POST", body: { theme: "tavern" }, cookie }); ok(r.status === 200 && r.data.user.theme === "tavern", "videochatroom 切换为 tavern");
r = await req(C, "/api/me", { cookie }); ok(r.data.user.theme === "tavern", "chatroom 同步为 tavern");
for (const bad of ["dark", "<script>", "", 123]) { r = await req(C, "/api/theme", { method: "POST", body: { theme: bad }, cookie }); ok(r.status === 400, `非法主题 ${JSON.stringify(bad)} 被拒（${r.status}）`); }
r = await req(C, "/api/theme", { method: "POST", body: { theme: "night" } }); ok(r.status === 401, "未登录保存主题 401");
r = await req(C, "/api/theme", { method: "POST", body: { theme: "night" }, cookie, origin: "https://evil.example" }); ok(r.status === 403, "跨站来源保存主题被拒");
r = await req(C, "/api/me", { cookie }); ok(r.data.user.theme === "tavern", "被拒的请求没有改动主题");
console.log("静态资源");
for (const b of [C, V]) {
  for (const f of ["/skins.css", "/theme.js", "/themes/cream-mascot.webp", "/themes/cream-hero.webp", "/themes/night-stars.svg", "/themes/tavern-frame.svg", "/themes/forest-help.webp"]) {
    const x = await fetch(b + f); ok(x.status === 200, `${b.replace("https://", "")}${f} 200`);
  }
  const local = fs.statSync(new URL("../public/themes/cream-mascot.webp", import.meta.url)).size;
  const live = (await (await fetch(b + "/themes/cream-mascot.webp")).arrayBuffer()).byteLength;
  ok(live === local, `${b.replace("https://", "")} 奶油主题吉祥物是新的奶蛙徽章`);
  const csp = (await fetch(b + "/")).headers.get("content-security-policy") || "";
  ok(/style-src 'self'/.test(csp) && /img-src 'self' data:/.test(csp), `${b.replace("https://", "")} CSP 未放宽`);
}
console.log("浏览器");
const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const shots = process.env.SHOTS === "1";
for (const [sz, vp] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await br.newContext({ viewport: vp, deviceScaleFactor: sz === "mobile" ? 2 : 1, isMobile: sz === "mobile", hasTouch: sz === "mobile" });
  await ctx.addCookies([{ name: "hzz_sid", value: sid, domain: ".xyzhzz.com", path: "/", httpOnly: true, secure: true }]);
  const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" && !/401|beacon|cloudflareinsights/i.test(m.text())) errs.push(m.text()); });
  const want = (await req(C, "/api/me", { cookie })).data.user.theme;
  await p.goto(C + "/"); await p.waitForSelector("#v-lobby:not(.hidden)"); await p.waitForTimeout(600);
  ok(await p.evaluate(() => document.documentElement.dataset.skin) === want, `[${sz}] chatroom 按账号显示 ${want}`);
  if (sz === "desktop") {
    await p.click(".mh-tools [data-open-theme]"); await p.click('.skin-opt[data-k="cream"]');
  } else { await p.click(".tabbar [data-open-theme]"); await p.click('.skin-opt[data-k="cream"]'); }
  await p.waitForTimeout(800);
  const st = await p.evaluate(async () => [document.documentElement.dataset.skin, getComputedStyle(document.querySelector(".stat-mascot")).backgroundImage, (await (await fetch("/api/me")).json()).user.theme]);
  ok(st[0] === "cream" && st[2] === "cream", `[${sz}] 选择器切到 cream 并保存到账号`);
  ok(/cream-mascot\.webp/.test(st[1]), `[${sz}] cream 吉祥物位置用的是奶蛙图`);
  await p.waitForTimeout(400);
  if (shots) await p.screenshot({ path: `/workspace/live-theme-cream-lobby-${sz}.png` });
  const v = await ctx.newPage(); v.on("pageerror", (e) => errs.push(e.message));
  await v.goto(V + "/"); await v.waitForSelector("#v-lobby:not(.hidden)"); await v.waitForTimeout(800);
  ok(await v.evaluate(() => document.documentElement.dataset.skin) === "cream", `[${sz}] videochatroom 同步显示 cream`);
  if (shots) await v.screenshot({ path: `/workspace/live-theme-cream-video-lobby-${sz}.png` });
  // 切到星夜，看另一个站
  await v.evaluate(() => setSkin("night")); await v.waitForTimeout(600);
  await p.reload(); await p.waitForSelector("#v-lobby:not(.hidden)"); await p.waitForTimeout(800);
  ok(await p.evaluate(() => document.documentElement.dataset.skin) === "night", `[${sz}] 在视频站切到 night 后文字站也是 night`);
  if (shots) await p.screenshot({ path: `/workspace/live-theme-night-lobby-${sz}.png` });
  ok(errs.length === 0, `[${sz}] 没有页面错误 / CSP 违规${errs.length ? "：" + errs.slice(0, 3).join(" | ") : ""}`);
  await ctx.close();
}
// 未登录：本机偏好（localStorage）
{
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  await p.goto(C + "/"); await p.waitForSelector("#v-auth:not(.hidden)");
  ok(await p.evaluate(() => document.documentElement.dataset.skin) === "forest", "未登录默认森林主题");
  await p.click('[data-skin-set="cream"]'); await p.reload(); await p.waitForSelector("#v-auth:not(.hidden)"); await p.waitForTimeout(500);
  ok(await p.evaluate(() => document.documentElement.dataset.skin) === "cream", "未登录选择的主题记在本机（刷新后保留）");
  if (shots) await p.screenshot({ path: `/workspace/live-theme-cream-auth-desktop.png` });
  await ctx.close();
}
await br.close();
console.log("清理");
const adm = (path, method) => req(C, path, { method, extra: { "X-Maint-Token": MAINT } });
r = await adm("/api/admin/users?q=" + encodeURIComponent(name));
const u = (r.data.users || r.data.rows || []).find((x) => x.username === name);
if (u) { r = await adm(`/api/admin/users/${u.id}`, "DELETE"); ok(r.status === 200, "删除测试用户"); } else ok(false, "找到测试用户");
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
