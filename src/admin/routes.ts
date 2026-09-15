import { Hono } from "hono";
import {
  getAdminConfig,
  mutateAdminConfig,
  slugifyProviderId,
  type ComboConfig
} from "./store";
import type { DynamicProvider, EnvBindings } from "@/types/provider";
import { PROVIDER_TEMPLATES, DEFAULT_COMBOS, ANTIGRAVITY_PUBLIC_CONFIG } from "@/config/constants";
import { extractBearer, resolvePrincipal, serverMisconfigured, unauthorized, maskSecret } from "./auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adminRouter = new Hono<{ Bindings: EnvBindings; Variables: any }>();

adminRouter.use("*", async (c, next) => {
  if (!c.env.AUTH_TOKEN) return serverMisconfigured();
  const token = extractBearer(c);
  const principal = await resolvePrincipal(c, c.env, token);
  if (!principal || principal.kind !== "master") {
    return unauthorized();
  }
  return next();
});

adminRouter.get("/config", async (c) => {
  const cfg = await getAdminConfig(c.env);
  
  // Mask keys before returning
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const safeProviders: Record<string, any> = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    safeProviders[id] = {
      ...p,
      keys: p.keys.map(k => maskSecret(k))
    };
  }

  return c.json({
    version: cfg.version,
    searchConfig: cfg.searchConfig,
    providers: safeProviders,
    templates: PROVIDER_TEMPLATES,
    combos: cfg.combos,
    defaultCombos: DEFAULT_COMBOS,
    antigravityConfigured: Boolean(cfg.antigravityConfig?.clientId && cfg.antigravityConfig?.clientSecret)
  });
});

adminRouter.post("/providers/:id", async (c) => {
  const id = slugifyProviderId(c.req.param("id"));
  const body = await c.req.json() as Partial<DynamicProvider>;
  if (!body.name || !body.baseUrl) return c.json({ error: "Name and baseUrl required" }, 400);

  const newProvider: DynamicProvider = {
    id,
    name: body.name,
    protocol: body.protocol || "openai",
    baseUrl: body.baseUrl.replace(/\/+$/, ""),
    keys: Array.isArray(body.keys) ? body.keys.filter(k => k.trim()) : [],
    enabled: body.enabled ?? true,
    models: Array.isArray(body.models) ? body.models : [],
    freeTier: !!body.freeTier,
    costPerMillionInput: body.costPerMillionInput || 0,
    costPerMillionOutput: body.costPerMillionOutput || 0,
  };

  const oldCfg = await getAdminConfig(c.env);
  const existing = oldCfg.providers[id];
  if (existing) {
    // Preserve existing unmasked keys if the incoming keys are still masked
    newProvider.keys = newProvider.keys.map(k => {
      if (k.includes("...")) {
        const oldKey = existing.keys.find(old => maskSecret(old) === k);
        return oldKey || k;
      }
      return k;
    }).filter(k => !k.includes("..."));
  }

  const updated = await mutateAdminConfig(c.env, (cfg) => {
    cfg.providers[id] = newProvider;
  });

  return c.json({ success: true, provider: updated.providers[id] });
});

adminRouter.delete("/providers/:id", async (c) => {
  const id = c.req.param("id");
  await mutateAdminConfig(c.env, (cfg) => {
    delete cfg.providers[id];
  });
  return c.json({ success: true });
});

adminRouter.post("/providers/sync", async (c) => {
  const { baseUrl, apiKey, protocol } = await c.req.json();
  if (!baseUrl) return c.json({ error: "baseUrl required" }, 400);
  
  const modelsUrl = baseUrl.replace(/\/+$/, "") + "/models";
  
  try {
    const headers: Record<string, string> = {
      "Accept": "application/json"
    };
    if (apiKey) {
      if (protocol === "anthropic") headers["x-api-key"] = apiKey;
      else if (protocol !== "gemini") headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const fetchUrl = (protocol === "gemini" && apiKey) ? `${modelsUrl}?key=${apiKey}` : modelsUrl;
    
    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) {
      return c.json({ error: `API Error: ${res.status} ${res.statusText}` }, 500);
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    let models: string[] = [];
    
    if (data.data && Array.isArray(data.data)) {
      models = data.data.map((m: any) => m.id || m.name).filter(Boolean);
    } else if (Array.isArray(data.models)) {
      models = data.models.map((m: any) => m.name || m.id).filter(Boolean);
    } else if (Array.isArray(data)) {
      models = data.map((m: any) => m.id || m.name || m).filter(Boolean);
    }
    
    return c.json({ success: true, models: Array.from(new Set(models)) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

adminRouter.post("/combos", async (c) => {
  const body = await c.req.json() as ComboConfig;
  const updated = await mutateAdminConfig(c.env, (cfg) => {
    cfg.combos[body.id] = body;
  });
  return c.json({ success: true, combo: updated.combos[body.id] });
});

adminRouter.delete("/combos/:id", async (c) => {
  const id = c.req.param("id");
  await mutateAdminConfig(c.env, (cfg) => {
    delete cfg.combos[id];
  });
  return c.json({ success: true });
});
