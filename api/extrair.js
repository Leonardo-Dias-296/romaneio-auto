// api/extrair.js — Vercel Serverless Function
import { setCors, checkRateLimit } from "./lib/auth.js";

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
  "endereco_transp": "endereço completo da transportadora (rua, número, bairro)",
  "cidade_transp": "cidade da transportadora",
  "uf_transp": "UF/estado da transportadora (sigla de 2 letras)",
  "telefone_transp": "telefone da transportadora com DDD (se não estiver visível, busque com base no nome e localização da empresa)",
  "nome_motorista": "nome completo do motorista",
  "cpf_motorista": "CPF ou RG do motorista",
  "placa_veiculo": "placa do veículo",
  "data_retirada": "data de retirada (NÃO invente — só extraia se estiver explícita no documento, formato DD/MM/AAAA)",
  "horario_retirada": "horário da retirada (NÃO invente — só extraia se estiver explícito no documento)",
  "numero_nf": "número da nota fiscal (apenas números)",
  "numero_pedido": "número do pedido",
  "produtos": "descrição dos produtos",
  "quantidade_volumes": "quantidade total de volumes (número)"
}

Responda APENAS com JSON válido, sem markdown, sem blocos de código, sem qualquer texto adicional.
Se um campo não existir no documento, use null.`;

const OR_VISION_MODELS = [
  "openrouter/free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-3.5-content-safety:free",
  "nex-agi/nex-n2-pro:free",
  "xiaomi/mimo-v2.5",
];

const OR_TEXT_MODELS = [
  "openrouter/free",
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-120b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "qwen/qwen3-coder:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "cohere/north-mini-code:free",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "liquid/lfm-2.5-1.2b-instruct:free",
];

const ALLOWED_MIMES = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "text/plain", "application/xml", "text/xml"];

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

async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "meta-llama/llama-4-scout-17b-16e-instruct", messages, temperature: 0, max_tokens: 1024 }),
  });
  if (!res.ok) throw new Error("provider_error");
  const data = await res.json();
  const texto = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  return JSON.parse(texto);
}

async function callGemini(parts, apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: 1024 } }),
  });
  if (!res.ok) throw new Error("provider_error");
  const data = await res.json();
  const texto = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").replace(/```json|```/g, "").trim();
  return JSON.parse(texto);
}

async function callOpenRouter(messages, apiKey, models) {
  let lastError;
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://romaneio-auto.vercel.app", "X-Title": "RomaneioAuto" },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 1024 }),
      });
      if (res.status === 429) { lastError = new Error("rate_limit"); continue; }
      if (!res.ok) { lastError = new Error("provider_error"); continue; }
      const data = await res.json();
      const texto = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      return JSON.parse(texto);
    } catch (err) { lastError = err; continue; }
  }
  throw lastError || new Error("provider_error");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`extrair:${ip}`, 10, 60000)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde 1 minuto." });
  }

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!groqKey && !geminiKey && !orKey) {
    return res.status(500).json({ erro: "Serviço de IA não configurado." });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let geminiParts, groqMessages, orMessages, orModels;
    let fileMimetype = "";

    if (contentType.includes("multipart/form-data")) {
      const boundary = parseBoundary(contentType);
      if (!boundary) return res.status(400).json({ erro: "Formato inválido." });

      const rawBody = await readRawBody(req);
      if (rawBody.length > 15 * 1024 * 1024) return res.status(400).json({ erro: "Arquivo muito grande (máx 15MB)." });

      const file = parseMultipart(rawBody, boundary);
      if (!file) return res.status(400).json({ erro: "Arquivo não encontrado." });
      if (!ALLOWED_MIMES.includes(file.mimetype)) return res.status(400).json({ erro: "Tipo de arquivo não suportado." });

      const base64 = file.buffer.toString("base64");
      fileMimetype = file.mimetype;

      groqMessages = [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${file.mimetype};base64,${base64}` } }, { type: "text", text: PROMPT }] }];
      geminiParts = [{ inlineData: { mimeType: file.mimetype, data: base64 } }, { text: PROMPT }];
      orMessages = [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${file.mimetype};base64,${base64}` } }, { type: "text", text: PROMPT }] }];
      orModels = OR_VISION_MODELS;
    } else if (contentType.includes("application/json")) {
      const rawBody = await readRawBody(req);
      const { texto } = JSON.parse(rawBody.toString());
      if (!texto || typeof texto !== "string" || texto.length > 50000) {
        return res.status(400).json({ erro: "Texto inválido ou muito longo." });
      }

      const textContent = `${PROMPT}\n\nConteúdo da NF:\n${texto}`;
      groqMessages = [{ role: "user", content: [{ type: "text", text: textContent }] }];
      geminiParts = [{ text: textContent }];
      orMessages = [{ role: "user", content: [{ type: "text", text: textContent }] }];
      orModels = [...OR_VISION_MODELS, ...OR_TEXT_MODELS];
    } else {
      return res.status(400).json({ erro: "Formato não suportado." });
    }

    const isPdf = fileMimetype === "application/pdf";
    const providers = isPdf
      ? [["Gemini", geminiKey, () => callGemini(geminiParts, geminiKey)], ["OpenRouter", orKey, () => callOpenRouter(orMessages, orKey, orModels)]]
      : [["Groq", groqKey, () => callGroq(groqMessages, groqKey)], ["Gemini", geminiKey, () => callGemini(geminiParts, geminiKey)], ["OpenRouter", orKey, () => callOpenRouter(orMessages, orKey, orModels)]];

    for (const [, key, fn] of providers) {
      if (!key) continue;
      try {
        const resultado = await fn();
        return res.status(200).json(resultado);
      } catch (err) {
        console.warn("[extrair] provider falhou:", err.message);
      }
    }

    return res.status(500).json({ erro: "Serviço de IA temporariamente indisponível. Tente novamente." });
  } catch (err) {
    console.error("[extrair]", err.message);
    return res.status(500).json({ erro: "Erro ao processar arquivo." });
  }
}
