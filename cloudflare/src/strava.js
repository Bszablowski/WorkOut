// Synchronizacja aktywności ze Stravy: połączenie konta (OAuth) i pobieranie listy aktywności.
// Aktywności trafiają do osobnej tabeli; aplikacja tylko je czyta, więc nie mieszają się z danymi z telefonu.
// Wymaga zmiennej STRAVA_CLIENT_ID i sekretu STRAVA_CLIENT_SECRET (z ustawień aplikacji API na strava.com).
const STRAVA = "https://www.strava.com";
const api = (env) => env.STRAVA_API || STRAVA; // STRAVA_API: atrapa Stravy w testach lokalnych
const SYNC_EVERY = 10 * 60; // s; Strava ogranicza liczbę zapytań całej aplikacji (ok. 100 na 15 minut)
const PAGE = 100;
const MAX_PAGES = 5; // na jedno wywołanie; resztę klient dociąga kolejnymi wywołaniami
const REFETCH = 7 * 86400; // ostatni tydzień pobiera ponownie, żeby złapać zmienione nazwy itp.

function json(code, body) {
  return new Response(body == null ? null : JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function compact(a) {
  return {
    id: a.id, name: a.name, type: a.sport_type || a.type, start: a.start_date_local,
    sec: a.moving_time || 0, km: a.distance ? Math.round(a.distance / 10) / 100 : 0, up: Math.round(a.total_elevation_gain || 0),
    hr: a.average_heartrate ? Math.round(a.average_heartrate) : null, w: a.average_watts ? Math.round(a.average_watts) : null,
    kj: a.kilojoules ? Math.round(a.kilojoules) : null, tr: !!a.trainer,
  };
}

async function oauth(env, params) {
  return fetch(api(env) + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...params }),
  });
}

// zwraca ważny token (odświeża przeterminowany); null, gdy konto nie jest połączone albo dostęp cofnięto
async function token(env, user) {
  const t = await env.DB.prepare("SELECT * FROM strava WHERE user_id = ?").bind(user).first();
  if (!t) return null;
  if (t.expires_at > Date.now() / 1000 + 60) return t;
  const r = await oauth(env, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  if (r.status === 400 || r.status === 401) { await forget(env, user); return null; }
  if (!r.ok) throw new Error("strava refresh " + r.status);
  const j = await r.json();
  await env.DB.prepare("UPDATE strava SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ?").bind(j.access_token, j.refresh_token, j.expires_at, user).run();
  return { ...t, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at };
}

// regulamin Stravy: po rozłączeniu dane z jej konta trzeba usunąć
async function forget(env, user) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM strava WHERE user_id = ?").bind(user),
    env.DB.prepare("DELETE FROM activities WHERE user_id = ?").bind(user),
  ]);
}

async function sync(env, user, force) {
  const t = await token(env, user);
  if (!t) return json(200, { connected: false });
  const now = Math.floor(Date.now() / 1000);
  if (!force && now - t.last_sync < SYNC_EVERY) return json(200, { connected: true, added: 0, more: false });
  const after = t.cursor ? t.cursor - REFETCH : 0;
  let cursor = t.cursor, n = 0, more = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${api(env)}/api/v3/athlete/activities?after=${after}&per_page=${PAGE}&page=${page}`, { headers: { Authorization: "Bearer " + t.access_token } });
    if (r.status === 429) return json(200, { connected: true, added: n, more: false, error: "rate" });
    if (!r.ok) throw new Error("strava activities " + r.status);
    const list = await r.json();
    if (list.length) {
      await env.DB.batch(list.map((a) => {
        const st = Math.floor(Date.parse(a.start_date) / 1000);
        if (st > cursor) cursor = st;
        return env.DB.prepare("INSERT INTO activities (user_id, id, start, data) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, id) DO UPDATE SET start = excluded.start, data = excluded.data")
          .bind(user, a.id, st, JSON.stringify(compact(a)));
      }));
      n += list.length;
    }
    if (list.length < PAGE) break;
    if (page === MAX_PAGES) more = true;
  }
  await env.DB.prepare("UPDATE strava SET last_sync = ?, cursor = ? WHERE user_id = ?").bind(now, cursor, user).run();
  return json(200, { connected: true, added: n, more });
}

export async function strava(req, env, user, p, sign) {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) return json(501, { error: "strava not configured" });
  const url = new URL(req.url);

  if (p === "/api/strava/connect") {
    const q = new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID, response_type: "code", approval_prompt: "auto", scope: "activity:read_all",
      redirect_uri: url.origin + "/api/strava/callback", state: await sign("strava:" + user),
    });
    return Response.redirect(api(env) + "/oauth/authorize?" + q, 302);
  }

  if (p === "/api/strava/callback") {
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    const scope = url.searchParams.get("scope") || "";
    if (!code || state !== (await sign("strava:" + user))) return Response.redirect(url.origin + "/?strava=err", 302);
    if (!/activity:read/.test(scope)) return Response.redirect(url.origin + "/?strava=scope", 302);
    const r = await oauth(env, { grant_type: "authorization_code", code });
    if (!r.ok) return Response.redirect(url.origin + "/?strava=err", 302);
    const j = await r.json();
    await env.DB.prepare(
      `INSERT INTO strava (user_id, athlete_id, access_token, refresh_token, expires_at, last_sync, cursor) VALUES (?, ?, ?, ?, ?, 0, 0)
       ON CONFLICT (user_id) DO UPDATE SET athlete_id = excluded.athlete_id, access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, last_sync = 0, cursor = 0`
    ).bind(user, j.athlete && j.athlete.id, j.access_token, j.refresh_token, j.expires_at).run();
    return Response.redirect(url.origin + "/?strava=ok", 302);
  }

  if (p === "/api/strava/sync" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    return sync(env, user, !!b.force);
  }

  if (p === "/api/strava/activities") {
    const t = await env.DB.prepare("SELECT 1 FROM strava WHERE user_id = ?").bind(user).first();
    const r = await env.DB.prepare("SELECT data FROM activities WHERE user_id = ? ORDER BY start").bind(user).all();
    return json(200, { connected: !!t, a: r.results.map((x) => JSON.parse(x.data)) });
  }

  if (p === "/api/strava/disconnect" && req.method === "POST") {
    const t = await token(env, user).catch(() => null);
    if (t) await fetch(api(env) + "/oauth/deauthorize", { method: "POST", headers: { Authorization: "Bearer " + t.access_token } }).catch(() => {});
    await forget(env, user);
    return json(204, null);
  }

  return json(404, { error: "not found" });
}
