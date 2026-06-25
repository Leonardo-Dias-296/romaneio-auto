// DESABILITADO: Endpoint legado com política de senha fraca (6 chars).
// Usar /api/auth-signup.js ou /api/admin-users.js em vez disso.
export default async function handler(req, res) {
  return res.status(410).json({ erro: "Endpoint desabilitado. Use /api/auth-signup." });
}
export const config = { api: { bodyParser: false } };
