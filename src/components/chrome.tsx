"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DataQualityNote } from "@/lib/types";

export function ThemeToggle() {
  /**
   * Deliberately stateless. The saved theme is applied before first paint by
   * the inline script in the root layout, so this only has to flip the
   * attribute - and reading the live value at click time avoids mirroring DOM
   * state into React just to toggle it.
   */
  const toggle = () => {
    const root = document.documentElement;
    const stamped = root.getAttribute("data-theme");
    const isDark =
      stamped === "dark" ||
      (stamped === null &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = isDark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ahc-theme", next);
    } catch {
      /* private window - the attribute still applies for this session */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle colour theme"
      title="Toggle colour theme"
      className="grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-hairline-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.6a6.4 6.4 0 1 0 6.4 6.4A4.8 4.8 0 0 1 8 1.6Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}

/** Debounced search that writes to the URL, so a filtered view is shareable. */
export function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(initial);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set("q", value);
      else next.delete("q");
      if (next.toString() !== params.toString()) {
        router.replace(`/?${next.toString()}`, { scroll: false });
      }
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id="account-search"
      type="search"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search account, domain or CSM"
      aria-label="Search accounts"
      className="h-[30px] min-w-0 rounded-[7px] border border-hairline-strong bg-surface px-[9px] text-[12.5px] text-ink placeholder:text-ink-3 sm:min-w-[210px]"
    />
  );
}

export function SelectFilter({
  name,
  value,
  options,
  label,
}: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  label: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <select
      id={`filter-${name}`}
      aria-label={label}
      value={value}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        if (e.target.value === "all") next.delete(name);
        else next.set(name, e.target.value);
        router.replace(`/?${next.toString()}`, { scroll: false });
      }}
      className="h-[30px] rounded-[7px] border border-hairline-strong bg-surface px-[9px] text-[12.5px] text-ink hover:border-ink-3"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function DataNotesDrawer({ notes }: { notes: DataQualityNote[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open data notes"
      title="Data notes"
      className="relative grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-hairline-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink"
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 1.8 L14.4 13.2 H1.6 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M8 6.2v3.1"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
      </svg>
      <span
        className="num absolute -right-1 -top-1 grid h-[15px] min-w-[15px] place-items-center rounded-[8px] border-[1.5px] border-surface px-[3px] text-[9.5px] font-bold"
        style={{ background: "var(--warn)", color: "#3a2a04" }}
      >
        {notes.length}
      </span>
    </button>
  );

  /* Two things this container is load-bearing for: it clips the panel while
     closed (parking a fixed element at translate-x-full would otherwise extend
     the document's scroll width and add a horizontal scrollbar on a phone),
     and it must not sit inside any ancestor with backdrop-filter, transform or
     filter - each of those makes a containing block for fixed descendants and
     would size `inset-0` to that ancestor instead of the viewport. */
  const panel = (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
      <div
        onClick={() => setOpen(false)}
        className={`absolute inset-0 bg-[rgba(9,9,11,0.42)] transition-opacity duration-150 ${
          open ? "pointer-events-auto opacity-100" : "opacity-0"
        }`}
        aria-hidden="true"
      />
      <aside
        aria-label="Data notes"
        aria-hidden={!open}
        className={`absolute inset-y-0 right-0 flex w-[min(452px,100%)] flex-col border-l border-hairline bg-surface transition-transform duration-200 ${
          open ? "pointer-events-auto translate-x-0" : "translate-x-full"
        }`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <header className="flex items-center gap-[10px] border-b border-hairline px-[18px] py-4">
          <h2 className="text-[14px] font-semibold">Data notes</h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close data notes"
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

        <div className="overflow-y-auto pb-6 pt-[6px]">
          {notes.map((n) => (
            <article
              key={n.id}
              className="border-b border-hairline px-[18px] py-[13px]"
            >
              <div className="mb-[5px] flex items-center gap-2">
                <span className="text-[12.5px] font-medium">{n.title}</span>
                {n.count > 0 ? (
                  <span className="num inline-flex h-[17px] items-center rounded-[4px] border border-hairline-strong px-[5px] text-[10.5px] text-ink-3">
                    {n.count}
                  </span>
                ) : null}
              </div>
              <p className="text-[12px] text-ink-2">{n.detail}</p>
              <p className="mt-[6px] text-[12px] font-medium text-accent-ink">
                {n.rule}
              </p>
            </article>
          ))}
          <article className="px-[18px] py-[13px]">
            <div className="mb-[5px] text-[12.5px] font-medium">
              Why this panel exists
            </div>
            <p className="text-[12px] text-ink-2">
              Every number here is one join away from a judgement call. Putting
              those calls on screen lets a CSM tell the difference between{" "}
              <b className="font-medium text-ink">an account in trouble</b> and{" "}
              <b className="font-medium text-ink">an account we cannot see</b> —
              and lets a reviewer argue with the reasoning instead of guessing
              at it.
            </p>
          </article>
        </div>
      </aside>
    </div>
  );

  return (
    <>
      {trigger}
      {panel}
    </>
  );
}
