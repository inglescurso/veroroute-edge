import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from "@/types/openai";

/**
 * Placeholders internos (model_enum) usados pelo Cloud Code Assist.
 * Mesma tabela do language_server/Account Switcher oficiais.
 */
const ANTIGRAVITY_MODEL_PLACEHOLDERS: Record<string, string> = {
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
  "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
  "gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
  "gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-flash-lite": "MODEL_PLACEHOLDER_M50",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

/**
 * Converte mensagens do padrão OpenAI para o formato Google Gemini (contents + systemInstruction)
 */
export function formatOpenAIToGemini(request: ChatCompletionRequest): Record<string, unknown> {
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  let systemText = "";

  for (const msg of request.messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      systemText += (systemText ? "\n\n" : "") + text;
      continue;
    }

    const geminiRole = msg.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else if (part.type === "image_url") {
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            const [mimePart, base64Data] = url.split(";base64,");
            const mimeType = mimePart.replace("data:", "");
            parts.push({
              inlineData: {
                mimeType,
                data: base64Data,
              },
            });
          }
        }
      }
    }

    // Suporte a tool calls do OpenAI no formato Gemini
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {}
        parts.push({
          functionCall: {
            name: tc.function.name,
            args,
          },
        });
      }
    }

    if (msg.role === "tool" && msg.tool_call_id) {
      parts.push({
        functionResponse: {
          name: msg.name || "function",
          response: { content: msg.content },
        },
      });
    }

    if (parts.length > 0) {
      contents.push({ role: geminiRole, parts });
    }
  }

  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: request.temperature ?? 0.7,
      topP: request.top_p ?? 0.95,
      maxOutputTokens: request.max_tokens ?? request.max_completion_tokens ?? 8192,
    },
  };

  if (systemText) {
    payload.systemInstruction = {
      parts: [{ text: systemText }],
    };
  }

  // Cloud Code Assist valida estes metadados internos para alguns modelos
  // Gemini/Claude expostos pelo catálogo (o IDE oficial sempre os envia).
  // model_enum só é enviado quando o modelo tem placeholder conhecido: mandar
  // o placeholder de outro modelo faz o upstream responder 400.
  const labels: Record<string, string> = {
    used_claude: "false",
    used_claude_conservative: "false",
    used_non_gemini_model: "false",
  };
  const placeholder = ANTIGRAVITY_MODEL_PLACEHOLDERS[request.model?.replace(/^(agy|antigravity)\//, "") || ""];
  if (placeholder) labels.model_enum = placeholder;
  payload.labels = labels;

  // Conversão de tools do OpenAI para functionDeclarations do Gemini
  if (request.tools && request.tools.length > 0) {
    const functionDeclarations = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: t.function.parameters || { type: "OBJECT", properties: {} },
    }));
    payload.tools = [{ functionDeclarations }];
  }

  return payload;
}

/**
 * Converte resposta do Google Gemini para OpenAI ChatCompletionResponse
 */
export function formatGeminiToOpenAI(
  geminiRes: any,
  modelName: string
): ChatCompletionResponse {
  const candidate = geminiRes.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  let textContent = "";
  const toolCalls: any[] = [];

  for (const part of parts) {
    if (part.text) {
      textContent += part.text;
    }
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).substring(2, 10)}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const promptTokens = geminiRes.usageMetadata?.promptTokenCount || 0;
  const candidateTokens = geminiRes.usageMetadata?.candidatesTokenCount || 0;

  return {
    id: `chatcmpl-${Math.random().toString(36).substring(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent || (toolCalls.length > 0 ? null : ""),
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: candidateTokens,
      total_tokens: promptTokens + candidateTokens,
    },
  };
}

/**
 * Converte chunks de SSE do Gemini para chunks do padrão OpenAI
 */
export function formatGeminiSSEChunkToOpenAI(
  chunkJson: any,
  modelName: string
): string | null {
  const candidate = chunkJson.candidates?.[0];
  if (!candidate) return null;

  const part = candidate.content?.parts?.[0];
  const deltaText = part?.text || "";

  const chunk: ChatCompletionChunk = {
    id: `chatcmpl-${Math.random().toString(36).substring(2, 12)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        delta: {
          content: deltaText,
        },
        finish_reason: candidate.finishReason === "STOP" ? "stop" : null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}
