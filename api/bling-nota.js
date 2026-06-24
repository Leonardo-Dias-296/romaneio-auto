// api/bling-nota.js — Fetch NF data from Bling by invoice number
import { setCors, checkRateLimit } from "./lib/auth.js";
import { getValidToken, blingGet, getToken } from "./lib/bling.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(`bling:${ip}`, 10, 60000)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde 1 minuto." });
  }

  try {
    // Check if connected
    const token = await getToken();
    if (!token) {
      return res.status(400).json({ erro: "Bling não conectado. Clique em 'Conectar Bling' primeiro." });
    }

    const { numero } = JSON.parse(await new Promise((resolve, reject) => {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => resolve(body));
      req.on("error", reject);
    }));

    if (!numero || typeof numero !== "string" && typeof numero !== "number") {
      return res.status(400).json({ erro: "Número da nota fiscal é obrigatório." });
    }

    const accessToken = await getValidToken();
    if (!accessToken) {
      return res.status(401).json({ erro: "Token do Bling expirado. Reconecte." });
    }

    // Search for invoices by number
    const data = await blingGet(`/nfe/notas?numero=${numero}&limite=1`, accessToken);

    if (!data.data || data.data.length === 0) {
      return res.status(404).json({ erro: `NF número ${numero} não encontrada no Bling.` });
    }

    const nf = data.data[0];
    const nfId = nf.id;

    // Get full NF details
    const detail = await blingGet(`/nfe/notas/${nfId}`, accessToken);
    const nfData = detail.data || {};

    // Extract relevant fields for romaneio
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
  } catch (err) {
    console.error("[bling-nota]", err.message);
    if (err.message.includes("401") || err.message.includes("token")) {
      return res.status(401).json({ erro: "Token do Bling expirado. Reconecte." });
    }
    return res.status(500).json({ erro: `Erro ao buscar NF: ${err.message}` });
  }
}
