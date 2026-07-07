// Spike JWT: symmetric HS256 shared with zero-cache (ZERO_AUTH_SECRET).
// Real app uses Better Auth; here we just need a signed { sub: userId }.
import { SignJWT, jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.ZERO_AUTH_SECRET ?? "spike-dev-secret-change-me",
);

export async function mintToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(secret);
}

export async function verifyToken(
  token: string,
): Promise<{ id: string } | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.sub ? { id: payload.sub } : undefined;
  } catch {
    return undefined;
  }
}
