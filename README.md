# RomaneioAuto — Vercel

Projeto completo (frontend + backend serverless) para deploy na Vercel.

## Estrutura

```
romaneio-auto/
├── api/
│   └── extrair.js      ← Serverless Function (backend seguro)
├── src/
│   ├── main.jsx
│   └── App.jsx         ← Frontend React
├── index.html
├── vite.config.js
├── vercel.json
└── package.json
```

A chave da API Anthropic **nunca vai para o browser** — fica apenas na Serverless Function, como variável de ambiente na Vercel.

---

## Deploy (5 minutos)

### 1. Suba o projeto no GitHub

```bash
git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/SEU_USUARIO/romaneio-auto.git
git push -u origin main
```

### 2. Importe na Vercel

1. Acesse https://vercel.com e faça login
2. Clique em **Add New → Project**
3. Importe o repositório `romaneio-auto`
4. As configurações são detectadas automaticamente (Vite)
5. Em **Environment Variables**, adicione:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-api03-...` (sua chave)
6. Clique em **Deploy**

Pronto! A Vercel faz o build e publica tudo num único domínio.

---

## Desenvolvimento local

```bash
npm install
npm run dev          # Frontend em http://localhost:5173
```

Para testar a Serverless Function localmente, instale a Vercel CLI:

```bash
npm i -g vercel
vercel dev           # Frontend + API em http://localhost:3000
```

---

## Como funciona

```
Browser  →  POST /api/extrair (multipart ou JSON)
                    ↓
         Serverless Function (api/extrair.js)
                    ↓  usa ANTHROPIC_API_KEY do ambiente
         API Anthropic → retorna JSON dos dados da NF
                    ↓
         Browser recebe JSON e monta o Romaneio
```
