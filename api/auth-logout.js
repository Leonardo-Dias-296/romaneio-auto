import { setCors, clearTokenCookie } from "./_lib/auth.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Method not allowed" });

  clearTokenCookie(res);
  return res.status(200).json({ ok: true });
}
