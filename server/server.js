// Serwer dziennika treningów: serwuje aplikację (public/) i zapisuje dane w PostgreSQL.
// Dane trzymane są jako dokumenty JSON (meta + miesięczne shardy serii), tak jak w synchronizacji z kontem Claude.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = +process.env.PORT || 8080;
const USER = process.env.APP_USER || "default";
const PUB = path.join(__dirname, "public");
const MAX_BODY = 5 * 1024 * 1024;
const HISTORY_DAYS = +process.env.HISTORY_DAYS || 90;

const pool = new Pool(); // PGHOST, PGUSER, PGPASSWORD, PGDATABASE ze zmiennych środowiskowych

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png", ".json": "application/json" };

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      user_id    text        NOT NULL,
      doc_id     text        NOT NULL,
      data       jsonb       NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, doc_id)
    );
    -- poprzednie wersje dokumentów: zabezpieczenie przed nadpisaniem danych pustym stanem
    CREATE TABLE IF NOT EXISTS docs_history (
      id          bigserial   PRIMARY KEY,
      user_id     text        NOT NULL,
      doc_id      text        NOT NULL,
      data        jsonb       NOT NULL,
      replaced_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS docs_history_doc ON docs_history (user_id, doc_id, replaced_at DESC);
    CREATE OR REPLACE FUNCTION docs_keep_old() RETURNS trigger AS $$
    BEGIN
      INSERT INTO docs_history (user_id, doc_id, data) VALUES (OLD.user_id, OLD.doc_id, OLD.data);
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    CREATE OR REPLACE TRIGGER docs_keep_old BEFORE UPDATE ON docs
      FOR EACH ROW WHEN (OLD.data IS DISTINCT FROM NEW.data) EXECUTE FUNCTION docs_keep_old();
  `);
  await pool.query("DELETE FROM docs_history WHERE replaced_at < now() - make_interval(days => $1)", [HISTORY_DAYS]);
}

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let n = 0, parts = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { fail(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", fail);
  });
}

async function api(req, res, p) {
  if (p === "/api/health") {
    await pool.query("SELECT 1");
    return send(res, 200, { ok: true, user: USER });
  }
  const m = /^\/api\/docs\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (!m) return send(res, 404, { error: "not found" });
  const id = m[1];
  if (req.method === "GET") {
    const r = await pool.query("SELECT data FROM docs WHERE user_id = $1 AND doc_id = $2", [USER, id]);
    return r.rows.length ? send(res, 200, r.rows[0].data) : send(res, 404, { error: "not found" });
  }
  if (req.method === "PUT") {
    let data;
    try { data = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: "bad json" }); }
    if (!data || typeof data !== "object") return send(res, 400, { error: "bad json" });
    await pool.query(
      `INSERT INTO docs (user_id, doc_id, data) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, doc_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [USER, id, data]
    );
    return send(res, 204, "");
  }
  return send(res, 405, { error: "method not allowed" });
}

function file(req, res, p) {
  if (p === "/") p = "/index.html";
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB + path.sep)) return send(res, 404, "Nie znaleziono", "text/plain; charset=utf-8");
  fs.readFile(f, (err, buf) => {
    if (err) return send(res, 404, "Nie znaleziono", "text/plain; charset=utf-8");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    if (p.startsWith("/api/")) await api(req, res, p);
    else if (req.method === "GET" || req.method === "HEAD") file(req, res, p);
    else send(res, 405, { error: "method not allowed" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
}).listen(PORT, async () => {
  for (let i = 1; ; i++) {
    try { await migrate(); break; } catch (e) {
      if (i >= 30) { console.error("Brak połączenia z bazą:", e.message); process.exit(1); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.log("Dziennik treningów działa na porcie " + PORT);
});
