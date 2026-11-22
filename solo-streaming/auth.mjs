import { createRemoteJWKSet, jwtVerify } from "jose";

export const readScope = "streams:read";
export const hostScope = "streams:host";

export function isWorkspace(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Expected a fixed HTTPS URL");
  }
  return url;
}

export function createStreamAuthorization({ issuer, resource, jwksUrl, clientId, requiredGrant, resolveKey }) {
  httpsUrl(issuer);
  httpsUrl(resource);
  if (!clientId) throw new Error("A registered PAIGE API client is required");
  const keys = resolveKey ?? createRemoteJWKSet(httpsUrl(jwksUrl), {
    timeoutDuration: 3000, cooldownDuration: 10000, cacheMaxAge: 60000,
  });
  const now = () => Math.floor(Date.now() / 1000);
  return {
    issuer,
    resource,
    async verify(header) {
      const token = typeof header === "string" && /^Bearer ([a-zA-Z0-9._-]{1,8192})$/i.exec(header)?.[1];
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, keys, {
          algorithms: ["RS256"], typ: "at+jwt", issuer, audience: resource,
          requiredClaims: ["sub", "client_id", "iat", "exp", "jti", "scope", "paige_workspace_id"],
          maxTokenAge: 300,
        });
        if (payload.aud !== resource || payload.client_id !== clientId ||
            (requiredGrant && payload.paige_grant_type !== requiredGrant) ||
            typeof payload.sub !== "string" || !payload.sub || typeof payload.jti !== "string" || !payload.jti ||
            payload.exp <= payload.iat || payload.exp - payload.iat > 300 || payload.exp <= now() ||
            !isWorkspace(payload.paige_workspace_id) || typeof payload.scope !== "string") return null;
        return { workspace: payload.paige_workspace_id, scopes: new Set(payload.scope.split(" ")),
          clientId: payload.client_id, expiresAt: payload.exp };
      } catch {
        return null;
      }
    },
  };
}

export function protectedResource(auth, scopes) {
  const url = new URL(auth.resource);
  const path = "/.well-known/oauth-protected-resource" + (url.pathname === "/" ? "" : url.pathname);
  const realm = 'Bearer resource_metadata="' + url.origin + path + '"';
  return {
    path,
    metadata: {
      resource: auth.resource, authorization_servers: [auth.issuer], scopes_supported: scopes,
      bearer_methods_supported: ["header"],
    },
    challenge: (scope, error) => realm + (error ? ', error="' + error + '"' : "") +
      (scope ? ', scope="' + scope + '"' : ""),
  };
}
