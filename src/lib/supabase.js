export async function signUp(email, senha, nome) {
  const res = await fetch("/api/auth-signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: senha, nome }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.erro || "Erro ao criar conta");
  return data;
}

export async function signIn(email, senha) {
  const res = await fetch("/api/auth-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: senha }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.erro || "Email ou senha inválidos");
  return data;
}

export async function getUser(token) {
  const res = await fetch("/api/auth-user", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}
