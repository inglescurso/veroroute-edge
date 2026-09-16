/**
 * Aliases de provedores e utilitários de URL/prefixo de modelos.
 *
 * Este é o ÚNICO lugar do projeto onde aliases como "agy" são conhecidos.
 * Camadas de persistência (KV), roteamento e UI devem apenas chamar
 * normalizeProviderId() em vez de repetir comparações hardcoded.
 */

const PROVIDER_ALIASES: Record<string, string> = {
  agy: "antigravity",
  "antigravity-cli": "antigravity",
};

/** Converte um alias de provedor no seu id canônico. */
export function normalizeProviderId(providerId: string): string {
  const id = (providerId || "").trim();
  if (!id) return id;
  return PROVIDER_ALIASES[id.toLowerCase()] || id;
}

/** Remove barras finais de uma URL. */
export function stripTrailingSlashes(url: string): string {
  return (url || "").trim().replace(/\/+$/, "");
}

/**
 * Detecta base URLs que expõem a superfície compatível com OpenAI.
 * Exemplos reais:
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 *   https://generativelanguage.googleapis.com/v1beta/openai/v1
 *   https://api.groq.com/openai/v1
 */
export function isOpenAICompatBaseUrl(baseUrl: string): boolean {
  const url = stripTrailingSlashes(baseUrl).toLowerCase();
  if (!url) return false;
  if (url.endsWith("/openai")) return true;
  if (/\/openai\/v\d+$/.test(url)) return true;
  return false;
}

/** Monta a URL de listagem de modelos (/models) a partir de um base URL. */
export function buildModelsUrl(baseUrl: string): string {
  const clean = stripTrailingSlashes(baseUrl);
  if (!clean) return "";
  if (/\/models$/.test(clean)) return clean;
  return clean + "/models";
}

/**
 * Extrai a lista de ids de modelos das respostas usuais de /models:
 *   { data: [{ id }] } | { models: [{ id|name }] } | [{ id }] | { models: { slug: {...} } }
 */
export function extractModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : ((payload as any)?.data ?? (payload as any)?.models);

  if (Array.isArray(list)) {
    return list
      .map((entry: any) =>
        typeof entry === "string" ? entry : entry?.id || entry?.name || entry?.model
      )
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      .map((id: string) => id.replace(/^models\//, ""));
  }

  // Mapas { "model-id": { displayName } } (ex.: Cloud Code Assist)
  if (list && typeof list === "object") {
    return Object.keys(list as Record<string, unknown>).filter(Boolean);
  }

  return [];
}
