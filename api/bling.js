// api/bling.js — Bling API integration (OAuth 2.0 + NF search)
import crypto from "crypto";
import { setCors, checkRateLimit } from "./_lib/auth.js";
import { getBlingClientId, getValidToken, blingGet, getToken, exchangeCodeForTokens, deleteToken } from "./_lib/bling.js";

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

  // Log debug para entender a estrutura do destinatário
  console.log("[bling] nfData top keys:", Object.keys(nfData).join(", "));
  console.log("[bling] nfData.contato:", JSON.stringify(nfData.contato || "NOT_FOUND").substring(0, 500));
  console.log("[bling] nfData.chaveAcesso:", nfData.chaveAcesso || "NOT_FOUND");
  console.log("[bling] nfData.xml:", nfData.xml ? "present" : "NOT_FOUND");

  let qtdVolumes = (nfData.itens || []).reduce((s, i) => s + (parseInt(i.quantidade) || 1), 0);
  let pesoBruto = nfData.pesoBruto || null;
  let pesoLiquido = nfData.pesoLiquido || null;
  let numeroPedido = nfData.numeroPedidoLoja || null;
  let chaveAcesso = nfData.chaveAcesso || null;
  let urlChaveXml = null;

  // 4. Busca XML para peso/volumes/chaveAcesso
  if (nfData.xml) {
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
        // Extrai chave de acesso do XML (tag <chNFe>)
        if (!chaveAcesso) {
          const chMatch = xmlText.match(/<chNFe>(\d{44})<\/chNFe>/);
          if (chMatch) chaveAcesso = chMatch[1];
        }
        // Extrai urlChave do XML (tag <urlChave> dentro de <infNFeSupl>)
        const urlChaveMatch = xmlText.match(/<urlChave>(.*?)<\/urlChave>/);
        if (urlChaveMatch) urlChaveXml = urlChaveMatch[1].trim();
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
    nome_destinatario: nfData.contato?.nome || null,
    endereco_destinatario: null,
    chave_acesso: chaveAcesso,
    url_chave: urlChaveXml,
  };

  // Extrai endereço do destinatário (contato)
  const cli = nfData.contato || {};
  const endCli = cli.endereco || {};
  if (endCli) {
    const log = endCli.endereco || "";
    const num = endCli.numero || "";
    const bai = endCli.bairro || "";
    const cid = endCli.municipio || "";
    const uf = endCli.uf || "";
    if (log) result.endereco_destinatario = `${log}${num ? ", " + num : ""}${bai ? " - " + bai : ""}${cid ? " - " + cid : ""}${uf ? "/" + uf : ""}`;
  }

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

    // ── GET /api/bling?action=listNFs ──
    if (req.method === "GET" && action === "listNFs") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado." });
      try {
        const accessToken = await getValidToken();
        if (!accessToken) return res.status(401).json({ erro: "Token inválido." });

        const pagina = parseInt(url.searchParams.get("pagina")) || 1;
        const limite = 100;

        const listData = await blingGet(`/nfe?pagina=${pagina}&limite=${limite}`, accessToken);
        const notas = (listData.data || []).map(n => ({
          id: n.id,
          numero: n.numero || "",
          situacao: n.situacao || "",
          dataEmissao: n.dataEmissao || "",
          cliente: n.contato?.nome || "",
          valor: n.valorNota || 0,
          chaveAcesso: n.chaveAcesso || null,
          linkDanfe: n.linkDanfe || n.linkPDF || null,
        }));

        return res.status(200).json({
          notas,
          total: notas.length,
          pagina,
          temProxima: notas.length === limite,
        });
      } catch {
        return res.status(500).json({ erro: "Erro ao listar NFs." });
      }
    }

    // ── GET /api/bling?action=downloadDanfe&chaveAcesso=XXX&linkDanfe=YYY ──
    if (req.method === "GET" && action === "downloadDanfe") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado." });
      const chaveAcesso = url.searchParams.get("chaveAcesso");
      const linkDanfeParam = url.searchParams.get("linkDanfe");
      if (!chaveAcesso || !/^\d{44}$/.test(chaveAcesso)) {
        return res.status(400).json({ erro: "chaveAcesso inválida (44 dígitos)." });
      }
      try {
        const accessToken = await getValidToken();
        if (!accessToken) return res.status(401).json({ erro: "Token inválido." });
        const BLING_BASE_URL = process.env.BLING_BASE_URL || "https://api.bling.com.br/Api/v3";

        let pdfBuffer = null;
        const debug = [];

        // Helper to try fetching a URL and checking for PDF
        async function tryFetchPdf(fetchUrl, label, headers = {}) {
          try {
            const r = await fetch(fetchUrl, { method: "GET", headers, signal: AbortSignal.timeout(30000) });
            const ct = r.headers.get("content-type") || "";
            const buf = Buffer.from(await r.arrayBuffer());
            debug.push(`${label}: status=${r.status} ct=${ct} size=${buf.length} firstHex=${buf.slice(0, 4).toString("hex")}`);

            // 1. Check for raw PDF
            if (r.ok && buf.length > 100 && buf[0] === 0x25) {
              pdfBuffer = buf;
              return true;
            }

            // 2. Check for JSON with base64-encoded PDF (Bling v3 format: {"data": "<base64>"})
            if (r.ok && (ct.includes("json") || buf[0] === 0x7b)) {
              try {
                const j = JSON.parse(buf.toString("utf8"));
                debug.push(`${label} JSON keys: ${Object.keys(j).join(",")}`);

                // Try various paths to find base64 PDF string
                const candidates = [
                  typeof j.data === "string" ? j.data : null,
                  j.data?.documento,
                  j.data?.danfe,
                  j.data?.pdf,
                  j.documento,
                  j.danfe,
                  j.pdf,
                ];
                for (const c of candidates) {
                  if (c && typeof c === "string" && c.length > 100) {
                    const decoded = Buffer.from(c, "base64");
                    if (decoded.length > 100 && decoded[0] === 0x25) {
                      pdfBuffer = decoded;
                      debug.push(`${label} decoded base64 PDF: size=${decoded.length}`);
                      return true;
                    }
                  }
                }
                debug.push(`${label} JSON found but no valid PDF in candidates`);
              } catch {}
            }

            // 3. Check for raw base64 text
            if (r.ok && buf.length > 200) {
              const text = buf.toString("ascii").trim();
              if (/^[A-Za-z0-9+/=\s]{200,}$/.test(text)) {
                const decoded = Buffer.from(text.replace(/\s/g, ""), "base64");
                if (decoded.length > 100 && decoded[0] === 0x25) {
                  pdfBuffer = decoded;
                  debug.push(`${label} decoded raw base64: size=${decoded.length}`);
                  return true;
                }
              }
            }

            return false;
          } catch (e) {
            debug.push(`${label}: error=${e.message}`);
            return false;
          }
        }

        // 1. Try linkDanfe URL from frontend
        if (linkDanfeParam) {
          if (await tryFetchPdf(linkDanfeParam, "linkDanfe_direct", { Authorization: `Bearer ${accessToken}` })) {
            // success
          }
        }

        // 2. Lookup NF from list to get linkDanfe
        if (!pdfBuffer) {
          try {
            const nfList = await blingGet(`/nfe?pagina=1&limite=100`, accessToken);
            const nf = (nfList.data || []).find(n => n.chaveAcesso === chaveAcesso);
            debug.push(`nfList_lookup: found=${!!nf} linkDanfe=${nf?.linkDanfe || "null"} linkPDF=${nf?.linkPDF || "null"}`);
            if (nf && (nf.linkDanfe || nf.linkPDF)) {
              await tryFetchPdf(nf.linkDanfe || nf.linkPDF, "linkDanfe_fromList", { Authorization: `Bearer ${accessToken}` });
            }
          } catch (e) {
            debug.push(`nfList_lookup: error=${e.message}`);
          }
        }

        // 3. Try /nfe/{id} detail endpoint for linkDanfe
        if (!pdfBuffer) {
          try {
            const nfList = await blingGet(`/nfe?pagina=1&limite=100`, accessToken);
            const nf = (nfList.data || []).find(n => n.chaveAcesso === chaveAcesso);
            if (nf?.id) {
              const detail = await blingGet(`/nfe/${nf.id}`, accessToken);
              const nfData = detail.data || {};
              debug.push(`nfDetail: linkDanfe=${nfData.linkDanfe || "null"} linkPDF=${nfData.linkPDF || "null"} keys=${Object.keys(nfData).join(",")}`);
              if (nfData.linkDanfe || nfData.linkPDF) {
                await tryFetchPdf(nfData.linkDanfe || nfData.linkPDF, "linkDanfe_fromDetail", { Authorization: `Bearer ${accessToken}` });
              }
            }
          } catch (e) {
            debug.push(`nfDetail: error=${e.message}`);
          }
        }

        // 4. Last resort: /nfe/documento endpoint
        if (!pdfBuffer) {
          await tryFetchPdf(`${BLING_BASE_URL}/nfe/documento/${chaveAcesso}?formato=pdf`, "nfe_documento", {
            Authorization: `Bearer ${accessToken}`,
            "enable-jwt": "1",
            Accept: "1.0",
          });
        }

        if (!pdfBuffer || pdfBuffer.length < 100 || pdfBuffer[0] !== 0x25) {
          return res.status(400).json({ erro: "Não foi possível obter o PDF da DANFE.", debug });
        }

        const filename = `DANFE_${chaveAcesso}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.status(200).send(pdfBuffer);
      } catch (e) {
        return res.status(500).json({ erro: "Erro ao baixar DANFE: " + e.message });
      }
    }

    // ── GET /api/bling?action=downloadDanfeBatch ──
    if (req.method === "GET" && action === "downloadDanfeBatch") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado." });
      const chavesParam = url.searchParams.get("chaves");
      if (!chavesParam) return res.status(400).json({ erro: "Parâmetro 'chaves' obrigatório." });
      const chaves = chavesParam.split(",").map(s => s.trim()).filter(s => /^\d{44}$/.test(s));
      if (chaves.length === 0) return res.status(400).json({ erro: "Nenhuma chave válida." });
      if (chaves.length > 20) return res.status(400).json({ erro: "Máximo 20 NFs por vez." });
      try {
        const accessToken = await getValidToken();
        if (!accessToken) return res.status(401).json({ erro: "Token inválido." });
        const BLING_BASE_URL = process.env.BLING_BASE_URL || "https://api.bling.com.br/Api/v3";
        const results = [];
        for (const chave of chaves) {
          try {
            const r = await fetch(`${BLING_BASE_URL}/nfe/documento/${chave}?formato=pdf`, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "enable-jwt": "1",
                Accept: "1.0",
              },
              signal: AbortSignal.timeout(20000),
            });
            if (r.ok) {
              const buffer = Buffer.from(await r.arrayBuffer());
              results.push({ chave, ok: true, pdf: buffer.toString("base64") });
            } else {
              results.push({ chave, ok: false, erro: `HTTP ${r.status}` });
            }
          } catch (e) {
            results.push({ chave, ok: false, erro: e.message });
          }
        }
        return res.status(200).json({ results });
      } catch (e) {
        return res.status(500).json({ erro: "Erro ao baixar DANFEs: " + e.message });
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
