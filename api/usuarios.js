import { verificarToken, listarUsuarios, criarUsuario, setCors, checkRateLimit } from "./lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers.authorization?.replace("Bearer ", "");
  const payload = verificarToken(auth || "");
  if (!payload || payload.role !== "admin") {
    return res.status(401).json({ erro: "Não autorizado." });
  }

  if (req.method === "GET") {
    const usuarios = await listarUsuarios();
    return res.status(200).json({ usuarios });
  }

  if (req.method === "POST") {
    const ip = req.headers["x-forwarded-for"] || "unknown";
    if (!checkRateLimit(`users:${ip}`, 10, 60000)) {
      return res.status(429).json({ erro: "Muitas requisições." });
    }

    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: "Nome, email e senha obrigatórios." });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ erro: "Email inválido." });
    }
    if (typeof senha !== "string" || senha.length < 6 || senha.length > 128) {
      return res.status(400).json({ erro: "Senha deve ter entre 6 e 128 caracteres." });
    }

    try {
      const user = await criarUsuario(
        nome.replace(/[<>"'`;]/g, "").trim().slice(0, 100),
        email.trim(),
        senha
      );
      return res.status(201).json({ user });
    } catch (err) {
      return res.status(400).json({ erro: err.message || "Erro ao criar usuário." });
    }
  }

  return res.status(405).json({ erro: "Método não permitido" });
}
