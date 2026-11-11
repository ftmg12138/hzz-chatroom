// ICE 服务器（与 videochatroom 相同逻辑）：STUN 公共；若配置了 Cloudflare Realtime TURN 密钥（secret
// TURN_KEY_ID / TURN_KEY_API_TOKEN），在服务端签发短期 TURN 凭据。
export const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
export async function iceServers(env) {
  const list = [...STUN];
  let turn = false;
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 6 * 3600 }),
      });
      if (r.ok) {
        const d = await r.json();
        const arr = Array.isArray(d.iceServers) ? d.iceServers : d.iceServers ? [d.iceServers] : [];
        for (const s of arr) {
          const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => u.startsWith("turn") && !/:53(\?|$)/.test(u));
          if (urls.length) { list.push({ ...s, urls }); turn = true; }
        }
      }
    } catch {}
  }
  return { iceServers: list, turn };
}
