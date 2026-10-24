// Dziennik treningów na Cloudflare: pliki aplikacji z katalogu public/, dane w bazie D1.
// API jest takie samo jak w server/server.js (wersja z PostgreSQL), dochodzi logowanie hasłem,
// bo aplikacja jest publicznie w internecie. Hasło ustawia się sekretem APP_PASSWORD.
const MAX_BODY = 1024 * 1024;
const SESSION_DAYS = 365;
const HISTORY_DAYS = 90;
const enc = new TextEncoder();

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

// porównanie w stałym czasie: skróty mają zawsze tę samą długość
async function sameText(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

// sesja: "<wygaśnięcie>.<podpis>"; zmiana hasła unieważnia wszystkie sesje
async function newSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return exp + "." + (await hmac(env.APP_PASSWORD, "session:" + exp));
}

async function validSession(req, env) {
  const m = /(?:^|;\s*)s=(\d+)\.([\w-]+)/.exec(req.headers.get("Cookie") || "");
  if (!m || +m[1] < Date.now()) return false;
  return sameText(m[2], await hmac(env.APP_PASSWORD, "session:" + m[1]));
}

function cookie(value, maxAge) {
  return `s=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function readJson(req) {
  const t = await req.text();
  if (t.length > MAX_BODY) throw new Error("too large");
  return JSON.parse(t);
}

async function api(req, env, p) {
  if (!env.APP_PASSWORD) return json(500, { error: "APP_PASSWORD not set" });
  const user = env.APP_USER || "default";

  if (p === "/api/login" && req.method === "POST") {
    let body;
    try { body = await readJson(req); } catch (e) { return json(400, { error: "bad json" }); }
    if (!(await sameText(String((body && body.password) || ""), env.APP_PASSWORD))) {
      await new Promise((r) => setTimeout(r, 1000)); // spowalnia zgadywanie hasła
      return json(401, { error: "bad password" });
    }
    return json(204, null, { "Set-Cookie": cookie(await newSession(env), SESSION_DAYS * 86400) });
  }
  if (p === "/api/logout" && req.method === "POST") return json(204, null, { "Set-Cookie": cookie("", 0) });

  if (!(await validSession(req, env))) return json(401, { error: "login required" });

  if (p === "/api/health") return json(200, { ok: true, user });

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
