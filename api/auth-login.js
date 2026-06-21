const SUPABASE_URL = "https://budpfteibhmpghpyagcs.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_4Is-dFQMf1SQEgizreCuiA_4fs2-TE0";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Method not allowed" });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ erro: data.msg || data.error_description || data.error || "Email ou senha inválidos" });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ erro: "Erro de conexão com Supabase: " + e.message });
  }
}
