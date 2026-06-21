import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://budpftetbhmpghpyagcs.supabase.co";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const ADMIN_EMAILS = ["leonardoestudotrabalho2026@gmail.com"];

function decodeUserFromToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      return { email: payload.email, id: payload.sub };
    }
    return null;
  } catch { return null; }
}

function isAdmin(user) {
  if (!user) return false;
  return ADMIN_EMAILS.includes(user.email);
}

// Usa fetch direto para REST (evita header Authorization que quebra com chave nova)
async function restInsert(table, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: SECRET_KEY, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(data),
  });
}
async function restSelect(table, email) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?email=eq.${encodeURIComponent(email)}&select=email`, {
    headers: { apikey: SECRET_KEY },
  });
  if (!r.ok) return null;
  return r.json();
}
async function restDelete(table, email) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?email=eq.${encodeURIComponent(email)}`, {
    method: "DELETE",
    headers: { apikey: SECRET_KEY },
  });
}

const supabaseAdmin = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erro: "Não autenticado" });
  const token = auth.replace("Bearer ", "");
  const user = decodeUserFromToken(token);
  if (!isAdmin(user)) return res.status(403).json({ erro: "Sem permissão de administrador" });

  if (req.method === "GET") {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (error) return res.status(400).json({ erro: error.message });

    // Sincroniza Auth → tabela usuarios
    if (data.users) {
      for (const u of data.users) {
        const existing = await restSelect("usuarios", u.email);
        if (!existing || existing.length === 0) {
          await restInsert("usuarios", {
            nome: u.user_metadata?.nome || u.email.split("@")[0],
            email: u.email,
            role: ADMIN_EMAILS.includes(u.email) ? "admin" : "user",
            criado_em: Date.now(),
          });
        }
      }
    }

    return res.status(200).json({ users: data.users || [] });
  }

  if (req.method === "POST") {
    const { email, password, nome } = req.body || {};
    if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, emailConfirm: true, userMetadata: { nome },
    });
    if (authError) return res.status(400).json({ erro: authError.message });

    await restInsert("usuarios", {
      nome, email, role: "user", criado_em: Date.now(),
    });

    return res.status(200).json(authData.user);
  }

  if (req.method === "DELETE") {
    const { id, email } = req.query;
    if (!id) return res.status(400).json({ erro: "ID obrigatório" });

    if (email) await restDelete("usuarios", email);

    const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (error) return res.status(400).json({ erro: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ erro: "Method not allowed" });
}
