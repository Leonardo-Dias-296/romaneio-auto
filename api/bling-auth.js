// api/bling-auth.js — Redirect to Bling OAuth authorization
import { setCors } from "./lib/auth.js";
import { getBlingClientId, getBlingRedirectUri } from "./lib/bling.js";
import crypto from "crypto";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ erro: "Método não permitido" });

  try {
    const clientId = getBlingClientId();
    if (!clientId) return res.status(500).json({ erro: "BLING_CLIENT_ID não configurado" });

    const redirectUri = getBlingRedirectUri(req);
    const state = crypto.randomBytes(16).toString("hex");

    const authUrl = `https://login.bling.com.br/oauth/authorize?response_type=code&client_id=${clientId}&state=${state}`;

    return res.redirect(authUrl);
  } catch (err) {
    console.error("[bling-auth]", err.message);
    return res.status(500).json({ erro: "Erro ao gerar URL de autorização" });
  }
}
