import { verificarToken, listarUsuarios, criarUsuario } from "./lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: "Nome, email e senha obrigatórios." });
    }
    try {
      const user = await criarUsuario(nome, email, senha);
      return res.status(201).json({ user });
    } catch (err) {
      return res.status(400).json({ erro: err.message });
    }
  }

  return res.status(405).json({ erro: "Método não permitido" });
}
