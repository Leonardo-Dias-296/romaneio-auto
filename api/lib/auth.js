import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const JWT_EXPIRY_MS = 24 * 60 * 60 * 1000;

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET não configurado");
  if (s.length < 32) throw new Error("JWT_SECRET deve ter pelo menos 32 caracteres");
  return s;
}

// ── JWT ────────────────────────────────────────────────────────
export function gerarToken(payload) {
  const secret = getSecret();
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Date.now();
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + JWT_EXPIRY_MS })).toString("base64url");
  const assinatura = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${assinatura}`;
}

export function verificarToken(token) {
  try {
    const [header, body, assinatura] = token.split(".");
    if (!header || !body || !assinatura) return null;

    const secret = getSecret();
    const esperada = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada))) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Rate limiting (sliding window, in-memory, por IP) ───────────
const rateLimitStore = new Map();
const RATE_LIMIT_MAX_ENTRIES = 10000;

export function checkRateLimit(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();

  // Proteção contra abuso de memória — limita entries
  if (rateLimitStore.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldest = rateLimitStore.keys().next().value;
    rateLimitStore.delete(oldest);
  }

  const entry = rateLimitStore.get(key);
  if (!entry || now - entry.start > windowMs) {
    rateLimitStore.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > maxRequests) return false;
  return true;
}

// ── CORS + Security headers ─────────────────────────────────────
export function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = process.env.FRONTEND_URL || "https://romaneio-auto.vercel.app";
  // Apenas permite origens exatas
  const isDev = process.env.NODE_ENV !== "production";
  const isAllowed = origin === allowed || (isDev && (origin === "http://localhost:3000" || origin === "http://localhost:5173"));
  res.setHeader("Access-Control-Allow-Origin", isAllowed ? origin : allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

// ── Supabase helpers ───────────────────────────────────────────
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

export async function autenticar(email, senha) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senha }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.access_token) return null;
    const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
    return { email: data.user?.email || email, nome: data.user?.user_metadata?.nome || email, role: isAdmin ? "admin" : "user" };
  } catch {
    return null;
  }
}

export { SUPABASE_URL, SUPABASE_KEY };

export function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}
