// Shared SEMS API client for the Vercel serverless functions.
//
// Module-level session cache survives across requests while the function is
// warm; cold starts trigger a fresh login. Credentials live in env vars and
// never leave the server.
//
// Mirrors the auth + token-refresh logic from the Flutter SemsApi.

const CROSS_LOGIN_URL =
  'https://www.semsportal.com/api/v1/Common/CrossLogin';
const DEFAULT_TOKEN_HEADER =
  '{"version":"v2.1.0","client":"ios","language":"en"}';
const SESSION_TTL_MS = 50 * 60 * 1000; // refresh well before SEMS expires the token

let cachedSession = null;
let cachedAt = 0;

function env(name) {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

async function login() {
  const account = env('SEMS_EMAIL');
  const pwd = env('SEMS_PASSWORD');

  const res = await fetch(CROSS_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Token: DEFAULT_TOKEN_HEADER,
    },
    body: JSON.stringify({ account, pwd }),
  });

  const body = await res.json().catch(() => null);
  if (!body) throw new Error('SEMS login: malformed response');
  if (!isSuccessCode(body.code)) {
    throw new Error(`SEMS login failed: ${body.msg || 'unknown error'}`);
  }

  const data = body.data;
  const session = {
    uid: data.uid,
    timestamp: data.timestamp,
    token: data.token,
    client: data.client,
    version: data.version,
    language: data.language,
    apiBase: body.api,
  };
  cachedSession = session;
  cachedAt = Date.now();
  return session;
}

function tokenHeader(session) {
  return JSON.stringify({
    version: session.version,
    client: session.client,
    language: session.language,
    timestamp: String(session.timestamp),
    uid: session.uid,
    token: session.token,
  });
}

async function getSession() {
  if (cachedSession && Date.now() - cachedAt < SESSION_TTL_MS) {
    return cachedSession;
  }
  return login();
}

function isSuccessCode(code) {
  return code === 0 || code === '0';
}

function isAuthError(body) {
  if (!body) return false;
  const code = body.code;
  if ([100, 101, -100, -1].includes(code)) return true;
  if (['100', '101', '-100', '-1'].includes(code)) return true;
  const msg = String(body.msg || '').toLowerCase();
  return ['token', 'login', 'auth', 'expir', 'unauthorized', 'session'].some(
    (kw) => msg.includes(kw),
  );
}

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
  if (!data) {
    const err = new Error('SEMS: malformed response');
    err.body = null;
    throw err;
  }
  if (!isSuccessCode(data.code)) {
    const err = new Error(data.msg || 'SEMS error');
    err.code = data.code;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * Call SEMS with automatic session refresh on auth-expiry.
 * Retries once after a fresh login if the cached token has expired.
 */
export async function semsCall(path, body) {
  let session = await getSession();
  try {
    return await semsPost(session, path, body);
  } catch (err) {
    if (isAuthError(err.body)) {
      // Token expired — invalidate, re-login, retry once
      cachedSession = null;
      session = await login();
      return semsPost(session, path, body);
    }
    throw err;
  }
}

export function getStationId() {
  return env('SEMS_STATION_ID');
}

export function todayDateString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
