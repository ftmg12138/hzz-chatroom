// 浏览器 UI 测试：注册后弹出头像选择、保存后各处显示、CSP 无报错（两个站点 + 后台页面）
// MAINT_TOKEN_FILE=... node test/ui-avatar.mjs
import fs from "node:fs";
import { chromium } from "playwright-core";
const C = "https://chatroom.xyzhzz.com", V = "https://videochatroom.xyzhzz.com";
const MT = fs.readFileSync(process.env.MAINT_TOKEN_FILE, "utf8").trim();
const sfx = Math.random().toString(36).slice(2, 6);
let pass = 0, failN = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓", n); } else { failN++; console.log("  ✗", n); } };
const br = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const names = [];
async function regUI(base, name) {
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["microphone", "camera"] }); // 不绕过 CSP，检查是否有违规
  const p = await ctx.newPage(); const errs = [];
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(base + "/"); await p.click('[data-tab="register"]');
  await p.fill("#a-user", name); await p.fill("#a-pass", "Ui-pass-" + sfx); await p.fill("#a-pass2", "Ui-pass-" + sfx);
  await p.click("#a-submit"); names.push(name);
  return { ctx, p, errs };
}
console.log("chatroom");
let { ctx, p, errs } = await regUI(C, `界面${sfx}`);
const picker = await p.waitForSelector(".av-picker", { timeout: 8000 }).catch(() => null);
ok(!!picker && /注册成功/.test(await p.textContent(".av-picker h2")), "注册后弹出头像选择");
await p.waitForSelector(".av-opt", { timeout: 8000, state: "attached" });
ok((await p.$$(".av-opt")).length >= 20, "预设形象从清单加载（≥20 个）");
await p.click('[data-avtab="letter"]'); await p.click('.av-sw[data-pick="c:#f29bbd"]');
ok((await p.$eval(".av-preview .av", (e) => getComputedStyle(e).backgroundColor)) === "rgb(242, 155, 189)", "字母头像预览显示所选颜色");
await p.$eval("#avp-color", (e) => { e.value = "#123456"; e.dispatchEvent(new Event("input", { bubbles: true })); });
ok((await p.textContent("#avp-desc")).includes("#123456"), "自定义颜色选择器生效");
await p.click("#avp-save"); await p.waitForSelector(".av-picker", { state: "detached" });
await p.waitForTimeout(600);
ok((await p.$eval("#l-av .av", (e) => getComputedStyle(e).backgroundColor)) === "rgb(18, 52, 86)", "大厅显示新头像（字母 + 自定义色）");
ok((await p.$eval("#l-av .av", (e) => e.textContent)) === "界", "字母头像用中文首字");
await p.click("#l-avatar"); await p.waitForSelector(".av-opt", { state: "attached" }); await p.click('[data-avtab="preset"]'); await p.click('.av-opt[data-pick="p:av05"]'); await p.click("#avp-save");
await p.waitForSelector(".av-picker", { state: "detached" }); await p.waitForTimeout(600);
ok(!!(await p.$("#l-av .av.img img")), "改为预设形象后大厅显示图片");
// 建房发消息，看消息与成员列表头像
await p.click('[data-rtab="create"]'); await p.fill("#r-num", "ui-" + sfx); await p.fill("#r-pass", "1234"); await p.click("#r-submit");
await p.waitForSelector("#ch-input"); await p.waitForTimeout(800);
await p.fill("#ch-input", "头像测试"); await p.press("#ch-input", "Enter"); await p.waitForTimeout(1000);
ok(!!(await p.$("#ch-msgs .mrow .av.img img")) && !!(await p.$("#ch-online .av.img img")), "消息和在线成员显示预设头像");
await p.click("#vc-toggle"); await p.click("#vc-join").catch(() => {}); await p.waitForTimeout(1500);
ok(!!(await p.$(".vc-chip .av")), "语音频道成员显示头像");
ok(errs.filter((e) => /Content Security Policy|Refused/.test(e) && !/cloudflareinsights/.test(e)).length === 0, "chatroom 无 CSP 违规" + (errs.some((e) => /cloudflareinsights/.test(e)) ? "（Cloudflare Web Analytics 自动注入的 beacon 被 CSP 拦截，非本站代码）" : ""));
await ctx.close();
console.log("videochatroom");
({ ctx, p, errs } = await regUI(V, `vui_${sfx}`));
ok(!!(await p.waitForSelector(".av-picker", { timeout: 8000 }).catch(() => null)), "视频站注册后也弹出头像选择");
await p.click("#avp-cancel"); await p.waitForTimeout(300);
ok(!(await p.$(".av-picker")) && (await p.$eval("#l-av .av", (e) => e.textContent)) === "V", "可以跳过，显示默认字母头像");
await p.click('[data-rtab="create"]'); await p.check('input[name="r-vis"][value="public"]');
ok((await p.textContent("#r-pass-label")).includes("可选"), "公开房间密码可选");
await p.fill("#r-num", "vui-" + sfx); await p.click("#r-submit");
await p.waitForSelector("#p-none"); await p.click("#p-none"); await p.waitForTimeout(2000);
ok(!!(await p.$('.tile[data-peer="local"] .off .av')) && !(await p.$("#rq-btn.hidden")), "视频格子显示头像，房主有申请按钮");
ok(errs.filter((e) => /Content Security Policy|Refused/.test(e) && !/cloudflareinsights/.test(e)).length === 0, "videochatroom 无 CSP 违规" + (errs.some((e) => /cloudflareinsights/.test(e)) ? "（Cloudflare Web Analytics 自动注入的 beacon 被 CSP 拦截，非本站代码）" : ""));
await ctx.close();
console.log("admin 页面");
ctx = await br.newContext({ viewport: { width: 1300, height: 800 } });
await ctx.route("**/api/me", (r) => r.fulfill({ json: { user: { id: 0, username: "维护测试", isAdmin: true, mustChange: false } } }));
await ctx.route("**/api/admin/**", (r) => r.continue({ headers: { ...r.request().headers(), "x-maint-token": MT } }));
p = await ctx.newPage(); errs = []; p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); }); p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(C + "/admin"); await p.waitForTimeout(2000);
ok((await p.$$("#mon-grid .mon-card")).length >= 1 && (await p.$$("#mon-kpis .kpi")).length === 5, "实时监控页渲染");
for (const t of ["rooms", "requests", "users", "logs", "settings"]) { await p.click(`[data-t="${t}"]`); await p.waitForTimeout(900); }
ok(!!(await p.$("#rg-enabled")) && !(await p.$eval("#rg-enabled", (e) => e.checked)), "注册设置页：开关为关闭");
await p.click('[data-t="rooms"]'); await p.waitForTimeout(900);
await p.click(`#rt [data-watch="ui-${sfx}"][data-kind="text"]`); await p.waitForTimeout(1200);
ok((await p.textContent("#md-body")).includes("头像测试"), "后台监看文字房间消息");
await p.click("#md-close");
ok(errs.filter((e) => /Content Security Policy|Refused|TypeError|ReferenceError/.test(e) && !/cloudflareinsights/.test(e)).length === 0, "后台页面无脚本错误" + (errs.some((e) => /cloudflareinsights/.test(e)) ? "（Cloudflare Web Analytics 自动注入的 beacon 被 CSP 拦截，非本站代码）" : ""));
await ctx.close(); await br.close();
console.log("清理");
const h = { "X-Maint-Token": MT, Origin: C };
for (const [k, n] of [["text", "ui-" + sfx], ["video", "vui-" + sfx]]) { const r = await fetch(`${C}/api/admin/rooms/${k}/${n}`, { method: "DELETE", headers: h }); ok(r.status === 200, "删除房间 " + n); }
const us = await (await fetch(`${C}/api/admin/users?q=${sfx}`, { headers: h })).json();
for (const u of us.rows.filter((u) => names.includes(u.username))) { const r = await fetch(`${C}/api/admin/users/${u.id}`, { method: "DELETE", headers: h }); ok(r.status === 200, "删除用户 " + u.username); }
console.log(`\n通过 ${pass}，失败 ${failN}`);
process.exit(failN ? 1 : 0);
