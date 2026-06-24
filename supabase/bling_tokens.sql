-- Cria tabela para armazenar tokens do Bling OAuth
-- Execute este SQL no Supabase SQL Editor

CREATE TABLE IF NOT EXISTS bling_tokens (
  key TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
);

-- Habilita RLS mas permite acesso via service key
ALTER TABLE bling_tokens ENABLE ROW LEVEL SECURITY;

-- Policy para service role (acesso total)
CREATE POLICY "Service role full access" ON bling_tokens
  FOR ALL
  USING (auth.role() = 'service_role');
