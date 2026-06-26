import { gerarToken, autenticar, setCors, checkRateLimit, setTokenCookie } from "./lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`login-jwt:${ip}`, 10, 60000)) {
    return res.status(429).json({ erro: "Muitas tentativas. Aguarde 1 minuto." });
  }

  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: "Email e senha obrigatórios." });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ erro: "Email inválido." });
  }

  try {
    const user = await autenticar(email, senha);
    if (!user) return res.status(401).json({ erro: "Email ou senha inválidos." });

    const token = gerarToken({ email: user.email, nome: user.nome, role: user.role });
    setTokenCookie(res, token);
    return res.status(200).json({ user });
  } catch {
    return res.status(500).json({ erro: "Erro ao conectar com servidor" });
  }
}
