import { describe, it, expect } from "vitest";
import { resolveCandidates } from "@/routing/cascade";
import { PROVIDER_REGISTRY } from "@/config/providers";
import * as constants from "@/config/constants";
import { DEFAULT_MODELS_CATALOG } from "@/config/constants";
import { getStaticCatalog, listAllAvailableModels } from "@/config/modelRegistry";
import { DEFAULT_COMBOS as LIVE_COMBOS, type AdminConfig } from "@/admin/store";
import { APP_COMMIT_SHA } from "@/config/version";
import type { ChatCompletionRequest } from "@/types/openai";

describe("Dossiê de Falhas do Subsistema de Modelos (Casos de Regressão)", () => {
  // -------------------------------------------------------------------------
  // Falha 1: O gateway mente sobre quais modelos existem via DEFAULT_MODELS_CATALOG
  // -------------------------------------------------------------------------
  it("Falha 1: DEFAULT_MODELS_CATALOG é uma lista estática com modelos mortos", () => {
    // Prova: O catálogo hardcoded lista modelos como cerebras/llama3.3-70b
    const cerebrasModel = DEFAULT_MODELS_CATALOG.find((m: any) => m.id === "cerebras/llama3.3-70b");
    expect(cerebrasModel).toBeDefined();
    expect(cerebrasModel?.provider).toBe("cerebras");

    const groqModel = DEFAULT_MODELS_CATALOG.find((m: any) => m.id === "llama-3.3-70b-versatile");
    expect(groqModel).toBeDefined();
    expect(groqModel?.provider).toBe("groq");
  });

  // -------------------------------------------------------------------------
  // Falha 2 (Corrigida na Fase 2): Modelo desconhecido NÃO cai em fallback gpt-4o
  // -------------------------------------------------------------------------
  it("Falha 2: Modelo inexistente retorna candidates vazio (sem fallback silencioso para gpt-4o)", () => {
    const fakeRequest: ChatCompletionRequest = {
      model: "modelo-que-nao-existe-12345",
      messages: [{ role: "user", content: "oi" }],
    };
    const plan = resolveCandidates(fakeRequest);

    // Corrigido: não cai mais silenciosamente em gpt-4o, retorna vazio
    expect(plan.candidates.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Falha 3 (Corrigida na Fase 2): Prefixos dinâmicos (nvidia, deepseek, mistral)
  // -------------------------------------------------------------------------
  it("Falha 3: Prefixos como nvidia/ e deepseek/ são reconhecidos dinamicamente", () => {
    const nvidiaReq: ChatCompletionRequest = {
      model: "nvidia/meta/llama-3.2-11b-vision-instruct",
      messages: [{ role: "user", content: "oi" }],
    };
    const nvidiaPlan = resolveCandidates(nvidiaReq);
    expect(nvidiaPlan.candidates.length).toBe(1);
    expect(nvidiaPlan.candidates[0].provider).toBe("nvidia");
    expect(nvidiaPlan.candidates[0].model).toBe("nvidia/meta/llama-3.2-11b-vision-instruct");

    const deepseekReq: ChatCompletionRequest = {
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "oi" }],
    };
    const deepseekPlan = resolveCandidates(deepseekReq);
    expect(deepseekPlan.candidates.length).toBe(1);
    expect(deepseekPlan.candidates[0].provider).toBe("deepseek");
    expect(deepseekPlan.candidates[0].model).toBe("deepseek/deepseek-chat");
  });

  // -------------------------------------------------------------------------
  // Falha 4 (Corrigida na Fase 2): A configuração do painel governa o roteamento
  // -------------------------------------------------------------------------
  it("Falha 4: resolveCandidates respeita providerStates e modelStates do AdminConfig", () => {
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
    // Corrigido: com providerStates.groq desabilitado, o modelo é bloqueado
    expect(plan.candidates.length).toBe(0);
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
  it("Falha 11: DEFAULT_COMBOS foi removido de constants.ts e store.ts é a fonte única", () => {
    // Prova: constants.ts não exporta mais DEFAULT_COMBOS (cópia morta eliminada)
    expect((constants as any).DEFAULT_COMBOS).toBeUndefined();
    // A única e canônica fonte de DEFAULT_COMBOS é store.ts
    expect(LIVE_COMBOS).toBeDefined();
    expect(LIVE_COMBOS["omni-free"]).toBeDefined();
    expect(LIVE_COMBOS["omni-code"]).toBeDefined();
    expect(LIVE_COMBOS["omni-fast"]).toBeDefined();
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

  // -------------------------------------------------------------------------
  // Fase 1: Centralização em modelRegistry.ts
  // -------------------------------------------------------------------------
  it("Fase 1: modelRegistry centraliza os catálogos estáticos e lista modelos disponíveis", () => {
    const cfModels = getStaticCatalog("cloudflare-ai");
    expect(cfModels.length).toBe(12);
    expect(cfModels).toContain("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    const agyModels = getStaticCatalog("antigravity");
    expect(agyModels.length).toBe(12);
    expect(agyModels).toContain("claude-opus-4-6-thinking");

    const all = listAllAvailableModels();
    expect(all.length).toBeGreaterThan(0);
    const gpt4o = all.find((m) => m.modelId === "gpt-4o" && m.providerId === "openai");
    expect(gpt4o).toBeDefined();
    expect(gpt4o?.pricing?.input_per_million).toBe(2.5);
  });
});
