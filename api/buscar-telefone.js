// api/buscar-telefone.js — Busca telefone da transportadora
import { setCors, checkRateLimit } from "./lib/auth.js";

export const config = { api: { bodyParser: false, sizeLimit: "1mb" } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extrairPrimeiroTelefone(texto) {
  if (!texto) return null;
  const match = texto.match(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g);
  if (!match) return null;
  let num = match[0].replace(/\D/g, "");
  if (num.length === 10) num = `(${num.slice(0, 2)}) ${num.slice(2, 6)}-${num.slice(6)}`;
  else if (num.length === 11) num = `(${num.slice(0, 2)}) ${num.slice(2, 7)}-${num.slice(7)}`;
  return num;
}

async function buscarReceitaWS(cnpj) {
  const res = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("receitaws_error");
  const data = await res.json();
  if (data.status === "ERROR") throw new Error("receitaws_error");
  if (data.telefone) { const tel = extrairPrimeiroTelefone(data.telefone); if (tel) return tel; }
  return null;
}

async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, temperature: 0, max_tokens: 256 }),
  });
  if (!res.ok) throw new Error("provider_error");
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function callGemini(prompt, apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 256 } }),
  });
  if (!res.ok) throw new Error("provider_error");
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

async function callOpenRouter(messages, apiKey) {
  const models = ["meta-llama/llama-3.3-70b-instruct:free", "google/gemma-4-26b-a4b-it:free"];
  let lastError;
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://romaneio-auto.vercel.app", "X-Title": "RomaneioAuto" },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 256 }),
      });
      if (!res.ok) { lastError = new Error("provider_error"); continue; }
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || "").trim();
    } catch (err) { lastError = err; continue; }
  }
  throw lastError || new Error("provider_error");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`telefone:${ip}`, 10, 60000)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde 1 minuto." });
  }

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;

  try {
    const rawBody = await readRawBody(req);
    const { transportadora, cnpj_transp, cidade_transp, uf_transp } = JSON.parse(rawBody.toString());

    if (!transportadora || typeof transportadora !== "string") {
      return res.status(400).json({ erro: "Nome da transportadora é obrigatório." });
    }

    const cleanTransp = transportadora.replace(/[<>"'`;]/g, "").trim().slice(0, 200);
    const cleanCidade = cidade_transp ? String(cidade_transp).replace(/[<>"'`;]/g, "").trim().slice(0, 100) : "";
    const cleanUf = uf_transp ? String(uf_transp).replace(/[<>"'`;]/g, "").trim().slice(0, 2) : "";

    // 1. Tenta ReceitaWS
    const cnpjLimpo = cnpj_transp ? String(cnpj_transp).replace(/\D/g, "") : null;
    if (cnpjLimpo && cnpjLimpo.length === 14) {
      try {
        const tel = await buscarReceitaWS(cnpjLimpo);
        if (tel) return res.status(200).json({ telefone: tel });
      } catch {}
    }

    // 2. Fallback: IA
    if (!groqKey && !geminiKey && !orKey) return res.status(200).json({ telefone: null });

    const localizacao = [cleanCidade, cleanUf].filter(Boolean).join(" - ");
    const prompt = `Qual o número de telefone de contato da transportadora brasileira "${cleanTransp}"${localizacao ? ` localizada em ${localizacao}` : ""}?

IMPORTANTE: Responda APENAS com UM ÚNICO número de telefone completo com DDD.
Exemplo válido: (51) 1234-5678 ou (51) 91234-5678
Não escreva "Telefone:", "Celular:" ou qualquer texto extra.
Se não souber o número, responda exatamente: "Não encontrado"`;

    const textMessages = [{ role: "user", content: [{ type: "text", text: prompt }] }];

    if (groqKey) { try { const r = await callGroq(textMessages, groqKey); const tel = extrairPrimeiroTelefone(r); if (tel) return res.status(200).json({ telefone: tel }); } catch {} }
    if (geminiKey) { try { const r = await callGemini(prompt, geminiKey); const tel = extrairPrimeiroTelefone(r); if (tel) return res.status(200).json({ telefone: tel }); } catch {} }
    if (orKey) { try { const r = await callOpenRouter(textMessages, orKey); const tel = extrairPrimeiroTelefone(r); if (tel) return res.status(200).json({ telefone: tel }); } catch {} }

    return res.status(200).json({ telefone: null });
  } catch {
    return res.status(500).json({ erro: "Erro ao buscar telefone." });
  }
}
