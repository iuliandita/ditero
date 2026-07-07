import { useState } from "react";
import { authClient } from "../lib/auth-client.ts";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function signUp() {
    setError(null);
    // Email verification is off, so signup yields an active session directly.
    const name = email.split("@")[0] || email;
    const res = await authClient.signUp.email({ email, password, name });
    if (res.error) setError(res.error.message ?? "sign up failed");
  }

  async function signIn() {
    setError(null);
    const res = await authClient.signIn.email({ email, password });
    if (res.error) setError(res.error.message ?? "sign in failed");
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-2 p-6">
      <h1 className="text-lg font-semibold">Ditero</h1>
      <input
        data-testid="email"
        className="border p-2"
        placeholder="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        data-testid="password"
        className="border p-2"
        type="password"
        placeholder="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button
        data-testid="signup"
        className="border bg-black p-2 text-white"
        type="button"
        onClick={signUp}
      >
        Sign up
      </button>
      <button
        data-testid="signin"
        className="border p-2"
        type="button"
        onClick={signIn}
      >
        Sign in
      </button>
      <button
        className="border p-2"
        type="button"
        onClick={() => authClient.signIn.social({ provider: "google" })}
      >
        Continue with Google
      </button>
      {error ? <p className="text-red-600">{error}</p> : null}
    </div>
  );
}
