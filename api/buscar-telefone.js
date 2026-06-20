// api/buscar-telefone.js — Busca telefone da transportadora via IA
// GROQ_API_KEY (principal), GEMINI_API_KEY (fallback), OPENROUTER_API_KEY (último recurso)

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "1mb",
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
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
    "openrouter/free",
    "google/gemma-4-26b-a4b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
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
  if (!groqKey && !geminiKey && !orKey) {
    return res.status(500).json({ erro: "Nenhuma API key configurada." });
  }

  try {
    const rawBody = await readRawBody(req);
    const { transportadora, cidade_transp, uf_transp } = JSON.parse(rawBody.toString());

    if (!transportadora) {
      return res.status(400).json({ erro: "Nome da transportadora é obrigatório." });
    }

    const localizacao = [cidade_transp, uf_transp].filter(Boolean).join(" - ");
    const prompt = `Qual o telefone de contato comercial da transportadora brasileira "${transportadora}"${localizacao ? ` localizada em ${localizacao}` : ""}?
Responda APENAS com o número de telefone completo com DDD (ex: (11) 1234-5678 ou (11) 91234-5678).
Se não souber, responda exatamente: "Não encontrado".`;

    const textMessages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    let resultado = null;

    if (groqKey) {
      try { resultado = await callGroq(textMessages, groqKey); if (resultado && resultado !== "Não encontrado") return res.status(200).json({ telefone: resultado }); } catch {}
    }
    if (geminiKey) {
      try { resultado = await callGemini(prompt, geminiKey); if (resultado && resultado !== "Não encontrado") return res.status(200).json({ telefone: resultado }); } catch {}
    }
    if (orKey) {
      try { resultado = await callOpenRouter(textMessages, orKey); if (resultado && resultado !== "Não encontrado") return res.status(200).json({ telefone: resultado }); } catch {}
    }

    return res.status(200).json({ telefone: null });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
