/**
 * Kiro AI OAuth — Gerenciamento de Tokens (AWS CodeWhisperer / Amazon Q)
 *
 * Padrão idêntico ao Antigravity: o usuário importa o JSON de tokens do
 * Kiro IDE do seu computador (via painel admin) e o VeroRoute Edge cuida da
 * renovação automática e do cache.
 *
 * Formato esperado do token salvo no keyPool:
 *   { "accessToken": "...", "refreshToken": "...", "clientId": "...",
 *     "clientSecret": "...", "region": "us-east-1", "authMethod": "builder-id" }
 *
 * Suporte a 3 tipos de autenticação:
 *   1. AWS SSO OIDC (Builder ID / IDC) — mais comum, usa clientId + clientSecret
 *   2. Social Auth (Google / GitHub) — usa endpoint social da Kiro
 *   3. API Key — token de longa duração, sem renovação
 */

import type { EnvBindings } from "@/types/provider";

// ---------------------------------------------------------------------------
// Endpoints oficiais da Kiro / AWS CodeWhisperer
// ---------------------------------------------------------------------------

/** URL de renovação de tokens Social Auth (Google/GitHub) da Kiro. */
const KIRO_SOCIAL_TOKEN_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

/** Endpoint AWS SSO OIDC para renovação de tokens Builder ID / IDC. */
function kiroOidcTokenUrl(region = "us-east-1"): string {
  return `https://oidc.${region}.amazonaws.com/token`;
}

/** Endpoint de registro de cliente OIDC público (re-registro em caso de falha). */
function kiroOidcRegisterUrl(region = "us-east-1"): string {
  return `https://oidc.${region}.amazonaws.com/client/register`;
}

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type KiroAuthMethod = "builder-id" | "idc" | "social" | "api_key" | "imported";

export interface KiroTokenData {
  /** Token de acesso de curta duração (Bearer). */
  accessToken: string;
  /** Token de renovação (usado para gerar novos accessTokens). */
  refreshToken?: string;
  /** AWS SSO OIDC clientId (obrigatório para Builder ID / IDC). */
  clientId?: string;
  /** AWS SSO OIDC clientSecret (obrigatório para Builder ID / IDC). */
  clientSecret?: string;
  /** Região AWS do endpoint OIDC (padrão: us-east-1). */
  region?: string;
  /** Tipo de autenticação. */
  authMethod?: KiroAuthMethod;
  /** Profile ARN para contas IDC enterprise (opcional). */
  profileArn?: string;
  /** Timestamp em ms de expiração do accessToken. */
  expires_at?: number;
}

export interface KiroRenewedToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

// ---------------------------------------------------------------------------
// Parsing do token armazenado no keyPool
// ---------------------------------------------------------------------------

/**
 * Parseia o valor salvo no keyPool para KiroTokenData.
 * Aceita JSON completo ({ accessToken, refreshToken, ... }) ou
 * string simples (API Key de longa duração).
 */
export function parseKiroCredential(raw: string): KiroTokenData {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { accessToken: "" };

  try {
    const parsed = JSON.parse(trimmed);
    // Normaliza chaves camelCase e snake_case da Kiro IDE
    return {
      accessToken: parsed.accessToken || parsed.access_token || "",
      refreshToken: parsed.refreshToken || parsed.refresh_token || "",
      clientId: parsed.clientId || parsed.client_id || "",
      clientSecret: parsed.clientSecret || parsed.client_secret || "",
      region: parsed.region || "us-east-1",
      authMethod: parsed.authMethod || parsed.auth_method || "builder-id",
      profileArn: parsed.profileArn || parsed.profile_arn || "",
      expires_at: parsed.expires_at || 0,
    };
  } catch {
    // String simples → API Key de longa duração (não precisa renovar)
    return { accessToken: trimmed, authMethod: "api_key" };
  }
}

// ---------------------------------------------------------------------------
// Renovação de Token via AWS SSO OIDC (Builder ID / IDC)
// ---------------------------------------------------------------------------

async function refreshViaAwsOidc(data: KiroTokenData): Promise<KiroRenewedToken | null> {
  const region = data.region || "us-east-1";
  const endpoint = kiroOidcTokenUrl(region);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      refreshToken: data.refreshToken,
      grantType: "refresh_token",
    }),
  });

  if (res.ok) {
    const tokens = await res.json() as any;
    return {
      accessToken: tokens.accessToken || tokens.access_token || "",
      refreshToken: tokens.refreshToken || tokens.refresh_token || data.refreshToken,
      expiresIn: tokens.expiresIn || tokens.expires_in,
    };
  }

  const errText = await res.text().catch(() => "");

  // Detecta erros irrecuperáveis (token revogado/expirado)
  let awsErrorType = "";
  try {
    awsErrorType = (JSON.parse(errText).__type || JSON.parse(errText).error || "");
  } catch { /* não JSON */ }

  if (
    awsErrorType === "InvalidGrantException" ||
    awsErrorType === "ExpiredTokenException" ||
    awsErrorType === "invalid_grant"
  ) {
    console.warn("[VeroRoute Kiro] Token AWS SSO OIDC expirado/revogado — reautenticação necessária.");
    return null;
  }

  // Tenta re-registro do cliente OIDC público antes de desistir
  console.warn("[VeroRoute Kiro] Falha no refresh OIDC, tentando re-registro do cliente...");
  try {
    const regRes = await fetch(kiroOidcRegisterUrl(region), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientName: "kiro-oauth-client",
        clientType: "public",
        scopes: [
          "codewhisperer:completions",
          "codewhisperer:analysis",
          "codewhisperer:conversations",
        ],
        grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
      }),
    });

    if (regRes.ok) {
      const newClient = await regRes.json() as any;
      const retryRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          clientId: newClient.clientId,
          clientSecret: newClient.clientSecret,
          refreshToken: data.refreshToken,
          grantType: "refresh_token",
        }),
      });

      if (retryRes.ok) {
        const retryTokens = await retryRes.json() as any;
        return {
          accessToken: retryTokens.accessToken || "",
          refreshToken: retryTokens.refreshToken || data.refreshToken,
          expiresIn: retryTokens.expiresIn,
        };
      }
    }
  } catch (reRegErr) {
    console.warn("[VeroRoute Kiro] Re-registro de cliente OIDC falhou:", reRegErr);
  }

  console.error("[VeroRoute Kiro] Falha total na renovação via AWS SSO OIDC.", errText.slice(0, 200));
  return null;
}

// ---------------------------------------------------------------------------
// Renovação de Token via Social Auth (Google / GitHub)
// ---------------------------------------------------------------------------

async function refreshViaSocial(data: KiroTokenData): Promise<KiroRenewedToken | null> {
  const res = await fetch(KIRO_SOCIAL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken: data.refreshToken }),
  });

  if (res.ok) {
    const tokens = await res.json() as any;
    return {
      accessToken: tokens.accessToken || tokens.access_token || "",
      refreshToken: tokens.refreshToken || tokens.refresh_token || data.refreshToken,
      expiresIn: tokens.expiresIn || tokens.expires_in,
    };
  }

  const errText = await res.text().catch(() => "");
  console.error("[VeroRoute Kiro] Falha na renovação social:", res.status, errText.slice(0, 200));
  return null;
}

// ---------------------------------------------------------------------------
// Função Principal: getValidKiroAccessToken
// Equivalente ao getValidAntigravityAccessToken do módulo antigravity.ts
// ---------------------------------------------------------------------------

/**
 * Obtém um Access Token válido da Kiro para a credencial fornecida.
 *
 * Fluxo:
 *   1. Se authMethod === "api_key" → devolve accessToken diretamente (sem renovar)
 *   2. Verifica cache no OMNI_CACHE (TTL 50 min)
 *   3. Se expirado → renova via AWS SSO OIDC ou Social Auth
 *   4. Salva novo token no cache
 *
 * @param rawCredential  Valor raw do keyPool (JSON ou string)
 * @param env            EnvBindings do Worker
 */
export async function getValidKiroAccessToken(
  rawCredential: string,
  env: EnvBindings
): Promise<{ accessToken: string; profileArn: string }> {
  const data = parseKiroCredential(rawCredential);

  if (!data.accessToken && !data.refreshToken) {
    throw new Error("Kiro: credencial vazia. Importe os tokens do Kiro IDE no painel admin.");
  }

  // API Key de longa duração: devolve diretamente sem cache
  if (data.authMethod === "api_key") {
    return { accessToken: data.accessToken, profileArn: data.profileArn || "" };
  }

  // Chave de cache baseada nos primeiros 24 chars do refreshToken (sem expor)
  const cacheKey = data.refreshToken
    ? `kiro_access_${(data.refreshToken).slice(0, 24).replace(/[^a-zA-Z0-9]/g, "_")}`
    : "";

  // Verifica cache OMNI_CACHE
  if (cacheKey && env.OMNI_CACHE) {
    const cached = await env.OMNI_CACHE.get(cacheKey).catch(() => null);
    if (cached) {
      return { accessToken: cached, profileArn: data.profileArn || "" };
    }
  }

  // Sem cache: verifica se o accessToken atual ainda é válido (margem de 2 min)
  if (data.accessToken && data.expires_at && Date.now() < data.expires_at - 120_000) {
    if (cacheKey && env.OMNI_CACHE) {
      const ttlSec = Math.floor((data.expires_at - Date.now() - 120_000) / 1000);
      if (ttlSec > 0) {
        await env.OMNI_CACHE.put(cacheKey, data.accessToken, { expirationTtl: Math.min(ttlSec, 3000) }).catch(() => {});
      }
    }
    return { accessToken: data.accessToken, profileArn: data.profileArn || "" };
  }

  // Precisa renovar
  if (!data.refreshToken) {
    if (data.accessToken) {
      // Sem refresh token mas tem access token → tenta usar diretamente
      return { accessToken: data.accessToken, profileArn: data.profileArn || "" };
    }
    throw new Error("Kiro: refresh_token ausente e accessToken expirado. Reimporte os tokens.");
  }

  let renewed: KiroRenewedToken | null = null;

  // Escolha do caminho de renovação baseado no authMethod
  // "imported" cai no caminho social (tokens social-issued, não AWS OIDC)
  const isAwsOidc =
    (data.authMethod === "builder-id" || data.authMethod === "idc") &&
    Boolean(data.clientId) &&
    Boolean(data.clientSecret);

  if (isAwsOidc) {
    renewed = await refreshViaAwsOidc(data);
  } else {
    // Social (Google/GitHub) ou "imported"
    renewed = await refreshViaSocial(data);
  }

  if (!renewed || !renewed.accessToken) {
    // Fallback: tenta usar o accessToken atual mesmo que possa estar expirado
    if (data.accessToken) {
      console.warn("[VeroRoute Kiro] Renovação falhou, usando accessToken existente como fallback.");
      return { accessToken: data.accessToken, profileArn: data.profileArn || "" };
    }
    throw new Error("Kiro: falha na renovação do token. Reautenticação necessária.");
  }

  // Salva no cache OMNI_CACHE (TTL 50 minutos = 3000s, antes dos ~60min da AWS)
  if (cacheKey && env.OMNI_CACHE) {
    const ttlSec = renewed.expiresIn ? Math.min(renewed.expiresIn - 120, 3000) : 3000;
    await env.OMNI_CACHE.put(cacheKey, renewed.accessToken, { expirationTtl: Math.max(ttlSec, 60) }).catch(() => {});
  }

  return { accessToken: renewed.accessToken, profileArn: data.profileArn || "" };
}

// ---------------------------------------------------------------------------
// Utilitários públicos
// ---------------------------------------------------------------------------

/**
 * Retorna as URLs de runtime do CodeWhisperer para uma dada região.
 * - Branded gateway (us-east-1, social/Builder ID)
 * - AWS direto (todas as regiões, IDC/API Key)
 */
export function kiroRuntimeUrls(
  region = "us-east-1",
  authMethod?: KiroAuthMethod
): { primary: string; fallback: string | null } {
  const awsUrl = `https://codewhisperer.${region}.amazonaws.com/generateAssistantResponse`;
  const brandedUrl = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";

  // IDC e API Key vão direto para a AWS (sem branded gateway)
  if (authMethod === "idc" || authMethod === "api_key") {
    return { primary: awsUrl, fallback: null };
  }

  // Builder ID e Social em us-east-1: tenta branded primeiro, cai na AWS
  if (region === "us-east-1") {
    return { primary: brandedUrl, fallback: awsUrl };
  }

  // Outras regiões: direto na AWS
  return { primary: awsUrl, fallback: null };
}
