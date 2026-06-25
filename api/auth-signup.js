import { SUPABASE_URL, SUPABASE_KEY, setCors, checkRateLimit } from "./lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

function validarSenha(s) {
  if (typeof s !== "string" || s.length < 8 || s.length > 128) return false;
  if (!/[A-Z]/.test(s)) return false;
  if (!/[a-z]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  return true;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`signup:${ip}`, 5, 300000)) {
    return res.status(429).json({ erro: "Muitas tentativas. Aguarde 5 minutos." });
  }

  const { email, password, nome } = req.body || {};
  if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ erro: "Email inválido" });
  }
  if (!validarSenha(password)) {
    return res.status(400).json({ erro: "Senha deve ter 8+ caracteres, com maiúscula, minúscula e número" });
  }

  const cleanNome = (typeof nome === "string" ? nome : "").replace(/[<>"'`;\\]/g, "").trim().slice(0, 100);

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, data: { nome: cleanNome } }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(400).json({ erro: "Erro ao criar conta" });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ erro: "Erro ao conectar com servidor" });
  }
}
