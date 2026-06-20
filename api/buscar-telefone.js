// api/buscar-telefone.js — Busca telefone da transportadora
// 1. Tenta ReceitaWS (CNPJ) 2. Fallback: IA (Groq → Gemini → OpenRouter)

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "1mb",
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function limparCnpj(cnpj) {
  if (!cnpj) return null;
  return cnpj.replace(/\D/g, "");
}

function extrairPrimeiroTelefone(texto) {
  if (!texto) return null;
  const padrao = /\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g;
  const match = texto.match(padrao);
  if (!match) return null;
  let num = match[0].replace(/\D/g, "");
  if (num.length === 10) num = `(${num.slice(0, 2)}) ${num.slice(2, 6)}-${num.slice(6)}`;
  else if (num.length === 11) num = `(${num.slice(0, 2)}) ${num.slice(2, 7)}-${num.slice(7)}`;
  return num;
}

async function buscarReceitaWS(cnpj) {
  const url = `https://www.receitaws.com.br/v1/cnpj/${cnpj}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ReceitaWS ${res.status}`);
  const data = await res.json();
  if (data.status === "ERROR") throw new Error("ReceitaWS: " + (data.message || "erro"));
  if (data.telefone) {
    const tel = extrairPrimeiroTelefone(data.telefone);
    if (tel) return tel;
  }
  return null;
}

async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0,
      max_tokens: 256,
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Groq ${res.status}: ${t}`); }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function callGemini(prompt, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256 },
      }),
    }
  );
  if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${t}`); }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

async function callOpenRouter(messages, apiKey) {
  const models = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "google/gemma-4-26b-a4b-it:free",
  ];
  let lastError;
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://romaneio-auto.vercel.app",
          "X-Title": "RomaneioAuto",
        },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 256 }),
      });
      if (res.status === 429) { lastError = new Error(`Rate limit ${model}`); continue; }
      if (!res.ok) { const t = await res.text(); lastError = new Error(`${model}: ${t}`); continue; }
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || "").trim();
    } catch (err) { lastError = err; continue; }
  }
  throw lastError || new Error("Todos falharam");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;

  try {
    const rawBody = await readRawBody(req);
    const { transportadora, cnpj_transp, cidade_transp, uf_transp } = JSON.parse(rawBody.toString());

    if (!transportadora) {
      return res.status(400).json({ erro: "Nome da transportadora é obrigatório." });
    }

    // 1. Tenta ReceitaWS pelo CNPJ
    const cnpjLimpo = limparCnpj(cnpj_transp);
    if (cnpjLimpo) {
      try {
        const tel = await buscarReceitaWS(cnpjLimpo);
        if (tel) return res.status(200).json({ telefone: tel });
      } catch (e) { console.warn("[buscar-telefone] ReceitaWS:", e.message); }
    }

    // 2. Fallback: IA
    if (!groqKey && !geminiKey && !orKey) {
      return res.status(200).json({ telefone: null });
    }

    const localizacao = [cidade_transp, uf_transp].filter(Boolean).join(" - ");
    const prompt = `Qual o número de telefone de contato da transportadora brasileira "${transportadora}"${localizacao ? ` localizada em ${localizacao}` : ""}?

IMPORTANTE: Responda APENAS com UM ÚNICO número de telefone completo com DDD.
Exemplo válido: (51) 1234-5678 ou (51) 91234-5678
Não escreva "Telefone:", "Celular:" ou qualquer texto extra.
Se não souber o número, responda exatamente: "Não encontrado"`;

    const textMessages = [{ role: "user", content: [{ type: "text", text: prompt }] }];

    if (groqKey) {
      try { const r = await callGroq(textMessages, groqKey); const tel = extrairPrimeiroTelefone(r); if (tel) return res.status(200).json({ telefone: tel }); } catch {}
    }
    if (geminiKey) {
      try { const r = await callGemini(prompt, geminiKey); const tel = extrairPrimeiroTelefone(r); if (tel) return res.status(200).json({ telefone: tel }); } catch {}
    }
    if (orKey) {
      try { const r = await callOpenRouter(textMessages, orKey); const tel = extrairPrimeiroTelefone(r); if (tel) return res.status(200).json({ telefone: tel }); } catch {}
    }

    return res.status(200).json({ telefone: null });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
