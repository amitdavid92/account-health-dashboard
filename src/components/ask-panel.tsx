"use client";

import { useEffect, useRef, useState } from "react";

/**
 * UI only - no agent wired up yet.
 *
 * The shapes here are deliberately the ones a real implementation needs, so
 * connecting it is additive rather than a rewrite:
 *
 *   - `streaming` on a message: a chat request should stream, so the assistant
 *     bubble renders incrementally and a long answer never looks like a hang.
 *   - `consulted`: the agent's tools are this app's own endpoints, so an answer
 *     can cite which ones it read. An unsourced number in a CS tool is worse
 *     than no number.
 *   - `status: "error" | "declined"`: an API call can fail, and a request can
 *     come back refused rather than answered. Both need somewhere to land.
 *
 * Where the logic goes: replace `sendStub` with a call to a route handler
 * (e.g. POST /api/ask) that owns the model call server-side. The API key must
 * never reach the browser, so the fetch target is our own server, not Anthropic.
 */

export interface AskSource {
  label: string;
  endpoint: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  consulted?: AskSource[];
  status?: "ok" | "error" | "declined" | "stub";
}

/** The tool surface an agent would be given - all read-only, all already built. */
const TOOL_SURFACE: AskSource[] = [
  { label: "Book & filters", endpoint: "GET /api/accounts" },
  { label: "Score decomposition", endpoint: "GET /api/accounts/:slug" },
  { label: "Roll-up & model", endpoint: "GET /api/summary" },
  { label: "Messy-data calls", endpoint: "GET /api/data-quality" },
];

export function AskPanel({ suggestions }: { suggestions: string[] }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pending]);

  /** Stands in for the real request. Swap for a POST to your own route handler. */
  const sendStub = (question: string) => {
    const q = question.trim();
    if (!q || pending) return;

    setMessages((m) => [...m, { id: `u${Date.now()}`, role: "user", text: q }]);
    setDraft("");
    setPending(true);

    window.setTimeout(() => {
      setPending(false);
      setMessages((m) => [
        ...m,
        {
          id: `a${Date.now()}`,
          role: "assistant",
          status: "stub",
          text:
            "The assistant is not connected yet — this is the interface only. " +
            "Once it is wired up, an answer to this would be grounded in the endpoints below and would cite the accounts it read.",
          consulted: TOOL_SURFACE.slice(0, 3),
        },
      ]);
    }, 450);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask about the data"
        title="Ask about the data"
        className="inline-flex h-[30px] items-center gap-[6px] rounded-[7px] border border-hairline-strong bg-surface px-[9px] text-[12.5px] text-ink-2 hover:border-ink-3 hover:text-ink"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2.2 4.1c0-1 .8-1.8 1.8-1.8h8c1 0 1.8.8 1.8 1.8v5.2c0 1-.8 1.8-1.8 1.8H7l-3.3 2.6V11.1h-.7c-1 0-1.8-.8-1.8-1.8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        Ask
      </button>

      <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
        <div
          onClick={() => setOpen(false)}
          className={`absolute inset-0 bg-[rgba(9,9,11,0.42)] transition-opacity duration-150 ${
            open ? "pointer-events-auto opacity-100" : "opacity-0"
          }`}
          aria-hidden="true"
        />
        <aside
          aria-label="Ask about the data"
          aria-hidden={!open}
          className={`absolute inset-y-0 right-0 flex w-[min(460px,100%)] flex-col border-l border-hairline bg-surface transition-transform duration-200 ${
            open ? "pointer-events-auto translate-x-0" : "translate-x-full"
          }`}
          style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
        >
          <header className="flex items-center gap-[10px] border-b border-hairline px-[18px] py-4">
            <h2 className="text-[14px] font-semibold">Ask about the book</h2>
            <span
              className="inline-flex h-[17px] items-center rounded-[4px] border border-hairline-strong px-[5px] text-[10px] text-ink-3"
              title="The interface is built; the assistant behind it is not connected yet."
            >
              UI preview
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close ask panel"
              className="grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-hairline-strong bg-surface text-ink-2 hover:text-ink"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path
                  d="M2.5 2.5l9 9m0-9l-9 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>

          <div ref={listRef} className="flex-1 overflow-y-auto px-[18px] py-4">
            {messages.length === 0 ? (
              <div className="flex flex-col gap-4">
                <p className="text-[12.5px] leading-[1.55] text-ink-2">
                  Ask a question about the accounts in this snapshot — scores,
                  why an account moved, what is held out and why.
                </p>

                <div>
                  <p className="eyebrow mb-2">Try</p>
                  <div className="flex flex-col gap-[6px]">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => sendStub(s)}
                        className="rounded-[8px] border border-hairline bg-inset px-[10px] py-[8px] text-left text-[12.5px] text-ink-2 hover:border-ink-3 hover:text-ink"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-[9px] border border-hairline px-[10px] py-[9px]">
                  <p className="eyebrow mb-[6px]">It would read</p>
                  <ul className="flex flex-col gap-[5px]">
                    {TOOL_SURFACE.map((t) => (
                      <li
                        key={t.endpoint}
                        className="flex items-baseline gap-2 text-[11.5px]"
                      >
                        <span className="text-ink-2">{t.label}</span>
                        <code className="ml-auto font-mono text-[10.5px] text-ink-3">
                          {t.endpoint}
                        </code>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-[8px] text-[11px] leading-[1.5] text-ink-3">
                    The same endpoints this dashboard uses, so an answer can
                    cite its sources and can never disagree with what is on
                    screen.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <p className="max-w-[84%] rounded-[10px] rounded-br-[3px] bg-accent-wash px-[11px] py-[8px] text-[12.5px] text-ink">
                        {m.text}
                      </p>
                    </div>
                  ) : (
                    <div key={m.id} className="flex flex-col gap-[6px]">
                      <p
                        className={`max-w-[92%] rounded-[10px] rounded-bl-[3px] border px-[11px] py-[8px] text-[12.5px] leading-[1.55] ${
                          m.status === "error" || m.status === "declined"
                            ? "border-crit-wash bg-crit-wash text-crit-ink"
                            : "border-hairline bg-inset text-ink-2"
                        }`}
                      >
                        {m.text}
                      </p>
                      {m.consulted && m.consulted.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-[5px]">
                          <span className="text-[10.5px] uppercase tracking-[0.04em] text-ink-3">
                            Would read
                          </span>
                          {m.consulted.map((c) => (
                            <code
                              key={c.endpoint}
                              className="rounded-[4px] border border-hairline px-[5px] py-[1px] font-mono text-[10px] text-ink-3"
                            >
                              {c.endpoint}
                            </code>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ),
                )}

                {pending ? (
                  <div className="flex items-center gap-2 text-[12px] text-ink-3">
                    <span className="flex gap-[3px]" aria-hidden="true">
                      <i className="h-[5px] w-[5px] animate-pulse rounded-full bg-ink-3" />
                      <i className="h-[5px] w-[5px] animate-pulse rounded-full bg-ink-3 [animation-delay:150ms]" />
                      <i className="h-[5px] w-[5px] animate-pulse rounded-full bg-ink-3 [animation-delay:300ms]" />
                    </span>
                    Working
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <form
            className="border-t border-hairline px-[14px] py-3"
            onSubmit={(e) => {
              e.preventDefault();
              sendStub(draft);
            }}
          >
            <div className="flex items-end gap-2">
              <label htmlFor="ask-input" className="sr-only">
                Ask a question about the accounts
              </label>
              <textarea
                id="ask-input"
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendStub(draft);
                  }
                }}
                placeholder="Ask about an account, a score, or the data…"
                className="max-h-[120px] min-h-[36px] flex-1 resize-none rounded-[8px] border border-hairline-strong bg-surface px-[10px] py-[8px] text-[12.5px] text-ink placeholder:text-ink-3"
              />
              <button
                type="submit"
                disabled={!draft.trim() || pending}
                aria-label="Send question"
                className="grid h-[36px] w-[36px] shrink-0 place-items-center rounded-[8px] bg-ink text-canvas disabled:cursor-not-allowed disabled:opacity-35"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M2.6 8h10.2M8.6 3.6 13.2 8l-4.6 4.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            <p className="mt-[7px] text-[10.5px] text-ink-3">
              Enter to send · Shift+Enter for a new line. Not connected to a
              model yet.
            </p>
          </form>
        </aside>
      </div>
    </>
  );
}
