// SIMOPS Radar API: voluntary sign-ups and feedback, stored in Cloudflare D1.
// Bindings: DB (D1). Optional var SALT (any random string) for hashing IPs.

const ORIGINS = [
  "https://simopsradar.com", "https://www.simopsradar.com",
  "https://pushpingeo.github.io", "http://localhost:8765",
];
const MAX_PER_DAY = 30;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

async function overLimit(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.SALT || "simops") + ip));
  const who = [...new Uint8Array(bytes)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM hits WHERE day < ?").bind(day).run();
  const row = await env.DB.prepare(
    "INSERT INTO hits (who, day, n) VALUES (?, ?, 1) ON CONFLICT(who, day) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(who, day).first();
  return row.n > MAX_PER_DAY;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ ok: false, error: "Not found" }, 404, origin);
    if (!ORIGINS.includes(origin)) return json({ ok: false, error: "Not allowed" }, 403, origin);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: "Bad request" }, 400, origin); }
    if (body.website) return json({ ok: true }, 200, origin); // honeypot: bots fill every field
    if (await overLimit(env, request)) return json({ ok: false, error: "Too many requests today. Try again tomorrow." }, 429, origin);

    const now = new Date().toISOString();
    const email = clip(body.email, 254).toLowerCase();

    if (pathname === "/signup") {
      if (!EMAIL.test(email)) return json({ ok: false, error: "That doesn't look like an email address." }, 400, origin);
      if (body.consent !== true) return json({ ok: false, error: "Please tick the box to agree." }, 400, origin);
      await env.DB.prepare(
        `INSERT INTO signups (email, operator, watching, settings, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(email) DO UPDATE SET operator = ?2, watching = ?3, settings = ?4, updated = ?5`
      ).bind(email, clip(body.operator, 120), clip(body.watching, 40), clip(body.settings, 2000), now).run();
      return json({ ok: true }, 200, origin);
    }

    if (pathname === "/remove") {
      if (!EMAIL.test(email)) return json({ ok: false, error: "That doesn't look like an email address." }, 400, origin);
      await env.DB.prepare("DELETE FROM signups WHERE email = ?").bind(email).run();
      await env.DB.prepare("UPDATE feedback SET email = NULL WHERE email = ?").bind(email).run();
      return json({ ok: true }, 200, origin); // same answer whether or not it was there
    }

    if (pathname === "/feedback") {
      const text = clip(body.text, 20000);
      if (!text) return json({ ok: false, error: "Nothing to send." }, 400, origin);
      if (email && !EMAIL.test(email)) return json({ ok: false, error: "That doesn't look like an email address." }, 400, origin);
      await env.DB.prepare("INSERT INTO feedback (created, email, body) VALUES (?, ?, ?)").bind(now, email || null, text).run();
      return json({ ok: true }, 200, origin);
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  },
};
