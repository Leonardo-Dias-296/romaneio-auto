import crypto from "crypto";

const PROJ_ID = "prj_XnAnSNHUJ9Hxvza3suHoAxHqLc9j";
const TEAM_ID = "team_4jXLEwrThN7uCEBicFejKpYW";

function getSecret() {
  return process.env.JWT_SECRET || "romaneio-auto-secret-dev";
}

export function hashSenha(senha) {
  return crypto.createHash("sha256").update(senha).digest("hex");
}

function getToken() {
  return process.env.VERCEL_API_TOKEN || "";
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

function getUsuariosFromEnv() {
  try {
    return JSON.parse(process.env.USUARIOS || "[]");
  } catch {
    return [];
  }
}

export async function autenticar(email, senha) {
  if (email === process.env.ADMIN_EMAIL && senha === process.env.ADMIN_PASSWORD) {
    return { email, nome: "Administrador", role: "admin" };
  }
  const usuarios = getUsuariosFromEnv();
  const user = usuarios.find(u => u.email === email && u.senhaHash === hashSenha(senha));
  if (user) return { email: user.email, nome: user.nome, role: "user" };
  return null;
}

export async function listarUsuarios() {
  return getUsuariosFromEnv().map(({ email, nome, role }) => ({ email, nome, role }));
}

export async function criarUsuario(nome, email, senha) {
  const usuarios = getUsuariosFromEnv();
  if (usuarios.find(u => u.email === email)) throw new Error("Email já cadastrado.");
  usuarios.push({ nome, email, senhaHash: hashSenha(senha), role: "user", criadoEm: Date.now() });

  const apiToken = getToken();
  if (!apiToken) throw new Error("VERCEL_API_TOKEN não configurado.");

  const body = {
    key: "USUARIOS",
    value: JSON.stringify(usuarios),
    type: "encrypted",
    target: ["production", "preview", "development"],
  };

  const res = await fetch(`https://api.vercel.com/v10/projects/${PROJ_ID}/env?teamId=${TEAM_ID}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("Erro ao salvar no Vercel: " + err);
  }

  return { email, nome, role: "user" };
}
