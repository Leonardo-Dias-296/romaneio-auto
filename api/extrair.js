// api/extrair.js — Vercel Serverless Function
// Agora usando a API gratuita do Google Gemini.
// A chave fica só aqui, nunca vai pro browser.

export const config = {
  api: {
    bodyParser: false, // usamos o parser manual para suportar multipart
    sizeLimit: "20mb",
  },
};

const PROMPT = `Você é um extrator de dados de notas fiscais brasileiras. Analise este documento e extraia EXATAMENTE estes campos (responda apenas com JSON válido):

{
  "transportadora": "nome completo da transportadora",
  "cnpj_transp": "CNPJ da transportadora no formato XX.XXX.XXX/XXXX-XX",
  "endereco_transp": "endereço completo da transportadora incluindo logradouro, número (se houver), bairro, cidade e UF (formato: 'Rua X, 123 - Bairro - Cidade/UF')",
  "cidade": "nome da cidade da transportadora (apenas o nome, ex: Taquari)",
  "uf": "sigla da unidade federativa (ex: RS)",
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

Regras importantes:
- Retorne SOMENTE o JSON acima, sem comentários, texto extra ou formatação Markdown.
- Garanta que `endereco_transp` contenha cidade e UF quando disponíveis. Se a cidade ou UF não forem encontradas no documento, coloque esses campos como null.
- Se um campo não existir no documento, use null.`;

// Modelo gratuito do Gemini. Se este ficar com cota esgotada,
// troque para "gemini-2.5-flash" ou outro modelo disponível
// na sua conta em https://aistudio.google.com
const GEMINI_MODEL = "gemini-2.5-flash";

// Lê o body cru da request (Buffer)
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Extrai boundary do Content-Type multipart
function parseBoundary(contentType) {
  const match = contentType.match(/boundary=([^\s;]+)/);
  return match ? match[1] : null;
}

// Parser multipart mínimo — extrai o primeiro campo "arquivo"
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;

  while (true) {
    const idx = buffer.indexOf(sep, start);
    if (idx === -1) break;
    const end = buffer.indexOf(sep, idx + sep.length);
    const part = buffer.slice(idx + sep.length, end === -1 ? buffer.length : end);
    if (part.length > 2) parts.push(part); // ignora terminadores vazios
    start = idx + sep.length;
    if (end === -1) break;
  }

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4, part.length - 2); // remove \r\n final

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

// content: array de "parts" no formato da Gemini API
// ex: [{ inlineData: { mimeType, data } }, { text: "..." }]
async function callGemini(parts, apiKey) {
  const MAX_RETRIES = 5;
  let lastError;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  for (let i = 0; i < MAX_RETRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, i < 3 ? 2000 : 5000));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          // Força a resposta a ser JSON válido, sem precisar
          // pedir isso no prompt nem limpar markdown depois.
          responseMimeType: "application/json",
        },
      }),
    });

    if (res.status === 429 || res.status === 503) {
      lastError = new Error(`Gemini sobrecarregado (${res.status})`);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Erro Gemini ${res.status}: ${txt}`);
    }

    const data = await res.json();
    const texto = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();

    if (!texto) throw new Error("Resposta vazia do Gemini.");

    return JSON.parse(texto);
  }
  throw lastError || new Error("Serviço indisponível após retries");
}

export default async function handler(req, res) {
  // CORS — permite qualquer origem *.vercel.app ou domínio próprio
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ erro: "GEMINI_API_KEY não configurada." });

  try {
    const contentType = req.headers["content-type"] || "";
    let parts;

    if (contentType.includes("multipart/form-data")) {
      // PDF ou imagem
      const boundary = parseBoundary(contentType);
      if (!boundary) return res.status(400).json({ erro: "Boundary multipart não encontrado." });

      const rawBody = await readRawBody(req);
      const file = parseMultipart(rawBody, boundary);
      if (!file) return res.status(400).json({ erro: "Campo 'arquivo' não encontrado no form." });

      const base64 = file.buffer.toString("base64");

      parts = [
        { inlineData: { mimeType: file.mimetype, data: base64 } },
        { text: PROMPT },
      ];
    } else if (contentType.includes("application/json")) {
      // XML ou TXT
      const rawBody = await readRawBody(req);
      const { texto } = JSON.parse(rawBody.toString());
      if (!texto) return res.status(400).json({ erro: "Campo 'texto' ausente." });
      parts = [{ text: `${PROMPT}\n\nConteúdo da NF:\n${texto}` }];
    } else {
      return res.status(400).json({ erro: "Content-Type não suportado." });
    }

    const resultado = await callGemini(parts, apiKey);
    return res.status(200).json(resultado);
  } catch (err) {
    console.error("[extrair]", err.message);
    return res.status(500).json({ erro: err.message });
  }
}