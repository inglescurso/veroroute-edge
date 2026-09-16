/**
 * Descoberta de modelos upstream (model discovery).
 *
 * Concentra as rotas de listagem de modelos que o painel usa no botão
 * "Buscar Modelos":
 *  - Google Cloud Code Assist (Antigravity CLI / alias "agy");
 *  - Gemini (AI Studio) na superfície nativa e na camada compatível com OpenAI.
 */

import { ANTIGRAVITY_PUBLIC_CONFIG } from "@/config/constants";
import { extractModelIds, stripTrailingSlashes } from "@/config/providerAliases";

export const GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_OPENAI_COMPAT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

/** Resultado padronizado de uma tentativa de descoberta upstream. */
export interface DiscoveryResult {
  models: string[];
  error: string | null;
  /** "upstream" = lista real da API; "catalog" = catálogo local de fallback. */
  source: "upstream" | "catalog";
}

// ---------------------------------------------------------------------------
// Cloud Code Assist (Antigravity CLI / "agy")
// ---------------------------------------------------------------------------

const ANTIGRAVITY_DISCOVERY_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

/**
 * Ordena os modelos priorizando o grupo "Recommended" do agentModelSorts e,
 * em seguida, ordenando os demais alfabeticamente (mesma heurística do
 * language server oficial do Antigravity).
 */
function orderAntigravityModels(ids: string[], payload: any): string[] {
  const available = new Set(ids);
  const ordered: string[] = [];

  const push = (id: unknown) => {
    if (typeof id !== "string") return;
    const clean = id.replace(/^models\//, "");
    if (available.has(clean) && !ordered.includes(clean)) ordered.push(clean);
  };

  const sorts = Array.isArray(payload?.agentModelSorts) ? payload.agentModelSorts : [];
  const recommended = sorts.filter(
    (sort: any) => String(sort?.displayName || "").toLowerCase() === "recommended"
  );
  const others = sorts.filter((sort: any) => !recommended.includes(sort));

  for (const sort of [...recommended, ...others]) {
    for (const group of sort?.groups || []) {
      for (const modelId of group?.modelIds || []) push(modelId);
    }
  }

  push(payload?.defaultAgentModelId);
  for (const id of [...available].sort()) push(id);

  return ordered;
}

/**
 * Lista os modelos realmente disponíveis para uma conta do Antigravity CLI.
 *
 * Endpoint oficial (RPC POST — NÃO existe rota REST /v1internal:models):
 *   POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
 *   body: {"project":"<projectId>"}
 *   resposta: { models: { "<slug>": { displayName, ... } }, agentModelSorts: [...] }
 */
export async function fetchAntigravityAvailableModels(
  accessToken: string,
  projectId?: string,
  timeoutMs = 8000
): Promise<DiscoveryResult> {
  if (!accessToken) {
    return { models: [], error: "Access token do Antigravity ausente", source: "catalog" };
  }

  const project = (projectId || ANTIGRAVITY_PUBLIC_CONFIG.defaultProjectId || "").trim();
  const body = JSON.stringify(project ? { project } : {});

  let lastError: string | null = null;

  for (const host of ANTIGRAVITY_DISCOVERY_HOSTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(host + ANTIGRAVITY_PUBLIC_CONFIG.fetchAvailableModelsPath, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": ANTIGRAVITY_PUBLIC_CONFIG.userAgent,
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
        lastError = `Cloud Code Assist HTTP ${res.status} (${host})${detail ? " — " + detail : ""}`;
        continue;
      }

      const json: any = await res.json().catch(() => null);
      const payload = json?.response && typeof json.response === "object" ? json.response : json;
      const list = payload?.models ?? payload?.availableModels ?? payload?.available_models;
      const raw = extractModelIds(list && typeof list === "object" && !Array.isArray(list) ? list : list);

      if (raw.length > 0) {
        return { models: orderAntigravityModels(raw, payload), error: null, source: "upstream" };
      }

      lastError = `Cloud Code Assist respondeu sem modelos (${host})`;
    } catch (err: any) {
      lastError =
        err?.name === "AbortError"
          ? `Timeout ao consultar Cloud Code Assist (${timeoutMs}ms)`
          : err?.message || String(err);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    models: [],
    error: lastError || "Falha desconhecida na descoberta Antigravity",
    source: "catalog",
  };
}

// ---------------------------------------------------------------------------
// Gemini (AI Studio) — camada compatível com OpenAI
// ---------------------------------------------------------------------------

/**
 * Lista modelos pela superfície compatível com OpenAI do Google:
 *   GET {base}/models  +  Authorization: Bearer <API_KEY>
 *
 * Necessário para a Base URL "https://generativelanguage.googleapis.com/v1beta/openai/"
 * e para as chaves novas do AI Studio (formato "AQ...."), que não funcionam
 * no parâmetro ?key= da API nativa.
 */
export async function fetchGeminiOpenAICompatModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 8000
): Promise<DiscoveryResult> {
  const url = stripTrailingSlashes(baseUrl || GEMINI_OPENAI_COMPAT_BASE_URL) + "/models";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: apiKey ? `Bearer ${apiKey}` : "",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const errJson: any = await res.json().catch(() => ({}));
      return {
        models: [],
        error: errJson?.error?.message || `Google OpenAI-compat HTTP ${res.status}`,
        source: "catalog",
      };
    }

    const json: any = await res.json().catch(() => ({}));
    const models = extractModelIds(json);
    return {
      models,
      error: models.length > 0 ? null : "Resposta da camada OpenAI-compat sem modelos",
      source: models.length > 0 ? "upstream" : "catalog",
    };
  } catch (err: any) {
    return {
      models: [],
      error:
        err?.name === "AbortError"
          ? `Timeout ao consultar ${url} (${timeoutMs}ms)`
          : err?.message || String(err),
      source: "catalog",
    };
  } finally {
    clearTimeout(timer);
  }
}
