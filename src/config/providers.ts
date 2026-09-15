import type { DynamicProvider, EnvBindings } from "@/types/provider";
import { getAdminConfig } from "@/admin/store";

export async function getProviderConfig(env: EnvBindings, id: string): Promise<DynamicProvider | undefined> {
  const cfg = await getAdminConfig(env);
  return cfg.providers[id];
}
