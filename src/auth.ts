import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from "jose";

export type AuthConfig =
  | { mode: "bearer"; token: string }
  | { mode: "oauth"; resource: string; issuer: string; jwksUrl: string; subject: string; scope: string };

export function httpsUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url;
}

export function createAuthenticator(config: AuthConfig, key?: JWTVerifyGetKey): (header: string | undefined) => Promise<boolean> {
  if (config.mode === "bearer") {
    if (!/^[A-Za-z0-9_-]{43,}$/.test(config.token)) throw new Error("MCP_HTTP_TOKEN must be a random base64url token of at least 43 characters");
    const expected = createHash("sha256").update(config.token).digest();
    return async header => {
      if (!header?.startsWith("Bearer ")) return false;
      return timingSafeEqual(expected, createHash("sha256").update(header.slice(7)).digest());
    };
  }
  httpsUrl(config.resource, "OAuth resource");
  httpsUrl(config.issuer, "OAuth issuer");
  const jwks = key ?? createRemoteJWKSet(httpsUrl(config.jwksUrl, "JWKS URL"), { timeoutDuration: 5000 });
  return async header => {
    if (!header?.startsWith("Bearer ")) return false;
    try {
      const { payload } = await jwtVerify(header.slice(7), jwks, {
        issuer: config.issuer, audience: config.resource, subject: config.subject,
        algorithms: ["RS256", "ES256"], requiredClaims: ["exp", "iat", "sub"]
      });
      return typeof payload.scope === "string" && payload.scope.split(" ").includes(config.scope);
    } catch {
      return false;
    }
  };
}
