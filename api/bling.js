// api/bling.js — Bling API integration (OAuth + fetch NF)
import { setCors, checkRateLimit } from "./lib/auth.js";
import { getBlingClientId, getBlingClientSecret, getValidToken, blingGet, getToken, exchangeCodeForTokens } from "./lib/bling.js";

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
      const authUrl = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${clientId}&state=xyz`;
      return res.redirect(authUrl);
    }

    // ── GET /api/bling?action=callback → handle OAuth callback ──
    if (req.method === "GET" && action === "callback") {
      const { code, error } = Object.fromEntries(url.searchParams);
      if (error) return res.redirect(`/?bling=error&msg=${encodeURIComponent(error)}`);
      if (!code) return res.redirect(`/?bling=error&msg=${encodeURIComponent("Código não recebido")}`);
      try {
        await exchangeCodeForTokens(code, req);
        return res.redirect(`/?bling=success`);
      } catch (err) {
        return res.redirect(`/?bling=error&msg=${encodeURIComponent(err.message)}`);
      }
    }

    // ── GET /api/bling?action=status → check if connected ──
    if (req.method === "GET" && action === "status") {
      const token = await getToken();
      return res.status(200).json({ connected: !!token });
    }

    // ── POST /api/bling → search NF by number ──
    if (req.method === "POST") {
      const token = await getToken();
      if (!token) return res.status(400).json({ erro: "Bling não conectado. Clique em 'Conectar Bling' primeiro." });

      let body = "";
      for await (const chunk of req) body += chunk;
      const { numero } = JSON.parse(body);

      if (!numero) return res.status(400).json({ erro: "Número da nota fiscal é obrigatório." });

      const accessToken = await getValidToken();
      if (!accessToken) return res.status(401).json({ erro: "Token do Bling expirado. Reconecte." });

      // Busca NFs e filtra pelo número
      let nfEncontrada = null;
      for (let pagina = 1; pagina <= 10; pagina++) {
        const listData = await blingGet(`/nfe?pagina=${pagina}&limite=100`, accessToken);
        if (!listData.data || listData.data.length === 0) break;
        nfEncontrada = listData.data.find(n => String(n.numero) === String(numero));
        if (nfEncontrada) break;
        if (listData.data.length < 100) break;
      }

      if (!nfEncontrada) {
        return res.status(404).json({ erro: `NF número ${numero} não encontrada no Bling.` });
      }

      const detail = await blingGet(`/nfe/${nfEncontrada.id}`, accessToken);
      const nfData = detail.data || {};

      const result = {
        numero_nf: nfData.numero || String(numero),
        transportadora: nfData.transp?.nome || null,
        cnpj_transp: nfData.transp?.cnpj || null,
        endereco_transp: nfData.transp?.endereco?.logradouro
          ? `${nfData.transp.endereco.logradouro}, ${nfData.transp.endereco.numero || ""} - ${nfData.transp.endereco.bairro || ""} - ${nfData.transp.endereco.cidade || ""}/${nfData.transp.endereco.uf || ""}`
          : null,
        cidade_transp: nfData.transp?.endereco?.cidade || null,
        uf_transp: nfData.transp?.endereco?.uf || null,
        telefone_transp: nfData.transp?.telefone || null,
        nome_motorista: nfData.transp?.motorista?.nome || null,
        cpf_motorista: nfData.transp?.motorista?.cpf || null,
        placa_veiculo: nfData.transp?.placa || null,
        data_retirada: nfData.data_saida ? new Date(nfData.data_saida).toLocaleDateString("pt-BR") : null,
        horario_retirada: nfData.data_saida ? new Date(nfData.data_saida).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : null,
        produtos: (nfData.itens || []).map(i => i.descricao || i.nome).join(", ") || null,
        quantidade_volumes: nfData.volumes ? String(nfData.volumes) : (nfData.itens || []).reduce((s, i) => s + (parseInt(i.quantidade) || 1), 0).toString(),
        numero_pedido: nfData.pedido?.numero || null,
        observacoes: nfData.obs_interna || nfData.obs || null,
      };

      return res.status(200).json(result);
    }

    return res.status(405).json({ erro: "Método não permitido" });
  } catch (err) {
    console.error("[bling]", err.message);
    if (err.message.includes("401") || err.message.includes("token")) {
      return res.status(401).json({ erro: "Token do Bling expirado. Reconecte." });
    }
    return res.status(500).json({ erro: `Erro: ${err.message}` });
  }
}
