// api/cron-ping.js — Mantém o Supabase ativo (evita pausa por inatividade no free tier)
// Executa a cada 5 dias via cron do Vercel

export default async function handler(req, res) {
  // Protege contra acessos não autorizados
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erro: "Unauthorized" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    return res.status(500).json({ erro: "Supabase env vars not configured" });
  }

  try {
    const r = await fetch(`${url}/rest/v1/bling_tokens?select=key&limit=1`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    return res.status(200).json({ ok: r.ok, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ erro: e.message });
  }
}
