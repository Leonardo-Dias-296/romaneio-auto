// api/bling-callback.js — Handle Bling OAuth callback
import { setCors } from "./lib/auth.js";
import { exchangeCodeForTokens } from "./lib/bling.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { code, error } = req.query;

    if (error) {
      return res.redirect(`/?bling=error&msg=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect(`/?bling=error&msg=${encodeURIComponent("Código não recebido")}`);
    }

    await exchangeCodeForTokens(code, req);

    return res.redirect(`/?bling=success`);
  } catch (err) {
    console.error("[bling-callback]", err.message);
    return res.redirect(`/?bling=error&msg=${encodeURIComponent(err.message)}`);
  }
}
