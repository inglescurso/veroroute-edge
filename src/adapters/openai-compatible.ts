import { formatGeminiSSEChunkToOpenAI, formatGeminiToOpenAI, formatOpenAIToGemini } from "./gemini";
import type { ChatCompletionRequest } from "@/types/openai";

/**
 * Executa chamadas para qualquer provedor compatível com OpenAI ou Google Gemini REST
 */
export async function executeOpenAICompatible(
  request: ChatCompletionRequest,
  config: { baseUrl: string; apiKey: string; protocol: string }
): Promise<Response> {
  const { baseUrl, apiKey, protocol } = config;
  const modelName = request.model;

  // --- Caso Especial: Google Gemini REST API ---
  if (protocol === "gemini") {
    const isStream = request.stream ?? false;
    const cleanModel = modelName.replace("gemini/", "");
    const url = isStream
      ? `${baseUrl}/models/${cleanModel}:streamGenerateContent?alt=sse&key=${apiKey}`
      : `${baseUrl}/models/${cleanModel}:generateContent?key=${apiKey}`;

    const geminiBody = formatOpenAIToGemini(request);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(
        JSON.stringify({
          error: {
            message: `Upstream Gemini API error: ${res.statusText}`,
            type: "upstream_error",
            details: errText,
          },
        }),
        { status: res.status, headers: { "Content-Type": "application/json" } }
      );
    }

    if (isStream) {
      const { readable, writable } = new TransformStream();
      res.body?.pipeTo(writable);

      return new Response(readable.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          const text = new TextDecoder().decode(chunk);
          const lines = text.split("\n").filter(l => l.trim().startsWith("data: "));
          for (const line of lines) {
            const dataStr = line.replace(/^data: /, "").trim();
            if (dataStr === "[DONE]") {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              continue;
            }
            try {
              const geminiChunk = JSON.parse(dataStr);
              const openaiChunk = formatGeminiSSEChunkToOpenAI(geminiChunk, cleanModel);
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
            } catch (e) {
              console.error("Erro no parse do chunk Gemini", e);
            }
          }
        }
      })), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geminiRes: any = await res.json();
    const openaiRes = formatGeminiToOpenAI(geminiRes, cleanModel);
    return new Response(JSON.stringify(openaiRes), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- OpenAI / Anthropic-like via fetch ---
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (apiKey) {
    if (protocol === "anthropic") headers["x-api-key"] = apiKey;
    else headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
    },
  });
}
