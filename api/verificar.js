import { verificarToken, setCors } from "./lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ erro: "Method not allowed" });

  const auth = req.headers.authorization?.replace("Bearer ", "");
  const payload = verificarToken(auth || "");
  if (!payload) return res.status(401).json({ valido: false });

  return res.status(200).json({
    valido: true,
    user: { email: payload.email, nome: payload.nome, role: payload.role },
  });
}
