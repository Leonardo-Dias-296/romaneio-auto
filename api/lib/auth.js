import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const JWT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 horas

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET não configurado");
  return s;
}

// ── Password hashing (PBKDF2 com salt, 100k iterações) ────────
export function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(senha, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

export function verificarSenha(senha, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.pbkdf2Sync(senha, salt, 100000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
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

// ── Rate limiting (in-memory, por IP) ──────────────────────────
const rateLimitStore = new Map();

export function checkRateLimit(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now - entry.start > windowMs) {
    rateLimitStore.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > maxRequests) return false;
  return true;
}

// Limpa entries antigos a cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > 300000) rateLimitStore.delete(key);
  }
}, 300000);

// ── CORS helper ────────────────────────────────────────────────
export function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = process.env.FRONTEND_URL || "https://romaneio-auto.vercel.app";
  const isLocal = !origin || origin.includes("localhost") || origin.includes("127.0.0.1");
  res.setHeader("Access-Control-Allow-Origin", isLocal ? (origin || "*") : allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Supabase helpers ───────────────────────────────────────────
export async function autenticar(email, senha) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  if (email === process.env.ADMIN_EMAIL && senha === process.env.ADMIN_PASSWORD) {
    return { email, nome: "Administrador", role: "admin" };
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: senha }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.access_token) return null;
    return { email: data.user?.email || email, nome: data.user?.user_metadata?.nome || email, role: "user" };
  } catch {
    return null;
  }
}

export async function listarUsuarios() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?select=nome,email,role`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

export async function criarUsuario(nome, email, senha) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase não configurado");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      nome, email,
      senha_hash: hashSenha(senha),
      role: "user",
      criado_em: Date.now(),
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    if (err.includes("duplicate")) throw new Error("Email já cadastrado.");
    throw new Error("Erro ao criar usuário.");
  }
  return (await r.json())[0];
}

export { SUPABASE_URL, SUPABASE_KEY };
