// Shared SEMS API client for Vercel serverless functions.
//
// Credentials priority:
//   1. Request headers X-Sems-Email / X-Sems-Password / X-Sems-Station-Id
//      (set by the browser when the user has entered their own creds)
//   2. Environment variables SEMS_EMAIL / SEMS_PASSWORD / SEMS_STATION_ID
//      (set in the Vercel dashboard for a personal deploy)
//
// Session cache is a Map keyed by email so multiple users sharing a warm
// function instance each get their own token.

const CROSS_LOGIN_URL =
  'https://www.semsportal.com/api/v1/Common/CrossLogin';
const DEFAULT_TOKEN_HEADER =
  '{"version":"v2.1.0","client":"ios","language":"en"}';
const SESSION_TTL_MS = 50 * 60 * 1000;

/** Map<email → { session, cachedAt }> */
const sessionCache = new Map();

// ── Credential resolution ──────────────────────────────────────────────────

export function resolveCredentials(req) {
  const email      = req.headers['x-sems-email']      || process.env.SEMS_EMAIL      || '';
  const password   = req.headers['x-sems-password']   || process.env.SEMS_PASSWORD   || '';
  const stationId  = req.headers['x-sems-station-id'] || process.env.SEMS_STATION_ID || '';

  if (!email || !password) {
    const err = new Error('No SEMS credentials. Open Settings and enter your details.');
    err.status = 401;
    throw err;
  }
  if (!stationId) {
    const err = new Error('No Station ID. Open Settings and enter your Station ID.');
    err.status = 401;
    throw err;
  }
  return { email, password, stationId };
}

// ── Auth ───────────────────────────────────────────────────────────────────

async function login(email, password) {
  const res = await fetch(CROSS_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Token: DEFAULT_TOKEN_HEADER,
    },
    body: JSON.stringify({ account: email, pwd: password }),
  });

  const body = await res.json().catch(() => null);
  if (!body) throw new Error('SEMS login: malformed response');
  if (!isSuccessCode(body.code)) {
    const err = new Error(body.msg || 'Login failed — check your email and password');
    err.status = 401;
    throw err;
  }

  const d = body.data;
  return {
    uid: d.uid,
    timestamp: d.timestamp,
    token: d.token,
    client: d.client,
    version: d.version,
    language: d.language,
    apiBase: body.api,
  };
}

async function getSession(email, password) {
  const cached = sessionCache.get(email);
  if (cached && Date.now() - cached.cachedAt < SESSION_TTL_MS) {
    return cached.session;
  }
  const session = await login(email, password);
  sessionCache.set(email, { session, cachedAt: Date.now() });
  return session;
}

function tokenHeader(session) {
  return JSON.stringify({
    version:   session.version,
    client:    session.client,
    language:  session.language,
    timestamp: String(session.timestamp),
    uid:       session.uid,
    token:     session.token,
  });
}

// ── Core request ───────────────────────────────────────────────────────────

async function semsPost(session, path, body) {
  const url = session.apiBase + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Token: tokenHeader(session),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('SEMS: malformed response');
  if (!isSuccessCode(data.code)) {
    const err = new Error(data.msg || 'SEMS error');
    err.code   = data.code;
    err.body   = data;
    err.status = isAuthBody(data) ? 401 : 502;
    throw err;
  }
  return data;
}

/**
 * Main entry point for API handlers.
 * Resolves credentials from the request, calls SEMS, retries once on auth expiry.
 */
export async function semsCall(req, path, body) {
  const { email, password, stationId } = resolveCredentials(req);

  let session = await getSession(email, password);
  try {
    const data = await semsPost(session, path, body);
    return { data, stationId };
  } catch (err) {
    if (isAuthErr(err)) {
      sessionCache.delete(email);
      session = await login(email, password);
      sessionCache.set(email, { session, cachedAt: Date.now() });
      const data = await semsPost(session, path, body);
      return { data, stationId };
    }
    throw err;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isSuccessCode(code) {
  return code === 0 || code === '0';
}

function isAuthBody(body) {
  if (!body) return false;
  if ([100, 101, -100, -1, '100', '101', '-100', '-1'].includes(body.code)) return true;
  const msg = String(body.msg || '').toLowerCase();
  return ['token','login','auth','expir','unauthorized','session'].some(kw => msg.includes(kw));
}

function isAuthErr(err) {
  return err.status === 401 || isAuthBody(err.body);
}

export function todayDateString() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
