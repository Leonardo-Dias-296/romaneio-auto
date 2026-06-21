import crypto from "crypto";

function getSecret() {
  return process.env.JWT_SECRET || "romaneio-auto-secret-dev";
}

function hashSenha(senha) {
  return crypto.createHash("sha256").update(senha).digest("hex");
}

function gerarToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString("base64url");
  const assinatura = crypto.createHmac("sha256", getSecret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${assinatura}`;
}

function verificarToken(token) {
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

async function getKV() {
  try {
    const { kv } = await import("@vercel/kv");
    return kv;
  } catch {
    return null;
  }
}

async function autenticar(email, senha) {
  // Admin (env vars)
  if (email === process.env.ADMIN_EMAIL && senha === process.env.ADMIN_PASSWORD) {
    return { email, nome: "Administrador", role: "admin" };
  }
  // Usuários no KV
  const kv = await getKV();
  if (kv) {
    const usuarios = await kv.get("usuarios") || [];
    const user = usuarios.find(u => u.email === email && u.senhaHash === hashSenha(senha));
    if (user) return { email: user.email, nome: user.nome, role: "user" };
  }
  return null;
}

async function listarUsuarios() {
  const kv = await getKV();
  if (!kv) return [];
  const usuarios = await kv.get("usuarios") || [];
  return usuarios.map(({ email, nome, role }) => ({ email, nome, role }));
}

async function criarUsuario(nome, email, senha) {
  const kv = await getKV();
  if (!kv) throw new Error("Vercel KV não configurado.");
  const usuarios = await kv.get("usuarios") || [];
  if (usuarios.find(u => u.email === email)) throw new Error("Email já cadastrado.");
  usuarios.push({ nome, email, senhaHash: hashSenha(senha), role: "user", criadoEm: Date.now() });
  await kv.set("usuarios", usuarios);
  return { email, nome, role: "user" };
}

export { gerarToken, verificarToken, autenticar, listarUsuarios, criarUsuario, hashSenha };
