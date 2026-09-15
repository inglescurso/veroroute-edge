import type { EnvBindings } from "@/types/provider";
import { getAdminConfig } from "@/admin/store";

const keyRotationIndex: Record<string, number> = {};
const keyCooldowns: Map<string, number> = new Map();
const KV_COOLDOWN_PREFIX = "cooldown:";

export async function getProviderKeys(env: EnvBindings, providerId: string): Promise<string[]> {
  const cfg = await getAdminConfig(env);
  const p = cfg.providers[providerId];
  return p ? p.keys : [];
}

async function isKeyCooledDown(env: EnvBindings, apiKey: string): Promise<boolean> {
  const now = Date.now();
  const localExpiry = keyCooldowns.get(apiKey);
  if (localExpiry !== undefined) {
    if (now < localExpiry) return true;
    keyCooldowns.delete(apiKey);
  }
  if (env.OMNI_CACHE) {
    const kvVal = await env.OMNI_CACHE.get(KV_COOLDOWN_PREFIX + apiKey);
    if (kvVal) {
      const kvExpiry = parseInt(kvVal, 10);
      if (!isNaN(kvExpiry) && now < kvExpiry) {
        keyCooldowns.set(apiKey, kvExpiry);
        return true;
      }
    }
  }
  return false;
}

export async function selectActiveKey(env: EnvBindings, providerId: string): Promise<string> {
  const keys = await getProviderKeys(env, providerId);
  if (keys.length === 0) return "";
  if (!keyRotationIndex[providerId]) keyRotationIndex[providerId] = 0;
  for (let i = 0; i < keys.length; i++) {
    const idx = (keyRotationIndex[providerId] + i) % keys.length;
    if (!await isKeyCooledDown(env, keys[idx])) {
      keyRotationIndex[providerId] = (idx + 1) % keys.length;
      return keys[idx];
    }
  }
  console.warn("[VeroRoute KeyPool] Todas as chaves do provedor " + providerId + " estão em cooldown. Usando a primeira.");
  return keys[0];
}

export async function markKeyRateLimited(env: EnvBindings, apiKey: string, cooldownSec = 60): Promise<void> {
  if (!apiKey) return;
  const expiryMs = Date.now() + cooldownSec * 1000;
  keyCooldowns.set(apiKey, expiryMs);
  if (env.OMNI_CACHE) await env.OMNI_CACHE.put(KV_COOLDOWN_PREFIX + apiKey, String(expiryMs), { expirationTtl: cooldownSec + 10 });
}
