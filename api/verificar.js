import { verificarToken } from "./lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers.authorization?.replace("Bearer ", "");
  const payload = verificarToken(auth || "");
  if (!payload) return res.status(401).json({ valido: false });

  return res.status(200).json({ valido: true, user: { email: payload.email, nome: payload.nome, role: payload.role } });
}
