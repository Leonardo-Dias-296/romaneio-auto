import { useState, useRef, useEffect } from "react";
import { signUp, signIn, signOut, getUser } from "./lib/supabase.js";

// Chama sempre /api/extrair — relativo ao domínio atual.
// Em dev (vercel dev): http://localhost:3000/api/extrair
// Em produção: https://seu-projeto.vercel.app/api/extrair
const API_URL = "/api/extrair";

const MAX_RETRIES = 3;
const FIELDS_PER_NF = ["numero_nf", "produtos", "quantidade_volumes", "numero_pedido", "observacoes"];

const REMETENTE = {
  razao_social: "SOLLARSUL ENERGIA SOLAR LTDA",
  cnpj: "42.366.377/0001-48",
  endereco: "ROD ALEIXO ROCHA DA SILVA, Nº 1320, PINHEIROS - TAQUARI/RS - CEP 95.860-000",
  telefone: "(51) 98034-5313",
};

// ── HTML sanitizer ─────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── PDF / Canvas helpers ───────────────────────────────────────
const SRI_HASHES = {
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js": "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js": "sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA==",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js": "sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js": "sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw==",
};
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    if (SRI_HASHES[src]) { s.integrity = SRI_HASHES[src]; s.crossOrigin = "anonymous"; }
    s.onload = resolve;
    s.onerror = () => reject(new Error("Falha ao carregar: " + src));
    document.head.appendChild(s);
  });
}
async function ensureLibs() {
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js");
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
}
async function elementToOutput(element, opts = {}) {
  await ensureLibs();
  const { scale = 2, pageSize } = opts;
  const canvas = await window.html2canvas(element, {
    scale,
    useCORS: true,
    backgroundColor: "#ffffff",
    logging: false,
  });

  const dataUrl = canvas.toDataURL("image/png");
  const { jsPDF } = window.jspdf;
  const pdf = pageSize && pageSize.widthMm && pageSize.heightMm
    ? new jsPDF({ orientation: "portrait", unit: "mm", format: [Number(pageSize.widthMm), Number(pageSize.heightMm)] })
    : new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 5; // mm
  // largura disponível para o conteúdo
  let contentW = pageW - margin * 2;
  // converte proporção do canvas para altura em mm
  let contentH = (canvas.height / canvas.width) * contentW;

  // Se a altura calculada extrapolar a altura imprimível, reduz proporcionalmente
  const maxContentH = pageH - margin * 2;
  if (contentH > maxContentH) {
    const scaleFactor = maxContentH / contentH;
    contentW = contentW * scaleFactor;
    contentH = contentH * scaleFactor;
  }

  // centraliza horizontalmente
  const x = (pageW - contentW) / 2;
  const y = margin;
  pdf.addImage(dataUrl, "PNG", x, y, contentW, contentH, "", "FAST");
  return { blob: pdf.output("blob"), dataUrl };
}
// ── PDF de etiquetas: 1 página por etiqueta (100x50mm) ──────────
async function generateEtiquetasPdf(labels, dados) {
  await ensureLibs();
  const { jsPDF } = window.jspdf;
  const ETIQUETA_W_MM = 100;
  const ETIQUETA_H_MM = 50;
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: [ETIQUETA_W_MM, ETIQUETA_H_MM] });

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-9999px;top:0;z-index:-1;width:378px;font-family:Arial,sans-serif;`;
  document.body.appendChild(container);

  for (let i = 0; i < labels.length; i++) {
    if (i > 0) pdf.addPage([ETIQUETA_W_MM, ETIQUETA_H_MM], "landscape");

    container.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.style.cssText = `width:378px;height:189px;background:#fff;font-family:Arial,sans-serif;`;

    const l = labels[i];
    const vol = l.volumeInNota + 1;
    const total = l.totalVolumesNota;
    const nf = l.nota.numero_nf || "—";
    const data = dados.data_retirada || "—";
    const transp = dados.transportadora || "—";
    const produtos = l.nota.produtos || dados.produtos || "Carga geral";
    const pedido = l.nota.numero_pedido || dados.numero_pedido || "";

    wrapper.innerHTML = `
      <div style="width:378px;height:189px;background:#fff;border:2px solid #000;display:flex;flex-direction:column;overflow:hidden;">
        <div style="border-bottom:2px solid #000;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-weight:900;font-size:15px;color:#000;">FRICLIM</div><div style="font-size:10px;color:#000;font-weight:700;letter-spacing:1px;text-transform:uppercase;">GRUPO SOLLAR SUL+</div></div>
          <div style="border:2px solid #000;border-radius:4px;padding:4px 10px;text-align:center;"><div style="font-size:8px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:1px;">VOLUME</div><div style="font-weight:900;font-size:24px;color:#000;line-height:1;">${escapeHtml(String(vol))}<span style="font-size:13px;font-weight:700;color:#000;">/${escapeHtml(String(total))}</span></div></div>
        </div>
        <div style="flex:1;padding:8px 12px;display:flex;flex-direction:column;gap:6px;">
          <div style="border-bottom:1px solid #CBD5E1;padding-bottom:5px;display:flex;justify-content:space-between;">
            <div><div style="font-size:9px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:1px;">Nota Fiscal</div><div style="font-size:15px;font-weight:900;color:#000;">NF-e ${escapeHtml(nf)}</div></div>
            <div style="text-align:right;"><div style="font-size:9px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:1px;">Data</div><div style="font-size:12px;font-weight:800;color:#000;">${escapeHtml(data)}</div></div>
          </div>
          <div><div style="font-size:9px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Transportadora</div><div style="font-size:13px;font-weight:800;color:#000;">${escapeHtml(transp)}</div></div>
          <div><div style="font-size:9px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:1px;margin-bottom:1px;">Produto(s)</div><div style="font-size:12px;font-weight:700;color:#000;line-height:1.3;">${escapeHtml(produtos)}</div></div>
          ${pedido ? `<div><div style="font-size:9px;font-weight:900;color:#000;text-transform:uppercase;letter-spacing:1px;margin-bottom:1px;">Pedido</div><div style="font-size:12px;font-weight:700;color:#000;">${escapeHtml(pedido)}</div></div>` : ""}
        </div>
        <div style="border-top:1px solid #CBD5E1;padding:3px 12px;display:flex;justify-content:space-between;">
          <span style="font-size:8px;color:#000;font-weight:700;">FRICLIM © ${new Date().getFullYear()}</span>
          <span style="font-size:8px;color:#000;font-weight:700;">Manuseie com cuidado</span>
        </div>
      </div>`;
    container.appendChild(wrapper);

    const canvas = await window.html2canvas(wrapper, { scale: 3, useCORS: true, backgroundColor: "#ffffff", logging: false, width: 378, windowWidth: 378 });
    const imgData = canvas.toDataURL("image/png");
    pdf.addImage(imgData, "PNG", 0, 0, ETIQUETA_W_MM, ETIQUETA_H_MM, "", "FAST");
  }

  document.body.removeChild(container);
  return { blob: pdf.output("blob") };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── UI Components ──────────────────────────────────────────────
function Field({ label, value, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.8px" }}>{label}</span>
      <input value={value || ""} onChange={e => onChange(e.target.value)}
        style={{ border: "1px solid #CBD5E1", borderRadius: 6, padding: "9px 12px", fontSize: 14, fontWeight: 500, color: "#0F172A", background: "#fff", fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" }}
        onFocus={e => e.target.style.borderColor = "#94A3B8"}
        onBlur={e => e.target.style.borderColor = "#CBD5E1"} />
    </div>
  );
}
function Btn({ children, onClick, busy, color = "#0F172A", textColor = "#fff" }) {
  return (
    <button onClick={onClick} disabled={busy}
      style={{ background: busy ? "#94A3B8" : color, color: textColor, border: "none", padding: "11px 22px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
      {busy ? "Gerando..." : children}
    </button>
  );
}

function PreviewModal({ imgDataUrl, pdfBlob, filename, onClose }) {
  const pdfUrl = imgDataUrl ? null : URL.createObjectURL(pdfBlob);
  function handlePrint() {
    const w = window.open("", "_blank");
    if (!w) { alert("Permita pop-ups para imprimir."); return; }
    if (imgDataUrl) {
      w.document.write(`<!DOCTYPE html><html><head><style>
        *{margin:0;padding:0;box-sizing:border-box;}body{background:#fff;}
        img{display:block;width:100%;height:auto;}
        @media print{
          @page{margin:3mm;size:A4;}
          html,body{height:100%;overflow:hidden;}
          img{width:100%!important;height:100%!important;object-fit:fill;}
        }
      </style></head><body><img src="${imgDataUrl}"/>
      </body></html>`);
    } else {
      w.document.write(`<!DOCTYPE html><html><head><style>
        *{margin:0;padding:0;}body{margin:0;}
        iframe{width:100%;height:100vh;border:none;}
      </style></head><body><iframe src="${pdfUrl}"></iframe>
      </body></html>`);
    }
    w.document.close();
    setTimeout(() => { try { w.print(); } catch {} }, imgDataUrl ? 300 : 500);
  }
  function handleClose() {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    onClose();
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 9999, display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#1E293B", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>Pré-visualização</span>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={handlePrint} style={{ background: "#fff", color: "#0F172A", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Imprimir</button>
          <button onClick={() => downloadBlob(pdfBlob, filename)} style={{ background: "#475569", color: "#fff", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Baixar PDF</button>
          <button onClick={handleClose} style={{ background: "rgba(255,255,255,.12)", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Fechar</button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", display: "flex", justifyContent: "center", padding: 24, background: "#374151" }}>
        {imgDataUrl
          ? <img src={imgDataUrl} alt="preview" style={{ maxWidth: 794, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,.5)", alignSelf: "flex-start" }} />
          : <iframe src={pdfUrl} style={{ width: "80%", height: "100%", border: "none", boxShadow: "0 8px 32px rgba(0,0,0,.5)" }} />
        }
      </div>
    </div>
  );
}

// ── Romaneio Document ──────────────────────────────────────────
function RomaneioDoc({ dados, forCapture, userEmail }) {
  const notas = dados.notas || [];
  const isMulti = notas.length > 1;
  const totalVolumes = notas.reduce((s, n) => s + (parseInt(n.quantidade_volumes) || 1), 0);
  const nfHeader = isMulti ? `${notas.length} Notas Fiscais` : (notas[0]?.numero_nf ? `NF-e ${notas[0].numero_nf}` : "Romaneio de Carga");
  const wrapRef = useRef(null);
  const innerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!forCapture || !wrapRef.current || !innerRef.current) return;
    const A4_HEIGHT = 1123;
    const contentH = innerRef.current.scrollHeight;
    setScale(contentH > A4_HEIGHT ? A4_HEIGHT / contentH : 1);
  }, [dados, forCapture]);

  const thStyle = { background: "#0F172A", color: "#fff", fontWeight: 700, fontSize: 11, padding: "6px 10px", textTransform: "uppercase", letterSpacing: "1.5px", textAlign: "left" };
  const labelStyle = { width: "34%", padding: "6px 10px", fontWeight: 800, fontSize: 12, color: "#000", background: "#F1F5F9", borderRight: "1px solid #CBD5E1", borderBottom: "1px solid #CBD5E1", whiteSpace: "nowrap" };
  const valueStyle = { padding: "6px 10px", fontSize: 12, color: "#000", borderBottom: "1px solid #CBD5E1", fontWeight: 700, wordBreak: "break-word" };

  const Section = ({ title }) => <tr><td colSpan={2} style={thStyle}>{title}</td></tr>;
  const Row = ({ label, value }) => <tr><td style={labelStyle}>{label}</td><td style={valueStyle}>{value || "\u00A0"}</td></tr>;

  const inner = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, paddingBottom: 10, borderBottom: "2px solid #0F172A", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1, display: "flex", gap: 12, alignItems: "center" }}>
          <img src="/image.png" alt="Logo" style={{ height: forCapture ? 80 : 110, objectFit: "contain", flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: forCapture ? 16 : 17, fontWeight: 900, color: "#000" }}>SOLLARSUL ENERGIA SOLAR LTDA</div>
            <div style={{ fontSize: forCapture ? 11 : 12, color: "#1E293B", fontWeight: 700, marginTop: 2 }}>CNPJ: {REMETENTE.cnpj}</div>
            <div style={{ fontSize: forCapture ? 11 : 12, color: "#1E293B", fontWeight: 700, marginTop: 1 }}>{REMETENTE.endereco}</div>
            <div style={{ fontSize: forCapture ? 11 : 12, color: "#1E293B", fontWeight: 700, marginTop: 1 }}>Tel: {REMETENTE.telefone}</div>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: forCapture ? 15 : 14, fontWeight: 900, color: "#000", textTransform: "uppercase" }}>Romaneio de Carga</div>
          <div style={{ fontSize: forCapture ? 11 : 12, color: "#1E293B", fontWeight: 700, marginTop: 2 }}>Comprovante de Retirada</div>
          <div style={{ marginTop: 6, display: "inline-block", border: "2px solid #0F172A", borderRadius: 4, padding: "3px 10px" }}>
            <span style={{ fontSize: forCapture ? 13 : 13, fontWeight: 900, color: "#000" }}>{nfHeader}</span>
          </div>
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #CBD5E1", flex: 1 }}>
        <tbody>
          <Section title="Dados da Transportadora" />
          <Row label="Transportadora:" value={dados.transportadora} />
          <Row label="CNPJ:" value={dados.cnpj_transp} />
          <Row label="Endereço:" value={dados.endereco_transp} />
          <Row label="Telefone:" value={dados.telefone_transp} />
          <Section title="Dados do Motorista" />
          <Row label="Nome:" value={dados.nome_motorista} />
          <Row label="CPF / RG:" value={dados.cpf_motorista} />
          <Row label="Placa do Veículo:" value={dados.placa_veiculo} />
          <Section title="Informações da Retirada" />
          <Row label="Data:" value={dados.data_retirada} />
          <Row label="Horário:" value={dados.horario_retirada} />
          <Row label="Observações:" value={dados.observacoes} />
          {isMulti ? (
            <>
              <Section title={`Notas Fiscais (${notas.length}) — Total de Volumes: ${totalVolumes}`} />
              <tr><td colSpan={2} style={{ padding: 0 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, width: "6%" }}>#</th>
                      <th style={{ ...thStyle, width: "20%" }}>NF-e</th>
                      <th style={{ ...thStyle, width: "40%" }}>Produto(s)</th>
                      <th style={{ ...thStyle, width: "14%" }}>Volumes</th>
                      <th style={{ ...thStyle, width: "20%" }}>Pedido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notas.map((n, i) => (
                      <tr key={i}>
                        <td style={{ ...valueStyle, textAlign: "center", fontWeight: 900 }}>{i + 1}</td>
                        <td style={{ ...valueStyle, fontWeight: 900 }}>{n.numero_nf || "—"}</td>
                        <td style={{ ...valueStyle, lineHeight: 1.3 }}>{n.produtos || "—"}</td>
                        <td style={{ ...valueStyle, textAlign: "center" }}>{n.quantidade_volumes || "1"}</td>
                        <td style={{ ...valueStyle }}>{n.numero_pedido || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </td></tr>
            </>
          ) : (
            <>
              <Row label="N. da NF:" value={notas[0]?.numero_nf} />
              <Row label="Pedido:" value={notas[0]?.numero_pedido} />
              <Section title="Descrição da Mercadoria" />
              <Row label="Produto(s):" value={notas[0]?.produtos} />
              <Row label="Quantidade de Volumes:" value={notas[0]?.quantidade_volumes} />
            </>
          )}
          <tr><td colSpan={2} style={thStyle}>Assinaturas</td></tr>
          <tr>
            <td colSpan={2} style={{ padding: 0, height: "100%" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", height: forCapture ? 130 : 80 }}>
                {["Assinatura do Motorista", "Assinatura do Responsável do CD"].map((label, i) => (
                  <div key={i} style={{ padding: forCapture ? "16px 16px 80px" : "14px 16px 60px", position: "relative", borderRight: i === 0 ? "1px solid #CBD5E1" : "none", display: "flex", alignItems: "flex-end" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#1E293B", textTransform: "uppercase", letterSpacing: .5 }}>{label}</span>
                    <div style={{ position: "absolute", bottom: 24, left: 16, right: 16, height: 1.5, background: "#0F172A" }} />
                  </div>
                ))}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", fontSize: 10, color: "#1E293B", fontWeight: 600, flexWrap: "wrap", gap: 4 }}>
        <span>SOLLARSUL ENERGIA SOLAR LTDA — Taquari/RS</span>
        {userEmail && <span>Gerado por: {userEmail}</span>}
        <span>Gerado em: {new Date().toLocaleString("pt-BR")}</span>
      </div>
    </div>
  );

  if (!forCapture) {
    return <div style={{ background: "#fff", border: "1px solid #CBD5E1", borderRadius: 10, overflow: "hidden" }}>{inner}</div>;
  }

  return (
    <div ref={wrapRef} style={{ width: 794, height: 1123, background: "#fff", fontFamily: "Arial, sans-serif", padding: 0, boxSizing: "border-box", overflow: "hidden", position: "relative" }}>
      <div ref={innerRef} style={{ transformOrigin: "top left", transform: `scale(${scale})`, width: 794, height: 1123 }}>
        {inner}
      </div>
    </div>
  );
}

// ── Etiqueta ───────────────────────────────────────────────────
// Dimensão real: 100mm x 50mm (proporção 2:1)
function Etiqueta({ nota, dados, volumeInNota, totalVolumesNota, forCapture }) {
  const size = forCapture
    ? { width: 378, height: 189, fontFamily: "Arial, sans-serif" }
    : { width: 378, height: 189, fontFamily: "Arial, sans-serif" };
  return (
    <div style={{ ...size, background: "#fff", border: "2px solid #000", borderRadius: forCapture ? 0 : 6, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ borderBottom: "2px solid #000", padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 15, color: "#000" }}>FRICLIM</div>
          <div style={{ fontSize: 10, color: "#000", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>GRUPO SOLLAR SUL+</div>
        </div>
        <div style={{ border: "2px solid #000", borderRadius: 4, padding: "4px 10px", textAlign: "center" }}>
          <div style={{ fontSize: 8, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: 1 }}>VOLUME</div>
          <div style={{ fontWeight: 900, fontSize: 24, color: "#000", lineHeight: 1 }}>
            {volumeInNota + 1}<span style={{ fontSize: 13, fontWeight: 700, color: "#000" }}>/{totalVolumesNota}</span>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ borderBottom: "1px solid #CBD5E1", paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: 1 }}>Nota Fiscal</div>
            <div style={{ fontSize: 15, fontWeight: 900, color: "#000" }}>NF-e {nota.numero_nf || "—"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: 1 }}>Data</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#000" }}>{dados.data_retirada || "—"}</div>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>Transportadora</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#000" }}>{dados.transportadora || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: 1, marginBottom: 1 }}>Produto(s)</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#000", lineHeight: 1.3 }}>{nota.produtos || "Carga geral"}</div>
        </div>
        {nota.numero_pedido && (
          <div>
            <div style={{ fontSize: 9, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: 1, marginBottom: 1 }}>Pedido</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#000" }}>{nota.numero_pedido}</div>
          </div>
        )}
      </div>
      <div style={{ borderTop: "1px solid #CBD5E1", padding: "3px 12px", display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 8, color: "#000", fontWeight: 700 }}>FRICLIM © {new Date().getFullYear()}</span>
        <span style={{ fontSize: 8, color: "#000", fontWeight: 700 }}>Manuseie com cuidado</span>
      </div>
    </div>
  );
}

function EtiquetasCapture({ dados }) {
  const notas = dados.notas || [];
  const labels = [];
  for (const nota of notas) {
    const vols = parseInt(nota.quantidade_volumes) || 1;
    for (let v = 0; v < vols; v++) {
      labels.push({ nota, volumeInNota: v, totalVolumesNota: vols });
    }
  }

  return (
    <div style={{ width: 794, background: "#fff", fontFamily: "Arial, sans-serif", padding: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {labels.map((l, i) => (
          <Etiqueta key={i} nota={l.nota} dados={dados} volumeInNota={l.volumeInNota} totalVolumesNota={l.totalVolumesNota} forCapture />
        ))}
      </div>
    </div>
  );
}

const isAdm = (u) => u && u.role === "admin";

// ── Main App ───────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState(1);
  const [tab, setTab] = useState("romaneio");
  const [pagePreset, setPagePreset] = useState("A4");
  const [customWidth, setCustomWidth] = useState(210);
  const [customHeight, setCustomHeight] = useState(297);
  const [dados, setDados] = useState({});
  const [tentativas, setTentativas] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [modoCadastro, setModoCadastro] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginSenha, setLoginSenha] = useState("");
  const [loginNome, setLoginNome] = useState("");
  const [loginErro, setLoginErro] = useState("");
  const [loginSucesso, setLoginSucesso] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [showSenha, setShowSenha] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMsg, setAdminMsg] = useState("");
  const [blingNumero, setBlingNumero] = useState("");
  const [blingBusy, setBlingBusy] = useState(false);
  const [blingProgress, setBlingProgress] = useState("");
  const [blingConnected, setBlingConnected] = useState(false);
  const [adminNovoEmail, setAdminNovoEmail] = useState("");
  const [adminNovoNome, setAdminNovoNome] = useState("");
  const [adminNovaSenha, setAdminNovaSenha] = useState("");
  const romaneioRef = useRef();
  const etiquetasRef = useRef();
  const fileRef = useRef();

  useEffect(() => { if (step === 3) ensureLibs().catch(() => {}); }, [step]);

  // Verifica sessão via cookie HttpOnly
  useEffect(() => {
    getUser().then(u => {
      setAuthUser(u || null);
      setAuthLoading(false);
    }).catch(() => { setAuthLoading(false); });
  }, []);

  // Verifica status do Bling (após callback OAuth)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const blingStatus = params.get("bling");
    if (blingStatus === "success") {
      setBlingConnected(true);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (blingStatus === "error") {
      alert("Erro ao conectar com Bling: " + (params.get("msg") || "desconhecido"));
      window.history.replaceState({}, "", window.location.pathname);
    }
    // Check if Bling is connected
    fetch("/api/bling?action=status")
      .then(r => r.json())
      .then(d => { if (d.connected) setBlingConnected(true); })
      .catch(() => {});
  }, []);

  // helper: current page size in mm
  function currentPageSize() {
    if (pagePreset === "custom") return { widthMm: Number(customWidth), heightMm: Number(customHeight) };
    if (pagePreset === "letter") return { widthMm: 216, heightMm: 279 };
    return { widthMm: 210, heightMm: 297 };
  }

  const nfSlug = (dados.notas && dados.notas.length === 1)
    ? (dados.notas[0].numero_nf || "").replace(/\D/g, "") || Date.now().toString().slice(-6)
    : (dados.notas && dados.notas.length > 1 ? "multi" + dados.notas.length : Date.now().toString().slice(-6));
  const totalLabels = (dados.notas || []).reduce((sum, n) => sum + (parseInt(n.quantidade_volumes) || 1), 0);

  async function handlePreview(ref, filename) {
    setBusy(true);
    try {
      const pageSize = currentPageSize();
      const scale = 3;
      const { blob, dataUrl } = await elementToOutput(ref.current, { scale, pageSize });
      setModal({ imgDataUrl: dataUrl, pdfBlob: blob, filename });
    } catch (err) { alert("Erro: " + err.message); }
    finally { setBusy(false); }
  }
  async function handleDownload(ref, filename) {
    setBusy(true);
    try {
      const pageSize = currentPageSize();
      const scale = 3;
      const { blob } = await elementToOutput(ref.current, { scale, pageSize });
      downloadBlob(blob, filename);
    } catch (err) { alert("Erro: " + err.message); }
    finally { setBusy(false); }
  }

  // ── Converte PDF para imagem (JPEG) antes de enviar ──────────
  async function pdfToImage(file) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        resolve(new File([blob], file.name.replace(/\.pdf$/i, ".jpg"), { type: "image/jpeg" }));
      }, "image/jpeg", 0.85);
    });
  }

  // ── Comprime imagem antes de enviar ──────────────────────────
  function compressImage(file) {
    return new Promise((resolve) => {
      if (!file.type.startsWith("image/")) {
        resolve(file);
        return;
      }
      try {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            try {
              const canvas = document.createElement("canvas");
              const MAX = 1024;
              let w = img.width, h = img.height;
              if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
              canvas.width = w;
              canvas.height = h;
              canvas.getContext("2d").drawImage(img, 0, 0, w, h);
              canvas.toBlob((blob) => {
                if (blob) {
                  resolve(new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }));
                } else {
                  resolve(file);
                }
              }, "image/jpeg", 0.8);
            } catch { resolve(file); }
          };
          img.onerror = () => resolve(file);
          img.src = e.target.result;
        };
        reader.onerror = () => resolve(file);
        reader.readAsDataURL(file);
      } catch { resolve(file); }
    });
  }

  // ── Envia 1 arquivo para /api/extrair, retorna dados parseados ─
  async function enviarUmArquivo(file, idx, total) {
    const isText = file.type === "text/plain" || file.name.endsWith(".txt") || file.name.endsWith(".xml");

    let fetchOpts;
    if (isText) {
      const texto = await file.text();
      fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto }),
      };
    } else {
      let sendFile = file;
      if (file.type === "application/pdf") {
        setStatusMsg(`Convertendo PDF ${idx + 1}/${total} para imagem...`);
        sendFile = await pdfToImage(file);
      } else {
        sendFile = await compressImage(file);
      }
      const form = new FormData();
      form.append("arquivo", sendFile);
      fetchOpts = { method: "POST", body: form };
    }

    for (let i = 0; i < MAX_RETRIES; i++) {
      setTentativas(i + 1);
      if (i > 0) {
        const wait = i < 3 ? 2000 : 5000;
        setStatusMsg(`Arquivo ${idx + 1}/${total} — Tentativa ${i + 1}/${MAX_RETRIES}, aguardando ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
      setStatusMsg(`Processando arquivo ${idx + 1}/${total}... (tentativa ${i + 1}/${MAX_RETRIES})`);

      try {
        const res = await fetch(API_URL, fetchOpts);
        if ((res.status === 503 || res.status === 500) && i < MAX_RETRIES - 1) continue;
        if (!res.ok) {
          const err = await res.json().catch(() => ({ erro: res.statusText }));
          throw new Error(err.erro || `Erro HTTP ${res.status}`);
        }
        const parsed = await res.json();
        // Junta cidade/uf ao endereço da transportadora
        try {
          const cidade = parsed.cidade_transp && String(parsed.cidade_transp).trim();
          const uf = parsed.uf_transp && String(parsed.uf_transp).trim();
          let endereco = parsed.endereco_transp && String(parsed.endereco_transp).trim();
          if ((cidade || uf) && endereco) {
            const cidadeUf = [cidade, uf].filter(Boolean).join("/");
            if (!endereco.includes(cidade) && !endereco.includes(uf)) {
              endereco = `${endereco} - ${cidadeUf}`;
            }
            parsed.endereco_transp = endereco;
          }
        } catch (e) { /* ignore */ }
        // Limpa telefone — extrai apenas o primeiro número se a IA retornar múltiplos
        if (parsed.telefone_transp) {
          const match = String(parsed.telefone_transp).match(/\(?\d{2}\)?\s?\d{4,5}-?\d{4}/g);
          if (match) {
            let num = match[0].replace(/\D/g, "");
            if (num.length === 10) num = `(${num.slice(0, 2)}) ${num.slice(2, 6)}-${num.slice(6)}`;
            else if (num.length === 11) num = `(${num.slice(0, 2)}) ${num.slice(2, 7)}-${num.slice(7)}`;
            parsed.telefone_transp = num;
          }
        }
        // Descarta data/horário genéricos que a IA inventa
        if (parsed.data_retirada) {
          const d = String(parsed.data_retirada).trim();
          if (/^(01\/01\/\d{4}|DD\/MM\/AAAA|00\/00\/0000|data\s*da\s*retirada)/i.test(d)) {
            parsed.data_retirada = null;
          }
        }
        if (parsed.horario_retirada) {
          const h = String(parsed.horario_retirada).trim();
          if (/^(00:00|HH:MM|horário\s*da\s*retirada)/i.test(h)) {
            parsed.horario_retirada = null;
          }
        }
        return parsed;
      } catch (e) {
        if (i === MAX_RETRIES - 1) throw e;
      }
    }
  }

  // ── Processa 1 ou mais arquivos ─────────────────────────────
  async function processarArquivos(files) {
    setStep(2); setTentativas(0);
    try {
      const allNotas = [];
      let shared = {};

      const campoPrefixo = ["transportadora", "cnpj_transp", "endereco_transp", "cidade_transp", "uf_transp", "telefone_transp", "nome_motorista", "cpf_motorista", "placa_veiculo", "data_retirada", "horario_retirada"];

      for (let i = 0; i < files.length; i++) {
        setStatusMsg(`Processando arquivo ${i + 1}/${files.length}...`);
        const parsed = await enviarUmArquivo(files[i], i, files.length);
        // Tenta preencher shared de QUALQUER arquivo (primeiro valor não nulo)
        for (const chave of campoPrefixo) {
          if (!shared[chave] && parsed[chave]) {
            shared[chave] = parsed[chave];
          }
        }
        allNotas.push({
          numero_nf: parsed.numero_nf,
          produtos: parsed.produtos,
          quantidade_volumes: parsed.quantidade_volumes,
          numero_pedido: parsed.numero_pedido,
          observacoes: parsed.observacoes,
        });
      }

      // Busca telefone da transportadora — prioriza CNPJ (ReceitaWS = filial correta)
      if (shared.transportadora) {
        setStatusMsg("Buscando telefone da transportadora...");
        try {
          const telRes = await fetch("/api/buscar-telefone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transportadora: shared.transportadora,
              cnpj_transp: shared.cnpj_transp || "",
              cidade_transp: shared.cidade_transp || "",
              uf_transp: shared.uf_transp || "",
            }),
          });
          if (telRes.ok) {
            const telData = await telRes.json();
            if (telData.telefone) shared.telefone_transp = telData.telefone;
          }
        } catch {}
      }

      // Preenche data atual do computador como fallback
      if (!shared.data_retirada) shared.data_retirada = new Date().toLocaleDateString("pt-BR");

      setDados({ ...shared, notas: allNotas });
      setStep(3);
    } catch (err) { alert("Erro:\n" + err.message); setStep(1); }
  }

  // ── Busca NF(s) pelo número via API do Bling ────────────────────
  async function buscarNFBling() {
    if (!blingNumero.trim()) return;
    const numeros = blingNumero.split(/[,\s;]+/).map(s => s.trim()).filter(Boolean);
    if (numeros.length === 0) return;

    setBlingBusy(true);
    setBlingProgress(`Buscando ${numeros.length} nota(s)...`);
    let adicionadas = 0;

    try {
      const res = await fetch("/api/bling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numeros }),
      });
      const data = await res.json();

      if (!res.ok) {
        console.error("[bling] Erro:", data);
        setBlingProgress(data.erro || "Erro ao buscar notas");
        await new Promise(r => setTimeout(r, 2000));
        setBlingProgress("");
        setBlingBusy(false);
        return;
      }

      // Batch response: { notas: [...] }  —  ou single: { numero_nf: ... }
      const notas = data.notas || [data];

      for (const nfData of notas) {
        const shared = {};
        const campoPrefixo = ["transportadora", "cnpj_transp", "endereco_transp", "cidade_transp", "uf_transp", "telefone_transp", "nome_motorista", "cpf_motorista", "placa_veiculo", "data_retirada", "horario_retirada"];
        for (const chave of campoPrefixo) {
          if (nfData[chave]) shared[chave] = nfData[chave];
        }

        const nota = {
          numero_nf: nfData.numero_nf || "",
          produtos: nfData.produtos || "",
          quantidade_volumes: nfData.quantidade_volumes || "",
          numero_pedido: nfData.numero_pedido || "",
          observacoes: nfData.observacoes || "",
        };

        if (!shared.data_retirada) shared.data_retirada = new Date().toLocaleDateString("pt-BR");

        setDados(prev => {
          const notasExistentes = prev.notas || [];
          if (notasExistentes.some(n => n.numero_nf === nota.numero_nf)) return prev;
          const merged = { ...shared };
          for (const chave of campoPrefixo) {
            if (!merged[chave] && prev[chave]) merged[chave] = prev[chave];
          }
          return { ...prev, ...merged, notas: [...notasExistentes, nota] };
        });
        adicionadas++;
      }

      if (adicionadas > 0) {
        setBlingProgress(`${adicionadas} nota(s) adicionada(s) com sucesso!`);
        await new Promise(r => setTimeout(r, 1500));
      } else {
        setBlingProgress("Nenhuma nota encontrada");
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error("[bling] Erro geral:", err.message);
      setBlingProgress("Erro de conexão");
      await new Promise(r => setTimeout(r, 2000));
    }

    setBlingProgress("");
    setBlingNumero("");
    if (adicionadas > 0) setStep(3);
    setBlingBusy(false);
  }

  function upd(key, val) { setDados(prev => ({ ...prev, [key]: val })); }
  function updNota(idx, key, val) {
    setDados(prev => {
      const notas = [...(prev.notas || [])];
      notas[idx] = { ...notas[idx], [key]: val };
      return { ...prev, notas };
    });
  }
  function addNota() {
    setDados(prev => ({
      ...prev,
      notas: [...(prev.notas || []), { numero_nf: "", produtos: "", quantidade_volumes: "", numero_pedido: "", observacoes: "" }],
    }));
  }
  function removeNota(idx) {
    setDados(prev => ({
      ...prev,
      notas: prev.notas.filter((_, i) => i !== idx),
    }));
  }

  async function handleLogin() {
    setLoginErro(""); setLoginSucesso(""); setLoginBusy(true);
    try {
      const data = await signIn(loginEmail, loginSenha);
      setAuthUser(data.user || { email: loginEmail, role: "user" });
      setLoginEmail(""); setLoginSenha("");
    } catch (e) { setLoginErro(e.message || "Email ou senha inválidos."); }
    finally { setLoginBusy(false); }
  }

  async function handleCadastro() {
    setLoginErro(""); setLoginSucesso(""); setLoginBusy(true);
    try {
      await signUp(loginEmail, loginSenha, loginNome);
      setLoginSucesso("Conta criada! Verifique seu email para confirmar.");
      setLoginNome(""); setLoginEmail(""); setLoginSenha("");
    } catch (e) { setLoginErro(e.message || "Erro de conexão"); }
    finally { setLoginBusy(false); }
  }

  async function handleLogout() {
    await signOut();
    setAuthUser(null);
    setStep(1); setDados({});
  }

  // ── Admin functions ──────────────────────────────────────────
  async function adminFetch(path, opts = {}) {
    return fetch(path, { ...opts, credentials: "include", headers: { "Content-Type": "application/json", ...opts.headers } });
  }
  async function adminLoadUsers() {
    setAdminBusy(true); setAdminMsg("");
    try {
      const r = await adminFetch("/api/admin-users");
      const data = await r.json();
      if (!r.ok) { setAdminMsg(data.erro || "Erro ao carregar"); return; }
      setAdminUsers(data.users || []);
    } catch (e) { setAdminMsg(e.message); }
    finally { setAdminBusy(false); }
  }
  async function adminCreateUser() {
    if (!adminNovoEmail || !adminNovaSenha) { setAdminMsg("Email e senha obrigatórios"); return; }
    setAdminBusy(true); setAdminMsg("");
    try {
      const r = await adminFetch("/api/admin-users", { method: "POST", body: JSON.stringify({ email: adminNovoEmail, password: adminNovaSenha, nome: adminNovoNome }) });
      const data = await r.json();
      if (!r.ok) { setAdminMsg(data.erro || "Erro ao criar"); return; }
      setAdminMsg("Usuário criado com sucesso!");
      setAdminNovoEmail(""); setAdminNovoNome(""); setAdminNovaSenha("");
      adminLoadUsers();
    } catch (e) { setAdminMsg(e.message); }
    finally { setAdminBusy(false); }
  }
  async function adminDeleteUser(id, email) {
    if (!confirm(`Excluir o usuário ${email}?`)) return;
    setAdminBusy(true); setAdminMsg("");
    try {
      const r = await adminFetch(`/api/admin-users?id=${id}&email=${encodeURIComponent(email)}`, { method: "DELETE" });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setAdminMsg(d.erro || "Erro ao excluir"); return; }
      setAdminMsg("Usuário excluído!");
      adminLoadUsers();
    } catch (e) { setAdminMsg(e.message); }
    finally { setAdminBusy(false); }
  }

  const wizardSteps = ["Enviar NF", "Processando", "Resultado"];

  return (
    <div style={{ fontFamily: "'Inter', Arial, sans-serif", minHeight: "100vh", background: "#F1F5F9", color: "#0F172A", position: "relative" }}>
      <div style={{ position: "fixed", inset: 0, backgroundImage: "url(/image.png)", backgroundSize: "cover", backgroundPosition: "center", opacity: 0.08, pointerEvents: "none", zIndex: 0 }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {step === 3 && (() => {
        const pageSize = currentPageSize();
        const pxPerMm = 3.78;
        const cssWidth = Math.max(400, Math.round(pageSize.widthMm * pxPerMm));
        return (
          <>
            <div ref={romaneioRef} style={{ position: "absolute", left: -9999, top: 0, zIndex: -1, width: cssWidth }}>
              <RomaneioDoc dados={dados} forCapture userEmail={authUser?.email} />
            </div>
            <div ref={etiquetasRef} style={{ position: "absolute", left: -9999, top: 0, zIndex: -1, width: cssWidth }}>
              <EtiquetasCapture dados={dados} />
            </div>
          </>
        );
      })()}

      {modal && <PreviewModal imgDataUrl={modal.imgDataUrl} pdfBlob={modal.pdfBlob} filename={modal.filename} onClose={() => setModal(null)} />}

      {/* Tela de Login */}
      {!authUser && !authLoading && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A", position: "relative", zIndex: 1 }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: "40px 36px", width: 380, maxWidth: "90%", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
            <div style={{ textAlign: "center", marginBottom: 28 }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: "#0F172A" }}>RomaneioAuto</div>
              <div style={{ fontSize: 12, color: "#64748B", fontWeight: 600, marginTop: 4 }}>{modoCadastro ? "Crie sua conta" : "Faça login para continuar"}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {modoCadastro && (
                <div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.8px" }}>Nome</span>
                  <input value={loginNome} onChange={e => setLoginNome(e.target.value)} placeholder="Seu nome"
                    style={{ width: "100%", border: "1px solid #CBD5E1", borderRadius: 6, padding: "9px 12px", fontSize: 14, fontFamily: "inherit", outline: "none", marginTop: 4, boxSizing: "border-box" }}
                    onKeyDown={e => e.key === "Enter" && handleCadastro()} />
                </div>
              )}
              <div>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.8px" }}>Email</span>
                <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="seu@email.com"
                  style={{ width: "100%", border: "1px solid #CBD5E1", borderRadius: 6, padding: "9px 12px", fontSize: 14, fontFamily: "inherit", outline: "none", marginTop: 4, boxSizing: "border-box" }}
                  onKeyDown={e => e.key === "Enter" && (modoCadastro ? handleCadastro() : handleLogin())} />
              </div>
              <div>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.8px" }}>Senha</span>
                <div style={{ position: "relative", marginTop: 4 }}>
                  <input type={showSenha ? "text" : "password"} value={loginSenha} onChange={e => setLoginSenha(e.target.value)} placeholder="Sua senha"
                    style={{ width: "100%", border: "1px solid #CBD5E1", borderRadius: 6, padding: "9px 36px 9px 12px", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }}
                    onKeyDown={e => e.key === "Enter" && (modoCadastro ? handleCadastro() : handleLogin())} />
                  <button type="button" onClick={() => setShowSenha(!showSenha)}
                    style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", padding: 4, color: "#94A3B8", fontSize: 11, fontWeight: 700, fontFamily: "inherit", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                    {showSenha ? "OCULTAR" : "VER"}
                  </button>
                </div>
              </div>
              {loginErro && <div style={{ color: "#EF4444", fontSize: 12, fontWeight: 600, textAlign: "center" }}>{loginErro}</div>}
              {loginSucesso && <div style={{ color: "#16A34A", fontSize: 12, fontWeight: 600, textAlign: "center" }}>{loginSucesso}</div>}
              <button onClick={modoCadastro ? handleCadastro : handleLogin} disabled={loginBusy}
                style={{ background: loginBusy ? "#94A3B8" : "#0F172A", color: "#fff", border: "none", padding: "11px 0", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: loginBusy ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                {loginBusy ? (modoCadastro ? "Criando..." : "Entrando...") : (modoCadastro ? "Criar Conta" : "Entrar")}
              </button>
              <div style={{ textAlign: "center", marginTop: 4 }}>
                <span style={{ fontSize: 12, color: "#64748B" }}>
                  {modoCadastro ? "Já tem conta? " : "Não tem conta? "}
                </span>
                <button onClick={() => { setModoCadastro(!modoCadastro); setLoginErro(""); setLoginSucesso(""); }}
                  style={{ background: "none", border: "none", color: "#0F172A", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
                  {modoCadastro ? "Fazer login" : "Criar conta"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {authLoading && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A" }}>
          <div style={{ color: "#fff", fontSize: 15 }}>Carregando...</div>
        </div>
      )}

      {/* Header */}
      {authUser && (
      <div style={{ background: "#0F172A", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", position: "relative", zIndex: 1, minHeight: 56 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Grupo Sollar - Friclim</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {isAdm(authUser) && <button onClick={() => { if (tab === "admin") { setTab("romaneio"); } else { setTab("admin"); adminLoadUsers(); } }} style={{ background: tab === "admin" ? "#F59E0B" : "rgba(255,255,255,.1)", color: tab === "admin" ? "#000" : "#fff", border: "none", padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{tab === "admin" ? "Voltar" : "Admin"}</button>}
          <span style={{ color: "rgba(255,255,255,.7)", fontSize: 12, fontWeight: 500 }}>{authUser.user_metadata?.nome || authUser.email}</span>
          <button onClick={handleLogout} style={{ background: "rgba(255,255,255,.1)", color: "#fff", border: "none", padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Sair</button>
        </div>
      </div>
      )}

      {/* Conteúdo principal (só exibe se logado) */}
      {authUser && (
      <>
      {tab !== "admin" && (
      <div style={{ background: "#fff", borderBottom: "1px solid #E2E8F0", padding: "14px 28px", display: "flex", position: "relative", zIndex: 1 }}>
        {wizardSteps.map((s, i) => {
          const n = i + 1, done = step > n, active = step === n;
          return (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0, background: done || active ? "#0F172A" : "#fff", color: done || active ? "#fff" : "#94A3B8", border: `2px solid ${done || active ? "#0F172A" : "#E2E8F0"}` }}>{done ? "✓" : n}</div>
              <span style={{ fontSize: 12, fontWeight: 500, color: done || active ? "#0F172A" : "#94A3B8" }}>{s}</span>
              {i < 2 && <div style={{ flex: 1, height: 2, background: done ? "#0F172A" : "#E2E8F0", margin: "0 8px" }} />}
            </div>
          );
        })}
      </div>
      )}

      <div style={{ padding: 28, maxWidth: 1200, margin: "0 auto", position: "relative", zIndex: 1 }}>

        {/* STEP 1 */}
        {step === 1 && (
          <div>
            <div onClick={() => fileRef.current.click()}
              style={{ background: "#fff", border: "2px dashed #CBD5E1", borderRadius: 12, padding: "72px 32px", textAlign: "center", cursor: "pointer", transition: "border-color .2s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#64748B"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#CBD5E1"}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#0F172A", marginBottom: 8 }}>Envie as Notas Fiscais</div>
              <p style={{ fontSize: 14, color: "#64748B", marginBottom: 24 }}>Selecione 1 ou mais arquivos — o sistema gera um romaneio único com todas as NFs</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 24, flexWrap: "wrap" }}>
                {["PDF", "PNG", "JPG", "TXT", "XML"].map(f => <span key={f} style={{ background: "#F1F5F9", color: "#475569", fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 5, border: "1px solid #E2E8F0" }}>{f}</span>)}
              </div>
              <div style={{ background: "#0F172A", color: "#fff", display: "inline-block", padding: "12px 28px", borderRadius: 8, fontSize: 14, fontWeight: 700 }}>Selecionar Arquivo</div>
              <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.txt,.xml" multiple style={{ display: "none" }} onChange={e => { const f = Array.from(e.target.files || []); if (f.length) processarArquivos(f); }} />
            </div>
            <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 280, background: "#fff", border: "1px solid #E2E8F0", borderRadius: 10, padding: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Buscar NF pelo Bling</div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 4 }}>Número da NF</div>
                    <input value={blingNumero} onChange={e => setBlingNumero(e.target.value)}
                      placeholder="Ex: 723, 724, 725"
                      onKeyDown={e => e.key === "Enter" && buscarNFBling()}
                      style={{ width: "100%", border: "1px solid #CBD5E1", borderRadius: 6, padding: "9px 12px", fontSize: 14, fontWeight: 500, color: "#0F172A", background: "#fff", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
                    <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 3 }}>Separe por vírgula, espaço ou ponto e vírgula para buscar várias</div>
                  </div>
                  <button onClick={buscarNFBling} disabled={blingBusy || !blingNumero.trim()}
                    style={{ background: blingBusy ? "#94A3B8" : "#16A34A", color: "#fff", border: "none", padding: "10px 18px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: blingBusy ? "not-allowed" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                    {blingBusy ? "Buscando..." : "Buscar"}
                  </button>
                </div>
                {blingProgress && (
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: "#2563EB" }}>{blingProgress}</div>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center" }}>
                  {blingConnected ? (
                    <>
                      <span style={{ fontSize: 11, color: "#16A34A", fontWeight: 700 }}>✓ Bling conectado</span>
                      <a onClick={async () => { await fetch("/api/bling?action=disconnect"); setBlingConnected(false); }} style={{ fontSize: 11, color: "#EF4444", fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>Reconectar</a>
                    </>
                  ) : (
                    <a href="/api/bling?action=auth" style={{ fontSize: 11, color: "#2563EB", fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>Conectar Bling</a>
                  )}
                  {blingConnected && (
                    <a href="/api/bling?action=test" target="_blank" style={{ fontSize: 11, color: "#64748B", textDecoration: "underline", cursor: "pointer" }}>Testar conexão</a>
                  )}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 20, background: "#fff", border: "1px solid #E2E8F0", borderRadius: 10, padding: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Remetente pré-configurado</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 13 }}>
                <div><span style={{ color: "#64748B" }}>Empresa: </span><span style={{ fontWeight: 600 }}>{REMETENTE.razao_social}</span></div>
                <div><span style={{ color: "#64748B" }}>CNPJ: </span><span>{REMETENTE.cnpj}</span></div>
                <div style={{ gridColumn: "1/-1" }}><span style={{ color: "#64748B" }}>Endereço: </span><span>{REMETENTE.endereco}</span></div>
                <div><span style={{ color: "#64748B" }}>Telefone: </span><span>{REMETENTE.telefone}</span></div>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #E2E8F0", padding: "64px 32px", textAlign: "center" }}>
            <div style={{ width: 64, height: 64, border: "4px solid #E2E8F0", borderTopColor: "#0F172A", borderRadius: "50%", margin: "0 auto 24px", animation: "spin 1s linear infinite" }} />
            <div style={{ fontSize: 17, fontWeight: 700, color: "#0F172A", marginBottom: 10 }}>{statusMsg}</div>
            <div style={{ fontSize: 13, color: "#64748B", marginBottom: 20 }}>Tentativa {tentativas} de {MAX_RETRIES}</div>
            <div style={{ width: "100%", height: 5, background: "#E2E8F0", borderRadius: 3, overflow: "hidden", marginBottom: 14 }}>
              <div style={{ height: "100%", background: "#0F172A", width: `${(tentativas / MAX_RETRIES) * 100}%`, transition: "width .3s" }} />
            </div>
            <div style={{ fontSize: 12, color: "#94A3B8" }}>Pode levar alguns segundos...</div>
          </div>
        )}

        {/* STEP 3 */}
        {step === 3 && tab !== "admin" && (
          <div>
            <div style={{ display: "flex", gap: 0, marginBottom: 24, background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, padding: 3, width: "fit-content" }}>
              {[["romaneio", "Romaneio"], ["etiquetas", `Etiquetas (${totalLabels})`]].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)}
                  style={{ padding: "9px 22px", borderRadius: 6, border: "none", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", background: tab === id ? "#0F172A" : "transparent", color: tab === id ? "#fff" : "#64748B", transition: "all .15s" }}>
                  {label}
                </button>
              ))}
            </div>

            {tab === "romaneio" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
                <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", overflow: "hidden" }}>
                  <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>Dados Extraídos</span>
                    <span style={{ background: "#F0FDF4", color: "#16A34A", fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 20, border: "1px solid #BBF7D0" }}>Extraído</span>
                  </div>
                    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, maxHeight: 600, overflowY: "auto" }}>
                    <Field label="Transportadora" value={dados.transportadora} onChange={v => upd("transportadora", v)} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label="CNPJ" value={dados.cnpj_transp} onChange={v => upd("cnpj_transp", v)} />
                      <Field label="Telefone" value={dados.telefone_transp} onChange={v => upd("telefone_transp", v)} />
                    </div>
                    <Field label="Endereço" value={dados.endereco_transp} onChange={v => upd("endereco_transp", v)} />
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, paddingTop: 4 }}>Motorista</div>
                    <Field label="Nome do Motorista" value={dados.nome_motorista} onChange={v => upd("nome_motorista", v)} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label="CPF / RG" value={dados.cpf_motorista} onChange={v => upd("cpf_motorista", v)} />
                      <Field label="Placa do Veículo" value={dados.placa_veiculo} onChange={v => upd("placa_veiculo", v)} />
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, paddingTop: 4 }}>Retirada</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label="Data" value={dados.data_retirada} onChange={v => upd("data_retirada", v)} />
                      <Field label="Horário" value={dados.horario_retirada} onChange={v => upd("horario_retirada", v)} />
                    </div>
                    <Field label="Observações" value={dados.observacoes} onChange={v => upd("observacoes", v)} />

                    <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, paddingTop: 8, borderTop: "1px solid #E2E8F0" }}>
                      Notas Fiscais ({(dados.notas || []).length})
                    </div>
                    {(dados.notas || []).map((nota, idx) => (
                      <div key={idx} style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10, position: "relative" }}>
                        {(dados.notas || []).length > 1 && (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#0F172A" }}>NF #{idx + 1}</span>
                            <button onClick={() => removeNota(idx)} style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 18, fontWeight: 700, padding: 0, lineHeight: 1 }}>×</button>
                          </div>
                        )}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <Field label="N. da NF" value={nota.numero_nf} onChange={v => updNota(idx, "numero_nf", v)} />
                          <Field label="Pedido" value={nota.numero_pedido} onChange={v => updNota(idx, "numero_pedido", v)} />
                        </div>
                        <Field label="Produto(s)" value={nota.produtos} onChange={v => updNota(idx, "produtos", v)} />
                        <Field label="Qtd de Volumes" value={nota.quantidade_volumes} onChange={v => updNota(idx, "quantidade_volumes", v)} />
                      </div>
                    ))}
                    <button onClick={addNota}
                      style={{ background: "#F1F5F9", border: "2px dashed #CBD5E1", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 600, color: "#475569", cursor: "pointer", fontFamily: "inherit" }}>
                      + Adicionar Nota Fiscal
                    </button>
                  </div>
                </div>
                <RomaneioDoc dados={dados} userEmail={authUser?.email} />
                <div style={{ gridColumn: "1/-1", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 12, color: "#64748B", fontWeight: 700 }}>Tamanho da página:</div>
                    <select value={pagePreset} onChange={e => setPagePreset(e.target.value)} style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid #E2E8F0", background: "#fff" }}>
                      <option value="A4">A4 (210×297 mm)</option>
                      <option value="letter">Letter (216×279 mm)</option>
                      <option value="custom">Custom (mm)</option>
                    </select>
                    {pagePreset === "custom" && (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input value={customWidth} onChange={e => setCustomWidth(e.target.value)} style={{ width: 64, padding: "6px 8px", borderRadius: 6, border: "1px solid #E2E8F0" }} />
                        <span style={{ color: "#64748B" }}>×</span>
                        <input value={customHeight} onChange={e => setCustomHeight(e.target.value)} style={{ width: 64, padding: "6px 8px", borderRadius: 6, border: "1px solid #E2E8F0" }} />
                        <span style={{ color: "#94A3B8", fontSize: 12 }}>mm</span>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
                    <Btn busy={busy} onClick={() => handlePreview(romaneioRef, `romaneio-${nfSlug}.pdf`)}>Visualizar / Imprimir</Btn>
                    <Btn busy={busy} color="#334155" onClick={() => handleDownload(romaneioRef, `romaneio-${nfSlug}.pdf`)}>Baixar PDF</Btn>
                  </div>
                  <Btn color="#F1F5F9" textColor="#0F172A" onClick={() => { setStep(1); setDados({}); }}>Novo Romaneio</Btn>
                </div>
              </div>
            )}

            {tab === "etiquetas" && (
              <div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 20, justifyContent: "center" }}>
                  {(() => {
                    const notas = dados.notas || [];
                    return notas.flatMap((nota, notaIdx) => {
                      const vols = parseInt(nota.quantidade_volumes) || 1;
                      return Array.from({ length: vols }, (_, v) => (
                        <Etiqueta key={`${notaIdx}-${v}`} nota={nota} dados={dados} volumeInNota={v} totalVolumesNota={vols} />
                      ));
                    });
                  })()}
                </div>
                <div style={{ background: "#fff", border: "1px solid #E2E8F0", borderRadius: 8, padding: "11px 16px", marginBottom: 18, fontSize: 13, color: "#475569" }}>
                  {totalLabels} etiqueta{totalLabels !== 1 ? "s" : ""} — volumes numerados por NF (ex: NF1 1/3, NF2 1/1).
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <Btn busy={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      const labels = [];
                      const notas = dados.notas || [];
                      for (const nota of notas) {
                        const vols = parseInt(nota.quantidade_volumes) || 1;
                        for (let v = 0; v < vols; v++) labels.push({ nota, volumeInNota: v, totalVolumesNota: vols });
                      }
                      const { blob } = await generateEtiquetasPdf(labels, dados);
                      const dataUrl = URL.createObjectURL(blob);
                      setModal({ imgDataUrl: null, pdfBlob: blob, filename: `etiquetas-${nfSlug}.pdf`, pdfUrl: dataUrl });
                    } catch (err) { alert("Erro: " + err.message); }
                    finally { setBusy(false); }
                  }}>Visualizar / Imprimir Etiquetas</Btn>
                  <Btn busy={busy} color="#334155" onClick={async () => {
                    setBusy(true);
                    try {
                      const labels = [];
                      const notas = dados.notas || [];
                      for (const nota of notas) {
                        const vols = parseInt(nota.quantidade_volumes) || 1;
                        for (let v = 0; v < vols; v++) labels.push({ nota, volumeInNota: v, totalVolumesNota: vols });
                      }
                      const { blob } = await generateEtiquetasPdf(labels, dados);
                      downloadBlob(blob, `etiquetas-${nfSlug}.pdf`);
                    } catch (err) { alert("Erro: " + err.message); }
                    finally { setBusy(false); }
                  }}>Baixar PDF das Etiquetas</Btn>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Admin Panel (independente do step) */}
        {tab === "admin" && isAdm(authUser) && (
          <div>
            <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", overflow: "hidden" }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#0F172A" }}>Gerenciar Usuários</span>
                <span style={{ fontSize: 12, color: "#64748B" }}>{adminUsers.length} usuário(s)</span>
              </div>
              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>Criar novo usuário</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                    <Field label="Nome" value={adminNovoNome} onChange={setAdminNovoNome} />
                    <div></div>
                    <Field label="Email" value={adminNovoEmail} onChange={setAdminNovoEmail} />
                    <Field label="Senha" value={adminNovaSenha} onChange={setAdminNovaSenha} />
                  </div>
                  <button onClick={adminCreateUser} disabled={adminBusy}
                    style={{ background: "#16A34A", color: "#fff", border: "none", padding: "9px 20px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: adminBusy ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                    {adminBusy ? "Criando..." : "Criar Usuário"}
                  </button>
                </div>
                {adminMsg && <div style={{ color: adminMsg.includes("sucesso") || adminMsg.includes("excluído") ? "#16A34A" : "#EF4444", fontSize: 12, fontWeight: 600 }}>{adminMsg}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {adminUsers.map(u => (
                    <div key={u.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 8, padding: "10px 16px" }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#0F172A" }}>{u.user_metadata?.nome || "Sem nome"}</div>
                        <div style={{ fontSize: 11, color: "#64748B" }}>{u.email} {isAdm(u) && <span style={{ background: "#FEF3C7", color: "#92400E", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, marginLeft: 6 }}>ADMIN</span>}</div>
                      </div>
                      {!isAdm(u) && <button onClick={() => adminDeleteUser(u.id, u.email)} disabled={adminBusy} style={{ background: "#FEE2E2", color: "#DC2626", border: "none", padding: "6px 12px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Excluir</button>}
                    </div>
                  ))}
                  {adminUsers.length === 0 && !adminBusy && <div style={{ fontSize: 13, color: "#94A3B8", textAlign: "center", padding: 20 }}>Nenhum usuário carregado</div>}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
