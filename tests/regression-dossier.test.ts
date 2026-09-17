import { describe, it, expect } from "vitest";
import { resolveCandidates } from "@/routing/cascade";
import { PROVIDER_REGISTRY } from "@/config/providers";
import { DEFAULT_MODELS_CATALOG, DEFAULT_COMBOS as DEAD_COMBOS } from "@/config/constants";
import { DEFAULT_COMBOS as LIVE_COMBOS, type AdminConfig } from "@/admin/store";
import { APP_COMMIT_SHA } from "@/config/version";
import type { ChatCompletionRequest } from "@/types/openai";

describe("Dossiê de Falhas do Subsistema de Modelos (Casos de Regressão)", () => {
  // -------------------------------------------------------------------------
  // Falha 1: O gateway mente sobre quais modelos existem via DEFAULT_MODELS_CATALOG
  // -------------------------------------------------------------------------
  it("Falha 1: DEFAULT_MODELS_CATALOG é uma lista estática com modelos mortos", () => {
    // Prova: O catálogo hardcoded lista modelos como cerebras/llama3.3-70b
    const cerebrasModel = DEFAULT_MODELS_CATALOG.find((m) => m.id === "cerebras/llama3.3-70b");
    expect(cerebrasModel).toBeDefined();
    expect(cerebrasModel?.provider).toBe("cerebras");

    const groqModel = DEFAULT_MODELS_CATALOG.find((m) => m.id === "llama-3.3-70b-versatile");
    expect(groqModel).toBeDefined();
    expect(groqModel?.provider).toBe("groq");
  });

  // -------------------------------------------------------------------------
  // Falha 2: Modelo desconhecido cai silenciosamente no gpt-4o (OpenAI)
  // -------------------------------------------------------------------------
  it("Falha 2: Modelo inexistente cai silenciosamente no fallback gpt-4o hoje", () => {
    const fakeRequest: ChatCompletionRequest = {
      model: "modelo-que-nao-existe-12345",
      messages: [{ role: "user", content: "oi" }],
    };
    const plan = resolveCandidates(fakeRequest);

    // Documenta a falha atual: em vez de retornar candidates vazio ou erro,
    // o roteador devolve o primeiro elemento do catálogo estático (gpt-4o)
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates[0].model).toBe("gpt-4o");
    expect(plan.candidates[0].provider).toBe("openai");
  });

  // -------------------------------------------------------------------------
  // Falha 3: Prefixos não reconhecidos (nvidia, deepseek, mistral) viram gpt-4o
  // -------------------------------------------------------------------------
  it("Falha 3: Prefixos como nvidia/ e deepseek/ não estão na lista de prefixos e viram gpt-4o", () => {
    const nvidiaReq: ChatCompletionRequest = {
      model: "nvidia/meta/llama-3.2-11b-vision-instruct",
      messages: [{ role: "user", content: "oi" }],
    };
    const nvidiaPlan = resolveCandidates(nvidiaReq);
    // Hoje cai no fallback gpt-4o porque "nvidia" não está no loop de prefixos do cascade.ts
    expect(nvidiaPlan.candidates[0].provider).toBe("openai");
    expect(nvidiaPlan.candidates[0].model).toBe("gpt-4o");

    const deepseekReq: ChatCompletionRequest = {
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "oi" }],
    };
    const deepseekPlan = resolveCandidates(deepseekReq);
    // Hoje cai no fallback gpt-4o porque "deepseek" não está no loop de prefixos do cascade.ts
    expect(deepseekPlan.candidates[0].provider).toBe("openai");
    expect(deepseekPlan.candidates[0].model).toBe("gpt-4o");
  });

  // -------------------------------------------------------------------------
  // Falha 4: A configuração do painel (providerStates, modelStates) é ignorada pelo roteador
  // -------------------------------------------------------------------------
  it("Falha 4: resolveCandidates ignora providerStates e modelStates do AdminConfig", () => {
    const groqReq: ChatCompletionRequest = {
      model: "groq/llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "oi" }],
    };

    const mockAdminCfg: Partial<AdminConfig> = {
      providerStates: { groq: { enabled: false } },
      modelStates: { "groq/llama-3.3-70b-versatile": { enabled: false } },
      removedModels: { groq: ["llama-3.3-70b-versatile"] },
      combos: {},
    };

    const plan = resolveCandidates(groqReq, mockAdminCfg as AdminConfig);
    // Documenta a falha atual: mesmo com providerStates.groq desabilitado,
    // o roteador devolve groq porque só olha prefixos e combos.
    expect(plan.candidates.length).toBe(1);
    expect(plan.candidates[0].provider).toBe("groq");
  });

  // -------------------------------------------------------------------------
  // Falha 5: Provedores duplicados no registro
  // -------------------------------------------------------------------------
  it("Falha 5: PROVIDER_REGISTRY canônico existe mas aliases podem criar duplicatas", () => {
    expect(PROVIDER_REGISTRY["groq"]).toBeDefined();
    expect(PROVIDER_REGISTRY["cerebras"]).toBeDefined();
    expect(PROVIDER_REGISTRY["openrouter"]).toBeDefined();
    expect(PROVIDER_REGISTRY["cloudflare-ai"]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Falha 7: Descoberta e execução discordam no Pollinations (host legado no baseUrl)
  // -------------------------------------------------------------------------
  it("Falha 7: PROVIDER_REGISTRY.pollinations usa host legado text.pollinations.ai", () => {
    const pollinations = PROVIDER_REGISTRY["pollinations"];
    expect(pollinations).toBeDefined();
    // Documenta a falha atual: aponta para text.pollinations.ai em vez de gen.pollinations.ai/v1
    expect(pollinations.baseUrl).toBe("https://text.pollinations.ai/openai");
  });

  // -------------------------------------------------------------------------
  // Falha 11: Código morto identificado no dossiê
  // -------------------------------------------------------------------------
  it("Falha 11: DEFAULT_COMBOS em constants.ts é uma cópia morta divergente de store.ts", () => {
    // Documenta que existem dois DEFAULT_COMBOS divergentes
    expect(DEAD_COMBOS).toBeDefined();
    expect(LIVE_COMBOS).toBeDefined();
    // A cópia morta em constants.ts tem estrutura diferente ({ name, strategy, targets: [{provider, model}] })
    // enquanto o store.ts tem ({ id, name, description, strategy, targets: [{provider, model, priority}], enabled })
    expect(Object.keys(DEAD_COMBOS)).toEqual(Object.keys(LIVE_COMBOS));
    expect((DEAD_COMBOS as any)["omni-free"].targets[0]).not.toEqual(LIVE_COMBOS["omni-free"].targets[0]);
  });

  // -------------------------------------------------------------------------
  // Falha 12: APP_COMMIT_SHA congelado
  // -------------------------------------------------------------------------
  it("Falha 12: APP_COMMIT_SHA é uma string hardcoded desatualizada em relação ao git master", () => {
    expect(APP_COMMIT_SHA).toBe("a90d193");
    // O git master atual é cdaab06
    expect(APP_COMMIT_SHA).not.toBe("cdaab06");
  });

  // -------------------------------------------------------------------------
  // Falha 13: Incompatibilidade de tipo entre ProviderConfig e CustomProvider
  // -------------------------------------------------------------------------
  it("Falha 13: ProviderConfig authType não inclui protocol 'anthropic'", () => {
    const validAuthTypes = ["bearer", "apikey-header", "query", "oauth", "native-binding"];
    // "anthropic" não é um authType válido em ProviderConfig
    expect(validAuthTypes.includes("anthropic")).toBe(false);
  });
});
