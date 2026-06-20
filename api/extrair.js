// api/extrair.js — Vercel Serverless Function
// GROQ_API_KEY (principal), GEMINI_API_KEY (fallback), OPENROUTER_API_KEY (último recurso)

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "20mb",
  },
};

const PROMPT = `Você é um extrator de dados de notas fiscais brasileiras. Analise este documento e extraia EXATAMENTE estes campos:

{
  "transportadora": "nome completo da transportadora",
  "cnpj_transp": "CNPJ da transportadora no formato XX.XXX.XXX/XXXX-XX",
  "endereco_transp": "endereço completo da transportadora",
  "telefone_transp": "telefone da transportadora com DDD",
  "nome_motorista": "nome completo do motorista",
  "cpf_motorista": "CPF ou RG do motorista",
  "placa_veiculo": "placa do veículo",
  "data_retirada": "data no formato DD/MM/AAAA",
  "horario_retirada": "horário da retirada",
  "numero_nf": "número da nota fiscal (apenas números)",
  "numero_pedido": "número do pedido",
  "produtos": "descrição dos produtos",
  "quantidade_volumes": "quantidade total de volumes (número)",
  "observacoes": "observações relevantes"
}

Responda APENAS com JSON válido, sem markdown, sem blocos de código, sem qualquer texto adicional.
Se um campo não existir no documento, use null.`;

const OR_VISION_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2-pro:free",
];

const OR_TEXT_MODELS = [
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-120b:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBoundary(contentType) {
  const match = contentType.match(/boundary=([^\s;]+)/);
  return match ? match[1] : null;
}

function parseMultipart(buffer, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;

  while (true) {
    const idx = buffer.indexOf(sep, start);
    if (idx === -1) break;
    const end = buffer.indexOf(sep, idx + sep.length);
    const part = buffer.slice(idx + sep.length, end === -1 ? buffer.length : end);
    if (part.length > 2) parts.push(part);
    start = idx + sep.length;
    if (end === -1) break;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4, part.length - 2);

    if (headerStr.includes('name="arquivo"')) {
      const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      return {
        buffer: body,
        mimetype: mimeMatch ? mimeMatch[1].trim() : "application/octet-stream",
      };
    }
  }
  return null;
}

// ── Groq (principal — super rápido) ───────────────────────────
async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages,
      temperature: 0,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Groq ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const texto = (data.choices?.[0]?.message?.content || "")
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(texto);
}

// ── Gemini (fallback 1) ──────────────────────────────────────
async function callGemini(parts, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt}`);
  }

  const data = await res.json();
  const texto = (data.candidates?.[0]?.content?.parts?.[0]?.text || "")
    .replace(/```json|```/g, "")
    .trim();
  return JSON.parse(texto);
}

// ── OpenRouter (fallback 2) ──────────────────────────────────
async function callOpenRouter(messages, apiKey, models) {
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
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          max_tokens: 1024,
        }),
      });

      if (res.status === 429) {
        lastError = new Error(`Rate limit ${model}`);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        lastError = new Error(`${model} ${res.status}: ${txt}`);
        continue;
      }

      const data = await res.json();
      const texto = (data.choices?.[0]?.message?.content || "")
        .replace(/```json|```/g, "")
        .trim();
      return JSON.parse(texto);
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error("OpenRouter: todos os modelos falharam");
}

// ── Handler ────────────────────────────────────────────────────
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
    const contentType = req.headers["content-type"] || "";
    let geminiParts;
    let groqMessages;
    let orMessages;
    let orModels;
    let fileMimetype = "";

    if (contentType.includes("multipart/form-data")) {
      const boundary = parseBoundary(contentType);
      if (!boundary) return res.status(400).json({ erro: "Boundary multipart não encontrado." });

      const rawBody = await readRawBody(req);
      const file = parseMultipart(rawBody, boundary);
      if (!file) return res.status(400).json({ erro: "Campo 'arquivo' não encontrado no form." });

      const base64 = file.buffer.toString("base64");
      fileMimetype = file.mimetype;

      groqMessages = [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${file.mimetype};base64,${base64}` } },
          { type: "text", text: PROMPT },
        ],
      }];

      geminiParts = [
        { inlineData: { mimeType: file.mimetype, data: base64 } },
        { text: PROMPT },
      ];

      orMessages = [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${file.mimetype};base64,${base64}` } },
          { type: "text", text: PROMPT },
        ],
      }];
      orModels = OR_VISION_MODELS;
    } else if (contentType.includes("application/json")) {
      const rawBody = await readRawBody(req);
      const { texto } = JSON.parse(rawBody.toString());
      if (!texto) return res.status(400).json({ erro: "Campo 'texto' ausente." });

      const textContent = `${PROMPT}\n\nConteúdo da NF:\n${texto}`;

      groqMessages = [{ role: "user", content: [{ type: "text", text: textContent }] }];
      geminiParts = [{ text: textContent }];
      orMessages = [{ role: "user", content: [{ type: "text", text: textContent }] }];
      orModels = [...OR_VISION_MODELS, ...OR_TEXT_MODELS];
    } else {
      return res.status(400).json({ erro: "Content-Type não suportado." });
    }

    const errors = [];
    const isPdf = fileMimetype === "application/pdf";

    const providers = isPdf
      ? [["Gemini", geminiKey, () => callGemini(geminiParts, geminiKey)],
         ["OpenRouter", orKey, () => callOpenRouter(orMessages, orKey, orModels)]]
      : [["Groq", groqKey, () => callGroq(groqMessages, groqKey)],
         ["Gemini", geminiKey, () => callGemini(geminiParts, geminiKey)],
         ["OpenRouter", orKey, () => callOpenRouter(orMessages, orKey, orModels)]];

    for (const [name, key, fn] of providers) {
      if (!key) continue;
      try {
        const resultado = await fn();
        return res.status(200).json(resultado);
      } catch (err) {
        console.warn(`[extrair] ${name} falhou:`, err.message);
        errors.push(`${name}: ${err.message}`);
      }
    }
    if (groqKey) {
      try {
        const resultado = await callGroq(groqMessages, groqKey);
        return res.status(200).json(resultado);
      } catch (err) {
        console.warn("[extrair] Groq falhou:", err.message);
        errors.push("Groq: " + err.message);
      }
    }

    if (geminiKey) {
      try {
        const resultado = await callGemini(geminiParts, geminiKey);
        return res.status(200).json(resultado);
      } catch (err) {
        console.warn("[extrair] Gemini falhou:", err.message);
        errors.push("Gemini: " + err.message);
      }
    }

    if (orKey) {
      try {
        const resultado = await callOpenRouter(orMessages, orKey, orModels);
        return res.status(200).json(resultado);
      } catch (err) {
        console.warn("[extrair] OpenRouter falhou:", err.message);
        errors.push("OpenRouter: " + err.message);
      }
    }

    return res.status(500).json({ erro: "Todas as APIs falharam: " + errors.join(" | ") });
  } catch (err) {
    console.error("[extrair]", err.message);
    return res.status(500).json({ erro: err.message });
  }
}
