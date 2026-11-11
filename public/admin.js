(() => {
  const EV = { visit: "页面访问", register: "注册", register_limited: "注册限流", login: "登录", admin_login: "管理员登录", login_fail: "登录失败",
    login_limited: "登录限流", login_banned: "封禁账号登录", logout: "退出", password_change: "修改密码", room_create: "创建房间", room_join: "进入房间",
    room_join_fail: "房间密码错误", room_join_limited: "进房限流", admin_ban: "封禁用户", admin_unban: "解封用户", admin_delete_user: "删除用户",
    admin_delete_room: "删除房间", admin_clear_messages: "清空消息", admin_delete_message: "删除消息" };
  const BAD = new Set(["login_fail", "login_limited", "login_banned", "room_join_fail", "room_join_limited", "register_limited"]);
  let me = null, lastId = null, tab = "logs", curRoom = null;
  const show = (id) => ["v-login", "v-chpw", "v-main"].forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));

  async function boot() {
    try { me = (await api("/api/me")).user; } catch { me = null; }
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
      setMsg($("#cp-msg"), ""); alert("密码已修改"); boot();
    } catch (er) { setMsg($("#cp-msg"), er.message); }
  };
  $("#m-pw").onclick = () => { $("#cp-tip").textContent = "修改管理员密码（至少 10 位）。修改后其他设备会下线。"; $("#cp-cancel").classList.remove("hidden"); show("v-chpw"); };
  $("#cp-cancel").onclick = () => show("v-main");
  $("#m-logout").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); };

  $$("[data-t]").forEach((b) => b.onclick = () => {
    tab = b.dataset.t;
    $$("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
    ["logs", "users", "rooms"].forEach((t) => $("#t-" + t).classList.toggle("hidden", t !== tab));
    load();
  });
  function load() { if (tab === "logs") logs(true); else if (tab === "users") users(); else rooms(); }
  const handle = (er) => { if (er.status === 401 || er.status === 403) boot(); else alert(er.message); };

  // ---- 日志 ----
  async function logs(reset) {
    if (reset) { lastId = null; $("#lt").innerHTML = ""; }
    const p = new URLSearchParams({ limit: 100 });
    const f = { event: $("#lf-event").value, username: $("#lf-user").value.trim(), ip: $("#lf-ip").value.trim(), room: $("#lf-room").value.trim(), q: $("#lf-q").value.trim() };
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (lastId) p.set("before", lastId);
    try {
      const d = await api("/api/admin/logs?" + p);
      const sel = $("#lf-event"), cur = sel.value;
      sel.innerHTML = `<option value="">全部事件</option>` + d.events.map((e) => `<option value="${esc(e.event)}">${esc(EV[e.event] || e.event)}（${e.n}）</option>`).join("");
      sel.value = cur;
      $("#lt").insertAdjacentHTML("beforeend", d.rows.map((r) => `<tr>
        <td class="nowrap">${esc(tokyo(r.ts))}</td>
        <td><span class="tag ${BAD.has(r.event) ? "bad" : r.event.startsWith("admin") ? "adm" : ""}">${esc(EV[r.event] || r.event)}</span></td>
        <td>${esc(r.username || "")}</td><td>${esc(r.room || "")}</td>
        <td class="nowrap"><a href="#" data-ip="${esc(r.ip || "")}">${esc(r.ip || "")}</a></td><td>${esc(r.country || "")}</td>
        <td>${esc([r.path, r.detail].filter(Boolean).join(" · "))}</td><td class="ua">${esc(r.ua || "")}</td></tr>`).join(""));
      if (d.rows.length) lastId = d.rows[d.rows.length - 1].id;
      const shown = $$("#lt tr").length;
      $("#l-total").textContent = `共 ${d.total} 条，已显示 ${shown} 条`;
      $("#l-more").classList.toggle("hidden", shown >= d.total || !d.rows.length);
      if (!shown) $("#lt").innerHTML = `<tr><td colspan="8" class="empty">没有记录</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#lt").onclick = (e) => { const a = e.target.closest("[data-ip]"); if (!a) return; e.preventDefault(); $("#lf-ip").value = a.dataset.ip; logs(true); };
  $("#lf").onsubmit = (e) => { e.preventDefault(); logs(true); };
  $("#lf-reset").onclick = () => { $("#lf").reset(); logs(true); };
  $("#l-more").onclick = () => logs(false);

  // ---- 用户 ----
  async function users() {
    try {
      const { rows } = await api("/api/admin/users?q=" + encodeURIComponent($("#uf-q").value.trim()));
      $("#ut").innerHTML = rows.map((u) => `<tr>
        <td>${u.id}</td><td><b>${esc(u.username)}</b></td>
        <td>${u.is_admin ? '<span class="tag adm">管理员</span>' : u.banned ? `<span class="tag bad">已封禁</span> <span class="sub">${esc(u.ban_reason || "")}</span>` : '<span class="tag good">正常</span>'}</td>
        <td class="nowrap">${esc(tokyo(u.created_at))}</td><td>${esc(u.created_ip || "")}</td>
        <td class="nowrap">${esc(tokyo(u.last_login_at))}</td><td>${esc(u.last_ip || "")}</td>
        <td class="nowrap">${u.is_admin ? "" : `<button class="btn sm ${u.banned ? "" : "danger"}" data-ban="${u.id}" data-b="${u.banned ? 0 : 1}" data-n="${esc(u.username)}">${u.banned ? "解封" : "封禁"}</button>
          <button class="btn ghost sm" data-del="${u.id}" data-n="${esc(u.username)}">删除</button>`}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">没有用户</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#ut").onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    try {
      if (b.dataset.ban) {
        const banned = b.dataset.b === "1";
        let reason = "";
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

  // ---- 房间 ----
  async function rooms() {
    try {
      const { rows } = await api("/api/admin/rooms?q=" + encodeURIComponent($("#rf-q").value.trim()));
      $("#rt").innerHTML = rows.map((r) => `<tr>
        <td><b>${esc(r.number)}</b></td><td>${esc(r.name || "")}</td><td>${esc(r.creator_name || "")}</td>
        <td class="nowrap">${esc(tokyo(r.created_at))}</td><td class="nowrap">${esc(tokyo(r.last_active_at))}</td>
        <td>${r.members ?? ""}</td><td>${r.messages ?? ""}</td><td>${esc((r.online || []).join("、"))}</td>
        <td class="nowrap"><button class="btn ghost sm" data-view="${esc(r.number)}">消息</button>
          <button class="btn danger sm" data-delroom="${esc(r.number)}">删除房间</button></td></tr>`).join("") || `<tr><td colspan="9" class="empty">没有房间</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#rt").onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.view) return openMsgs(b.dataset.view);
    if (b.dataset.delroom && confirm(`确定删除房间「${b.dataset.delroom}」及其全部消息？在线成员会被移出。`)) {
      try { await api(`/api/admin/rooms/${encodeURIComponent(b.dataset.delroom)}`, { method: "DELETE" }); rooms(); } catch (er) { handle(er); }
    }
  };
  $("#rf").onsubmit = (e) => { e.preventDefault(); rooms(); };
  async function openMsgs(number) {
    curRoom = number;
    $("#md-title").textContent = `房间 ${number} 的消息`;
    $("#modal").classList.remove("hidden");
    try {
      const { rows } = await api(`/api/admin/rooms/${encodeURIComponent(number)}/messages`);
      $("#md-body").innerHTML = rows.map((m) => `<tr><td class="nowrap">${esc(tokyo(m.ts))}</td><td>${esc(m.username || "系统")}</td>
        <td class="msgtxt">${esc(m.text)}</td><td>${esc(m.ip || "")}</td><td>${m.kind === "msg" ? `<button class="btn ghost sm" data-mid="${m.id}">删除</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">没有消息</td></tr>`;
    } catch (er) { handle(er); }
  }
  $("#md-body").onclick = async (e) => {
    const b = e.target.closest("[data-mid]"); if (!b) return;
    try { await api(`/api/admin/rooms/${encodeURIComponent(curRoom)}/messages/${b.dataset.mid}`, { method: "DELETE" }); openMsgs(curRoom); } catch (er) { handle(er); }
  };
  $("#md-clear").onclick = async () => {
    if (!confirm("确定清空该房间全部消息？")) return;
    try { await api(`/api/admin/rooms/${encodeURIComponent(curRoom)}/messages`, { method: "DELETE" }); openMsgs(curRoom); rooms(); } catch (er) { handle(er); }
  };
  $("#md-close").onclick = () => $("#modal").classList.add("hidden");

  boot();
})();
