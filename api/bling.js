// api/bling.js — Bling API integration (OAuth 2.0 + NF search)
import crypto from "crypto";
import { setCors, checkRateLimit } from "./lib/auth.js";
import { getBlingClientId, getValidToken, blingGet, getToken, exchangeCodeForTokens, deleteToken } from "./lib/bling.js";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`bling:${ip}`, 10, 60000)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde 1 minuto." });
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const action = url.searchParams.get("action") || "status";

    // ── GET /api/bling?action=auth → redirect to Bling OAuth ──
    if (req.method === "GET" && action === "auth") {
      const clientId = getBlingClientId();
      if (!clientId) return res.status(500).json({ erro: "BLING_CLIENT_ID não configurado" });
      // Gera state aleatório para prevenir CSRF
      const state = crypto.randomBytes(16).toString("hex");
      // Armazena state em cookie HttpOnly com expiração de 10 min
      res.setHeader("Set-Cookie", `bling_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&state=${state}`;
      return res.redirect(authUrl);
    }

    // ── GET /api/bling?action=callback → handle OAuth callback ──
    if (req.method === "GET" && action === "callback") {
      const { code, error, state } = Object.fromEntries(url.searchParams);
      if (error) return res.redirect("/?bling=error");
      if (!code) return res.redirect("/?bling=error");

      // Valida state CSRF
      const cookieHeader = req.headers.cookie || "";
      const cookies = Object.fromEntries(cookieHeader.split(";").map(c => c.trim().split("=")).filter(c => c.length === 2));
      const savedState = cookies.bling_oauth_state;
      if (!savedState || savedState !== state) {
        return res.redirect("/?bling=error");
      }
      // Limpa o cookie do state
      res.setHeader("Set-Cookie", "bling_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");

      try {
        await exchangeCodeForTokens(code);
        return res.redirect("/?bling=success");
      } catch {
        return res.redirect("/?bling=error");
      }
    }

    // ── GET /api/bling?action=status → check if connected ──
    if (req.method === "GET" && action === "status") {
      const token = await getToken();
      return res.status(200).json({ connected: !!token });
    }

    // ── GET /api/bling?action=disconnect → remove token ──
    if (req.method === "GET" && action === "disconnect") {
      await deleteToken();
      return res.status(200).json({ ok: true });
    }

    // ── GET /api/bling?action=test → test Bling API connection ──
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

    // ── POST /api/bling → search NF by number ──
    if (req.method === "POST") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado. Clique em 'Conectar Bling' primeiro." });

      let body = "";
      for await (const chunk of req) body += chunk;
      if (body.length > 500) return res.status(400).json({ erro: "Dados inválidos." });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return res.status(400).json({ erro: "JSON inválido." }); }
      const { numero } = parsed;

      if (!numero) return res.status(400).json({ erro: "Número da nota fiscal é obrigatório." });
      const numStr = String(numero).trim();
      if (numStr.length > 20 || !/^\d+$/.test(numStr.replace(/\D/g, ""))) {
        return res.status(400).json({ erro: "Número inválido." });
      }

      const accessToken = await getValidToken();
      if (!accessToken) return res.status(401).json({ erro: "Token do Bling expirado. Reconecte." });

      // Busca NFs e filtra pelo número
      const numBusca = numStr.replace(/\D/g, "").replace(/^0+/, "") || numStr.replace(/\D/g, "");
      let nfEncontrada = null;
      for (let pagina = 1; pagina <= 10; pagina++) {
        try {
          const listData = await blingGet(`/nfe?pagina=${pagina}&limite=100`, accessToken);
          if (!listData.data || listData.data.length === 0) break;
          nfEncontrada = listData.data.find(n => {
            const numApi = String(n.numero || "").replace(/\D/g, "").replace(/^0+/, "");
            return numApi === numBusca || String(n.numero) === numStr;
          });
          if (nfEncontrada) break;
          if (listData.data.length < 100) break;
        } catch {
          return res.status(500).json({ erro: "Erro ao listar NFs do Bling." });
        }
      }

      if (!nfEncontrada) {
        return res.status(404).json({ erro: "NF não encontrada no Bling." });
      }

      const detail = await blingGet(`/nfe/${nfEncontrada.id}`, accessToken);
      const nfData = detail.data || {};

      const transp = nfData.transporte || {};
      const transportador = transp.transportador || {};

      // Busca volumes e peso do XML da NF-e (campo mais confiável)
      let qtdVolumes = (nfData.itens || []).reduce((s, i) => s + (parseInt(i.quantidade) || 1), 0);
      let pesoBruto = nfData.pesoBruto || null;
      let pesoLiquido = nfData.pesoLiquido || null;
      let numeroPedido = nfData.numeroPedidoLoja || null;
      const xmlUrl = nfData.xml || null;
      if (xmlUrl) {
        try {
          const xmlRes = await fetch(xmlUrl, { signal: AbortSignal.timeout(10000) });
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
            if (!numeroPedido) {
              const pedMatch = xmlText.match(/<xPed>(\d+)<\/xPed>/);
              if (pedMatch) numeroPedido = pedMatch[1];
            }
          }
        } catch {}
      }

      // Busca pedido de venda vinculado à NF (cruza por cliente + produto)
      if (!numeroPedido) {
        try {
          const contatoId = nfEncontrada.contato?.id || nfData.contato?.id || null;
          const dataEmissao = (nfData.dataEmissao || "").substring(0, 10);
          const nfDescricao = ((nfData.itens || [])[0]?.descricao || "").toLowerCase().trim();
          const nfValor = (nfData.valorNota || 0);
          if (contatoId && dataEmissao && dataEmissao !== "0000-00-00") {
            const pedidos = await blingGet(`/pedidos/vendas?pagina=1&limite=100&idContato=${contatoId}&dataInicial=${dataEmissao}&dataFinal=${dataEmissao}`, accessToken);
            if (pedidos.data && pedidos.data.length > 0) {
              let bestMatch = null;
              for (const ped of pedidos.data) {
                try {
                  const pedDetalhe = await blingGet(`/pedidos/vendas/${ped.id}`, accessToken);
                  const pd = pedDetalhe.data || ped;
                  // Verifica se o pedido tem NF vinculada
                  const nfRef = pd.nfe || pd.notaFiscal || pd.nfes || null;
                  if (nfRef) {
                    const refNum = String(nfRef.numero || nfRef.id || nfRef.numeroNfe || "");
                    if (refNum === String(nfData.numero || "") || refNum === String(nfEncontrada.id || "")) {
                      bestMatch = pd;
                      break;
                    }
                  }
                  // Fallback: compara descrição do produto + valor
                  const pedDesc = ((pd.itens || [])[0]?.produto?.descricao || (pd.itens || [])[0]?.descricao || "").toLowerCase().trim();
                  const pedValor = pd.valorTotal || pd.valor || 0;
                  if (nfDescricao && pedDesc && nfDescricao.substring(0, 20) === pedDesc.substring(0, 20)) {
                    bestMatch = pd;
                    break;
                  }
                  if (nfValor && pedValor && Math.abs(nfValor - pedValor) < 1) {
                    bestMatch = pd;
                  }
                } catch {}
              }
              if (bestMatch) {
                numeroPedido = String(bestMatch.numero || "");
              }
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

      // Busca dados completos da transportadora via API de contatos do Bling
      const cnpjLimpo = (transportador.numeroDocumento || "").replace(/\D/g, "");
      if (cnpjLimpo && cnpjLimpo.length === 14 && accessToken) {
        try {
          const contatos = await blingGet(`/contatos?pagina=1&limite=100&tipoPessoa=J`, accessToken);
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
            }
          }
        } catch {}
      }

      // Fallback: busca endereço e telefone via ReceitaWS
      if ((!result.endereco_transp || !result.telefone_transp) && cnpjLimpo && cnpjLimpo.length === 14) {
        try {
          const rws = await fetch(`https://www.receitaws.com.br/v1/cnpj/${cnpjLimpo}`, { signal: AbortSignal.timeout(8000) });
          if (rws.ok) {
            const rwsData = await rws.json();
            if (rwsData.status !== "ERROR") {
              if (!result.endereco_transp) {
                const log = rwsData.logradouro || "";
                const num = rwsData.numero || "";
                const bai = rwsData.bairro || "";
                const cid = rwsData.municipio || "";
                const uf = rwsData.uf || "";
                if (log) result.endereco_transp = `${log}${num ? ", " + num : ""}${bai ? " - " + bai : ""}${cid ? " - " + cid : ""}${uf ? "/" + uf : ""}`;
                if (!result.cidade_transp && cid) result.cidade_transp = cid;
                if (!result.uf_transp && uf) result.uf_transp = uf;
              }
              if (!result.telefone_transp && rwsData.telefone) {
                const telMatch = rwsData.telefone.match(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g);
                if (telMatch) result.telefone_transp = telMatch[0];
              }
            }
          }
        } catch {}
      }

      return res.status(200).json(result);
    }

    return res.status(405).json({ erro: "Método não permitido" });
  } catch {
    return res.status(500).json({ erro: "Erro interno do servidor." });
  }
}
