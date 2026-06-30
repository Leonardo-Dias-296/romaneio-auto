// api/lib/bling.js — Bling API v3 helpers (OAuth 2.0 + encrypted token storage)
import crypto from "crypto";

const BLING_BASE = "https://api.bling.com.br/Api/v3";
const BLING_AUTH = "https://www.bling.com.br/Api/v3/oauth";

export function getBlingClientId() {
  return process.env.BLING_CLIENT_ID || "";
}

export function getBlingClientSecret() {
  return process.env.BLING_CLIENT_SECRET || "";
}

export function getBlingRedirectUri() {
  // Usa sempre a URL fixa — nunca confia em headers do request
  const base = process.env.FRONTEND_URL || "https://romaneio-auto.vercel.app";
  return `${base.replace(/\/$/, "")}/api/bling?action=callback`;
}

// ── Token storage via Supabase (encrypted) ──────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

function getEncryptKey() {
  const k = process.env.BLING_ENCRYPT_KEY || process.env.JWT_SECRET || "";
  return k.length >= 32 ? k.slice(0, 32) : null;
}

function encrypt(text) {
  const key = getEncryptKey();
  if (!key || !text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  return `${iv.toString("hex")}:${enc}`;
}

function decrypt(text) {
  const key = getEncryptKey();
  if (!key || !text || !text.includes(":")) return text;
  try {
    const [ivHex, enc] = text.split(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key, "utf8"), Buffer.from(ivHex, "hex"));
    let dec = decipher.update(enc, "hex", "utf8");
    dec += decipher.final("utf8");
    return dec;
  } catch {
    return text;
  }
}

async function supabaseRequest(path, method = "GET", body = null) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase não configurado");
  const opts = {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : undefined,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/bling_tokens${path}`, opts);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Supabase error: ${t}`);
  }
  return r.json();
}

export async function getToken() {
  const rows = await supabaseRequest("?select=access_token,refresh_token,expires_at&key=eq.default&limit=1");
  const row = rows[0] || null;
  if (row) {
    row.access_token = decrypt(row.access_token);
    row.refresh_token = decrypt(row.refresh_token);
  }
  return row;
}

export async function saveToken(accessToken, refreshToken, expiresAt) {
  const encAccess = encrypt(accessToken);
  const encRefresh = encrypt(refreshToken);
  const existing = await getToken();
  if (existing) {
    await supabaseRequest("?key=eq.default", "PATCH", {
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
    });
  } else {
    await supabaseRequest("", "POST", {
      key: "default",
      access_token: encAccess,
      refresh_token: encRefresh,
      expires_at: expiresAt,
    });
  }
}

export async function deleteToken() {
  await supabaseRequest("?key=eq.default", "DELETE");
}

// ── Exchange authorization code for tokens ──────────────────────
export async function exchangeCodeForTokens(code, req) {
  const creds = Buffer.from(`${getBlingClientId()}:${getBlingClientSecret()}`).toString("base64");
  const r = await fetch(`${BLING_AUTH}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
      Accept: "1.0",
      "enable-jwt": "1",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
    }).toString(),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Erro ao obter token: ${err}`);
  }
  const data = await r.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await saveToken(data.access_token, data.refresh_token, expiresAt);
  return data;
}

// ── Refresh access token ───────────────────────────────────────
export async function refreshAccessToken(refreshToken) {
  const creds = Buffer.from(`${getBlingClientId()}:${getBlingClientSecret()}`).toString("base64");
  const r = await fetch(`${BLING_AUTH}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
      Accept: "1.0",
      "enable-jwt": "1",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Erro ao renovar token: ${err}`);
  }
  const data = await r.json();
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await saveToken(data.access_token, data.refresh_token || refreshToken, expiresAt);
  return data;
}

// ── Get valid access token (refresh if needed) ─────────────────
export async function getValidToken() {
  const token = await getToken();
  if (!token) return null;

  // Refresh if expired (with 5 min buffer)
  if (Date.now() > token.expires_at - 300000) {
    try {
      const refreshed = await refreshAccessToken(token.refresh_token);
      return refreshed.access_token;
    } catch {
      return null;
    }
  }
  return token.access_token;
}

// ── Call Bling API with retry + timeout ────────────────────────
const BLING_TIMEOUT = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

async function blingFetch(endpoint, accessToken) {
  const r = await fetch(`${BLING_BASE}${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "enable-jwt": "1",
      Accept: "1.0",
    },
    signal: AbortSignal.timeout(BLING_TIMEOUT),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Bling API error (${r.status}): ${err}`);
  }
  return r.json();
}

export async function blingGet(endpoint, accessToken) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await blingFetch(endpoint, accessToken);
    } catch (err) {
      lastError = err;
      const status = err.message?.match(/\((\d+)\)/)?.[1];
      const retryable = !status || status === "429" || status === "500" || status === "502" || status === "503";
      if (!retryable || attempt === MAX_RETRIES - 1) throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw lastError;
}
