(() => {
  const EV = { visit: "页面访问", register: "注册", register_limited: "注册限流", login: "登录", admin_login: "管理员登录", login_fail: "登录失败",
    login_limited: "登录限流", login_banned: "封禁账号登录", logout: "退出", password_change: "修改密码", room_create: "创建房间", room_join: "进入房间",
    room_join_fail: "房间密码错误", room_join_limited: "进房限流", room_request: "申请加入", room_request_approve: "同意申请", room_request_reject: "拒绝申请",
    admin_ban: "封禁用户", admin_unban: "解封用户", admin_delete_user: "删除用户", admin_kick: "移出房间", admin_room_visibility: "修改可见性",
    admin_delete_room: "解散房间", admin_clear_messages: "清空消息", admin_delete_message: "删除消息",
    video_visit: "页面访问", video_room_create: "创建房间", video_join: "进入房间", video_join_fail: "房间密码错误",
    video_join_limited: "进房限流", video_connect: "上线", video_leave: "离开房间", video_request: "申请加入", video_request_approve: "同意申请", video_request_reject: "拒绝申请",
    voice_join: "加入语音", voice_leave: "离开语音", register_code_fail: "注册口令错误", register_code_limited: "注册口令限流", admin_reg_config: "修改注册设置" };
  const BAD = new Set(["login_fail", "login_limited", "login_banned", "room_join_fail", "room_join_limited", "register_limited", "video_join_fail", "video_join_limited", "register_code_fail", "register_code_limited"]);
  const source = (r) => r.event.startsWith("video_") ? '<span class="tag vid">视频</span>' : r.event.startsWith("voice_") ? '<span class="tag good">语音</span>'
    : r.event.startsWith("admin") ? '<span class="tag adm">后台</span>' : r.room || r.event.startsWith("room_") ? '<span class="tag">文字</span>' : '<span class="tag">账号</span>';
  const kindTag = (k) => (k === "video" ? '<span class="tag vid">🎥 视频</span>' : '<span class="tag">💬 文字</span>');
  const visTag = (v) => (v === "public" ? '<span class="tag pub">🌿 公开</span>' : '<span class="tag priv">🔒 私密</span>');
  let me = null, lastId = null, tab = "monitor", cur = null, monTimer = null, mdTimer = null;
  const show = (id) => ["v-login", "v-chpw", "v-main"].forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));

  async function boot() {
    try { me = (await api("/api/me")).user; } catch { me = null; }
    window.__me = me; if (me) syncSkin(me);
    if (!me) return show("v-login");
    if (!me.isAdmin) { show("v-login"); setMsg($("#lg-msg"), "当前登录的不是管理员账号，请退出后用管理员账号登录"); return; }
    if (me.mustChange) { $("#cp-cancel").classList.add("hidden"); return show("v-chpw"); }
    show("v-main"); $("#m-name").textContent = me.username; load();
  }
  $("#f-login").onsubmit = (e) => {
    e.preventDefault();
    busy($("#lg-btn"), async () => {
      try {
        await api("/api/logout", { method: "POST" }).catch(() => {});
        me = (await api("/api/login", { method: "POST", body: { username: $("#lg-user").value.trim(), password: $("#lg-pass").value } })).user;
        $("#lg-pass").value = "";
        if (!me.isAdmin) { setMsg($("#lg-msg"), "该账号不是管理员"); return; }
        setMsg($("#lg-msg"), ""); boot();
      } catch (er) { setMsg($("#lg-msg"), er.message); }
    });
  };
  $("#f-chpw").onsubmit = async (e) => {
    e.preventDefault();
    if ($("#cp-new").value !== $("#cp-new2").value) return setMsg($("#cp-msg"), "两次输入的新密码不一致");
    try {
      me = (await api("/api/password", { method: "POST", body: { oldPassword: $("#cp-old").value, newPassword: $("#cp-new").value } })).user;
      ["#cp-old", "#cp-new", "#cp-new2"].forEach((s) => ($(s).value = ""));
      setMsg($("#cp-msg"), ""); toast("密码已修改"); boot();
    } catch (er) { setMsg($("#cp-msg"), er.message); }
  };
  $("#m-pw").onclick = () => { $("#cp-tip").textContent = "修改管理员密码（至少 10 位）。修改后其他设备会下线。"; $("#cp-cancel").classList.remove("hidden"); show("v-chpw"); };
  $("#cp-cancel").onclick = () => show("v-main");
  $("#m-logout").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); };

  const TABS = ["monitor", "rooms", "requests", "users", "logs", "settings"];
  $$("[data-t]").forEach((b) => b.onclick = () => {
    tab = b.dataset.t;
    $$("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
    TABS.forEach((t) => $("#t-" + t).classList.toggle("hidden", t !== tab));
    $("#v-main").classList.remove("nav-open"); window.scrollTo({ top: 0 });
    load();
  });
  function load() {
    clearTimeout(monTimer); badges();
    ({ monitor: () => monitor(), rooms, requests, users, logs: () => logs(true), settings })[tab]();
  }
  const handle = (er) => { if (er.status === 401 || er.status === 403) boot(); else toast(er.message); };
  const roomPath = (kind, number) => `/api/admin/rooms/${kind}/${encodeURIComponent(number)}`;

  // ---- 角标 ----
  let reg = null;
  async function badges() {
    try {
      reg = await api("/api/admin/reg-config");
      const b = $("#new-badge"); b.textContent = reg.newCount; b.classList.toggle("hidden", !reg.newCount);
      const q = await api("/api/admin/requests");
      const c = $("#rq-badge"); c.textContent = q.rows.length; c.classList.toggle("hidden", !q.rows.length);
    } catch {}
  }

  // ---- 实时监控 ----
  async function monitor() {
    clearTimeout(monTimer);
    try {
      const { rows, now } = await api("/api/admin/monitor");
      const onlineRooms = rows.filter((r) => (r.members || []).length);
      const people = rows.reduce((n, r) => n + (r.members || []).length, 0);
      const inVoice = rows.reduce((n, r) => n + (r.voice || []).length, 0), inVideo = rows.filter((r) => r.kind === "video").reduce((n, r) => n + (r.members || []).length, 0);
      $("#mon-kpis").innerHTML = [["在线连接", people, "🟢"], ["房间总数", rows.length, "🏠"], ["有人在线的房间", onlineRooms.length, "💬"], ["语音中", inVoice, "🎧"], ["视频中", inVideo, "🎥"]]
        .map(([k, v, ico], i) => `<div class="kpi${i === 0 ? " hl" : ""}" data-ico="${ico}"><b>${v}</b><span>${k}</span></div>`).join("");
      const list = $("#mon-active").checked ? onlineRooms : rows;
      $("#mon-grid").innerHTML = list.map((r) => {
        const mem = r.members || [];
        return `<div class="card mon-card">
          <div class="mc-head"><span class="ico-room ${r.kind === "video" ? "v" : ""}">${r.kind === "video" ? "🎥" : "💬"}</span>
            <div class="col"><b>${esc(r.name || r.number)}</b><div class="sub">${esc(r.number)} · 房主 ${esc(r.creator_name || "—")}</div></div></div>
          <div class="mc-stats">${kindTag(r.kind)} ${visTag(r.visibility)} <span>在线 <b>${mem.length}</b></span><span>消息 <b>${r.messages ?? 0}</b></span>
            ${r.kind === "text" ? `<span>语音 <b>${(r.voice || []).length}</b></span>` : ""}${r.pending ? `<span class="tag bad">${r.pending} 个申请</span>` : ""}<span>活跃 ${esc(r.lastActivity ? timeShort(r.lastActivity) : "—")}</span></div>
          <ul class="list">${mem.length ? mem.map((x) => `<li><div class="row">${avatar(x.username, true)}<div><b>${esc(x.username)}</b>
              ${x.voice ? ` <span class="tag good">🎧${x.muted ? "🔇" : ""}</span>` : ""}${r.kind === "video" ? ` <span class="tag vid">${x.video ? "📷" : "📷✕"}${x.audio ? "" : "🔇"}${x.screen ? "🖥️" : ""}</span>` : ""}
              <div class="sub">${esc(x.ip || "")} ${esc(x.country || "")}</div></div></div>
              <button class="btn ghost sm nogrow" data-kick="${x.uid}" data-kind="${r.kind}" data-room="${esc(r.number)}" data-n="${esc(x.username)}">移出</button></li>`).join("")
            : `<li class="empty">当前没人在线</li>`}</ul>
          <div class="mc-actions"><button class="btn soft sm" data-watch="${esc(r.number)}" data-kind="${r.kind}">👀 ${r.kind === "video" ? "看房间聊天" : "实时看消息"}</button>
            <button class="btn danger sm" data-dissolve="${esc(r.number)}" data-kind="${r.kind}">解散</button></div></div>`;
      }).join("") || `<div class="empty">${$("#mon-active").checked ? "现在没有房间有人在线" : "还没有房间"}</div>`;
      $("#mon-time").textContent = "更新于 " + tokyo(now) + "（东京）";
    } catch (er) { handle(er); }
    if ($("#mon-auto").checked && tab === "monitor") monTimer = setTimeout(monitor, 5000);
  }
  $("#mon-auto").onchange = () => monitor();
  $("#mon-active").onchange = () => monitor();
  async function dissolve(kind, number) {
    if (!confirm(`确定解散${kind === "video" ? "视频" : "文字"}房间「${number}」？\n所有人（含语音/视频中）会被立即移出，房间和全部聊天记录将被删除。`)) return;
    try { await api(roomPath(kind, number), { method: "DELETE" }); toast("已解散"); load(); } catch (er) { handle(er); }
  }
  async function kick(kind, number, uid, name) {
    if (!confirm(`把「${name}」移出房间「${number}」？\n他需要重新输入房间密码或重新申请才能再进。`)) return;
    try { await api(roomPath(kind, number) + "/kick", { method: "POST", body: { userId: Number(uid) } }); toast("已移出"); load(); } catch (er) { handle(er); }
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kick],[data-watch],[data-dissolve],[data-vis]"); if (!b || !$("#v-main").contains(b)) return;
    if (b.dataset.kick) kick(b.dataset.kind, b.dataset.room, b.dataset.kick, b.dataset.n);
    else if (b.dataset.watch) openMsgs(b.dataset.kind, b.dataset.watch);
    else if (b.dataset.dissolve) dissolve(b.dataset.kind, b.dataset.dissolve);
    else if (b.dataset.vis) setVis(b.dataset.kind, b.dataset.room, b.dataset.vis);
  });

  // ---- 房间 ----
  async function rooms() {
    try {
      const { rows } = await api("/api/admin/rooms?q=" + encodeURIComponent($("#rf-q").value.trim()));
      const kind = $("#rf-kind").value;
      $("#rt").innerHTML = rows.filter((r) => !kind || r.kind === kind).map((r) => `<tr>
        <td><b>${esc(r.number)}</b></td><td>${kindTag(r.kind)}</td>
        <td>${visTag(r.visibility)}<br><button class="btn ghost sm" data-vis="${r.visibility === "public" ? "private" : "public"}" data-kind="${r.kind}" data-room="${esc(r.number)}">改为${r.visibility === "public" ? "私密" : "公开"}</button></td>
        <td>${esc(r.name || "")}</td><td>${esc(r.creator_name || "")}</td>
        <td class="nowrap">${esc(tokyo(r.created_at))}</td><td class="nowrap">${esc(tokyo(Math.max(r.last_active_at || 0, r.lastMsgAt || 0)))}</td>
        <td>${r.members ?? ""}</td><td>${r.pending ? `<span class="tag bad">${r.pending}</span>` : "0"}</td><td>${r.messages ?? ""}</td><td>${esc((r.online || []).join("、"))}</td>
        <td>${esc((r.kind === "video" ? r.video : r.voice || []).join("、"))}</td>
        <td class="nowrap"><button class="btn soft sm" data-watch="${esc(r.number)}" data-kind="${r.kind}">消息</button>
          <button class="btn danger sm" data-dissolve="${esc(r.number)}" data-kind="${r.kind}">解散</button></td></tr>`).join("") || `<tr><td colspan="13" class="empty">没有房间</td></tr>`;
    } catch (er) { handle(er); }
  }
  async function setVis(kind, number, v) {
    try { await api(roomPath(kind, number) + "/visibility", { method: "POST", body: { visibility: v } }); toast("已修改"); rooms(); } catch (er) { handle(er); }
  }
  $("#rf").onsubmit = (e) => { e.preventDefault(); rooms(); };
  $("#rf-kind").onchange = () => rooms();

  // ---- 消息查看（实时轮询） ----
  async function openMsgs(kind, number) {
    cur = { kind, number, after: 0 };
    $("#md-title").textContent = `${kind === "video" ? "视频" : "文字"}房间 ${number} 的消息`;
    $("#modal").classList.remove("hidden"); $("#md-body").innerHTML = "";
    await pollMsgs(true);
  }
  async function pollMsgs(first) {
    clearTimeout(mdTimer);
    if (!cur) return;
    try {
      const { rows } = await api(`${roomPath(cur.kind, cur.number)}/messages?after=${first ? 0 : cur.after}`);
      if (first) $("#md-body").innerHTML = "";
      if (rows.length) {
        cur.after = Math.max(cur.after, ...rows.map((m) => m.id));
        $("#md-body").insertAdjacentHTML("afterbegin", rows.map((m) => `<tr data-mid-row="${m.id}"><td class="nowrap">${esc(tokyo(m.ts))}</td><td>${esc(m.username || "系统")}</td>
          <td class="msgtxt">${esc(m.text)}</td><td>${esc(m.ip || "")}</td><td>${m.kind === "msg" ? `<button class="btn ghost sm" data-mid="${m.id}">删除</button>` : ""}</td></tr>`).join(""));
      }
      if (!$("#md-body").children.length) $("#md-body").innerHTML = `<tr class="ph"><td colspan="5" class="empty">没有消息</td></tr>`;
      else $$("#md-body .ph").forEach((x) => x.remove());
    } catch (er) { handle(er); }
    if ($("#md-live").checked && cur) mdTimer = setTimeout(() => pollMsgs(false), 3000);
  }
  $("#md-live").onchange = () => pollMsgs(false);
  $("#md-body").onclick = async (e) => {
    const b = e.target.closest("[data-mid]"); if (!b) return;
    try { await api(`${roomPath(cur.kind, cur.number)}/messages/${b.dataset.mid}`, { method: "DELETE" }); b.closest("tr").remove(); } catch (er) { handle(er); }
  };
  $("#md-clear").onclick = async () => {
    if (!confirm("确定清空该房间全部消息？")) return;
    try { await api(`${roomPath(cur.kind, cur.number)}/messages`, { method: "DELETE" }); openMsgs(cur.kind, cur.number); } catch (er) { handle(er); }
  };
  $("#md-close").onclick = () => { clearTimeout(mdTimer); cur = null; $("#modal").classList.add("hidden"); };

  // ---- 申请 ----
  async function requests() {
    try {
      const { rows } = await api("/api/admin/requests");
      $("#qt").innerHTML = rows.map((q) => `<tr><td class="nowrap">${esc(tokyo(q.created_at))}</td><td>${avatar(q.username, true)} <b>${esc(q.username)}</b></td><td>${esc(q.room)}</td>
        <td>${kindTag(q.kind)}</td><td>${esc(q.creator_name || "")}</td><td>${esc(q.ip || "")}</td>
        <td class="nowrap"><button class="btn ok sm" data-qok="${q.id}">同意</button> <button class="btn ghost sm" data-qno="${q.id}">拒绝</button></td></tr>`).join("") || `<tr><td colspan="7" class="empty">没有待处理的申请</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#qt").onclick = async (e) => {
    const b = e.target.closest("[data-qok],[data-qno]"); if (!b) return;
    try { await api("/api/admin/requests/decide", { method: "POST", body: { id: Number(b.dataset.qok || b.dataset.qno), approve: !!b.dataset.qok } }); requests(); badges(); } catch (er) { handle(er); }
  };

  // ---- 用户 ----
  async function users() {
    try {
      const { rows } = await api("/api/admin/users?q=" + encodeURIComponent($("#uf-q").value.trim()));
      $("#ut").innerHTML = rows.map((u) => `<tr>
        <td>${u.id}</td><td>${!u.is_admin && reg && u.created_at > (reg.seenAt || 0) ? '<span class="tag bad">新</span> ' : ""}${avatar(u.username, true)} <b>${esc(u.username)}</b></td>
        <td>${u.is_admin ? '<span class="tag adm">管理员</span>' : u.banned ? `<span class="tag bad">已封禁</span> <span class="sub">${esc(u.ban_reason || "")}</span>` : '<span class="tag good">正常</span>'}</td>
        <td class="nowrap">${esc(tokyo(u.created_at))}</td><td>${esc(u.created_ip || "")}</td>
        <td class="nowrap">${esc(tokyo(u.last_login_at))}</td><td>${esc(u.last_ip || "")}</td>
        <td class="nowrap">${u.is_admin ? "" : `<button class="btn sm ${u.banned ? "ok" : "danger"}" data-ban="${u.id}" data-b="${u.banned ? 0 : 1}" data-n="${esc(u.username)}">${u.banned ? "解封" : "封禁"}</button>
          <button class="btn ghost sm" data-del="${u.id}" data-n="${esc(u.username)}">删除</button>`}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">没有用户</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#ut").onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.ban) {
        const banned = b.dataset.b === "1"; let reason = "";
        if (banned) { reason = prompt(`封禁「${b.dataset.n}」的原因（可留空）：`, ""); if (reason === null) return; }
        await api(`/api/admin/users/${b.dataset.ban}/ban`, { method: "POST", body: { banned, reason } });
      } else if (b.dataset.del) {
        if (!confirm(`确定删除用户「${b.dataset.n}」？该操作不可恢复（历史消息保留）。`)) return;
        await api(`/api/admin/users/${b.dataset.del}`, { method: "DELETE" });
      }
      users();
    } catch (er) { handle(er); }
  };
  $("#uf").onsubmit = (e) => { e.preventDefault(); users(); };

  // ---- 日志 ----
  async function logs(reset) {
    if (reset) { lastId = null; $("#lt").innerHTML = ""; }
    const p = new URLSearchParams({ limit: 100 });
    const f = { scope: $("#lf-scope").value, event: $("#lf-event").value, username: $("#lf-user").value.trim(), ip: $("#lf-ip").value.trim(), room: $("#lf-room").value.trim(), q: $("#lf-q").value.trim() };
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (lastId) p.set("before", lastId);
    try {
      const d = await api("/api/admin/logs?" + p);
      const sel = $("#lf-event"), curv = sel.value;
      sel.innerHTML = `<option value="">全部事件</option>` + d.events.map((e) => `<option value="${esc(e.event)}">${esc((e.event.startsWith("video_") ? "视频·" : "") + (EV[e.event] || e.event))}（${e.n}）</option>`).join("");
      sel.value = curv;
      $("#lt").insertAdjacentHTML("beforeend", d.rows.map((r) => `<tr>
        <td class="nowrap">${esc(tokyo(r.ts))}</td><td>${source(r)}</td>
        <td><span class="tag ${BAD.has(r.event) ? "bad" : r.event.startsWith("admin") ? "adm" : r.event.startsWith("video_") ? "vid" : r.event.startsWith("voice_") ? "good" : ""}">${esc(EV[r.event] || r.event)}</span></td>
        <td>${esc(r.username || "")}</td><td>${esc(r.room || "")}</td>
        <td class="nowrap"><a href="#" data-ip="${esc(r.ip || "")}">${esc(r.ip || "")}</a></td><td>${esc(r.country || "")}</td>
        <td>${esc([r.path, r.detail].filter(Boolean).join(" · "))}</td><td class="ua">${esc(r.ua || "")}</td></tr>`).join(""));
      if (d.rows.length) lastId = d.rows[d.rows.length - 1].id;
      const shown = $$("#lt tr").length;
      $("#l-total").textContent = `共 ${d.total} 条，已显示 ${shown} 条`;
      $("#l-more").classList.toggle("hidden", shown >= d.total || !d.rows.length);
      if (!shown) $("#lt").innerHTML = `<tr><td colspan="9" class="empty">没有记录</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#lt").onclick = (e) => { const a = e.target.closest("[data-ip]"); if (!a) return; e.preventDefault(); $("#lf-ip").value = a.dataset.ip; logs(true); };
  $("#lf").onsubmit = (e) => { e.preventDefault(); logs(true); };
  $("#lf-reset").onclick = () => { $("#lf").reset(); logs(true); };
  $("#l-more").onclick = () => logs(false);
  $("#lf-scope").onchange = () => logs(true);

  // ---- 注册设置 ----
  async function settings() {
    await badges(); if (!reg) return;
    $("#rg-enabled").checked = reg.enabled;
    $("#rg-state").textContent = reg.enabled ? "已开启：注册需要口令" : "已关闭：任何人都可注册";
    $("#rg-info").textContent = reg.hasCode ? `口令更新于 ${tokyo(reg.updatedAt)}（东京）· 24 小时内口令错误 ${reg.codeFails24h} 次` : "尚未设置口令";
    $("#rg-list").innerHTML = reg.recent.map((u) => `<tr><td>${u.created_at > (reg.seenAt || 0) ? '<span class="tag bad">新</span> ' : ""}${avatar(u.username, true)} <b>${esc(u.username)}</b></td>
      <td class="nowrap">${esc(tokyo(u.created_at))}</td><td>${esc(u.created_ip || "")}</td><td>${u.banned ? '<span class="tag bad">已封禁</span>' : '<span class="tag good">正常</span>'}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">还没有用户注册</td></tr>`;
  }
  $("#rg-enabled").onchange = async (e) => {
    try { await api("/api/admin/reg-config", { method: "POST", body: { enabled: e.target.checked } }); setMsg($("#rg-msg"), e.target.checked ? "已开启注册口令" : "已关闭注册口令", "ok"); }
    catch (er) { e.target.checked = !e.target.checked; setMsg($("#rg-msg"), er.message); }
    settings();
  };
  $("#rg-form").onsubmit = async (e) => {
    e.preventDefault();
    const code = $("#rg-code").value.trim(); if (!code) return setMsg($("#rg-msg"), "请输入新口令");
    try { await api("/api/admin/reg-config", { method: "POST", body: { code } }); $("#rg-code").value = ""; setMsg($("#rg-msg"), "口令已保存" + (reg && reg.enabled ? "，新注册立即生效" : "；打开上方开关后生效"), "ok"); settings(); }
    catch (er) { setMsg($("#rg-msg"), er.message); }
  };
  $("#rg-clear").onclick = async () => {
    if (!confirm("清除注册口令并关闭口令注册？")) return;
    try { await api("/api/admin/reg-config", { method: "POST", body: { clearCode: true } }); setMsg($("#rg-msg"), "已清除口令", "ok"); settings(); } catch (er) { setMsg($("#rg-msg"), er.message); }
  };
  $("#rg-seen").onclick = async () => { await api("/api/admin/users/seen", { method: "POST" }).catch(() => {}); settings(); };

  boot();
})();
