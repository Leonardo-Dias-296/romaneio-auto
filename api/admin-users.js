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

const supabaseAdmin = createClient(SUPABASE_URL, SECRET_KEY);

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ erro: "Não autenticado" });
  const token = auth.replace("Bearer ", "");
  const user = decodeUserFromToken(token);
  if (!isAdmin(user)) return res.status(403).json({ erro: "Sem permissão de administrador" });

  if (req.method === "GET") {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 100 });
    if (error) return res.status(400).json({ erro: error.message });
    return res.status(200).json({ users: data.users || [] });
  }

  if (req.method === "POST") {
    const { email, password, nome } = req.body || {};
    if (!email || !password) return res.status(400).json({ erro: "Email e senha obrigatórios" });
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      emailConfirm: true,
      userMetadata: { nome },
    });
    if (error) return res.status(400).json({ erro: error.message });
    return res.status(200).json(data.user);
  }

  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ erro: "ID obrigatório" });
    const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (error) return res.status(400).json({ erro: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ erro: "Method not allowed" });
}
