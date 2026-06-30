import { SUPABASE_URL, SUPABASE_KEY, setCors } from "./_lib/auth.js";

export const config = { api: { bodyParser: true, sizeLimit: "1mb" } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ erro: "Method not allowed" });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ erro: "Token não fornecido" });

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: auth },
    });
    if (!r.ok) return res.status(401).json({ erro: "Token inválido" });
    const data = await r.json();
    return res.status(200).json(data);
  } catch {
    return res.status(500).json({ erro: "Erro ao conectar com servidor" });
  }
}
