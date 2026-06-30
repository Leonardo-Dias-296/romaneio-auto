import { gerarToken, autenticar, setCors, checkRateLimit } from "./_lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`login:${ip}`, 10, 60000)) {
    return res.status(429).json({ erro: "Muitas tentativas. Aguarde 1 minuto." });
  }

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ erro: "Email inválido" });
  }
  if (typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ erro: "Senha inválida" });
  }

  try {
    const user = await autenticar(email, password);
    if (!user) return res.status(401).json({ erro: "Email ou senha inválidos" });
    // Retorna JWT customizado — nunca expõe tokens brutos do Supabase
    const token = gerarToken({ email: user.email, nome: user.nome, role: user.role });
    return res.status(200).json({ token, user });
  } catch {
    return res.status(500).json({ erro: "Erro ao conectar com servidor" });
  }
}
