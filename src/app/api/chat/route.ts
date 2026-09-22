/**
 * POST /api/chat
 *
 * A manual tool-use loop over the Gemini API. The model has no way to compute
 * a number itself - every tool in chat-tools.ts is a read-only wrapper over the
 * same db.ts the rest of the app reads, so any figure it reports came from the
 * stored pipeline output.
 *
 * What that does not buy: the prose around those figures is generated text and
 * nothing here verifies it. The system prompt tells the model to answer only
 * from tool results; no code enforces that it did, so a misread or an
 * unsupported claim is possible and the UI says as much.
 *
 * Stateless by design: the client resends the whole visible conversation
 * (plain user/assistant text) on every turn. Only that history is on the
 * wire - the functionCall / functionResponse exchange for the current turn
 * lives and dies inside this one request, so nothing but the final answer
 * needs to be persisted or re-sent by the client.
 */

import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { CHAT_TOOLS, runChatTool } from "@/lib/chat-tools";

import { providerStatus, withChatRetry } from "@/lib/chat-retry";

export const dynamic = "force-dynamic";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const MAX_TOOL_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are the assistant embedded in the Account Health Dashboard, an internal tool for Customer Success and Sales.

Answer only from tool results - every number, tier, or risk you state must come from a tool call, never from memory or estimation. If a tool returns "not found" or ambiguous candidates, ask the user to clarify rather than guessing which account they mean.

A CSM is reading this between calls, on a narrow panel. Brevity is the requirement, not a preference:

- Open with the direct answer in one short sentence.
- Keep the whole reply under 90 words. A list of accounts: under 130.
- Listing accounts? One line each, no sub-bullets: **Company Name** - $ARR - the single strongest reason, in a few words.
- Give the one reason that matters most. Do not enumerate every risk an account carries, and do not repeat score, tier, plan and ARR together unless asked for them.
- Formatting: plain sentences and single-level lines only. Use **bold** for company names and nothing else. No headings, no numbered lists, no nested bullets, no tables.
- Close with at most one short offer to go deeper, e.g. "Ask about any of these for the full breakdown." Skip it if the answer is already complete.

Refer to accounts by company name, not slug. When a risk or pillar already has a "why it matters" or evidence sentence, compress it - do not quote it in full.

If a question falls outside what the tools can answer - for example anything this dataset does not track, like hour-of-day usage - say so directly in one sentence instead of inventing an answer.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Please send a valid question." }, { status: 400 });
  }
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40 ||
      !messages.every((m): m is ChatMessage => m !== null && typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string" &&
        m.content.trim().length > 0 && m.content.length <= 12000) ||
      messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Please send a question of up to 12,000 characters (at most 40 messages)." }, { status: 400 });
  }
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "The assistant is not configured yet. You can still explore accounts in the dashboard." }, { status: 503 });
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  const retryBudget = { remaining: 2 };
  // Disable SDK retries so attempts do not multiply underneath our turn budget.
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { retryOptions: { attempts: 1 }, timeout: 20_000 } });
  const history: Content[] = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await withChatRetry(() => ai.models.generateContent({
        model: MODEL,
        contents: history,
        config: {
          abortSignal: signal,
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: CHAT_TOOLS }],
        },
      }), signal, retryBudget);

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
      error: "Please try a narrower question. You can also open an account to see its score and risks.",
    });
  } catch (err) {
    const status = providerStatus(err);
    const error = signal.aborted
      ? "The assistant took too long to respond. Please try again; the dashboard is still available."
      : status === 401 || status === 403
        ? "The assistant could not connect with its configured credentials. Please check its API key."
        : status === 429 || status === 503
          ? "The AI service is busy right now. Please try again shortly, or use the account list and details."
          : "The assistant could not complete this request. Please try again, or explore the dashboard.";
    return NextResponse.json({ error }, { status: signal.aborted ? 504 : 503 });
  }
}
