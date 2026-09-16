import { Hono } from "hono";
import { PROVIDER_REGISTRY, getProviderConfig } from "@/config/providers";
import {
  getAdminConfig,
  mutateAdminConfig,
  deleteCombo,
  slugifyProviderId,
  appendProviderKeys,
  appendProviderCredentials,
  getStoredProviderCredentials,
  setStoredProviderCredentials,
  removeProviderKeys,
  getCustomProviderKeys,
  setProviderBaseUrl,
  type CustomProvider,
  type ComboConfig,
} from "./store";
import { extractBearer, resolvePrincipal, serverMisconfigured, unauthorized, maskSecret } from "./auth";
import { executeOpenAICompatible } from "@/adapters/openai-compatible";
import { executeCloudflareAI } from "@/adapters/cloudflare-ai";
import type { ChatCompletionRequest } from "@/types/openai";
import { selectActiveCredential } from "@/routing/keyPool";
import { getAntigravityOAuthCredentials } from "./store";
import type { EnvBindings } from "@/types/provider";
import { getUsageSummary } from "@/routing/costTracker";
import { getCircuitStatus } from "@/routing/circuitBreaker";
import { DEFAULT_MODELS_CATALOG } from "@/config/constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adminRouter = new Hono<{ Bindings: EnvBindings; Variables: any }>();

// ---------------------------------------------------------------------------
// Admin auth middleware — AUTH_TOKEN is MANDATORY (fail-closed, no open mode)
// C-1/C-2: Requires master token; virtual keys cannot access admin API.
// ---------------------------------------------------------------------------
adminRouter.use("*", async (c, next) => {
  const token = extractBearer(c);
  const principal = await resolvePrincipal(c, token);
  if (!principal || principal.kind !== "master") {
    return unauthorized();
  }
  return next();
});

// ---------------------------------------------------------------------------
// GET /config — C-2: API key values masked, never returned in cleartext
// ---------------------------------------------------------------------------
adminRouter.get("/config", async (c) => {
  const cfg = await getAdminConfig(c.env);
  const providers: unknown[] = [];

  for (const [id, staticCfg] of Object.entries(PROVIDER_REGISTRY)) {
    const state = cfg.providerStates[id]?.enabled ?? true;
    const removed = new Set(cfg.removedModels?.[id] || []);
    const customModels = (cfg.customModels[id] || []).filter((m) => !removed.has(m));
    const baseModels = (staticCfg.models || []).filter((m) => !removed.has(m));
    const mergedModels = [...baseModels, ...customModels.filter((m) => !baseModels.includes(m))];
    const finalModels = mergedModels.filter((m) => cfg.modelStates[id + "/" + m]?.enabled !== false);
    const keys = await getCustomProviderKeys(c.env, id);
    const customBaseUrl = cfg.providerBaseUrls?.[id] || (id === "azure" ? c.env.AZURE_OPENAI_ENDPOINT : undefined);
    const effectiveBaseUrl = customBaseUrl || staticCfg.baseUrl || "";
    providers.push({
      id,
      name: staticCfg.name,
      isBuiltIn: true,
      enabled: state,
      baseUrl: effectiveBaseUrl,
      defaultBaseUrl: staticCfg.baseUrl || "",
      hasCustomEndpoint: Boolean(customBaseUrl),
      authType: staticCfg.authType,
      protocol: "openai",
      models: finalModels,
      freeTier: staticCfg.freeTier,
      supportsStreaming: staticCfg.supportsStreaming,
      supportsTools: staticCfg.supportsTools,
      supportsVision: staticCfg.supportsVision,
      keyCount: keys.length,
      keys: keys.map(maskSecret), // C-2
    });
  }

  for (const [id, cp] of Object.entries(cfg.customProviders)) {
    const keys = await getCustomProviderKeys(c.env, id);
    const removed = new Set(cfg.removedModels?.[id] || []);
    const finalModels = (cp.models || []).filter((m) => !removed.has(m) && cfg.modelStates[id + "/" + m]?.enabled !== false);
    const customBaseUrl = cfg.providerBaseUrls?.[id];
    providers.push({
      id,
      name: cp.name,
      isBuiltIn: false,
      enabled: true,
      baseUrl: customBaseUrl || cp.baseUrl,
      defaultBaseUrl: cp.baseUrl,
      hasCustomEndpoint: Boolean(customBaseUrl),
      authType: cp.protocol === "anthropic" ? "anthropic" : "bearer",
      protocol: cp.protocol,
      models: finalModels,
      freeTier: cp.freeTier,
      supportsStreaming: cp.supportsStreaming,
      supportsTools: cp.supportsTools,
      supportsVision: cp.supportsVision,
      keyCount: keys.length,
      keys: keys.map(maskSecret), // C-2
    });
  }

  return c.json({
    providers,
    hasKV: Boolean(c.env.OMNI_KEYS),
    providerStates: cfg.providerStates,
    modelStates: cfg.modelStates,
    customModels: cfg.customModels,
    removedModels: cfg.removedModels || {},
    customProviders: Object.fromEntries(
      Object.entries(cfg.customProviders).map(([id, cp]) => [
        id,
        { ...cp, apiKeys: cp.apiKeys.map(maskSecret) }, // C-2
      ])
    ),
  });
});

adminRouter.post("/providers/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    const current = cfg.providerStates[id]?.enabled ?? (PROVIDER_REGISTRY[id] ? true : false);
    cfg.providerStates[id] = { enabled: enabled ?? !current };
  });
  return c.json({ ok: true, id, providerStates: cfg.providerStates });
});

adminRouter.post("/providers/:id/endpoint", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: string };
  const rawUrl = (body.baseUrl || "").trim();
  const cfg = await setProviderBaseUrl(c.env, id, rawUrl);
  const staticCfg = PROVIDER_REGISTRY[id];
  const effectiveBaseUrl = cfg.providerBaseUrls?.[id] || (id === "azure" ? c.env.AZURE_OPENAI_ENDPOINT : undefined) || staticCfg?.baseUrl || "";
  return c.json({
    ok: true,
    id,
    baseUrl: effectiveBaseUrl,
    hasCustomEndpoint: Boolean(cfg.providerBaseUrls?.[id]),
  });
});

adminRouter.delete("/providers/:id/endpoint", async (c) => {
  const id = c.req.param("id");
  const cfg = await setProviderBaseUrl(c.env, id, undefined);
  const staticCfg = PROVIDER_REGISTRY[id];
  return c.json({
    ok: true,
    id,
    baseUrl: staticCfg?.baseUrl || "",
    hasCustomEndpoint: false,
  });
});

adminRouter.post("/providers", async (c) => {
  const body = (await c.req.json()) as Partial<CustomProvider>;
  const name = body.name?.trim();
  const baseUrl = body.baseUrl?.trim();
  if (!name || !baseUrl) {
    return c.json({ error: { message: "name e baseUrl são obrigatórios", type: "validation" } }, 400);
  }
  const id = body.id?.trim() ? slugifyProviderId(body.id.trim()) : slugifyProviderId(name);
  const apiKeys = (body.apiKeys || []).map((k) => k.trim()).filter(Boolean);
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    cfg.customProviders[id] = {
      id, name, baseUrl,
      apiKeys,
      protocol: body.protocol || "openai",
      models: body.models || [],
      freeTier: body.freeTier ?? false,
      costPerMillionInput: body.costPerMillionInput ?? 0,
      costPerMillionOutput: body.costPerMillionOutput ?? 0,
      supportsStreaming: body.supportsStreaming ?? true,
      supportsTools: body.supportsTools ?? false,
      supportsVision: body.supportsVision ?? false,
    };
  });
  if (apiKeys.length) await appendProviderKeys(c.env, id, apiKeys);
  return c.json({ ok: true, id, provider: { ...cfg.customProviders[id], apiKeys: apiKeys.map(maskSecret) } });
});

adminRouter.delete("/providers/:id", async (c) => {
  const id = c.req.param("id");
  const existing = (await getAdminConfig(c.env)).customProviders[id];
  if (!existing) return c.json({ error: { message: "Provedor não encontrado", type: "not_found" } }, 404);
  const cfg = await mutateAdminConfig(c.env, (cfg) => { delete cfg.customProviders[id]; });
  await removeProviderKeys(c.env, id, await getCustomProviderKeys(c.env, id));
  return c.json({ ok: true, id, customProviders: cfg.customProviders });
});

adminRouter.post("/providers/:id/keys", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { keys?: string[]; credentials?: Array<{ apiKey?: string }> };
  const credentials = (body.credentials || []).map((item) => ({ apiKey: item.apiKey?.trim() || "" }));
  credentials.push(...(body.keys || []).map((apiKey) => ({ apiKey: apiKey.trim() })));
  const merged = await appendProviderCredentials(c.env, id, credentials.filter((item) => item.apiKey));
  return c.json({ ok: true, id, keyCount: merged.length, count: merged.length, keys: merged.map((item) => ({ key: maskSecret(item.apiKey) })) });
});

adminRouter.delete("/providers/:id/keys", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { keys?: string[] };
  let remaining: string[];
  if (!body.keys || body.keys.length === 0) {
    // Limpar todas as chaves deste provedor
    await setStoredProviderCredentials(c.env, id, []);
    remaining = [];
  } else {
    remaining = await removeProviderKeys(c.env, id, body.keys);
  }
  return c.json({
    ok: true,
    id,
    keyCount: remaining.length,
    count: remaining.length,
    keys: remaining.map(maskSecret),
  });
});

adminRouter.post("/providers/:id/models", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { model?: string; models?: string[] };
  const modelsToAdd = (body.models && Array.isArray(body.models) ? body.models : [body.model])
    .map((m) => m?.trim())
    .filter((m): m is string => Boolean(m));
  if (modelsToAdd.length === 0) {
    return c.json({ error: { message: "Nome do modelo é obrigatório", type: "validation" } }, 400);
  }
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    if (!cfg.removedModels) cfg.removedModels = {};
    if (cfg.removedModels[id]) {
      cfg.removedModels[id] = cfg.removedModels[id].filter((m) => !modelsToAdd.includes(m));
    }
    if (cfg.customProviders[id]) {
      const list = cfg.customProviders[id].models;
      for (const model of modelsToAdd) {
        if (!list.includes(model)) list.push(model);
      }
    } else {
      cfg.customModels[id] = Array.from(new Set([...(cfg.customModels[id] || []), ...modelsToAdd]));
    }
    for (const model of modelsToAdd) {
      const mk = id + "/" + model;
      if (cfg.modelStates[mk]) delete cfg.modelStates[mk];
    }
  });
  return c.json({
    ok: true,
    id,
    models: modelsToAdd,
    customModels: cfg.customModels,
    customProviders: cfg.customProviders,
  });
});

adminRouter.post("/providers/:id/fetch-models", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; baseUrl?: string };
  const cfg = await getAdminConfig(c.env);
  const prov = cfg.customProviders[id] || PROVIDER_REGISTRY[id];
  const preset = FREE_PROVIDER_PRESETS.find((p) => p.id === id);

  let apiKey = body.apiKey?.trim() || "";
  if (!apiKey) {
    apiKey = (await selectActiveCredential(c.env, id)).apiKey;
  }

  // Prioriza baseUrl enviado no body, depois customizado no KV, depois env var, depois default do provedor
  const customBaseUrl = body.baseUrl?.trim() || cfg.providerBaseUrls?.[id] || (id === "azure" ? c.env.AZURE_OPENAI_ENDPOINT : undefined);
  const baseUrl = customBaseUrl || prov?.baseUrl || preset?.baseUrl || "";
  const authType = (prov && "authType" in prov ? prov.authType : undefined) || "bearer";
  const headerName: string = (prov && "headerName" in prov && typeof (prov as any).headerName === "string" ? (prov as any).headerName : "api-key");

  let upstreamModels: string[] = [];
  let fetchError: string | null = null;

  // Catálogo nativo Cloudflare Workers AI
  if (id === "cloudflare-ai" || baseUrl === "workers-ai") {
    upstreamModels = [
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-3.1-70b-instruct",
      "@cf/meta/llama-3.1-8b-instruct",
      "@cf/meta/llama-3-8b-instruct",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
      "@cf/qwen/qwen2.5-72b-instruct",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/mistral/mistral-7b-instruct-v0.2",
      "@cf/google/gemma-7b-it",
      "@cf/google/gemma-2b-it",
      "@cf/baai/bge-large-en-v1.5",
      "@cf/baai/bge-small-en-v1.5",
    ];
  } else if (id === "antigravity") {
    const antigravityCatalog = [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "code-bison",
      "chat-bison",
    ];
    try {
      const { getValidAntigravityAccessToken } = await import("@/oauth/antigravity");
      const agy = await getValidAntigravityAccessToken(c.env).catch(() => null);
      if (agy?.accessToken) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);
          const modelsRes = await fetch("https://cloudcode-pa.googleapis.com/v1internal:models", {
            headers: {
              Authorization: `Bearer ${agy.accessToken}`,
              "User-Agent": "Antigravity-CLI/2.5.0",
              "X-Goog-Api-Client": "gl-node/20.20.2 antigravity/2.5.0",
              Accept: "application/json",
            },
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (modelsRes.ok) {
            const data = (await modelsRes.json().catch(() => ({}))) as any;
            const list = Array.isArray(data.models) ? data.models : (Array.isArray(data.availableModels) ? data.availableModels : []);
            const extracted = list.map((m: any) => typeof m === "string" ? m : (m.id || m.name || m.modelId)).filter(Boolean);
            upstreamModels = extracted.length > 0 ? extracted : antigravityCatalog;
          } else {
            upstreamModels = antigravityCatalog;
          }
        } catch {
          upstreamModels = antigravityCatalog;
        }
      } else {
        upstreamModels = antigravityCatalog;
        fetchError = "Antigravity: Login OAuth pendente. Para conectar sua conta Google, use a aba Antigravity OAuth.";
      }
    } catch (e: any) {
      upstreamModels = antigravityCatalog;
      fetchError = "Antigravity: " + (e.message || "OAuth não autenticado");
    }
  } else if (id === "1min") {
    const oneMinCatalog = [
      "gpt-4o",
      "gpt-4o-mini",
      "o1",
      "o1-mini",
      "o3-mini",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "deepseek-chat",
      "deepseek-reasoner",
      "llama-3.3-70b-instruct",
      "mistral-large-2",
      "qwen-2.5-72b-instruct",
    ];
    upstreamModels = oneMinCatalog;
    if (!apiKey) {
      fetchError = "Catálogo oficial 1min.ai disponível. Cadastre uma chave de API para habilitar os testes.";
    }
  } else if (id === "gemini") {
    const geminiOfficialCatalog = [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-thinking-preview",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-1.5-flash-8b",
      "text-embedding-004",
      "aqa",
    ];
    if (apiKey) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        let url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        let res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!res.ok) {
          url = `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`;
          res = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
        }
        clearTimeout(timeoutId);
        if (res.ok) {
          const json = (await res.json()) as any;
          if (Array.isArray(json.models)) {
            const fetched = json.models
              .filter((m: any) => {
                const methods = m.supportedGenerationMethods || [];
                return methods.length === 0 || methods.includes("generateContent") || methods.includes("generateAnswer");
              })
              .map((m: any) => (m.name || "").replace(/^models\//, ""))
              .filter(Boolean);
            upstreamModels = fetched.length > 0 ? fetched : geminiOfficialCatalog;
          } else {
            upstreamModels = geminiOfficialCatalog;
          }
        } else {
          const errJson = (await res.json().catch(() => ({}))) as any;
          fetchError = errJson.error?.message || `Google API HTTP ${res.status}`;
          upstreamModels = geminiOfficialCatalog;
        }
      } catch (err: any) {
        fetchError = err.name === "AbortError" ? "Timeout ao consultar Google Gemini (8s)" : (err.message || String(err));
        upstreamModels = geminiOfficialCatalog;
      }
    } else {
      upstreamModels = geminiOfficialCatalog;
      fetchError = "Catálogo oficial Gemini disponível. Digite sua chave de API para sincronizar modelos personalizados.";
    }
  } else if (id === "azure") {
    const cleanAzure = (baseUrl || "").replace(/\/+$/, "");
    const azureCatalogPresets = [
      "gpt-4o",
      "gpt-4o-mini",
      "o1",
      "o3-mini",
      "gpt-4-turbo",
      "gpt-35-turbo",
      "text-embedding-3-small",
      "text-embedding-3-large",
    ];
    if (cleanAzure && !cleanAzure.includes("https://openai.azure.com")) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        let url = `${cleanAzure}/openai/deployments?api-version=2024-02-15-preview`;
        let res = await fetch(url, { headers: { Accept: "application/json", "api-key": apiKey }, signal: controller.signal });
        if (!res.ok) {
          url = `${cleanAzure}/openai/models?api-version=2024-02-15-preview`;
          res = await fetch(url, { headers: { Accept: "application/json", "api-key": apiKey }, signal: controller.signal });
        }
        clearTimeout(timeoutId);
        if (res.ok) {
          const json = (await res.json()) as any;
          const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
          const extracted = list.map((m: any) => m.id || m.name || m.model).filter(Boolean);
          upstreamModels = extracted.length > 0 ? extracted : azureCatalogPresets;
        } else {
          fetchError = `Azure HTTP ${res.status}: verifique a chave e o endpoint`;
          upstreamModels = azureCatalogPresets;
        }
      } catch (err: any) {
        fetchError = err.name === "AbortError" ? "Timeout ao consultar Azure (8s)" : (err.message || String(err));
        upstreamModels = azureCatalogPresets;
      }
    } else {
      upstreamModels = azureCatalogPresets;
      fetchError = "Azure: Configure a URL do seu recurso Azure (ex: https://seu-recurso.openai.azure.com) no campo Endpoint acima.";
    }
  } else if (id === "bedrock") {
    const bedrockModels = [
      "anthropic.claude-3-7-sonnet-20250219-v1:0",
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "anthropic.claude-3-5-haiku-20241022-v1:0",
      "anthropic.claude-3-haiku-20240307-v1:0",
      "meta.llama3-3-70b-instruct-v1:0",
      "meta.llama3-1-70b-instruct-v1:0",
      "meta.llama3-1-8b-instruct-v1:0",
      "amazon.nova-pro-v1:0",
      "amazon.nova-lite-v1:0",
      "amazon.nova-micro-v1:0",
      "mistral.mistral-large-2407-v1:0",
      "deepseek.r1-v1:0",
    ];
    const cleanBedrock = (baseUrl || "").replace(/\/+$/, "");
    if (cleanBedrock && !cleanBedrock.includes("amazonaws.com")) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const url = cleanBedrock.endsWith("/models") ? cleanBedrock : (cleanBedrock.endsWith("/v1") ? `${cleanBedrock}/models` : `${cleanBedrock}/v1/models`);
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: apiKey ? (apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`) : "",
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const json = (await res.json()) as any;
          const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : (Array.isArray(json) ? json : []));
          const extracted = list.map((m: any) => typeof m === "string" ? m : (m.id || m.name || m.model)).filter(Boolean);
          upstreamModels = extracted.length > 0 ? extracted : bedrockModels;
        } else {
          upstreamModels = bedrockModels;
        }
      } catch {
        upstreamModels = bedrockModels;
      }
    } else {
      upstreamModels = bedrockModels;
      if (!apiKey) {
        fetchError = "AWS Bedrock: Catálogo de Foundation Models disponível. Configure endpoint de proxy ou credenciais para testes.";
      }
    }
  } else if (baseUrl) {
    // Consulta à API oficial upstream para outros provedores OpenAI / Anthropic
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      let url = baseUrl.replace(/\/+$/, "") + "/models";
      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      if (id === "pollinations") {
        url = "https://gen.pollinations.ai/models";
      } else if (id === "openrouter" || id === "openrouter-free") {
        url = "https://openrouter.ai/api/v1/models";
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (authType === "anthropic" || (prov && "protocol" in prov && prov.protocol === "anthropic")) {
        headers["x-api-key"] = apiKey || "";
        headers["anthropic-version"] = "2023-06-01";
      } else if (authType === "apikey-header") {
        headers[headerName || "api-key"] = apiKey || "";
      } else {
        let cleanedUrl = baseUrl.replace(/\/+$/, "");
        if (cleanedUrl.endsWith("/models")) {
          url = cleanedUrl;
        } else if (prov?.protocol === "openai" || id === "cheaperinference" || cleanedUrl.endsWith("/v1")) {
          if (!cleanedUrl.endsWith("/v1")) cleanedUrl += "/v1";
          url = cleanedUrl + "/models";
        } else {
          url = cleanedUrl + "/models";
        }
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const json = (await res.json()) as any;
        const list = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : []));
        let extracted = list
          .map((m: any) => (typeof m === "string" ? m : (m.id || m.name)))
          .filter((m: any): m is string => Boolean(m))
          .map((m: string) => m.replace(/^models\//, ""));

        if (id === "openrouter-free") {
          const freeOnly = extracted.filter((m: string) => m.endsWith(":free"));
          extracted = freeOnly.length > 0 ? freeOnly : extracted;
        }
        upstreamModels = extracted;
      } else {
        fetchError = `Upstream HTTP ${res.status}`;
      }
    } catch (err: any) {
      fetchError = err.name === "AbortError" ? "Timeout ao consultar upstream (8s)" : (err.message || String(err));
    }
  }

  // 2. Combinar com catálogo conhecido do provedor e modelos ativos
  const activeCustomModels = cfg.customModels[id] || [];
  const registryModels = prov?.models || [];
  const removedModels = cfg.removedModels?.[id] || [];

  const allAvailable = Array.from(
    new Set([
      ...upstreamModels,
      ...registryModels,
      ...activeCustomModels,
    ])
  ).filter((m) => !removedModels.includes(m));

  return c.json({
    ok: true,
    id,
    models: allAvailable,
    upstreamCount: upstreamModels.length,
    hasUpstream: upstreamModels.length > 0,
    fetchError,
    activeModels: Array.from(new Set([...registryModels, ...activeCustomModels])).filter((m) => !removedModels.includes(m)),
  });
});

/**
 * Despachante unificado para teste direto de modelo/provedor sem side-effects
 */
export async function executeDirectProviderTest(
  env: EnvBindings,
  providerId: string,
  apiKey: string,
  model: string,
  timeoutMs = 12000,
  overrideBaseUrl?: string
): Promise<{
  provider: string;
  model: string;
  status: number;
  latency_ms: number;
  success: boolean;
  output?: string;
  error?: string;
}> {
  const testReq: ChatCompletionRequest = {
    model,
    messages: [{ role: "user" as const, content: "Respond with OK" }],
    max_tokens: 5,
    temperature: 0,
    stream: false,
  };

  const start = Date.now();
  try {
    let resPromise: Promise<Response>;

    if (providerId === "cloudflare-ai") {
      if (!env.AI) {
        return {
          provider: providerId,
          model,
          status: 503,
          latency_ms: 0,
          success: false,
          error: "Cloudflare Workers AI (env.AI) não está habilitado no ambiente",
        };
      }
      resPromise = executeCloudflareAI(testReq, env.AI, model);
    } else if (providerId === "antigravity") {
      const { getValidAntigravityAccessToken } = await import("@/oauth/antigravity");
      const { executeAntigravityRequest } = await import("@/adapters/antigravity");
      const antigravResult = await getValidAntigravityAccessToken(env);
      if (!antigravResult?.accessToken) {
        return {
          provider: providerId,
          model,
          status: 401,
          latency_ms: 0,
          success: false,
          error: "Antigravity: Nenhum token de acesso válido. Realize o login OAuth no painel.",
        };
      }
      resPromise = executeAntigravityRequest(testReq, antigravResult.accessToken, antigravResult.projectId || "", model);
    } else if (providerId === "1min") {
      if (!apiKey) {
        return {
          provider: providerId,
          model,
          status: 401,
          latency_ms: 0,
          success: false,
          error: "Sem chave de API para 1min.ai",
        };
      }
      const { executeOneMinAI } = await import("@/adapters/onemin");
      resPromise = executeOneMinAI(testReq, apiKey, model, overrideBaseUrl);
    } else {
      if (!apiKey && providerId !== "pollinations" && providerId !== "freeapikey") {
        return {
          provider: providerId,
          model,
          status: 401,
          latency_ms: 0,
          success: false,
          error: "Sem chave de API configurada",
        };
      }
      resPromise = executeOpenAICompatible(testReq, providerId, apiKey, model, overrideBaseUrl);
    }

    const res = (await Promise.race([
      resPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout " + timeoutMs + "ms")), timeoutMs)
      ),
    ])) as Response;

    const latency = Date.now() - start;
    if (res.ok) {
      let text = "OK";
      try {
        const j = (await res.json()) as any;
        if (j.choices?.[0]?.message?.content) {
          text = j.choices[0].message.content.trim().slice(0, 40);
        } else if (j.candidates?.[0]?.content?.parts?.[0]?.text) {
          text = j.candidates[0].content.parts[0].text.trim().slice(0, 40);
        } else if (j.response || j.output) {
          text = String(j.response || j.output).trim().slice(0, 40);
        }
      } catch {}
      return { provider: providerId, model, status: res.status, latency_ms: latency, success: true, output: text };
    }

    const errText = (await res.text().catch(() => "")).slice(0, 180);
    return { provider: providerId, model, status: res.status, latency_ms: latency, success: false, error: errText };
  } catch (err: unknown) {
    return {
      provider: providerId,
      model,
      status: 500,
      latency_ms: Date.now() - start,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

adminRouter.post("/providers/:id/test-models", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    apiKey?: string;
    baseUrl?: string;
    models?: string[];
  };
  const cfg = await getAdminConfig(c.env);
  const prov = cfg.customProviders[id] || PROVIDER_REGISTRY[id];
  const activeCustomModels = cfg.customModels[id] || [];
  const registryModels = prov?.models || [];
  const removedModels = cfg.removedModels?.[id] || [];

  const allAvailable = Array.from(new Set([...registryModels, ...activeCustomModels]))
    .filter((m) => !removedModels.includes(m));

  // Prioriza modelos passados no body ou os primeiros ativos (máximo 5)
  const targetModels = (Array.isArray(body.models) && body.models.length > 0)
    ? body.models.slice(0, 5)
    : allAvailable.slice(0, 5);

  if (targetModels.length === 0) {
    return c.json({ ok: false, results: [], message: "Nenhum modelo cadastrado para testar" });
  }

  let apiKey = body.apiKey?.trim() || "";
  if (!apiKey) {
    apiKey = (await selectActiveCredential(c.env, id)).apiKey;
  }
  if (!apiKey && id !== "cloudflare-ai" && id !== "antigravity" && id !== "pollinations" && id !== "freeapikey") {
    return c.json({ error: { message: "Sem chave de API configurada para testar este provedor", type: "auth" } }, 401);
  }

  const effectiveBaseUrl = body.baseUrl?.trim() || cfg.providerBaseUrls?.[id] || (id === "azure" ? c.env.AZURE_OPENAI_ENDPOINT : undefined) || prov?.baseUrl;

  const COMBO_TEST_TIMEOUT_MS = 12000;
  const results = await Promise.all(
    targetModels.map((model) => executeDirectProviderTest(c.env, id, apiKey, model, COMBO_TEST_TIMEOUT_MS, effectiveBaseUrl))
  );

  return c.json({ ok: true, results });
});

adminRouter.delete("/providers/:id/models", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { model: string };
  const model = body.model?.trim();
  if (!model) return c.json({ error: { message: "Nome do modelo é obrigatório", type: "validation" } }, 400);
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    if (!cfg.removedModels) cfg.removedModels = {};
    if (!cfg.removedModels[id]) cfg.removedModels[id] = [];
    if (!cfg.removedModels[id].includes(model)) {
      cfg.removedModels[id].push(model);
    }
    if (cfg.customProviders[id]) {
      cfg.customProviders[id].models = cfg.customProviders[id].models.filter((m) => m !== model);
    }
    if (cfg.customModels[id]) {
      cfg.customModels[id] = (cfg.customModels[id] || []).filter((m) => m !== model);
    }
    cfg.modelStates[id + "/" + model] = { enabled: false };
  });
  return c.json({ ok: true, id, model, removedModels: cfg.removedModels, customModels: cfg.customModels, customProviders: cfg.customProviders });
});

adminRouter.get("/models", async (c) => {
  const q = (c.req.query("q") || "").toLowerCase();
  const cfg = await getAdminConfig(c.env);
  const allModels: Array<{ id: string; provider: string; enabled: boolean }> = [];
  for (const [pid, p] of Object.entries(PROVIDER_REGISTRY)) {
    const enabled = cfg.providerStates[pid]?.enabled ?? true;
    const removed = new Set(cfg.removedModels?.[pid] || []);
    for (const m of p.models || []) {
      if (removed.has(m)) continue;
      allModels.push({ id: m, provider: pid, enabled: enabled && (cfg.modelStates[pid + "/" + m]?.enabled ?? true) });
    }
    for (const m of cfg.customModels[pid] || []) {
      if (removed.has(m)) continue;
      allModels.push({ id: m, provider: pid, enabled: enabled && (cfg.modelStates[pid + "/" + m]?.enabled ?? true) });
    }
  }
  for (const [pid, cp] of Object.entries(cfg.customProviders)) {
    const removed = new Set(cfg.removedModels?.[pid] || []);
    for (const m of cp.models || []) {
      if (removed.has(m)) continue;
      allModels.push({ id: m, provider: pid, enabled: true });
    }
  }
  const filtered = q ? allModels.filter((m) => m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)) : allModels;
  return c.json({ models: filtered.slice(0, 200), total: filtered.length });
});

adminRouter.post("/models", async (c) => {
  const body = (await c.req.json()) as { provider: string; model: string };
  const model = body.model?.trim();
  const provider = body.provider?.trim();
  if (!model || !provider) return c.json({ error: { message: "provider e model são obrigatórios", type: "validation" } }, 400);
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    if (!cfg.removedModels) cfg.removedModels = {};
    if (cfg.removedModels[provider]) {
      cfg.removedModels[provider] = cfg.removedModels[provider].filter((m) => m !== model);
    }
    cfg.customModels[provider] = Array.from(new Set([...(cfg.customModels[provider] || []), model]));
    const mk = provider + "/" + model;
    if (cfg.modelStates[mk]) delete cfg.modelStates[mk];
  });
  return c.json({ ok: true, provider, model, customModels: cfg.customModels });
});

// ---------------------------------------------------------------------------
// Free provider presets
// ---------------------------------------------------------------------------
export const FREE_PROVIDER_PRESETS = [
  { id: "gemini", name: "Google Gemini (AI Studio Free)", eloRank: 1, protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"], recommendedModels: ["gemini-2.5-flash", "gemini-2.0-flash"], freeTier: true, freeTierNotes: "60M tokens/mes", supportsStreaming: true, supportsTools: true, supportsVision: true },
  { id: "groq", name: "Groq LPU (Ultra-Fast Inference)", eloRank: 2, protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-2.5-coder-32b", "gemma2-9b-it"], recommendedModels: ["llama-3.3-70b-versatile"], freeTier: true, freeTierNotes: "6.000 reqs/dia", supportsStreaming: true, supportsTools: true, supportsVision: false },
  { id: "cerebras", name: "Cerebras WSE-3", eloRank: 3, protocol: "openai", baseUrl: "https://api.cerebras.ai/v1", models: ["llama3.3-70b", "llama3.1-8b"], recommendedModels: ["llama3.3-70b"], freeTier: true, freeTierNotes: "1M tokens/dia", supportsStreaming: true, supportsTools: true, supportsVision: false },
  { id: "sambanova", name: "SambaNova Systems", eloRank: 4, protocol: "openai", baseUrl: "https://api.sambanova.ai/v1", models: ["Meta-Llama-3.3-70B-Instruct", "Qwen2.5-72B-Instruct"], recommendedModels: ["Meta-Llama-3.3-70B-Instruct"], freeTier: true, freeTierNotes: "LPU gratuito", supportsStreaming: true, supportsTools: true, supportsVision: false },
  { id: "openrouter-free", name: "OpenRouter Free Models", eloRank: 5, protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", models: ["deepseek/deepseek-r1-0528:free", "deepseek/deepseek-chat-v3-0324:free"], recommendedModels: ["deepseek/deepseek-r1-0528:free"], freeTier: true, freeTierNotes: "Modelos gratuitos", supportsStreaming: true, supportsTools: false, supportsVision: false },
  { id: "cloudflare-ai", name: "Cloudflare Workers AI (Native)", eloRank: 6, protocol: "openai", baseUrl: "workers-ai", models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"], recommendedModels: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"], freeTier: true, freeTierNotes: "10.000 neuronios/dia", supportsStreaming: true, supportsTools: false, supportsVision: false },
];

adminRouter.get("/presets", (c) => c.json({ presets: FREE_PROVIDER_PRESETS }));

// ---------------------------------------------------------------------------
// Search config — C-2: mask stored API keys in GET response
// ---------------------------------------------------------------------------
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
      activeProvider: (activeProvider || cfg.searchConfig.activeProvider || "auto") as "auto" | "searxng" | "duckduckgo" | "tavily" | "serper" | "brave" | "firecrawl" | "exa" | "context7" | "linkup" | "searchapi" | "ydc",
      searxngUrl: body.searxngUrl !== undefined ? body.searxngUrl.trim() : cfg.searchConfig.searxngUrl,
      tavilyApiKey: body.tavilyApiKey !== undefined ? body.tavilyApiKey.trim() : cfg.searchConfig.tavilyApiKey,
      serperApiKey: body.serperApiKey !== undefined ? body.serperApiKey.trim() : cfg.searchConfig.serperApiKey,
      braveApiKey: body.braveApiKey !== undefined ? body.braveApiKey.trim() : cfg.searchConfig.braveApiKey,
      firecrawlApiKey: body.firecrawlApiKey !== undefined ? body.firecrawlApiKey.trim() : cfg.searchConfig.firecrawlApiKey,
      exaApiKey: body.exaApiKey !== undefined ? body.exaApiKey.trim() : cfg.searchConfig.exaApiKey,
      context7ApiKey: body.context7ApiKey !== undefined ? body.context7ApiKey.trim() : cfg.searchConfig.context7ApiKey,
      linkupApiKey: body.linkupApiKey !== undefined ? body.linkupApiKey.trim() : cfg.searchConfig.linkupApiKey,
      searchapiApiKey: body.searchapiApiKey !== undefined ? body.searchapiApiKey.trim() : cfg.searchConfig.searchapiApiKey,
      ydcApiKey: body.ydcApiKey !== undefined ? body.ydcApiKey.trim() : cfg.searchConfig.ydcApiKey,
    };
  });
  return c.json({ ok: true, searchConfig: {
    activeProvider: cfg.searchConfig.activeProvider,
    searxngUrl: cfg.searchConfig.searxngUrl,
    tavilyApiKey: maskSecret(cfg.searchConfig.tavilyApiKey),
    serperApiKey: maskSecret(cfg.searchConfig.serperApiKey),
    braveApiKey: maskSecret(cfg.searchConfig.braveApiKey),
    firecrawlApiKey: maskSecret(cfg.searchConfig.firecrawlApiKey),
    exaApiKey: maskSecret(cfg.searchConfig.exaApiKey),
    context7ApiKey: maskSecret(cfg.searchConfig.context7ApiKey),
    linkupApiKey: maskSecret(cfg.searchConfig.linkupApiKey),
    searchapiApiKey: maskSecret(cfg.searchConfig.searchapiApiKey),
    ydcApiKey: maskSecret(cfg.searchConfig.ydcApiKey),
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

// ---------------------------------------------------------------------------
// Virtual keys — C-2: token returned ONCE on creation, masked on GET
// ---------------------------------------------------------------------------
adminRouter.get("/virtual-keys", async (c) => {
  const cfg = await getAdminConfig(c.env);
  return c.json({
    keys: Object.values(cfg.virtualKeys || {}).map((vk) => ({
      id: vk.id,
      name: vk.name,
      keyPreview: maskSecret(vk.id), // C-2: never return full token
      createdAt: vk.createdAt,
      requestsCount: vk.totalRequests || 0,
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
      createdAt: new Date().toISOString(),
      allowedModels: allowed,
      rpmLimit: body.rpmLimit,
      totalRequests: 0,
      enabled: true,
    };
  });
  // C-2: return full key ONLY at creation time
  return c.json({ ok: true, key: { id: keyId, name, key: keyId, createdAt: new Date().toISOString(), requestsCount: 0, allowedModels: allowed } });
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

// ---------------------------------------------------------------------------
// Combos — A-5: deleteCombo() maintains blacklist for defaults
// ---------------------------------------------------------------------------
adminRouter.get("/combos", async (c) => {
  const cfg = await getAdminConfig(c.env);
  return c.json({ ok: true, combos: Object.values(cfg.combos || {}) });
});

adminRouter.post("/combos", async (c) => {
  const body = (await c.req.json()) as Partial<ComboConfig>;
  const rawId = body.id?.trim() || body.name?.trim();
  if (!rawId) return c.json({ error: { message: "ID/Nome do Combo e obrigatorio", type: "validation" } }, 400);
  const id = slugifyProviderId(rawId);
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    const existing = cfg.combos[id];
    cfg.combos[id] = {
      id, name: body.name?.trim() || id,
      description: body.description?.trim() || "",
      strategy: body.strategy || "priority",
      targets: Array.isArray(body.targets) ? body.targets : [],
      enabled: body.enabled !== false,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // If re-creating a deleted default, remove from blacklist
    cfg._deletedDefaultCombos = cfg._deletedDefaultCombos.filter((d) => d !== id);
  });
  return c.json({ ok: true, combo: cfg.combos[id] });
});

adminRouter.delete("/combos/:id", async (c) => {
  const id = c.req.param("id");
  await deleteCombo(c.env, id); // A-5: handles default combo blacklist
  const cfg = await getAdminConfig(c.env);
  return c.json({ ok: true, id, combos: Object.values(cfg.combos) });
});

adminRouter.post("/combos/:id/models", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { provider: string; model: string; weight?: number; priority?: number };
  if (!body.provider || !body.model) return c.json({ error: { message: "provider e model sao obrigatorios", type: "validation" } }, 400);
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    if (!cfg.combos[id]) return;
    const already = cfg.combos[id].targets.find((x) => x.provider === body.provider && x.model === body.model);
    if (!already) cfg.combos[id].targets.push({ provider: body.provider, model: body.model, weight: body.weight, priority: body.priority });
    cfg.combos[id].updatedAt = new Date().toISOString();
  });
  return c.json({ ok: true, id, combo: cfg.combos[id] });
});

adminRouter.delete("/combos/:id/models", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json()) as { provider: string; model: string };
  if (!body.provider || !body.model) return c.json({ error: { message: "provider e model sao obrigatorios", type: "validation" } }, 400);
  const cfg = await mutateAdminConfig(c.env, (cfg) => {
    if (cfg.combos[id]) {
      cfg.combos[id].targets = cfg.combos[id].targets.filter(
        (t) => !(t.provider === body.provider && t.model === body.model)
      );
      cfg.combos[id].updatedAt = new Date().toISOString();
    }
  });
  return c.json({ ok: true, id, combo: cfg.combos[id] });
});

// ---------------------------------------------------------------------------
// Combo test — A-7: direct provider call (not cascade), M-10: parallel + timeout
// ---------------------------------------------------------------------------
const COMBO_TEST_TIMEOUT_MS = 12_000;

adminRouter.post("/combos/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    comboId?: string;
    targets?: Array<{ provider: string; model: string }>;
  };
  const cfg = await getAdminConfig(c.env);
  let targets: Array<{ provider: string; model: string }>;

  if (body.targets && Array.isArray(body.targets) && body.targets.length > 0) {
    targets = body.targets;
  } else if (body.comboId && cfg.combos[body.comboId]) {
    targets = cfg.combos[body.comboId].targets;
  } else {
    targets = [
      { provider: "gemini", model: "gemini-2.0-flash" },
      { provider: "groq", model: "llama-3.3-70b-versatile" },
      { provider: "cerebras", model: "llama3.3-70b" },
      { provider: "cloudflare-ai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
    ];
  }

  // A-7: call provider directly with proper adapter and timeout
  const testTarget = async (target: { provider: string; model: string }) => {
    const provCfg = getProviderConfig(target.provider);
    if (!provCfg) {
      return { provider: target.provider, model: target.model, status: 404, latency_ms: 0, success: false, error: "Provedor não encontrado" };
    }
    const credential = await selectActiveCredential(c.env, target.provider);
    const apiKey = credential.apiKey;
    const customBaseUrl = cfg.providerBaseUrls?.[target.provider] || (target.provider === "azure" ? c.env.AZURE_OPENAI_ENDPOINT : undefined);
    return executeDirectProviderTest(c.env, target.provider, apiKey, target.model, COMBO_TEST_TIMEOUT_MS, customBaseUrl);
  };

  // M-10: all in parallel
  const results = await Promise.all(targets.map(testTarget));
  return c.json({ ok: true, results });
});

// ---------------------------------------------------------------------------
// Antigravity OAuth config — C-2: credentials masked
// ---------------------------------------------------------------------------
adminRouter.get("/antigravity/status", async (c) => {
  const { clientId, isConfigured } = await getAntigravityOAuthCredentials(c.env);
  const creds = await getStoredProviderCredentials(c.env, "antigravity");
  const hasTokens = creds && creds.length > 0;
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

export default adminRouter;

// Phase C: usage stats
adminRouter.get("/usage/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const usage = await getUsageSummary(c.env, keyId);
  return c.json({ keyId, ...usage });
});

// Phase C: circuit breaker status
adminRouter.get("/circuits", async (c) => {
  const providers = ["openai", "gemini", "groq", "cerebras", "cloudflare-ai", "1min", "openrouter", "deepseek", "mistral", "sambanova", "pollinations"];
  const results = await Promise.all(providers.map(async (p) => ({ provider: p, ...(await getCircuitStatus(c.env, p)) })));
  return c.json({ circuits: results });
});
