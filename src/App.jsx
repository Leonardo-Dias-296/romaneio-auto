import { useState, useRef, useEffect } from "react";

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
  telefone: "(51) 9 9564-8255",
};

// ── PDF / Canvas helpers ───────────────────────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve;
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
  const margin = 10; // mm
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
        style={{ border: "1px solid #CBD5E1", borderRadius: 6, padding: "9px 12px", fontSize: 14, fontWeight: 500, color: "#0F172A", background: "#fff", fontFamily: "inherit", outline: "none", width: "100%" }}
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
  function handlePrint() {
    const w = window.open("", "_blank");
    if (!w) { alert("Permita pop-ups para imprimir."); return; }
    w.document.write(`<!DOCTYPE html><html><head><style>
      *{margin:0;padding:0;box-sizing:border-box;}body{background:#fff;}
      img{width:100%;display:block;}
      @media print{@page{margin:5mm;size:A4;}img{width:100%;}}
    </style></head><body><img src="${imgDataUrl}"/>
    <script>window.onload=function(){setTimeout(function(){window.print();},300);}<\/script>
    </body></html>`);
    w.document.close();
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.75)", zIndex: 9999, display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#1E293B", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>Pré-visualização</span>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={handlePrint} style={{ background: "#fff", color: "#0F172A", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Imprimir</button>
          <button onClick={() => downloadBlob(pdfBlob, filename)} style={{ background: "#475569", color: "#fff", border: "none", padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Baixar PDF</button>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.12)", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Fechar</button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", display: "flex", justifyContent: "center", padding: 24, background: "#374151" }}>
        <img src={imgDataUrl} alt="preview" style={{ maxWidth: 794, width: "100%", boxShadow: "0 8px 32px rgba(0,0,0,.5)", alignSelf: "flex-start" }} />
      </div>
    </div>
  );
}

// ── Romaneio Document ──────────────────────────────────────────
function RomaneioDoc({ dados, forCapture }) {
  const notas = dados.notas || [];
  const isMulti = notas.length > 1;

  const style = forCapture
    ? { width: "100%", maxWidth: 794, minHeight: 1123, background: "#fff", fontFamily: "Arial, sans-serif", padding: "20px 24px", boxSizing: "border-box", overflow: "hidden", display: "flex", flexDirection: "column" }
    : { background: "#fff", border: "1px solid #CBD5E1", borderRadius: 10, overflow: "hidden" };

  const thStyle = { background: "#0F172A", color: "#fff", fontWeight: 700, fontSize: 10, padding: "5px 10px", textTransform: "uppercase", letterSpacing: "1.5px", textAlign: "left" };
  const labelStyle = { width: "34%", padding: "5px 10px", fontWeight: 700, fontSize: 11, color: "#0F172A", background: "#F8FAFC", borderRight: "1px solid #CBD5E1", borderBottom: "1px solid #E2E8F0", whiteSpace: "nowrap" };
  const valueStyle = { padding: "5px 10px", fontSize: 11, color: "#0F172A", borderBottom: "1px solid #E2E8F0", fontWeight: 400, wordBreak: "break-word" };

  const Section = ({ title }) => <tr><td colSpan={2} style={thStyle}>{title}</td></tr>;
  const Row = ({ label, value }) => <tr><td style={labelStyle}>{label}</td><td style={valueStyle}>{value || "\u00A0"}</td></tr>;

  const totalVolumes = notas.reduce((s, n) => s + (parseInt(n.quantidade_volumes) || 1), 0);
  const nfHeader = isMulti ? `${notas.length} Notas Fiscais` : (notas[0]?.numero_nf ? `NF-e ${notas[0].numero_nf}` : "Romaneio de Carga");

  return (
    <div style={style}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, paddingBottom: 10, borderBottom: "2px solid #0F172A", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1, display: "flex", gap: 12, alignItems: "center" }}>
          <img src="/image.png" alt="Logo" style={{ height: forCapture ? 100 : 110, objectFit: "contain", flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: forCapture ? 14 : 17, fontWeight: 900, color: "#0F172A" }}>SOLLARSUL ENERGIA SOLAR LTDA</div>
            <div style={{ fontSize: forCapture ? 10 : 12, color: "#475569", marginTop: 2 }}>CNPJ: {REMETENTE.cnpj}</div>
            <div style={{ fontSize: forCapture ? 10 : 12, color: "#475569", marginTop: 1 }}>{REMETENTE.endereco}</div>
            <div style={{ fontSize: forCapture ? 10 : 12, color: "#475569", marginTop: 1 }}>Tel: {REMETENTE.telefone}</div>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: forCapture ? 13 : 14, fontWeight: 900, color: "#0F172A", textTransform: "uppercase" }}>Romaneio de Carga</div>
          <div style={{ fontSize: forCapture ? 10 : 12, color: "#475569", fontWeight: 600, marginTop: 2 }}>Comprovante de Retirada</div>
          <div style={{ marginTop: 6, display: "inline-block", border: "1.5px solid #0F172A", borderRadius: 4, padding: "2px 8px" }}>
            <span style={{ fontSize: forCapture ? 11 : 13, fontWeight: 700, color: "#0F172A" }}>{nfHeader}</span>
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
          {isMulti ? (
            <>
              <Section title={`Notas Fiscais (${notas.length}) — Total de Volumes: ${totalVolumes}`} />
              <tr><td colSpan={2} style={{ padding: 0 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, width: "6%" }}>#</th>
                      <th style={{ ...thStyle, width: "18%" }}>NF-e</th>
                      <th style={{ ...thStyle, width: "36%" }}>Produto(s)</th>
                      <th style={{ ...thStyle, width: "14%" }}>Volumes</th>
                      <th style={{ ...thStyle, width: "14%" }}>Pedido</th>
                      <th style={{ ...thStyle, width: "12%" }}>Obs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notas.map((n, i) => (
                      <tr key={i}>
                        <td style={{ ...valueStyle, textAlign: "center", fontWeight: 700 }}>{i + 1}</td>
                        <td style={{ ...valueStyle, fontWeight: 700 }}>{n.numero_nf || "—"}</td>
                        <td style={{ ...valueStyle, lineHeight: 1.3 }}>{n.produtos || "—"}</td>
                        <td style={{ ...valueStyle, textAlign: "center" }}>{n.quantidade_volumes || "1"}</td>
                        <td style={{ ...valueStyle }}>{n.numero_pedido || "—"}</td>
                        <td style={{ ...valueStyle, fontSize: 10 }}>{n.observacoes || "—"}</td>
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
              <Row label="Observações:" value={notas[0]?.observacoes} />
            </>
          )}
          <tr><td colSpan={2} style={thStyle}>Assinaturas</td></tr>
          <tr>
            <td colSpan={2} style={{ padding: 0, height: "100%" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: forCapture ? 120 : 80 }}>
                {["Assinatura do Motorista", "Assinatura do Responsável do CD"].map((label, i) => (
                  <div key={i} style={{ padding: forCapture ? "20px 16px 80px" : "14px 16px 60px", position: "relative", borderRight: i === 0 ? "1px solid #CBD5E1" : "none", display: "flex", alignItems: "flex-end" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: .5 }}>{label}</span>
                    <div style={{ position: "absolute", bottom: 22, left: 16, right: 16, height: 1, background: "#94A3B8" }} />
                  </div>
                ))}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94A3B8" }}>
        <span>SOLLARSUL ENERGIA SOLAR LTDA — Taquari/RS</span>
        <span>Gerado em: {new Date().toLocaleString("pt-BR")}</span>
      </div>
    </div>
  );
}

// ── Etiqueta ───────────────────────────────────────────────────
function Etiqueta({ nota, dados, volumeInNota, totalVolumesNota, forCapture }) {
  const size = forCapture
    ? { width: 340, height: 220, fontFamily: "Arial, sans-serif" }
    : { width: "100%", aspectRatio: "10/6.5", maxWidth: 340 };
  return (
    <div style={{ ...size, background: "#fff", border: "2px solid #0F172A", borderRadius: forCapture ? 0 : 6, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ borderBottom: "2px solid #0F172A", padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 13, color: "#0F172A" }}>SOLLAR SUL</div>
          <div style={{ fontSize: 9, color: "#475569", letterSpacing: 1, textTransform: "uppercase" }}>Energia Solar</div>
        </div>
        <div style={{ border: "2px solid #0F172A", borderRadius: 4, padding: "4px 10px", textAlign: "center" }}>
          <div style={{ fontSize: 7, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>VOLUME</div>
          <div style={{ fontWeight: 900, fontSize: 22, color: "#0F172A", lineHeight: 1 }}>
            {volumeInNota + 1}<span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>/{totalVolumesNota}</span>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ borderBottom: "1px solid #E2E8F0", paddingBottom: 5, display: "flex", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 8, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1 }}>Nota Fiscal</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#0F172A" }}>NF-e {nota.numero_nf || "—"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 8, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1 }}>Data</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#0F172A" }}>{dados.data_retirada || "—"}</div>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 8, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>Transportadora</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#0F172A" }}>{dados.transportadora || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: 8, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, marginBottom: 1 }}>Produto(s)</div>
          <div style={{ fontSize: 11, fontWeight: 500, color: "#0F172A", lineHeight: 1.3 }}>{nota.produtos || "Carga geral"}</div>
        </div>
        {nota.numero_pedido && (
          <div>
            <div style={{ fontSize: 8, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1, marginBottom: 1 }}>Pedido</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: "#0F172A" }}>{nota.numero_pedido}</div>
          </div>
        )}
      </div>
      <div style={{ borderTop: "1px solid #CBD5E1", padding: "3px 12px", display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 8, color: "#94A3B8", fontWeight: 600 }}>SOLLAR SUL © {new Date().getFullYear()}</span>
        <span style={{ fontSize: 8, color: "#94A3B8", fontWeight: 600 }}>Manuseie com cuidado</span>
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
  const romaneioRef = useRef();
  const etiquetasRef = useRef();
  const fileRef = useRef();

  useEffect(() => { if (step === 3) ensureLibs().catch(() => {}); }, [step]);

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
      const scale = 2;
      const { blob, dataUrl } = await elementToOutput(ref.current, { scale, pageSize });
      setModal({ imgDataUrl: dataUrl, pdfBlob: blob, filename });
    } catch (err) { alert("Erro: " + err.message); }
    finally { setBusy(false); }
  }
  async function handleDownload(ref, filename) {
    setBusy(true);
    try {
      const pageSize = currentPageSize();
      const scale = 2;
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

      for (let i = 0; i < files.length; i++) {
        setStatusMsg(`Processando arquivo ${i + 1}/${files.length}...`);
        const parsed = await enviarUmArquivo(files[i], i, files.length);
        // Fields shared across the romaneio (from first file)
        if (i === 0) {
          shared = {
            transportadora: parsed.transportadora,
            cnpj_transp: parsed.cnpj_transp,
            endereco_transp: parsed.endereco_transp,
            telefone_transp: parsed.telefone_transp,
            nome_motorista: parsed.nome_motorista,
            cpf_motorista: parsed.cpf_motorista,
            placa_veiculo: parsed.placa_veiculo,
            data_retirada: parsed.data_retirada,
            horario_retirada: parsed.horario_retirada,
          };
        }
        allNotas.push({
          numero_nf: parsed.numero_nf,
          produtos: parsed.produtos,
          quantidade_volumes: parsed.quantidade_volumes,
          numero_pedido: parsed.numero_pedido,
          observacoes: parsed.observacoes,
        });
      }

      setDados({ ...shared, notas: allNotas });
      setStep(3);
    } catch (err) { alert("Erro:\n" + err.message); setStep(1); }
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
              <RomaneioDoc dados={dados} forCapture />
            </div>
            <div ref={etiquetasRef} style={{ position: "absolute", left: -9999, top: 0, zIndex: -1, width: cssWidth }}>
              <EtiquetasCapture dados={dados} />
            </div>
          </>
        );
      })()}

      {modal && <PreviewModal imgDataUrl={modal.imgDataUrl} pdfBlob={modal.pdfBlob} filename={modal.filename} onClose={() => setModal(null)} />}

      {/* Header */}
      <div style={{ background: "#0F172A", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", position: "relative", zIndex: 1 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Grupo Sollar - Friclim</div>
        <span style={{ color: "rgba(255,255,255,.85)", fontSize: 14, fontWeight: 600 }}>RomaneioAuto</span>
      </div>

      {/* Wizard */}
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
        {step === 3 && (
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
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 1 }}>Transportadora</div>
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
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <Field label="Qtd de Volumes" value={nota.quantidade_volumes} onChange={v => updNota(idx, "quantidade_volumes", v)} />
                          <Field label="Observações" value={nota.observacoes} onChange={v => updNota(idx, "observacoes", v)} />
                        </div>
                      </div>
                    ))}
                    <button onClick={addNota}
                      style={{ background: "#F1F5F9", border: "2px dashed #CBD5E1", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 600, color: "#475569", cursor: "pointer", fontFamily: "inherit" }}>
                      + Adicionar Nota Fiscal
                    </button>
                  </div>
                </div>
                <RomaneioDoc dados={dados} />
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
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16, marginBottom: 20 }}>
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
                  <Btn busy={busy} onClick={() => handlePreview(etiquetasRef, `etiquetas-${nfSlug}.pdf`)}>Visualizar / Imprimir Etiquetas</Btn>
                  <Btn busy={busy} color="#334155" onClick={() => handleDownload(etiquetasRef, `etiquetas-${nfSlug}.pdf`)}>Baixar PDF das Etiquetas</Btn>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
