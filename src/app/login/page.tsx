"use client";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
export default function LoginPage() {
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((x) => setSetup(x.setupRequired));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error);
      return;
    }
    sessionStorage.setItem("mg_csrf", data.csrfToken);
    router.push("/");
  }
  return (
    <main className="auth">
      <section className="auth-card">
        <p className="eyebrow">H&H SUITE</p>
        <h1>{setup ? "Create administrator" : "Sign in"}</h1>
        <p className="muted">
          {setup
            ? "Secure your Media Guard installation before configuring services."
            : "Use your local administrator account."}
        </p>
        <form onSubmit={submit}>
          <label>
            Username
            <input
              name="username"
              autoComplete="username"
              required
              minLength={3}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              required
              minLength={12}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="button" type="submit">
            {setup ? "Create administrator" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
