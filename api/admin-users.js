const SUPABASE_URL = "https://budpftetbhmpghpyagcs.supabase.co";
const ANON_KEY = "sb_publishable_4Is-dFQMf1SQEgizreCuiA_4fs2-TE0";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const ADMIN_EMAILS = ["leonardoestudotrabalho2026@gmail.com"];

async function isAdmin(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return false;
  const user = await r.json();
  return ADMIN_EMAILS.includes(user.email) || user.app_metadata?.role === "admin";
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erro: "Não autenticado" });
  const token = auth.replace("Bearer ", "");
  if (!(await isAdmin(token))) return res.status(403).json({ erro: "Sem permissão de administrador" });

  if (req.method === "GET") {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=100`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ erro: data.msg || "Erro ao listar usuários" });
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  if (req.method === "POST") {
    const { email, password, nome } = req.body || {};
    if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nome } }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ erro: data.msg || data.error_description || "Erro ao criar usuário" });
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ erro: "ID obrigatório" });
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        return res.status(r.status).json({ erro: data.msg || "Erro ao excluir" });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  return res.status(405).json({ erro: "Method not allowed" });
}
