// Dziennik treningów na Cloudflare: pliki aplikacji z katalogu public/, dane w bazie D1.
// API dokumentów jest takie samo jak w server/server.js (wersja z PostgreSQL), dochodzą konta użytkowników.
// Konto zakłada się w aplikacji, podając kod zaproszenia: sekret APP_PASSWORD.
import { strava } from "./strava.js";

const MAX_BODY = 1024 * 1024;
const SESSION_DAYS = 365;
const HISTORY_DAYS = 90;
const PBKDF2_ROUNDS = 20000; // darmowy plan ma ok. 10 ms procesora na zapytanie
const NAME_RE = /^[a-z0-9_-]{3,32}$/;
const enc = new TextEncoder();
let sessionKey = null;

function json(code, body, headers) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64url(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ROUNDS }, key, 256));
}

// porównanie w stałym czasie: skróty mają zawsze tę samą długość
async function sameText(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const slow = () => new Promise((r) => setTimeout(r, 1000)); // spowalnia zgadywanie haseł

// klucz do podpisywania sesji: losowy, tworzony przy pierwszym użyciu i trzymany w bazie
async function getSessionKey(env) {
  if (sessionKey) return sessionKey;
  const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('session_key', ?)").bind(fresh).run();
  sessionKey = (await env.DB.prepare("SELECT v FROM settings WHERE k = 'session_key'").first()).v;
  return sessionKey;
}

// sesja: "<login>.<wygaśnięcie>.<podpis>"
async function newSession(env, name) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return name + "." + exp + "." + (await hmac(await getSessionKey(env), name + ":" + exp));
}

async function sessionUser(req, env) {
  const m = /(?:^|;\s*)s=([a-z0-9_-]+)\.(\d+)\.([\w-]+)/.exec(req.headers.get("Cookie") || "");
  if (!m || +m[2] < Date.now()) return null;
  return (await sameText(m[3], await hmac(await getSessionKey(env), m[1] + ":" + m[2]))) ? m[1] : null;
}

function cookie(value, maxAge) {
  return `s=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function readJson(req) {
  const t = await req.text();
  if (t.length > MAX_BODY) throw new Error("too large");
  return JSON.parse(t);
}

async function loggedIn(env, name) {
  return json(200, { ok: true, user: name }, { "Set-Cookie": cookie(await newSession(env, name), SESSION_DAYS * 86400) });
}

async function register(req, env) {
  let b;
  try { b = await readJson(req); } catch (e) { return json(400, { error: "bad json" }); }
  const name = String(b.user || "").trim().toLowerCase(), password = String(b.password || "");
  if (!env.APP_PASSWORD || !(await sameText(String(b.code || ""), env.APP_PASSWORD))) { await slow(); return json(403, { error: "bad code" }); }
  if (!NAME_RE.test(name)) return json(400, { error: "bad user" });
  if (password.length < 8) return json(400, { error: "short password" });
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const r = await env.DB.prepare("INSERT OR IGNORE INTO users (name, salt, hash) VALUES (?, ?, ?)").bind(name, salt, await pbkdf2(password, salt)).run();
  if (!r.meta.changes) return json(409, { error: "user exists" });
  return loggedIn(env, name);
}

async function login(req, env) {
  let b;
  try { b = await readJson(req); } catch (e) { return json(400, { error: "bad json" }); }
  const name = String(b.user || "").trim().toLowerCase();
  const u = NAME_RE.test(name) ? await env.DB.prepare("SELECT salt, hash FROM users WHERE name = ?").bind(name).first() : null;
  // przy nieznanym loginie też liczymy skrót, żeby czas odpowiedzi nie zdradzał, które konta istnieją
  const hash = await pbkdf2(String(b.password || ""), u ? u.salt : "x");
  if (!u || !(await sameText(hash, u.hash))) { await slow(); return json(401, { error: "bad login" }); }
  return loggedIn(env, name);
}

async function api(req, env, p) {
  if (p === "/api/register" && req.method === "POST") return register(req, env);
  if (p === "/api/login" && req.method === "POST") return login(req, env);
  if (p === "/api/logout" && req.method === "POST") return json(204, null, { "Set-Cookie": cookie("", 0) });

  const user = await sessionUser(req, env);
  if (!user) return json(401, { error: "login required" });

  if (p === "/api/health") return json(200, { ok: true, user, acct: true, strava: !!(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET) });
  if (p.startsWith("/api/strava/")) return strava(req, env, user, p, async (msg) => hmac(await getSessionKey(env), msg));

  const m = /^\/api\/docs\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (!m) return json(404, { error: "not found" });
  const id = m[1];
  if (req.method === "GET") {
    const row = await env.DB.prepare("SELECT data FROM docs WHERE user_id = ? AND doc_id = ?").bind(user, id).first();
    return row ? new Response(row.data, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }) : json(404, { error: "not found" });
  }
  if (req.method === "PUT") {
    let data;
    try { data = await readJson(req); } catch (e) { return json(400, { error: "bad json" }); }
    if (!data || typeof data !== "object") return json(400, { error: "bad json" });
    await env.DB.prepare(
      `INSERT INTO docs (user_id, doc_id, data, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, doc_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(user, id, JSON.stringify(data)).run();
    return json(204, null);
  }
  return json(405, { error: "method not allowed" });
}

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, p);
    } catch (e) {
      console.error(e);
      return json(500, { error: "server error" });
    }
  },
  // raz dziennie usuwa stare wersje dokumentów
  async scheduled(event, env) {
    await env.DB.prepare("DELETE FROM docs_history WHERE replaced_at < datetime('now', ?)").bind(`-${HISTORY_DAYS} days`).run();
  },
};
