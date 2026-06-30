import { verificarToken, SUPABASE_URL, SUPABASE_KEY, setCors, checkRateLimit, getAdminEmails, getTokenFromCookie } from "./_lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Rate limiting
  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`admin:${ip}`, 30, 60000)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde 1 minuto." });
  }

  const token = getTokenFromCookie(req);
  const payload = verificarToken(token || "");
  const ADMIN_EMAILS = getAdminEmails();
  if (!payload || !ADMIN_EMAILS.includes(payload.email?.toLowerCase())) {
    return res.status(401).json({ erro: "Não autorizado." });
  }

  if (req.method === "GET") {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!r.ok) return res.status(400).json({ erro: "Erro ao listar usuários." });
      const data = await r.json();
      return res.status(200).json({ users: data.users || [] });
    } catch {
      return res.status(500).json({ erro: "Erro interno." });
    }
  }

  if (req.method === "POST") {
    const { email, password, nome } = req.body || {};
    if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: "Email inválido" });
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return res.status(400).json({ erro: "Senha deve ter entre 8 e 128 caracteres" });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({ erro: "Senha deve conter maiúscula, minúscula e número" });
    }

    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nome: nome || "" } }),
      });
      if (!r.ok) {
        const err = await r.json();
        return res.status(400).json({ erro: "Erro ao criar usuário." });
      }
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ erro: "Erro interno." });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id || typeof id !== "string") return res.status(400).json({ erro: "ID obrigatório" });

    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (!r.ok) return res.status(400).json({ erro: "Erro ao deletar usuário." });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ erro: "Erro interno." });
    }
  }

  return res.status(405).json({ erro: "Method not allowed" });
}
