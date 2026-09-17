import type { Context } from "hono";
import { getAdminConfig } from "./store";
import type { EnvBindings } from "@/types/provider";

// AUTH_TOKEN is configured by wrangler.toml for fresh installations.
// Cloudflare Git builds can re-apply the default value from [vars], so users
// who chose a custom password must review it after each Sync fork/rebuild.

export type AuthPrincipal =
  | { kind: "master"; id: "master" }
  | { kind: "virtual"; id: string; name: string; allowedModels: string[]; rpmLimit?: number };

type AnyCtx = Context<{ Bindings: EnvBindings; Variables: any }>;

export function extractBearer(c: AnyCtx): string {
  const h = c.req.header("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  const q = c.req.query("token");
  if (q) return q.trim();
  return "";
}



export async function resolvePrincipal(
  c: AnyCtx,
  token: string
): Promise<AuthPrincipal | null> {
  const master = c.env.AUTH_TOKEN;
  if (!master) return null;

  if (token && token === master) {
    return { kind: "master", id: "master" };
  }

  // Check virtual keys
  if (token.startsWith("sk-vr-")) {
    const cfg = await getAdminConfig(c.env);
    const vk = cfg.virtualKeys?.[token];
    if (vk && vk.enabled !== false) {
      return {
        kind: "virtual",
        id: vk.id,
        name: vk.name,
        allowedModels: vk.allowedModels || [],
        rpmLimit: vk.rpmLimit,
      };
    }
  }

  return null;
}


export function unauthorized(): Response {
  return Response.json(
    { error: { message: "Nao autorizado — Bearer token invalido ou ausente", type: "unauthorized" } },
    { status: 401 }
  );
}

export function forbidden(reason = "Acesso negado"): Response {
  return Response.json(
    { error: { message: reason, type: "forbidden" } },
    { status: 403 }
  );
}

export function isModelAllowed(principal: AuthPrincipal, model: string): boolean {
  if (principal.kind === "master") return true;
  if (!principal.allowedModels || principal.allowedModels.length === 0) return true;
  return principal.allowedModels.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*")) {
      return model.startsWith(pattern.slice(0, -1));
    }
    return model === pattern;
  });
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

/**
 * Record virtual key usage. 
 * NOTE: Moved to no-op to avoid mutateAdminConfig race conditions on every request.
 * Usage counters should be tracked via Analytics Engine or Durable Objects, not KV admin config.
 */
export function recordVirtualKeyUse(
  _env: EnvBindings,
  _keyId: string,
  _ctx?: ExecutionContext
): void {
  // Intentional no-op — see audit report Bug #4 / recommendation
  // Future: Analytics Engine or DO-based counter
}
