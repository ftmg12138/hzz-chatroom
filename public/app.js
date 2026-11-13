(() => {
  let me = null, mode = "login", rmode = "join", ws = null, curRoom = null, retry = 0, pingT = null, wantClose = false;
  const views = ["v-auth", "v-chpw", "v-lobby", "v-chat"];
  const show = (id) => views.forEach((v) => $("#" + v).classList.toggle("hidden", v !== id));

  async function boot() {
    try { me = (await api("/api/me")).user; } catch { me = null; }
    route();
  }
  function route() {
    if (me) avSet(me.username, me.avatar);
    window.__me = me;
    if (!me) { closeWs(); show("v-auth"); return; }
    syncSkin(me);
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
    if (mode === "register") api("/api/reg-config").then((d) => $("#code-wrap").classList.toggle("hidden", !d.codeRequired)).catch(() => {});
  });
  $("#f-auth").onsubmit = (e) => {
    e.preventDefault();
    const username = $("#a-user").value.trim(), password = $("#a-pass").value;
    if (mode === "register" && password !== $("#a-pass2").value) return setMsg($("#a-msg"), "两次输入的密码不一致");
    busy($("#a-submit"), async () => {
      try {
        const code = $("#code-wrap").classList.contains("hidden") ? undefined : $("#a-code").value.trim();
        me = (await api("/api/" + mode, { method: "POST", body: { username, password, code } })).user;
        $("#a-pass").value = $("#a-pass2").value = "";
        const isNew = mode === "register";
        route();
        if (isNew && me && !me.mustChange) { const u = await openAvatarPicker(me, { welcome: true }); if (u) { me = u; route(); } }
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
  let pubTimer = null;
  let myList = [], pubList = [];
  function lobbyStats() {
    const online = new Map(); pubList.forEach((r) => online.set(r.number, r.online || 0));
    $("#st-online").textContent = [...online.values()].reduce((a, b) => a + b, 0);
    $("#st-my").textContent = myList.length; $("#st-pub").textContent = pubList.length;
    $("#st-own").textContent = myList.filter((r) => r.creator_name === me.username).length;
    $("#l-feed").innerHTML = Lobby.feed(myList, pubList);
  }
  async function lobby() {
    $("#l-name").textContent = me.username;
    $("#l-av").innerHTML = `<button class="av-me" id="l-avbtn" type="button" title="设置头像">${avatar(me.username)}</button>`;
    $("#l-avbtn").onclick = pickAvatar;
    $("#l-admin").classList.toggle("hidden", !me.isAdmin);
    const box = $("#l-rooms");
    try {
      const { rooms } = await api("/api/rooms");
      const pubOnline = new Map(pubList.map((r) => [r.number, r]));
      myList = rooms.map((r) => ({ ...r, ...(pubOnline.has(r.number) ? { online: pubOnline.get(r.number).online, members: pubOnline.get(r.number).members } : {}) }));
      $("#l-rooms-n").textContent = rooms.length;
      box.innerHTML = rooms.length ? Lobby.cards(myList, "my") : `<div class="empty">还没有房间。创建一个，或用房间号和密码加入 ✨</div>`;
      $$("[data-leave]", box).forEach((b) => b.onclick = async () => {
        if (!confirm("从列表移除该房间？之后再进需要重新输入房间密码或重新申请。")) return;
        await api("/api/rooms/leave", { method: "POST", body: { number: b.dataset.leave } }); lobby();
      });
      Lobby.search(); lobbyStats();
    } catch (er) { if (er.status === 401) { me = null; route(); return; } }
    publicRooms();
  }
  async function pickAvatar() { const u = await openAvatarPicker(me); if (u) { me = u; lobby(); } }
  $("#l-avatar").onclick = pickAvatar;
  async function publicRooms() {
    clearTimeout(pubTimer);
    if ($("#v-lobby").classList.contains("hidden")) return;
    try {
      const { rooms } = await api("/api/rooms/public");
      pubList = rooms;
      $("#l-pub-n").textContent = rooms.length;
      $("#l-pub").innerHTML = rooms.length ? Lobby.cards(rooms, "pub") : `<div class="empty">还没有公开房间。创建房间时选「公开」，就会出现在这里。</div>`;
      $$("[data-req]").forEach((b) => b.onclick = () => busy(b, async () => {
        try { const d = await api("/api/rooms/request", { method: "POST", body: { number: b.dataset.req } }); if (d.member) location.hash = "#/room/" + encodeURIComponent(b.dataset.req); else { toast("已发送申请，房主同意后即可进入"); publicRooms(); } }
        catch (er) { toast(er.message); }
      }));
      // 把在线人数补到「我的房间」卡片上
      const m = new Map(rooms.map((r) => [r.number, r]));
      if (myList.some((r) => m.has(r.number) && r.online !== m.get(r.number).online)) {
        myList = myList.map((r) => (m.has(r.number) ? { ...r, online: m.get(r.number).online, members: m.get(r.number).members } : r));
        $("#l-rooms").innerHTML = Lobby.cards(myList, "my");
        $$("[data-leave]", $("#l-rooms")).forEach((b) => b.onclick = async () => {
          if (!confirm("从列表移除该房间？之后再进需要重新输入房间密码或重新申请。")) return;
          await api("/api/rooms/leave", { method: "POST", body: { number: b.dataset.leave } }); lobby();
        });
      }
      Lobby.search(); lobbyStats();
      // 有待处理申请时定时刷新，被同意后自动出现在「我的房间」
      if (rooms.some((r) => r.pending)) pubTimer = setTimeout(() => { if (!$("#v-lobby").classList.contains("hidden")) lobby(); }, 5000);
    } catch {}
  }
  $$("[data-rtab]").forEach((b) => b.onclick = () => {
    rmode = b.dataset.rtab;
    $$("[data-rtab]").forEach((x) => x.classList.toggle("on", x === b));
    $("#r-create-extra").classList.toggle("hidden", rmode !== "create");
    $("#r-vis-wrap").classList.toggle("hidden", rmode !== "create");
    $("#r-submit").textContent = rmode === "join" ? "加入" : "创建并进入";
    visHint(); setMsg($("#r-msg"), "");
  });
  const vis = () => (document.querySelector('input[name="r-vis"]:checked') || {}).value || "private";
  function visHint() {
    const pub = rmode === "create" && vis() === "public";
    $("#r-pass-label").textContent = pub ? "房间密码（可选）" : "房间密码";
    $("#r-pass").placeholder = pub ? "留空则只能申请加入；设置后也可凭密码直接进" : "4–64 位";
  }
  $$('input[name="r-vis"]').forEach((x) => x.onchange = visHint);
  $("#f-room").onsubmit = (e) => {
    e.preventDefault();
    const number = $("#r-num").value.trim(), password = $("#r-pass").value, name = $("#r-name").value.trim();
    busy($("#r-submit"), async () => {
      try {
        const { room } = await api(rmode === "join" ? "/api/rooms/join" : "/api/rooms", { method: "POST", body: { number, password, name, visibility: vis() } });
        $("#r-pass").value = ""; setMsg($("#r-msg"), "");
        location.hash = "#/room/" + encodeURIComponent(room.number);
      } catch (er) { setMsg($("#r-msg"), er.message); }
    });
  };

  // ---- 聊天 ----
  function closeWs() { $("#rq-panel").classList.add("hidden"); voiceStop(); $("#vc-bar").classList.remove("open"); wantClose = true; clearInterval(pingT); if (ws) { try { ws.close(); } catch {} } ws = null; curRoom = null; }
  function openRoom(number) {
    if (curRoom === number && ws) return;
    closeWs(); wantClose = false; curRoom = number; retry = 0; closingSelf = false; isOwner = false; canManage = false; idleSt = {}; roomIdleUI({}, false); $("#close-room-btn").classList.add("hidden");
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
        $("#ch-title").innerHTML = `${esc(m.name || m.room)}<small>${m.visibility === "public" ? "🌿 公开" : "🔒 私密"} · ${esc(m.room)}</small>`;
        isOwner = !!m.isOwner; $("#rq-btn").classList.toggle("hidden", !isOwner); $("#close-room-btn").classList.toggle("hidden", !isOwner); if (isOwner) loadRequests();
        canManage = isOwner || !!m.isAdmin; idleSt = { keep: m.keep, idleAt: m.idleAt, idleMs: m.idleMs }; roomIdleUI(idleSt, canManage);
        $("#ch-msgs").innerHTML = "";
        if (!m.history.length) addSys("还没有消息，打个招呼吧 👋").classList.add("hint");
        m.history.forEach(addMsg); online(m.online); scrollEnd(true);
        V.max = m.voiceMax || 8; V.list = m.voice || []; vcRender();
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
      else if (m.type === "kicked") { wantClose = true; if (m.closed) { if (!closingSelf) toast(m.reason, 5000); } else alert(m.reason); location.hash = ""; }
      else if (m.type === "room-idle") { idleSt = { ...idleSt, keep: m.keep, idleAt: m.idleAt }; roomIdleUI(idleSt, canManage); }
      else if (m.type === "error") addSys("⚠ " + m.error);
      else if (m.type === "join-request") { toast(`${m.username} 申请加入房间`); loadRequests(); }
      else if (m.type.startsWith("voice-")) onVoice(m);
    };
    sock.onclose = async (ev) => {
      if (ws !== sock) return;
      clearInterval(pingT);
      if (V.active) { voiceStop(); vcTip("连接断开，已退出语音频道"); }
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
    $("#ch-online").innerHTML = list.map((n) => `<li>${avatar(n, true)}<span>${esc(n)}</span>${n === me.username ? '<span class="sub">（我）</span>' : ""}<span class="dot"></span></li>`).join("");
  }
  function addSys(t) { const d = document.createElement("div"); d.className = "sys"; d.textContent = t; $("#ch-msgs").appendChild(d); return d; }
  function addMsg(m) {
    $$("#ch-msgs .hint").forEach((x) => x.remove());
    if (m.kind === "system") { addSys(m.text); return; }
    const d = document.createElement("div");
    const mine = m.username === me.username;
    const prev = $("#ch-msgs").lastElementChild;
    const cont = prev && prev.classList.contains("mrow") && prev.dataset.u === m.username && m.ts - Number(prev.dataset.ts) < 5 * 60e3;
    d.className = "mrow" + (mine ? " me" : "") + (cont ? " cont" : "");
    d.dataset.u = m.username; d.dataset.ts = m.ts;
    if (m.id) d.dataset.id = m.id;
    if (m.cid) d.dataset.cid = m.cid;
    d.innerHTML = `${avatar(m.username)}<div class="col">${cont ? "" : `<div class="meta">${mine ? "" : esc(m.username) + " · "}${esc(timeShort(m.ts))}</div>`}<div class="txt"></div></div>`;
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

  // ===== 房主：处理加入申请 =====
  let isOwner = false, closingSelf = false, canManage = false, idleSt = {};
  // 保留房间（房主 / 管理员）：开启后不自动关闭；取消后重新计时
  $("#keep-btn").onclick = async () => {
    if (!curRoom || !canManage) return;
    const want = !idleSt.keep;
    try {
      const d = await api("/api/rooms/keep", { method: "POST", body: { number: curRoom, keep: want } });
      idleSt = { ...idleSt, keep: d.keep, idleAt: d.idleAt, idleMs: d.idleMs || idleSt.idleMs }; roomIdleUI(idleSt, canManage);
      toast(want ? "已保留房间，不会自动关闭" : `已取消保留：在线不足 2 人持续 ${Math.round((idleSt.idleMs || 600000) / 60000)} 分钟会自动关闭`);
    } catch (er) { toast(er.message); }
  };
  async function loadRequests() {
    if (!isOwner || !curRoom) return;
    try {
      const { rows } = await api("/api/rooms/requests?number=" + encodeURIComponent(curRoom));
      const n = $("#rq-n"); n.textContent = rows.length; n.classList.toggle("hidden", !rows.length);
      $("#rq-list").innerHTML = rows.length ? rows.map((r) => `<li><div class="row">${avatar(r.username, true)}<div><b>${esc(r.username)}</b><div class="sub">${esc(timeShort(r.created_at))} 申请</div></div></div>
        <div class="row nogrow"><button class="btn ok sm" data-ok="${r.id}">同意</button><button class="btn ghost sm" data-no="${r.id}">拒绝</button></div></li>`).join("") : `<li class="empty">暂时没有新的申请</li>`;
    } catch {}
  }
  // 房主关闭房间：确认后调用 /api/rooms/close，服务器会把房间里所有人（包括自己）踢回大厅
  $("#close-room-btn").onclick = async () => {
    const n = curRoom; if (!n || !isOwner) return;
    const yes = await confirmDialog({ title: "关闭房间？", text: `房间「${n}」会被删除，房间里的所有人会被移出并回到大厅，聊天记录一并清除，此操作不能撤销。`, ok: "关闭房间" });
    if (!yes) return;
    closingSelf = true;
    try { await api("/api/rooms/close", { method: "POST", body: { number: n } }); toast("房间已关闭"); location.hash = ""; }
    catch (er) { closingSelf = false; toast(er.message); }
  };
  $("#rq-btn").onclick = () => { $("#rq-panel").classList.toggle("hidden"); loadRequests(); };
  $("#rq-close").onclick = () => $("#rq-panel").classList.add("hidden");
  $("#rq-list").onclick = async (e) => {
    const b = e.target.closest("[data-ok],[data-no]"); if (!b) return;
    try { const d = await api("/api/rooms/requests/decide", { method: "POST", body: { id: Number(b.dataset.ok || b.dataset.no), approve: !!b.dataset.ok } }); toast(d.status === "approved" ? `已同意 ${d.username}` : `已拒绝 ${d.username}`); }
    catch (er) { toast(er.message); }
    loadRequests();
  };

  // ===== 语音频道（音频 mesh，信令走房间 WebSocket） =====
  const V = { active: false, joining: false, sid: null, stream: null, track: null, muted: false, peers: new Map(), list: [], ice: null, ac: null, meters: new Map(), timer: null, max: 8 };
  window.__voice = V;
  const vcTip = (t) => { $("#vc-tip").textContent = t || ""; };
  const wsSend = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  function micError(er) {
    const n = er && er.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "你拒绝了麦克风权限。可点击地址栏左侧的🔒图标重新允许后再试。";
    if (n === "NotFoundError") return "没有找到麦克风。";
    if (n === "NotReadableError") return "麦克风被其他程序占用。";
    return "无法打开麦克风：" + ((er && er.message) || n || "未知错误");
  }
  async function voiceJoin() {
    if (V.active || V.joining) return;
    if (!ws || ws.readyState !== 1) return vcTip("未连接到房间");
    if (!navigator.mediaDevices?.getUserMedia) return vcTip("当前浏览器不支持语音");
    V.joining = true; vcTip("正在打开麦克风…");
    try {
      V.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (er) { V.joining = false; vcTip(micError(er)); return; }
    V.track = V.stream.getAudioTracks()[0]; V.muted = false;
    try { V.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { V.ac = null; }
    if (!V.ice) { try { V.ice = (await api("/api/ice")).iceServers; } catch { V.ice = [{ urls: "stun:stun.cloudflare.com:3478" }]; } }
    vcTip("");
    wsSend({ type: "voice-join" });
  }
  function voiceLeave() { if (V.active) wsSend({ type: "voice-leave" }); voiceStop(); vcRender(); }
  function voiceStop() {
    for (const sid of [...V.peers.keys()]) vcRemove(sid);
    if (V.stream) V.stream.getTracks().forEach((t) => t.stop());
    clearInterval(V.timer); V.timer = null; V.meters.clear();
    if (V.ac) V.ac.close().catch(() => {});
    Object.assign(V, { active: false, joining: false, sid: null, stream: null, track: null, ac: null });
    vcRender();
  }
  function onVoice(m) {
    switch (m.type) {
      case "voice-welcome":
        V.active = true; V.joining = false; V.sid = m.you;
        meter(V.sid, V.stream);
        for (const p of m.peers) vcPeer(p.sid, p.username, true);
        vcRender(); break;
      case "voice-full": voiceStop(); vcTip(m.error); break;
      case "voice-peer-join": if (V.active) vcPeer(m.sid, m.username, false); break;
      case "voice-peer-leave": vcRemove(m.sid); break;
      case "voice-update": V.list = m.voice || []; vcRender(); break;
      case "voice-signal": if (V.active) vcSignal(m.from, m.username, m.data); break;
    }
  }
  function vcPeer(sid, username, initiator) {
    if (V.peers.has(sid)) return V.peers.get(sid);
    const pc = new RTCPeerConnection({ iceServers: V.ice || [] });
    const p = { sid, username, pc, queue: [], audio: null, initiator, restarted: 0 };
    V.peers.set(sid, p);
    pc.onicecandidate = (e) => e.candidate && wsSend({ type: "voice-signal", to: sid, data: { candidate: e.candidate } });
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!p.audio) { p.audio = document.createElement("audio"); p.audio.autoplay = true; p.audio.playsInline = true; document.body.appendChild(p.audio); }
      p.audio.srcObject = stream; p.audio.play().catch(() => vcTip("浏览器阻止了自动播放，点一下页面即可听到声音"));
      meter(sid, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && p.initiator && p.restarted < 2) { p.restarted++; vcOffer(p, true); }
      vcRender();
    };
    if (initiator) { pc.addTransceiver(V.track, { direction: "sendrecv", streams: [V.stream] }); vcOffer(p, false); }
    return p;
  }
  async function vcOffer(p, iceRestart) {
    try {
      await p.pc.setLocalDescription(await p.pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
      wsSend({ type: "voice-signal", to: p.sid, data: { sdp: p.pc.localDescription } });
    } catch (e) { console.warn(e); }
  }
  async function vcSignal(from, username, d) {
    const p = V.peers.get(from) || vcPeer(from, username, false);
    try {
      if (d.sdp) {
        await p.pc.setRemoteDescription(d.sdp);
        if (d.sdp.type === "offer") {
          for (const t of p.pc.getTransceivers()) { t.direction = "sendrecv"; await t.sender.replaceTrack(V.track); }
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          wsSend({ type: "voice-signal", to: from, data: { sdp: p.pc.localDescription } });
        }
        for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      } else if (d.candidate) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.candidate).catch(() => {}); else p.queue.push(d.candidate);
      }
    } catch (e) { console.warn(e); }
  }
  function vcRemove(sid) {
    const p = V.peers.get(sid); if (!p) return;
    try { p.pc.close(); } catch {}
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    V.peers.delete(sid); V.meters.delete(sid);
  }
  // 说话指示：本地分析每路音频音量
  function meter(sid, stream) {
    if (!V.ac || !stream) return;
    try {
      const src = V.ac.createMediaStreamSource(stream);
      const an = V.ac.createAnalyser(); an.fftSize = 512; src.connect(an);
      V.meters.set(sid, { an, buf: new Uint8Array(an.fftSize) });
      if (!V.timer) V.timer = setInterval(() => {
        for (const [id, mt] of V.meters) {
          mt.an.getByteTimeDomainData(mt.buf);
          let sum = 0; for (const v of mt.buf) { const x = (v - 128) / 128; sum += x * x; }
          const speaking = Math.sqrt(sum / mt.buf.length) > 0.035 && !(id === V.sid && V.muted);
          const chip = document.querySelector(`.vc-chip[data-sid="${id}"]`);
          if (chip) chip.classList.toggle("speaking", speaking);
        }
      }, 150);
    } catch {}
  }
  function vcRender() {
    const n = V.list.length;
    $("#vc-count").textContent = n;
    $("#vc-toggle").classList.toggle("live", V.active);
    $("#vc-cap").textContent = `${n}/${V.max}`;
    $("#vc-people").innerHTML = V.list.map((v) => {
      const p = V.peers.get(v.sid), st = v.sid === V.sid ? "" : p && p.pc.connectionState !== "connected" && V.active ? '<span class="st">连接中</span>' : "";
      return `<span class="vc-chip${v.sid === V.sid ? " me" : ""}" data-sid="${esc(v.sid)}">${avatar(v.username, true)}${v.muted ? "🔇" : ""} ${esc(v.username)}${v.sid === V.sid ? "（我）" : ""}${st}</span>`;
    }).join("");
    $("#vc-join").classList.toggle("hidden", V.active);
    $("#vc-join").disabled = V.joining;
    $("#vc-join").textContent = n >= V.max && !V.active ? "语音已满" : "加入语音";
    $("#vc-mute").classList.toggle("hidden", !V.active);
    $("#vc-leave").classList.toggle("hidden", !V.active);
    $("#vc-mute").textContent = V.muted ? "🔇 取消静音" : "🎙️ 静音";
    if (V.active) $("#vc-bar").classList.add("open");
  }
  $("#vc-toggle").onclick = () => $("#vc-bar").classList.toggle("open");
  $("#vc-join").onclick = () => voiceJoin();
  $("#vc-leave").onclick = () => voiceLeave();
  $("#vc-mute").onclick = () => {
    if (!V.active) return;
    V.muted = !V.muted; if (V.track) V.track.enabled = !V.muted;
    wsSend({ type: "voice-mute", muted: V.muted }); vcRender();
  };

  boot();
})();
