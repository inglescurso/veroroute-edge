/**
 * Constantes Globais, Credenciais Públicas OAuth e Templates de Provedores
 */

// Credenciais Públicas Oficiais do Google Cloud Code Assist (Antigravity CLI / agy)
export const ANTIGRAVITY_PUBLIC_CONFIG = {
  get clientId() {
    return [94,93,89,88,66,95,67,68,83,29,69,76,83,65,29,14,69,5,66,6,3,92,1,64,94,25,23,23,72,66,70,87,26,29,12,65,25,91,7,89,9,93,66,92,16,4,75,76,0,5,17,66,14,12,66,17,93,10,24,29,12,0,12,26,26,17,72,30,1,76,15,6,14]
      .map((c, i) => String.fromCharCode(c ^ "omniroute-public-v1".charCodeAt(i % 19))).join("");
  },
  get clientSecret() {
    return [40,34,45,58,34,55,88,63,80,21,54,34,48,88,81,85,97,18,125,37,92,3,37,48,87,6,44,38,25,10,67,19,40,40,5]
      .map((c, i) => String.fromCharCode(c ^ "omniroute-public-v1".charCodeAt(i % 19))).join("");
  },
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  runtimeBaseUrl: "https://cloudcode-pa.googleapis.com",
  loadCodeAssistPath: "/v1internal:loadCodeAssist",
  onboardUserPath: "/v1internal:onboardUser",
  modelsDiscoveryPath: "/v1internal:models",
};

// Claude Code CLI OAuth
export const CLAUDE_PUBLIC_CONFIG = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  scopes: ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code"],
};

// OpenAI Codex CLI OAuth
export const CODEX_PUBLIC_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: "openid profile email offline_access",
};

export const PROVIDER_TEMPLATES = [
  { id: "openai", name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", models: [] },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", models: [] },
  { id: "gemini", name: "Google Gemini", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: [] },
  { id: "groq", name: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", models: [] },
  { id: "openrouter", name: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", models: [] },
  { id: "cerebras", name: "Cerebras", protocol: "openai", baseUrl: "https://api.cerebras.ai/v1", models: [] },
  { id: "alibaba", name: "Alibaba DashScope", protocol: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", models: [] },
  { id: "cloudflare-ai", name: "Cloudflare Workers AI", protocol: "openai", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1", models: [] },
];

export const DEFAULT_COMBOS = {
  "omni-free": {
    name: "Omni Free Tier Cascade",
    strategy: "priority",
    targets: [
      { provider: "gemini", model: "gemini-2.5-flash" },
      { provider: "groq", model: "llama-3.3-70b-versatile" },
      { provider: "cerebras", model: "llama3.3-70b" },
      { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" },
    ],
  }
};
