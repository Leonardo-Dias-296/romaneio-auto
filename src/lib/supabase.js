import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://budpfteibhmphgyagcs.supabase.co";
const supabaseAnonKey = "sb_publishable_4Is-dFQMf1SQEgizreCuiA_4fs2-TE0";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: true, persistSession: true },
});

// Fallback: chamadas diretas caso o JS client falhe
export async function signUp(email, senha, nome) {
  const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "apikey": supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: senha,
      data: { nome },
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.msg || err.error_description || err.error || "Erro ao criar conta");
  }
  return res.json();
}

export async function signIn(email, senha) {
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "apikey": supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: senha }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.msg || err.error_description || err.error || "Email ou senha inválidos");
  }
  return res.json();
}

export async function getUser(token) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      "apikey": supabaseAnonKey,
      "Authorization": `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}
