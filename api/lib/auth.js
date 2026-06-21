import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

function getSecret() {
  return process.env.JWT_SECRET || "romaneio-auto-secret-dev";
}

export function hashSenha(senha) {
  return crypto.createHash("sha256").update(senha).digest("hex");
}

export function gerarToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString("base64url");
  const assinatura = crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${assinatura}`;
}

export function verificarToken(token) {
  try {
    const [header, body, assinatura] = token.split(".");
    if (!header || !body || !assinatura) return null;
    const esperada = crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest("base64url");
    if (assinatura !== esperada) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
}

async function supabaseQuery(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supabaseInsert(data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text();
    if (err.includes("duplicate")) throw new Error("Email já cadastrado.");
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  return res.json();
}

export async function autenticar(email, senha) {
  if (email === process.env.ADMIN_EMAIL && senha === process.env.ADMIN_PASSWORD) {
    return { email, nome: "Administrador", role: "admin" };
  }
  try {
    const usuarios = await supabaseQuery(`usuarios?email=eq.${encodeURIComponent(email)}&select=*`);
    const user = usuarios.find(u => u.senha_hash === hashSenha(senha));
    if (user) return { email: user.email, nome: user.nome, role: user.role };
  } catch {}
  return null;
}

export async function listarUsuarios() {
  try {
    const usuarios = await supabaseQuery("usuarios?select=nome,email,role");
    return usuarios;
  } catch {
    return [];
  }
}

export async function criarUsuario(nome, email, senha) {
  const result = await supabaseInsert({
    nome,
    email,
    senha_hash: hashSenha(senha),
    role: "user",
    criado_em: Date.now(),
  });
  return { email: result[0].email, nome: result[0].nome, role: result[0].role };
}
