// 密码哈希：PBKDF2-SHA256 + 每用户随机盐（WebCrypto；Workers 上限 100000 次迭代）
export const PBKDF2_ITER = 100000;
const enc = new TextEncoder();

export function b64(buf) {
  let s = ""; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
export function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
export function randomB64(n = 16) { return b64(crypto.getRandomValues(new Uint8Array(n))); }
export function randomToken(n = 32) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function hashPassword(password, saltB64 = randomB64(16), iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, key, 256);
  return { hash: b64(bits), salt: saltB64, iter };
}
export async function verifyPassword(password, hash, salt, iter) {
  const h = await hashPassword(password, salt, iter);
  const a = unb64(h.hash), b = unb64(hash);
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
