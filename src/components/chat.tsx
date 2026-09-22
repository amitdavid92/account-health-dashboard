"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const EXAMPLES = [
  "Which accounts are At Risk and why?",
  "What's wrong with Pinnacle Manufacturing?",
  "How much ARR is at risk right now?",
  "What did the data-quality check find?",
];

/**
 * Renders the two things the model is told to emit, and nothing else:
 * line breaks (preserved by whitespace-pre-wrap on the bubble) and **bold**
 * company names. A full markdown renderer would be a dependency and a much
 * larger attack surface for one styling nicety; anything else the model sends
 * falls through as plain text rather than as stray asterisks in a heading.
 */
function formatReply(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * A chat panel over the same read path the pages use - see chat-tools.ts.
 * Stateless on the wire: only plain user/assistant text round-trips to the
 * client, so there is nothing but this array to persist between messages.
 */
export function ChatAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryRef = useRef<ChatMessage[] | null>(null);
  const inFlight = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, pending, error]);

  /** Drops the transcript so the next question starts a fresh context. The
   *  server is stateless, so clearing this array is the whole reset. */
  function resetConversation() {
    if (inFlight.current) return;
    setMessages([]);
    setInput("");
    setError(null);
    retryRef.current = null;
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || pending) return;

    const next = [...messages, { role: "user", content: question } as ChatMessage];
    await submit(next);
  }

  async function submit(next: ChatMessage[]) {
    if (inFlight.current) return;
    inFlight.current = true;
    retryRef.current = next;
    setMessages(next);
    setInput("");
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
        signal: AbortSignal.timeout(50_000),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok || data.error || !data.reply) {
        setError(data.error ?? "The assistant is unavailable. Please try again.");
        return;
      }
      retryRef.current = null;
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch {
      setError("Couldn't get a response in time. Please try again; you can still use the dashboard.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Ask the data"
      title="Ask the data"
      className="grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-hairline-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M1.8 3.6c0-1 .8-1.8 1.8-1.8h8.8c1 0 1.8.8 1.8 1.8v5.6c0 1-.8 1.8-1.8 1.8H6.4l-3 2.6v-2.6H3.6c-1 0-1.8-.8-1.8-1.8z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  return (
    <>
      {trigger}
      <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-[rgba(9,9,11,0.42)] transition-opacity duration-150 ${
            open ? "pointer-events-auto opacity-100" : "opacity-0"
          }`}
          aria-hidden="true"
        />
        <aside
          aria-label="Ask the data"
          aria-hidden={!open}
          className={`absolute inset-y-0 right-0 flex w-[min(440px,100%)] flex-col border-l border-hairline bg-surface transition-transform duration-200 ${
            open ? "pointer-events-auto translate-x-0" : "translate-x-full"
          }`}
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <header className="flex items-center gap-[10px] border-b border-hairline px-[18px] py-4">
            <h2 className="text-[14px] font-semibold">Ask the data</h2>
            <span className="flex-1" />
            <button
              type="button"
              onClick={resetConversation}
              disabled={pending || (messages.length === 0 && !error)}
              title="Start a new conversation"
              className="h-[30px] rounded-[7px] border border-hairline-strong bg-surface px-[9px] text-[12px] text-ink-2 hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:text-ink-2"
            >
              New chat
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-hairline-strong bg-surface text-ink-2 hover:text-ink"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                <path
                  d="M2.5 2.5l9 9m0-9l-9 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-[18px] py-4">
            {messages.length === 0 ? (
              <div className="flex flex-col gap-[10px]">
                <p className="text-[12.5px] leading-[1.55] text-ink-2">
                  Ask about any account&apos;s score, the portfolio, or the data-quality report.
                  The model can only read numbers through the same tools the dashboard reads, so the
                  figures come from the pipeline rather than from the model. The wording around them
                  is the model&apos;s own and is not checked automatically — open the account page if
                  an answer matters.
                </p>
                <div className="flex flex-col gap-[6px]">
                  {EXAMPLES.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => send(q)}
                      className="rounded-[7px] border border-hairline-strong bg-inset px-[10px] py-[7px] text-left text-[12px] text-ink-2 hover:border-ink-3 hover:text-ink"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={`max-w-[88%] whitespace-pre-wrap rounded-[10px] px-3 py-2 text-[12.5px] leading-[1.55] ${
                      m.role === "user"
                        ? "ml-auto bg-accent-wash text-accent-ink"
                        : "mr-auto bg-inset text-ink"
                    }`}
                  >
                    {m.role === "assistant" ? formatReply(m.content) : m.content}
                  </div>
                ))}
                {pending && (
                  <div className="mr-auto max-w-[88%] rounded-[10px] bg-inset px-3 py-2 text-[12.5px] text-ink-3">
                    Checking the data… If the AI service is busy, this may take up to 45 seconds.
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="border-t border-hairline px-4 py-3 text-[12.5px] text-ink-2">
              <p>{error}</p>
              <button type="button" disabled={pending} className="mt-2 underline disabled:opacity-40"
                onClick={() => { if (retryRef.current) void submit(retryRef.current); }}>
                Try again
              </button>
              <Link href="/?tier=At%20Risk" onClick={() => setOpen(false)} className="ml-4 underline">View at-risk accounts</Link>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-end gap-[8px] border-t border-hairline px-[14px] py-[12px]"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask about an account, a risk, or the portfolio…"
              rows={1}
              className="max-h-[110px] flex-1 resize-none rounded-[7px] border border-hairline-strong bg-canvas px-[10px] py-[7px] text-[12.5px] text-ink outline-none focus:border-ink-3"
            />
            <button
              type="submit"
              disabled={pending || !input.trim()}
              className="h-[32px] shrink-0 rounded-[7px] border border-hairline-strong bg-surface px-[12px] text-[12.5px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </aside>
      </div>
    </>
  );
}
