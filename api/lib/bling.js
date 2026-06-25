// api/lib/bling.js — Bling API v3 helpers (OAuth 2.0 + JWT)

const BLING_BASE = "https://api.bling.com.br/Api/v3";
const BLING_AUTH = "https://www.bling.com.br/Api/v3/oauth";

export function getBlingClientId() {
  return process.env.BLING_CLIENT_ID || "";
}

export function getBlingClientSecret() {
  return process.env.BLING_CLIENT_SECRET || "";
}

export function getBlingRedirectUri(req) {
  const origin = req.headers.origin || req.headers.referer || "https://romaneio-auto.vercel.app";
  return `${origin.replace(/\/$/, "")}/api/bling?action=callback`;
}

// ── Token storage via Supabase ─────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

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
  return rows[0] || null;
}

export async function saveToken(accessToken, refreshToken, expiresAt) {
  // Try upsert
  const existing = await getToken();
  if (existing) {
    await supabaseRequest("?key=eq.default", "PATCH", {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
    });
  } else {
    await supabaseRequest("", "POST", {
      key: "default",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
    });
  }
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

// ── Call Bling API ─────────────────────────────────────────────
export async function blingGet(endpoint, accessToken) {
  const r = await fetch(`${BLING_BASE}${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "enable-jwt": "1",
      Accept: "1.0",
    },
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Bling API error (${r.status}): ${err}`);
  }
  return r.json();
}
