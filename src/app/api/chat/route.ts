/**
 * POST /api/chat
 *
 * A manual tool-use loop over the Gemini API. The model never computes a
 * number - every tool in chat-tools.ts is a read-only wrapper over the same
 * db.ts the rest of the app reads, so an answer here can never disagree with
 * what the dashboard itself shows.
 *
 * Stateless by design: the client resends the whole visible conversation
 * (plain user/assistant text) on every turn. Only that history is on the
 * wire - the functionCall / functionResponse exchange for the current turn
 * lives and dies inside this one request, so nothing but the final answer
 * needs to be persisted or re-sent by the client.
 */

import { ApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { CHAT_TOOLS, runChatTool } from "@/lib/chat-tools";

export const dynamic = "force-dynamic";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const MAX_TOOL_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are the assistant embedded in the Account Health Dashboard, an internal tool for Customer Success and Sales.

Answer only from tool results - every number, tier, or risk you state must come from a tool call, never from memory or estimation. If a tool returns "not found" or ambiguous candidates, ask the user to clarify rather than guessing which account they mean.

Be concise: a CSM is reading this between calls. Lead with the answer, then the one or two facts that support it. Refer to accounts by company name, not slug. When a risk or pillar already has a "why it matters" or evidence sentence, you may quote it rather than re-explain it yourself.

If a question falls outside what the tools can answer - for example anything this dataset does not track, like hour-of-day usage - say so directly instead of inventing an answer.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({
      reply:
        "The chat assistant needs a GEMINI_API_KEY environment variable - the rest of the dashboard works without it. Add one to .env.local (a free key is available at aistudio.google.com/apikey) and restart the server.",
    });
  }

  const { messages } = (await request.json()) as { messages: ChatMessage[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages is required" }, { status: 400 });
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const history: Content[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: history,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: CHAT_TOOLS }],
        },
      });

      const calls = response.functionCalls;
      if (!calls || calls.length === 0) {
        const text = response.text?.trim();
        return NextResponse.json({ reply: text || "I don't have an answer for that." });
      }

      const modelTurn = response.candidates?.[0]?.content;
      if (modelTurn) history.push(modelTurn);

      const responseParts: Part[] = [];
      for (const call of calls) {
        let resultPayload: Record<string, unknown>;
        try {
          const raw = await runChatTool(call.name ?? "", call.args ?? {});
          resultPayload = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          resultPayload = { error: err instanceof Error ? err.message : "Tool failed." };
        }
        responseParts.push({
          functionResponse: { id: call.id, name: call.name, response: resultPayload },
        });
      }
      history.push({ role: "user", parts: responseParts });
    }

    return NextResponse.json({
      reply: "That took more steps than I'm allowed to take - try asking a narrower question.",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        return NextResponse.json({
          reply: "The configured GEMINI_API_KEY was rejected. Check the key in .env.local.",
        });
      }
      if (err.status === 429) {
        return NextResponse.json({
          reply: "Rate limited by the model provider - try again in a moment.",
        });
      }
      return NextResponse.json({ reply: `The model provider returned an error: ${err.message}` });
    }
    throw err;
  }
}
