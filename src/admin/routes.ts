
import { getProviderConfig } from "@/config/providers";
import { executeOpenAICompatible } from "@/adapters/openai-compatible";
import { getProviderKeys } from "@/routing/keyPool";
import { getUsageSummary } from "@/routing/costTracker";
import { getCircuitStatus } from "@/routing/circuitBreaker";
import { Hono } from "hono";
import {
  getAdminConfig,
  mutateAdminConfig,
  slugifyProviderId,
  getAntigravityOAuthCredentials,
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


// RESTORED ROUTES

adminRouter.get("/search", async (c) => {
  const cfg = await getAdminConfig(c.env);
  return c.json({
    ok: true,
    searchConfig: {
      engine: cfg.searchConfig.activeProvider || "auto",
      activeProvider: cfg.searchConfig.activeProvider || "auto",
      searxngUrl: cfg.searchConfig.searxngUrl || "",
      serperApiKey: maskSecret(cfg.searchConfig.serperApiKey), // C-2
      braveApiKey: maskSecret(cfg.searchConfig.braveApiKey),   // C-2
      tavilyApiKey: maskSecret(cfg.searchConfig.tavilyApiKey), // C-2
    },
    envSearx: c.env.SEARXNG_URL || "",
    hasTavilyEnv: !!c.env.TAVILY_API_KEYS,
  });
});

adminRouter.post("/search", async (c) => {
  const body = (await c.req.json()) as Record<string, string>;
  const activeProvider = body.engine || body.activeProvider;
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    cfg.searchConfig = {
      activeProvider: (activeProvider || cfg.searchConfig.activeProvider || "auto") as "auto" | "searxng" | "duckduckgo" | "tavily" | "serper" | "brave",
      searxngUrl: body.searxngUrl !== undefined ? body.searxngUrl.trim() : cfg.searchConfig.searxngUrl,
      tavilyApiKey: body.tavilyApiKey !== undefined ? body.tavilyApiKey.trim() : cfg.searchConfig.tavilyApiKey,
      serperApiKey: body.serperApiKey !== undefined ? body.serperApiKey.trim() : cfg.searchConfig.serperApiKey,
      braveApiKey: body.braveApiKey !== undefined ? body.braveApiKey.trim() : cfg.searchConfig.braveApiKey,
    };
  });
  return c.json({ ok: true, searchConfig: {
    activeProvider: cfg.searchConfig.activeProvider,
    searxngUrl: cfg.searchConfig.searxngUrl,
    tavilyApiKey: maskSecret(cfg.searchConfig.tavilyApiKey),
    serperApiKey: maskSecret(cfg.searchConfig.serperApiKey),
    braveApiKey: maskSecret(cfg.searchConfig.braveApiKey),
  }});
});

adminRouter.post("/search/test", async (c) => {
  const { dispatchSearch } = await import("@/search/dispatcher");
  const body = (await c.req.json()) as { query: string; provider?: string };
  if (!body.query) return c.json({ error: "query e obrigatorio" }, 400);
  try {
    const rr = await dispatchSearch({ query: body.query } as never, c.env);
    return c.json({ ok: true, engine: rr.provider, results: rr.results || [], total_results: rr.total_results });
  } catch (err: unknown) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

adminRouter.get("/virtual-keys", async (c) => {
  const cfg = await getAdminConfig(c.env);
  return c.json({
    keys: Object.values(cfg.virtualKeys || {}).map((vk) => ({
      id: vk.id,
      name: vk.name,
      keyPreview: maskSecret(vk.id), // C-2: never return full token
      createdAt: vk.createdAt,
      requestsCount: 0,
      lastUsedAt: vk.lastUsedAt,
      allowedModels: vk.allowedModels,
      rpmLimit: vk.rpmLimit,
      enabled: vk.enabled,
    })),
  });
});

adminRouter.post("/virtual-keys", async (c) => {
  const body = (await c.req.json()) as { name?: string; allowedModels?: string[]; rpmLimit?: number };
  const name = body.name?.trim() || "Cliente VeroRoute";
  const keyId = "sk-vr-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const allowed = body.allowedModels?.length ? body.allowedModels : ["*"];
  await mutateAdminConfig(c.env, (cfg) => {
    cfg.virtualKeys[keyId] = {
      id: keyId, name,
      createdAt: Date.now(),
      allowedModels: allowed,
      rpmLimit: body.rpmLimit,
      
      enabled: true,
    };
  });
  // C-2: return full key ONLY at creation time
  return c.json({ ok: true, key: { id: keyId, name, key: keyId, createdAt: Date.now(), requestsCount: 0, allowedModels: allowed } });
});

adminRouter.patch("/virtual-keys/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { enabled?: boolean; allowedModels?: string[]; rpmLimit?: number };
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    const v = cfg.virtualKeys[id];
    if (!v) return;
    if (typeof body.enabled === "boolean") v.enabled = body.enabled;
    if (body.allowedModels) v.allowedModels = body.allowedModels;
    if (body.rpmLimit !== undefined) v.rpmLimit = body.rpmLimit;
  });
  const v = cfg.virtualKeys[id];
  if (!v) return c.json({ error: { message: "Chave nao encontrada", type: "not_found" } }, 404);
  return c.json({ ok: true, key: { id: v.id, name: v.name, keyPreview: maskSecret(v.id), enabled: v.enabled, allowedModels: v.allowedModels } });
});

adminRouter.delete("/virtual-keys/:id", async (c) => {
  const id = c.req.param("id");
  const cfg = await mutateAdminConfig(c.env, (cfg) => { delete cfg.virtualKeys[id]; });
  return c.json({ ok: true, id, count: Object.keys(cfg.virtualKeys).length });
});

adminRouter.get("/antigravity/status", async (c) => {
  const { clientId, isConfigured } = await getAntigravityOAuthCredentials(c.env);
  let hasTokens = false;
  if (c.env.OMNI_KEYS) {
    hasTokens = Boolean(await c.env.OMNI_KEYS.get("antigravity_tokens"));
  }
  return c.json({ ok: true, isConfigured, hasClientId: Boolean(clientId), maskedClientId: maskSecret(clientId), hasTokens });
});

adminRouter.post("/antigravity/config", async (c) => {
  const body = (await c.req.json()) as { clientId: string; clientSecret: string };
  const clientId = body.clientId?.trim();
  const clientSecret = body.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    return c.json({ error: { message: "Client ID e Client Secret sao obrigatorios", type: "validation" } }, 400);
  }
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    cfg.antigravityConfig = { clientId, clientSecret, updatedAt: new Date().toISOString() };
  });
  return c.json({ ok: true, message: "Credenciais salvas no KV OMNI_KEYS.", configuredAt: cfg.antigravityConfig?.updatedAt });
});

adminRouter.get("/usage/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const usage = await getUsageSummary(c.env, keyId);
  return c.json({ keyId, ...usage });
});

adminRouter.get("/circuits", async (c) => {
  const providers = ["openai", "gemini", "groq", "cerebras", "cloudflare-ai", "1min", "openrouter", "deepseek", "mistral", "sambanova", "pollinations"];
  const results = await Promise.all(providers.map(async (p) => ({ provider: p, ...(await getCircuitStatus(c.env, p)) })));
  return c.json({ circuits: results });
});


adminRouter.post("/combos/test", async (c) => {
  const COMBO_TEST_TIMEOUT_MS = 10000;
  const body = (await c.req.json().catch(() => ({}))) as {
    comboId?: string;
    targets?: Array<{ provider: string; model: string }>;
  };
  const cfg = await getAdminConfig(c.env);
  let targets: Array<{ provider: string; model: string }> = [];

  if (body.targets && Array.isArray(body.targets) && body.targets.length > 0) {
    targets = body.targets;
  } else if (body.comboId && cfg.combos[body.comboId]) {
    const comboProviders = cfg.combos[body.comboId].providers || [];
    targets = comboProviders.map(p => ({ provider: p.provider, model: p.model }));
  }

  const testTarget = async (target: { provider: string; model: string }) => {
    const provCfg = await getProviderConfig(c.env, target.provider);
    if (!provCfg) {
      return { provider: target.provider, model: target.model, status: 404, latency_ms: 0, success: false, error: "Provedor nao encontrado" };
    }
    const keys = await getProviderKeys(c.env, target.provider);
    const apiKey = keys.length > 0 ? keys[0] : "";
    
    if (!apiKey && provCfg.protocol !== "cloudflare-ai" && provCfg.protocol !== "1min") {
      return { provider: target.provider, model: target.model, status: 401, latency_ms: 0, success: false, error: "Sem chave de API" };
    }

    const testReq = {
      model: target.model,
      messages: [{ role: "user" as const, content: "Respond with OK" }],
      max_tokens: 5,
      temperature: 0,
      stream: false,
    };

    const start = Date.now();
    try {
      const res = await Promise.race([
        executeOpenAICompatible(testReq, { baseUrl: provCfg.baseUrl, apiKey, protocol: provCfg.protocol }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout " + COMBO_TEST_TIMEOUT_MS + "ms")), COMBO_TEST_TIMEOUT_MS)
        ),
      ]);
      const latency = Date.now() - start;
      if (res.ok) {
        let text = "OK";
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const j = (await res.json()) as any;
          text = j.choices?.[0]?.message?.content?.trim().slice(0, 30) || "OK";
        } catch { }
        return { provider: target.provider, model: target.model, status: res.status, latency_ms: latency, success: true, output: text };
      }
      const errText = (await res.text()).slice(0, 150);
      return { provider: target.provider, model: target.model, status: res.status, latency_ms: latency, success: false, error: errText };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { provider: target.provider, model: target.model, status: 500, latency_ms: Date.now() - start, success: false, error: e.message };
    }
  };

  const results = await Promise.all(targets.map(testTarget));
  return c.json({ ok: true, results });
});
