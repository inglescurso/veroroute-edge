import type { EnvBindings, ComboRule, DynamicProvider } from "@/types/provider";
import { ANTIGRAVITY_PUBLIC_CONFIG } from "@/config/constants";

export interface VirtualApiKey {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  enabled: boolean;
  allowedModels?: string[];
  rpmLimit?: number;
}

export interface AdminSearchConfig {
  defaultProvider?: "duckduckgo" | "searxng" | "auto";
  activeProvider?: string;
  searxngUrl?: string;
  safeSearch?: boolean;
  serperApiKey?: string;
  braveApiKey?: string;
  tavilyApiKey?: string;
}

export interface ComboConfig extends ComboRule {}

export interface AntigravityOAuthConfig {
  clientId: string;
  clientSecret: string;
  updatedAt?: string;
}

export interface AdminConfig {
  version: number;
  _seq: number;
  _deletedDefaultCombos: string[];
  providers: Record<string, DynamicProvider>;
  searchConfig: AdminSearchConfig;
  virtualKeys: Record<string, VirtualApiKey>;
  combos: Record<string, ComboConfig>;
  antigravityConfig?: AntigravityOAuthConfig;
}

const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  version: 2,
  _seq: 0,
  _deletedDefaultCombos: [],
  providers: {},
  searchConfig: { defaultProvider: "auto", safeSearch: true },
  virtualKeys: {},
  combos: {},
};

const KV_ADMIN_KEY = "admin_config";
const CACHE_TTL_MS = 2000;

let cache: { data: AdminConfig; ts: number } | null = null;

function cloneConfig(c: AdminConfig): AdminConfig {
  return JSON.parse(JSON.stringify(c));
}

function invalidateCache(): void {
  cache = null;
}

export async function getAdminConfig(env: EnvBindings): Promise<AdminConfig> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cloneConfig(cache.data);

  const kv = env.OMNI_KEYS;
  if (!kv) {
    const def = cloneConfig(DEFAULT_ADMIN_CONFIG);
    cache = { data: def, ts: now };
    return cloneConfig(def);
  }

  try {
    const raw = await kv.get(KV_ADMIN_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AdminConfig>;
      const merged: AdminConfig = {
        ...DEFAULT_ADMIN_CONFIG,
        ...p,
        _seq: p._seq ?? 0,
        _deletedDefaultCombos: p._deletedDefaultCombos ?? [],
        searchConfig: { ...DEFAULT_ADMIN_CONFIG.searchConfig, ...(p.searchConfig ?? {}) },
        virtualKeys: { ...(p.virtualKeys ?? {}) },
        providers: { ...(p.providers ?? {}) },
        combos: { ...(p.combos ?? {}) },
        antigravityConfig: p.antigravityConfig,
      };
      cache = { data: merged, ts: now };
      return cloneConfig(merged);
    }
  } catch {
    // corrupted JSON
  }

  const def = cloneConfig(DEFAULT_ADMIN_CONFIG);
  cache = { data: def, ts: now };
  return cloneConfig(def);
}

export async function saveAdminConfig(env: EnvBindings, cfg: AdminConfig): Promise<void> {
  const kv = env.OMNI_KEYS;
  if (kv) await kv.put(KV_ADMIN_KEY, JSON.stringify(cfg));
  cache = { data: cloneConfig(cfg), ts: Date.now() };
}

export async function mutateAdminConfig(
  env: EnvBindings,
  mutator: (cfg: AdminConfig) => void,
  maxRetries = 3
): Promise<AdminConfig> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    invalidateCache();
    const cfg = await getAdminConfig(env);
    const seqBefore = cfg._seq;
    cfg._seq = seqBefore + 1;
    mutator(cfg);

    if (env.OMNI_KEYS && attempt < maxRetries) {
      const check = await env.OMNI_KEYS.get(KV_ADMIN_KEY);
      if (check) {
        try {
          const onDisk = (JSON.parse(check) as Partial<AdminConfig>)._seq ?? 0;
          if (onDisk !== seqBefore) continue; // retry
        } catch {}
      }
    }

    await saveAdminConfig(env, cfg);
    return cfg;
  }
  invalidateCache();
  const cfg = await getAdminConfig(env);
  cfg._seq = (cfg._seq ?? 0) + 1;
  mutator(cfg);
  await saveAdminConfig(env, cfg);
  return cfg;
}

export async function getAntigravityOAuthCredentials(
  env: EnvBindings
): Promise<{ clientId: string; clientSecret: string; isConfigured: boolean }> {
  const cfg = await getAdminConfig(env);
  const fromKv = cfg.antigravityConfig;
  
  const clientId =
    fromKv?.clientId?.trim() ||
    (typeof env.ANTIGRAVITY_CLIENT_ID === "string" ? env.ANTIGRAVITY_CLIENT_ID.trim() : "") ||
    ANTIGRAVITY_PUBLIC_CONFIG.clientId;
    
  const clientSecret =
    fromKv?.clientSecret?.trim() ||
    (typeof env.ANTIGRAVITY_CLIENT_SECRET === "string" ? env.ANTIGRAVITY_CLIENT_SECRET.trim() : "") ||
    ANTIGRAVITY_PUBLIC_CONFIG.clientSecret;
    
  const isConfigured = Boolean(clientId && clientSecret);
  return { clientId, clientSecret, isConfigured };
}

export function slugifyProviderId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "provider";
}
