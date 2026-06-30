// api/bling.js — Bling API integration (OAuth 2.0 + NF search)
import crypto from "crypto";
import { setCors, checkRateLimit } from "./lib/auth.js";
import { getBlingClientId, getValidToken, blingGet, getToken, exchangeCodeForTokens, deleteToken } from "./lib/bling.js";

export const config = { api: { bodyParser: false } };

// ── In-memory caches ───────────────────────────────────────────
const nfResultCache = new Map();
const NF_RESULT_TTL = 10 * 60 * 1000; // 10 min — resultado completo da NF

const nfListCache = new Map();
const NF_LIST_TTL = 5 * 60 * 1000;

const transpCache = new Map();
const TRANSP_CACHE_TTL = 30 * 60 * 1000;

const contatosListCache = new Map();
const CONTATOS_LIST_TTL = 15 * 60 * 1000;

function getCached(cache, key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < entry.ttl) return entry.value;
  cache.delete(key);
  return null;
}

function setCache(cache, key, value, ttl) {
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value, ts: Date.now(), ttl });
}

// ── Busca uma NF pelo número (mínimo de chamadas) ──────────────
async function buscarNF(numero, accessToken) {
  const numStr = String(numero).trim();
  const numBusca = numStr.replace(/\D/g, "").replace(/^0+/, "") || numStr.replace(/\D/g, "");

  // 1. Checa cache de resultado completo
  const resultCacheKey = `nf_result:${numBusca}`;
  const cached = getCached(nfResultCache, resultCacheKey);
  if (cached) return cached;

  // 2. Busca a NF na listagem paginada (com cache de páginas)
  let nfEncontrada = null;
  for (let pagina = 1; pagina <= 10; pagina++) {
    const cacheKey = `nf_list:${pagina}`;
    let listData = getCached(nfListCache, cacheKey);
    if (!listData) {
      listData = await blingGet(`/nfe?pagina=${pagina}&limite=100`, accessToken);
      setCache(nfListCache, cacheKey, listData, NF_LIST_TTL);
    }
    if (!listData.data || listData.data.length === 0) break;
    nfEncontrada = listData.data.find(n => {
      const numApi = String(n.numero || "").replace(/\D/g, "").replace(/^0+/, "");
      return numApi === numBusca || String(n.numero) === numStr;
    });
    if (nfEncontrada) break;
    if (listData.data.length < 100) break;
  }

  if (!nfEncontrada) return null;

  // 3. Detalhes da NF
  const detail = await blingGet(`/nfe/${nfEncontrada.id}`, accessToken);
  const nfData = detail.data || {};
  const transp = nfData.transporte || {};
  const transportador = transp.transportador || {};

  let qtdVolumes = (nfData.itens || []).reduce((s, i) => s + (parseInt(i.quantidade) || 1), 0);
  let pesoBruto = nfData.pesoBruto || null;
  let pesoLiquido = nfData.pesoLiquido || null;
  let numeroPedido = nfData.numeroPedidoLoja || null;

  // 4. Busca XML APENAS se precisar de peso/volumes que a API não tem
  const precisaXml = !pesoBruto || !pesoLiquido;
  if (precisaXml && nfData.xml) {
    try {
      const xmlRes = await fetch(nfData.xml, { signal: AbortSignal.timeout(8000) });
      if (xmlRes.ok) {
        const xmlText = await xmlRes.text();
        const qVolMatch = xmlText.match(/<qVol>(\d+)<\/qVol>/);
        if (qVolMatch) qtdVolumes = parseInt(qVolMatch[1]) || qtdVolumes;
        if (!pesoBruto) {
          const pbMatch = xmlText.match(/<pesoB>([\d.]+)<\/pesoB>/);
          if (pbMatch) pesoBruto = parseFloat(pbMatch[1]);
        }
        if (!pesoLiquido) {
          const plMatch = xmlText.match(/<pesoL>([\d.]+)<\/pesoL>/);
          if (plMatch) pesoLiquido = parseFloat(plMatch[1]);
        }
      }
    } catch {}
  }

  const result = {
    numero_nf: nfData.numero || numStr,
    transportadora: transportador.nome || null,
    cnpj_transp: transportador.numeroDocumento || null,
    endereco_transp: null,
    cidade_transp: null,
    uf_transp: null,
    telefone_transp: null,
    nome_motorista: null,
    cpf_motorista: null,
    placa_veiculo: null,
    data_retirada: null,
    horario_retirada: null,
    produtos: (nfData.itens || []).map(i => i.descricao).join(", ") || null,
    quantidade_volumes: String(qtdVolumes),
    numero_pedido: numeroPedido,
    observacoes: nfData.obs_interna || nfData.obs || null,
    peso_bruto: pesoBruto,
    peso_liquido: pesoLiquido,
  };

  // 6. Busca transportadora com cache compartilhado de contatos
  const cnpjLimpo = (transportador.numeroDocumento || "").replace(/\D/g, "");
  if (cnpjLimpo && cnpjLimpo.length === 14 && accessToken) {
    const transpCacheKey = `transp:${cnpjLimpo}`;
    const cachedTransp = getCached(transpCache, transpCacheKey);
    if (cachedTransp) {
      result.endereco_transp = cachedTransp.endereco;
      result.cidade_transp = cachedTransp.cidade;
      result.uf_transp = cachedTransp.uf;
      result.telefone_transp = cachedTransp.telefone;
    } else {
      try {
        let contatos = getCached(contatosListCache, "contatos_j");
        if (!contatos) {
          contatos = await blingGet(`/contatos?pagina=1&limite=100&tipoPessoa=J`, accessToken);
          setCache(contatosListCache, "contatos_j", contatos, CONTATOS_LIST_TTL);
        }
        if (contatos.data) {
          const contato = contatos.data.find(c => {
            const doc = (c.numeroDocumento || "").replace(/\D/g, "");
            return doc === cnpjLimpo;
          });
          if (contato && contato.id) {
            const detalhe = await blingGet(`/contatos/${contato.id}`, accessToken);
            const cd = detalhe.data || contato;
            const end = cd.endereco?.geral || cd.endereco || {};
            const log = end.endereco || "";
            const num = end.numero || "";
            const bai = end.bairro || "";
            const cid = end.municipio || "";
            const uf = end.uf || "";
            if (log) result.endereco_transp = `${log}${num ? ", " + num : ""}${bai ? " - " + bai : ""}${cid ? " - " + cid : ""}${uf ? "/" + uf : ""}`;
            if (cid) result.cidade_transp = cid;
            if (uf) result.uf_transp = uf;
            if (cd.telefone) result.telefone_transp = cd.telefone;
            setCache(transpCache, transpCacheKey, {
              endereco: result.endereco_transp,
              cidade: result.cidade_transp,
              uf: result.uf_transp,
              telefone: result.telefone_transp,
            }, TRANSP_CACHE_TTL);
          }
        }
      } catch {}
    }
  }

  // 7. Fallback ReceitaWS
  if ((!result.endereco_transp || !result.telefone_transp) && cnpjLimpo && cnpjLimpo.length === 14) {
    const rwCacheKey = `rw:${cnpjLimpo}`;
    const cachedRW = getCached(transpCache, rwCacheKey);
    if (cachedRW) {
      result.endereco_transp = result.endereco_transp || cachedRW.endereco;
      result.cidade_transp = result.cidade_transp || cachedRW.cidade;
      result.uf_transp = result.uf_transp || cachedRW.uf;
      result.telefone_transp = result.telefone_transp || cachedRW.telefone;
    } else {
      try {
        const rws = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpjLimpo}`, { signal: AbortSignal.timeout(8000) });
        if (rws.ok) {
          const rwsData = await rws.json();
          if (rwsData.status !== "ERROR") {
            const rwEnd = (!result.endereco_transp) ? (() => {
              const log = rwsData.logradouro || "";
              const num = rwsData.numero || "";
              const bai = rwsData.bairro || "";
              const cid = rwsData.municipio || "";
              const uf = rwsData.uf || "";
              return log ? `${log}${num ? ", " + num : ""}${bai ? " - " + bai : ""}${cid ? " - " + cid : ""}${uf ? "/" + uf : ""}` : null;
            })() : null;
            if (rwEnd) result.endereco_transp = rwEnd;
            if (!result.cidade_transp && rwsData.municipio) result.cidade_transp = rwsData.municipio;
            if (!result.uf_transp && rwsData.uf) result.uf_transp = rwsData.uf;
            const telMatch = rwsData.telefone?.match(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g);
            if (!result.telefone_transp && telMatch) result.telefone_transp = telMatch[0];
            setCache(transpCache, rwCacheKey, {
              endereco: result.endereco_transp,
              cidade: result.cidade_transp,
              uf: result.uf_transp,
              telefone: result.telefone_transp,
            }, TRANSP_CACHE_TTL);
          }
        }
      } catch {}
    }
  }

  // Cache resultado completo
  setCache(nfResultCache, resultCacheKey, result, NF_RESULT_TTL);
  return result;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`bling:${ip}`, 50, 60000)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde 1 minuto." });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const action = url.searchParams.get("action") || "status";

    // ── GET /api/bling?action=auth ──
    if (req.method === "GET" && action === "auth") {
      const clientId = getBlingClientId();
      if (!clientId) return res.status(500).json({ erro: "BLING_CLIENT_ID não configurado" });
      const state = crypto.randomBytes(16).toString("hex");
      res.setHeader("Set-Cookie", `bling_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&state=${state}`;
      return res.redirect(authUrl);
    }

    // ── GET /api/bling?action=callback ──
    if (req.method === "GET" && action === "callback") {
      const { code, error, state } = Object.fromEntries(url.searchParams);
      if (error || !code) return res.redirect("/?bling=error");
      const cookieHeader = req.headers.cookie || "";
      const cookies = Object.fromEntries(cookieHeader.split(";").map(c => c.trim().split("=")).filter(c => c.length === 2));
      if (!cookies.bling_oauth_state || cookies.bling_oauth_state !== state) {
        return res.redirect("/?bling=error");
      }
      res.setHeader("Set-Cookie", "bling_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
      try {
        await exchangeCodeForTokens(code);
        return res.redirect("/?bling=success");
      } catch {
        return res.redirect("/?bling=error");
      }
    }

    // ── GET /api/bling?action=status ──
    if (req.method === "GET" && action === "status") {
      const token = await getToken();
      return res.status(200).json({ connected: !!token });
    }

    // ── GET /api/bling?action=disconnect ──
    if (req.method === "GET" && action === "disconnect") {
      await deleteToken();
      return res.status(200).json({ ok: true });
    }

    // ── GET /api/bling?action=test ──
    if (req.method === "GET" && action === "test") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado" });
      try {
        const accessToken = await getValidToken();
        if (!accessToken) return res.status(401).json({ erro: "Token inválido" });
        const testData = await blingGet("/nfe?pagina=1&limite=5", accessToken);
        return res.status(200).json({ ok: true, count: testData.data?.length || 0 });
      } catch {
        return res.status(500).json({ erro: "Erro ao testar conexão" });
      }
    }

    // ── POST /api/bling → search NF(s) by number ──
    if (req.method === "POST") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado. Clique em 'Conectar Bling' primeiro." });

      let body = "";
      for await (const chunk of req) body += chunk;
      if (body.length > 1000) return res.status(400).json({ erro: "Dados inválidos." });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return res.status(400).json({ erro: "JSON inválido." }); }

      const accessToken = await getValidToken();
      if (!accessToken) return res.status(401).json({ erro: "Token do Bling expirado. Reconecte." });

      // Batch: aceita { numeros: ["723","724",...] } ou { numero: "723" }
      const numeros = parsed.numeros || (parsed.numero ? [parsed.numero] : []);
      if (numeros.length === 0) return res.status(400).json({ erro: "Número da nota fiscal é obrigatório." });

      for (const num of numeros) {
        const numStr = String(num).trim();
        if (numStr.length > 20 || !/^\d+$/.test(numStr.replace(/\D/g, ""))) {
          return res.status(400).json({ erro: `Número inválido: ${numStr}` });
        }
      }

      if (numeros.length === 1) {
        const result = await buscarNF(numeros[0], accessToken);
        if (!result) return res.status(404).json({ erro: "NF não encontrada no Bling." });
        return res.status(200).json(result);
      }

      // Batch: busca todas as NFs em paralelo (3 por vez para não sobrecarregar)
      const BATCH_SIZE = 3;
      const resultados = [];
      for (let i = 0; i < numeros.length; i += BATCH_SIZE) {
        const lote = numeros.slice(i, i + BATCH_SIZE);
        const loteResultados = await Promise.allSettled(
          lote.map(num => buscarNF(num, accessToken))
        );
        for (const r of loteResultados) {
          if (r.status === "fulfilled" && r.value) {
            resultados.push(r.value);
          }
        }
      }

      return res.status(200).json({ notas: resultados, total: resultados.length });
    }

    return res.status(405).json({ erro: "Método não permitido" });
  } catch {
    return res.status(500).json({ erro: "Erro interno do servidor." });
  }
}
