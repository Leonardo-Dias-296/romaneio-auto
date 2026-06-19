// api/extrair.js — Vercel Serverless Function
// A chave da API (OPENROUTER_API_KEY) fica só aqui, nunca vai pro browser.

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

const MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "nex-agi/nex-n2-pro:free",
  "nvidia/nemotron-3.5-content-safety:free",
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

async function callOpenRouter(messages, apiKey) {
  let lastError;

  for (const model of MODELS) {
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
        lastError = new Error(`Rate limit no modelo ${model}`);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text();
        lastError = new Error(`Erro ${model} ${res.status}: ${txt}`);
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
  throw lastError || new Error("Todos os modelos falharam");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "OPENROUTER_API_KEY não configurada." });

  try {
    const contentType = req.headers["content-type"] || "";
    let userContent;

    if (contentType.includes("multipart/form-data")) {
      const boundary = parseBoundary(contentType);
      if (!boundary) return res.status(400).json({ erro: "Boundary multipart não encontrado." });

      const rawBody = await readRawBody(req);
      const file = parseMultipart(rawBody, boundary);
      if (!file) return res.status(400).json({ erro: "Campo 'arquivo' não encontrado no form." });

      const base64 = file.buffer.toString("base64");

      userContent = [
        {
          type: "image_url",
          image_url: { url: `data:${file.mimetype};base64,${base64}` },
        },
        { type: "text", text: PROMPT },
      ];
    } else if (contentType.includes("application/json")) {
      const rawBody = await readRawBody(req);
      const { texto } = JSON.parse(rawBody.toString());
      if (!texto) return res.status(400).json({ erro: "Campo 'texto' ausente." });
      userContent = [{ type: "text", text: `${PROMPT}\n\nConteúdo da NF:\n${texto}` }];
    } else {
      return res.status(400).json({ erro: "Content-Type não suportado." });
    }

    const messages = [{ role: "user", content: userContent }];
    const resultado = await callOpenRouter(messages, apiKey);
    return res.status(200).json(resultado);
  } catch (err) {
    console.error("[extrair]", err.message);
    return res.status(500).json({ erro: err.message });
  }
}
