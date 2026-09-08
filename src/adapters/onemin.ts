import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk } from "@/types/openai";

const ONEMIN_BASE = "https://api.1min.ai/api/features";

/**
 * Execute 1min.ai request — clean adapter, no internal tool emulation.
 * Tool emulation is handled centrally by cascade.ts.
 */
export async function executeOneMinAI(
  request: ChatCompletionRequest,
  apiKey: string,
  modelName: string
): Promise<Response> {
  if (!apiKey) throw new Error("1min.ai: API key not configured");

  const cleanModel = modelName.replace("1min/", "");
  const isStream = request.stream ?? false;

  const endpoint = `https://api.1min.ai/api/chat-with-ai${isStream ? "?isStreaming=true" : ""}`;

  let prompt = "";
  const images: string[] = [];

  for (const m of request.messages) {
    if (typeof m.content === "string") {
      prompt += `${m.role}: ${m.content}\n\n`;
    } else if (Array.isArray(m.content)) {
      prompt += `${m.role}: `;
      for (const part of m.content) {
        if (part.type === "text") {
          prompt += part.text + " ";
        } else if (part.type === "image_url" && part.image_url?.url) {
          images.push(part.image_url.url);
          prompt += "[Image Attachment] ";
        }
      }
      prompt += "\n\n";
    }
  }

  prompt += "assistant:";

  const body: any = {
    type: "UNIFY_CHAT_WITH_AI",
    model: cleanModel,
    promptObject: {
      prompt: prompt.trim()
    }
  };

  if (images.length > 0) {
    body.promptObject.attachments = { images };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "API-KEY": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    return new Response(
      JSON.stringify({ error: { message: `1min.ai (${response.status}): ${errText.slice(0, 200)}`, status: response.status } }),
      { status: response.status, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!isStream) {
    const raw = await response.json() as any;
    let textContent = "";
    if (raw?.aiRecord?.aiRecordDetail?.resultObject) {
      const resObj = raw.aiRecord.aiRecordDetail.resultObject;
      if (Array.isArray(resObj)) {
        textContent = resObj.join("");
      } else if (typeof resObj === "string") {
        textContent = resObj;
      }
    }

    const completion: ChatCompletionResponse = {
      id: `chatcmpl-${crypto.randomUUID().slice(0, 10)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: cleanModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: textContent },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return Response.json(completion);
  }

  // Streaming: transform 1min SSE to OpenAI-compatible SSE
  if (!response.body) {
    return new Response("No stream body", { status: 502 });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          let eventType = "message";
          let data = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              data = line.slice(6).trim();
            }
          }

          if (eventType === "content" && data) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                const chunk: ChatCompletionChunk = {
                  id: `chatcmpl-${crypto.randomUUID().slice(0, 10)}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: cleanModel,
                  choices: [{ index: 0, delta: { content: parsed.content }, finish_reason: null }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            } catch (e) {}
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
