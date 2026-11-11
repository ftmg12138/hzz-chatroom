(() => {
  let me = null, mode = "login", rmode = "join", ws = null, curRoom = null, retry = 0, pingT = null, wantClose = false;
  const views = ["v-auth", "v-chpw", "v-lobby", "v-chat"];
  const show = (id) => views.forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));

  async function boot() {
    try { me = (await api("/api/me")).user; } catch { me = null; }
    route();
  }
  function route() {
    if (!me) { closeWs(); show("v-auth"); return; }
    if (me.mustChange) { closeWs(); show("v-chpw"); return; }
    const m = location.hash.match(/^#\/room\/(.+)$/);
    if (m) openRoom(decodeURIComponent(m[1]));
    else { closeWs(); show("v-lobby"); lobby(); }
  }
  window.addEventListener("hashchange", route);

  // ---- 登录注册 ----
  $$("[data-tab]").forEach((b) => b.onclick = () => {
    mode = b.dataset.tab;
    $$("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
    $("#reg-extra").classList.toggle("hidden", mode !== "register");
    $("#a-submit").textContent = mode === "login" ? "登录" : "注册并登录";
    $("#a-pass").autocomplete = mode === "login" ? "current-password" : "new-password";
    setMsg($("#a-msg"), "");
  });
  $("#f-auth").onsubmit = (e) => {
    e.preventDefault();
    const username = $("#a-user").value.trim(), password = $("#a-pass").value;
    if (mode === "register" && password !== $("#a-pass2").value) return setMsg($("#a-msg"), "两次输入的密码不一致");
    busy($("#a-submit"), async () => {
      try {
        me = (await api("/api/" + mode, { method: "POST", body: { username, password } })).user;
        $("#a-pass").value = $("#a-pass2").value = "";
        route();
      } catch (er) { setMsg($("#a-msg"), er.message); }
    });
  };

  // ---- 改密码 ----
  $("#f-chpw").onsubmit = async (e) => {
    e.preventDefault();
    const o = $("#c-old").value, n = $("#c-new").value;
    if (n !== $("#c-new2").value) return setMsg($("#c-msg"), "两次输入的新密码不一致");
    try {
      me = (await api("/api/password", { method: "POST", body: { oldPassword: o, newPassword: n } })).user;
      $("#c-old").value = $("#c-new").value = $("#c-new2").value = "";
      setMsg($("#c-msg"), "");
      if (me.isAdmin && new URLSearchParams(location.search).get("next") === "admin") location.href = "/admin";
      else { location.hash = ""; route(); }
    } catch (er) { setMsg($("#c-msg"), er.message); }
  };
  $("#l-pw").onclick = () => { show("v-chpw"); $("#v-chpw .notice").textContent = "修改后其他设备上的登录会失效。"; };
  $("#l-logout").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); me = null; location.hash = ""; route(); };

  // ---- 大厅 ----
  async function lobby() {
    $("#l-name").textContent = me.username;
    $("#l-admin").classList.toggle("hidden", !me.isAdmin);
    const ul = $("#l-rooms");
    try {
      const { rooms } = await api("/api/rooms");
      ul.innerHTML = rooms.length ? rooms.map((r) => `<li><div><b>${esc(r.name || r.number)}</b><div class="sub">房间号 ${esc(r.number)} · 创建者 ${esc(r.creator_name || "—")}</div></div>
        <div class="row nogrow"><a class="btn sm" href="#/room/${encodeURIComponent(r.number)}">进入</a><button class="btn ghost sm" data-leave="${esc(r.number)}">移除</button></div></li>`).join("")
        : `<li class="empty">还没有房间。创建一个，或用房间号和密码加入。</li>`;
      $$("[data-leave]", ul).forEach((b) => b.onclick = async () => {
        if (!confirm("从列表移除该房间？之后再进需要重新输入房间密码。")) return;
        await api("/api/rooms/leave", { method: "POST", body: { number: b.dataset.leave } }); lobby();
      });
    } catch (er) { if (er.status === 401) { me = null; route(); } }
  }
  $$("[data-rtab]").forEach((b) => b.onclick = () => {
    rmode = b.dataset.rtab;
    $$("[data-rtab]").forEach((x) => x.classList.toggle("on", x === b));
    $("#r-create-extra").classList.toggle("hidden", rmode !== "create");
    $("#r-submit").textContent = rmode === "join" ? "加入" : "创建并进入";
    setMsg($("#r-msg"), "");
  });
  $("#f-room").onsubmit = (e) => {
    e.preventDefault();
    const number = $("#r-num").value.trim(), password = $("#r-pass").value, name = $("#r-name").value.trim();
    busy($("#r-submit"), async () => {
      try {
        const { room } = await api(rmode === "join" ? "/api/rooms/join" : "/api/rooms", { method: "POST", body: { number, password, name } });
        $("#r-pass").value = ""; setMsg($("#r-msg"), "");
        location.hash = "#/room/" + encodeURIComponent(room.number);
      } catch (er) { setMsg($("#r-msg"), er.message); }
    });
  };

  // ---- 聊天 ----
  function closeWs() { wantClose = true; clearInterval(pingT); if (ws) { try { ws.close(); } catch {} } ws = null; curRoom = null; }
  function openRoom(number) {
    if (curRoom === number && ws) return;
    closeWs(); wantClose = false; curRoom = number; retry = 0;
    show("v-chat");
    $("#ch-title").textContent = "房间 " + number;
    $("#ch-msgs").innerHTML = "";
    connect();
  }
  function status(t, bad) { const s = $("#ch-status"); s.textContent = t; s.classList.toggle("bad", !!bad); }
  function connect() {
    const room = curRoom;
    status("连接中…");
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/rooms/${encodeURIComponent(room)}/ws`);
    ws = sock;
    let opened = false;
    sock.onopen = () => { opened = true; retry = 0; status("已连接"); clearInterval(pingT); pingT = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 25000); };
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "hello") {
        $("#ch-title").innerHTML = `${esc(m.room)}<small>房间号</small>`;
        $("#ch-msgs").innerHTML = "";
        if (!m.history.length) addSys("还没有消息，打个招呼吧 👋").classList.add("hint");
        m.history.forEach(addMsg); online(m.online); scrollEnd(true);
      } else if (m.type === "msg") {
        if (m.cid) { const p = document.querySelector(`[data-cid="${m.cid}"]`); if (p) p.remove(); }
        addMsg(m.msg); scrollEnd();
      } else if (m.type === "presence") {
        online(m.online);
        if (m.joined && m.joined !== me.username) addSys(`${m.joined} 进入了房间`);
        if (m.left) addSys(`${m.left} 离开了房间`);
        scrollEnd();
      } else if (m.type === "deleted") { const el = document.querySelector(`[data-id="${m.id}"]`); if (el) el.remove(); }
      else if (m.type === "cleared") { $("#ch-msgs").innerHTML = ""; addMsg(m.msg); }
      else if (m.type === "kicked") { wantClose = true; alert(m.reason); location.hash = ""; }
      else if (m.type === "error") addSys("⚠ " + m.error);
    };
    sock.onclose = async (ev) => {
      if (ws !== sock) return;
      clearInterval(pingT);
      if (wantClose || curRoom !== room) return;
      if (!opened) {
        // 可能无权限 / 未登录：查一下
        try { me = (await api("/api/me")).user; } catch { me = null; return route(); }
        if (retry >= 1) { status("无法进入：请先在大厅用房间号和密码加入", true); return; }
      }
      retry++;
      const wait = Math.min(1000 * 2 ** retry, 15000);
      status(`连接断开，${Math.round(wait / 1000)} 秒后重连…`, true);
      setTimeout(() => { if (curRoom === room && !wantClose) connect(); }, wait);
    };
  }
  function online(list) {
    $("#ch-count").textContent = $("#ch-count2").textContent = list.length;
    $("#ch-online").innerHTML = list.map((n) => `<li><span class="dot"></span>${esc(n)}${n === me.username ? '<span class="sub">（我）</span>' : ""}</li>`).join("");
  }
  function addSys(t) { const d = document.createElement("div"); d.className = "sys"; d.textContent = t; $("#ch-msgs").appendChild(d); return d; }
  function addMsg(m) {
    $$("#ch-msgs .hint").forEach((x) => x.remove());
    if (m.kind === "system") { addSys(m.text); return; }
    const d = document.createElement("div");
    const mine = m.username === me.username;
    d.className = "bubble" + (mine ? " me" : "");
    if (m.id) d.dataset.id = m.id;
    if (m.cid) d.dataset.cid = m.cid;
    d.innerHTML = `<div class="meta">${mine ? "" : esc(m.username) + " · "}${esc(timeShort(m.ts))}</div><div class="txt"></div>`;
    d.querySelector(".txt").textContent = m.text;
    $("#ch-msgs").appendChild(d);
    return d;
  }
  function scrollEnd(force) {
    const box = $("#ch-msgs");
    if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }
  $("#f-send").onsubmit = (e) => {
    e.preventDefault();
    const inp = $("#ch-input"), text = inp.value.trim();
    if (!text) return;
    if (!ws || ws.readyState !== 1) { addSys("⚠ 未连接，消息未发送"); return; }
    const cid = Math.random().toString(36).slice(2, 10);
    ws.send(JSON.stringify({ type: "msg", text, cid }));
    const p = addMsg({ username: me.username, text, ts: Date.now(), cid }); p.classList.add("pending");
    inp.value = ""; inp.style.height = ""; scrollEnd(true);
  };
  $("#ch-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#f-send").requestSubmit(); }
  });
  $("#ch-input").addEventListener("input", (e) => { const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; });
  $("#ch-back").onclick = () => { location.hash = ""; };
  $("#ch-online-btn").onclick = () => $("#ch-side").classList.toggle("open");
  $("#ch-msgs").onclick = () => $("#ch-side").classList.remove("open");

  boot();
})();
