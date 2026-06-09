// Cloudflare Pages Function: POST /api/subscribe
//
// Collects iOS waitlist signups from the landing-page modal (Linear T1-616)
// into the D1 `signups` table bound as `env.DB` (see wrangler.toml).
// Same-origin, so no CORS or API keys are involved.

const ALLOWED_SOURCES = new Set(["header", "hero", "download_cta"]);

// Pragmatic email check — good enough to reject obvious junk without
// fighting the RFC. Real validation is "we sent it and it bounced".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Read the request body as an object, accepting JSON or form posts. */
async function readPayload(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    return await request.json();
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  let data;
  try {
    data = await readPayload(request);
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }

  // Honeypot: a hidden field real users never fill. If it's populated,
  // silently accept so bots get no signal, but store nothing. The field is
  // named `hp_url` rather than an autofill token (e.g. "company") so browser
  // / password-manager autofill can't trip it and drop a real signup.
  if (data.hp_url) return json({ ok: true });

  const email = String(data.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ ok: false, error: "Please enter a valid email address." }, 400);
  }
  // Accept only an explicit affirmative — a form post of `consent=false`
  // would otherwise be a truthy string and record consent that wasn't given.
  const consentGiven =
    data.consent === true || ["true", "on", "1"].includes(String(data.consent));
  if (!consentGiven) {
    return json({ ok: false, error: "Please agree to be notified." }, 400);
  }

  const source = ALLOWED_SOURCES.has(data.source) ? data.source : null;

  try {
    // INSERT OR IGNORE makes a repeat email a no-op instead of an error,
    // which we surface to the user as success ("you're on the list").
    await env.DB.prepare(
      "INSERT OR IGNORE INTO signups (email, consent, source) VALUES (?, 1, ?)"
    )
      .bind(email, source)
      .run();
  } catch (err) {
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }

  return json({ ok: true });
}
