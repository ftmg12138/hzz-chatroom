// 房间自动关闭（文字 ChatRoom / 视频 VideoRoom 两个 DO 共用；两个仓库里内容相同）
// 规则：房间未「保留」时，在线人数（按账号去重，文字房含语音频道里的人）≤1 持续 10 分钟 → 自动关闭（同房主关闭：删除登记、踢出所有人）。
// 计时起点：房间创建时 / 人数降到 ≤1 时；人数回到 ≥2 时取消；房主关闭「保留」时重新计 10 分钟。
// 用 Durable Object 闹钟实现（不需要 cron）；最终是否删除由 Directory.autoCloseRoom 再查一次 keep 决定。
export const IDLE_MS = 10 * 60 * 1000;
// 仅测试用：Worker secret IDLE_TEST_MS（5–600 秒）只对房间号以 TEST_PREFIX 开头的房间生效，真实房间永远是 10 分钟
export const TEST_PREFIX = "zz-idle-";
export const AUTO_REASON = "房间因长时间无人已自动关闭";

export function idleMsFor(env, room) {
  const t = Number(env.IDLE_TEST_MS);
  return String(room || "").toLowerCase().startsWith(TEST_PREFIX) && t >= 5000 && t <= IDLE_MS ? t : IDLE_MS;
}

// 把自动关闭逻辑装到 DO 类上。需要：this.sql（含 kv 表）、this.env.DIRECTORY、kind、presentUids(exceptWs)、broadcast(obj)、destroy(reason, closed)
export function withIdle(Base, kind) {
  return class extends Base {
    kvGet(k) { const r = this.sql.exec("SELECT v FROM kv WHERE k=?", k).toArray()[0]; return r ? r.v : null; }
    kvSet(k, v) { if (v == null) this.sql.exec("DELETE FROM kv WHERE k=?", k); else this.sql.exec("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)", k, String(v)); }
    idleState() { const at = Number(this.kvGet("idleAt")) || null; return { keep: this.kvGet("keep") === "1", idleAt: at, idleMs: idleMsFor(this.env, this.kvGet("room")) }; }
    // 人数变化 / 设置变化后调用。force=true：重新开始计时（创建房间、关闭保留）
    async idleCheck(exceptWs = null, force = false) {
      const room = this.kvGet("room"); if (!room) return;
      const keep = this.kvGet("keep") === "1";
      const n = this.presentUids(exceptWs).size;
      let at = await this.ctx.storage.getAlarm();
      if (keep || n >= 2) { if (at) await this.ctx.storage.deleteAlarm(); at = null; }
      else if (!at || force) { at = Date.now() + idleMsFor(this.env, room); await this.ctx.storage.setAlarm(at); }
      const prev = Number(this.kvGet("idleAt")) || null;
      const prevKeep = this.kvGet("keepSent") === "1";
      if (prev !== at || prevKeep !== keep) {
        this.kvSet("idleAt", at); this.kvSet("keepSent", keep ? "1" : "0");
        this.broadcast({ type: "room-idle", keep, idleAt: at });
      }
    }
    // Worker 调用：房间创建 / 保留开关变化 / 连接时同步房间号和 keep
    async roomMeta(room, keep, force = false) {
      this.kvSet("room", room); this.kvSet("keep", keep ? "1" : "0");
      await this.idleCheck(null, force);
      return this.idleState();
    }
    async alarm() {
      const room = this.kvGet("room"); if (!room) return;
      if (this.kvGet("keep") === "1" || this.presentUids().size >= 2) { this.kvSet("idleAt", null); return this.idleCheck(); }
      const D = this.env.DIRECTORY;
      const r = await D.get(D.idFromName("main")).autoCloseRoom(room, kind, `在线不足 2 人持续 ${Math.round(idleMsFor(this.env, room) / 60000 * 10) / 10} 分钟，自动关闭`);
      if (r && r.closed) await this.destroy(AUTO_REASON, true);
      else if (r && r.keep) { this.kvSet("keep", "1"); await this.idleCheck(); }
      else if (r && r.missing) { await this.ctx.storage.deleteAlarm(); this.kvSet("room", null); }
    }
  };
}
