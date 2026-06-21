const SUPABASE_URL = "https://budpfteibhmpghpyagcs.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_4Is-dFQMf1SQEgizreCuiA_4fs2-TE0";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ erro: "Method not allowed" });
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erro: "No token" });

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: auth },
    });
    if (!r.ok) return res.status(r.status).json({ erro: "Invalid token" });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ erro: "Erro de conexão com Supabase: " + e.message });
  }
}
