const projectOrigin = "https://xygzykjyynhzqytbqnzu.supabase.co";

export function createSupabasePilot(publishableKey, audit, fetcher = fetch) {
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error("PAIGE Supabase publishable key required");
  }

  async function request(method, path, token, body) {
    const headers = { apikey: publishableKey, Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    const reply = await fetcher(projectOrigin + path, {
      method, headers, body: body && JSON.stringify(body), redirect: "error",
      cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    // Store method, operation and status only. No queries, identities, credentials or tokens.
    audit({ method, operation: path.split("?")[0], status: reply.status });
    return reply;
  }

  async function read(method, path, token, body) {
    const reply = await request(method, path, token, body);
    if (!reply.ok) throw new Error("Supabase read failed");
    return reply.json();
  }

  return {
    async signIn(email, password) {
      const reply = await request("POST", "/auth/v1/token?grant_type=password", null, { email, password });
      if ([400, 401, 403, 422].includes(reply.status)) return null;
      if (!reply.ok) throw new Error("Supabase sign-in unavailable");
      return reply.json();
    },
    async account(token, evaluator) {
      const user = await read("GET", "/auth/v1/user", token);
      if (user.id !== evaluator.id || user.email?.toLowerCase() !== evaluator.email) return null;

      if (evaluator.mode === "operator") {
        if (await read("POST", "/rest/v1/rpc/is_platform_admin", token, {}) !== true) return null;
        // The existing SELECT policies decide which rows the signed-in operator can read.
        const directory = await read("GET", "/rest/v1/tenants?select=name,status&archived_at=is.null&order=name.asc,id.asc&limit=21", token);
        if (!Array.isArray(directory) || directory.some((row) => typeof row.name !== "string" || typeof row.status !== "string")) return null;
        return {
          email: user.email, scope: "operator", truncated: directory.length > 20,
          workspaces: directory.slice(0, 20).map(({ name, status }) => ({ name, status })),
        };
      }

      const [memberships, admin, owner] = await Promise.all([
        read("GET", `/rest/v1/tenant_members?select=tenant_id,role&user_id=eq.${evaluator.id}&status=eq.active&limit=2`, token),
        read("POST", "/rest/v1/rpc/is_platform_admin", token, {}),
        read("POST", "/rest/v1/rpc/is_platform_owner", token, {}),
      ]);
      if (admin !== false || owner !== false || memberships.length !== 1 ||
          memberships[0].tenant_id !== evaluator.tenant || memberships[0].role !== evaluator.role) return null;

      const tenants = await read("GET", `/rest/v1/tenants?select=id,name&id=eq.${evaluator.tenant}&limit=1`, token);
      if (tenants.length !== 1 || tenants[0].id !== evaluator.tenant || typeof tenants[0].name !== "string") return null;
      return { email: user.email, workspace: tenants[0].name, role: evaluator.role };
    },
    async signOut(token) {
      const reply = await request("POST", "/auth/v1/logout?scope=local", token);
      return reply.status === 204;
    },
  };
}
