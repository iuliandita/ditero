import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";

// Fetch a fresh JWT from Better Auth. In v1.7 the Zero client `auth` option is a
// token string (not a callback), so the token is resolved before construction.
async function fetchToken(): Promise<string> {
  const res = await fetch("/api/auth/token", { credentials: "include" });
  if (!res.ok) return "";
  const body = (await res.json()) as { token?: string };
  return body.token ?? "";
}

export function AppZeroProvider({
  userID,
  children,
}: {
  userID: string;
  children: ReactNode;
}) {
  const [zero, setZero] = useState<Zero<typeof schema> | null>(null);

  useEffect(() => {
    let instance: Zero<typeof schema> | undefined;
    let cancelled = false;
    void (async () => {
      const token = await fetchToken();
      if (cancelled) return;
      instance = new Zero({
        cacheURL: import.meta.env.VITE_ZERO_URL ?? "http://localhost:4848",
        userID,
        schema,
        mutators,
        auth: token,
      });
      setZero(instance);
    })();
    return () => {
      cancelled = true;
      instance?.close();
      setZero(null);
    };
  }, [userID]);

  if (!zero) return null;
  return <ZeroProvider zero={zero}>{children}</ZeroProvider>;
}
