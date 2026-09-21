"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { QualityIssue } from "@/lib/types";
import { QUALITY_STYLE } from "@/lib/ui";

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
      (stamped === null && window.matchMedia("(prefers-color-scheme: dark)").matches);
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
        <path d="M8 1.6a6.4 6.4 0 1 0 6.4 6.4A4.8 4.8 0 0 1 8 1.6Z" fill="currentColor" />
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

/** Like SelectFilter, but several values can be active at once (OR'd together). */
export function MultiSelectFilter({
  name,
  values,
  options,
  label,
  allLabel,
}: {
  name: string;
  values: string[];
  options: { value: string; label: string }[];
  label: string;
  allLabel: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    const active = new Set(values);
    if (active.has(value)) active.delete(value);
    else active.add(value);

    const next = new URLSearchParams(params.toString());
    next.delete(name);
    for (const v of active) next.append(name, v);
    router.replace(`/?${next.toString()}`, { scroll: false });
  };

  const summary =
    values.length === 0 || values.length === options.length
      ? allLabel
      : values.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className="flex h-[30px] items-center gap-[6px] whitespace-nowrap rounded-[7px] border border-hairline-strong bg-surface px-[9px] text-[12.5px] text-ink hover:border-ink-3"
      >
        {summary}
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0 text-ink-3">
          <path
            d="M1.5 3.5l3.5 3 3.5-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="absolute right-0 z-30 mt-[6px] min-w-[168px] rounded-[8px] border border-hairline-strong bg-surface p-[5px] shadow-[var(--card-shadow)]"
        >
          {options.map((o) => {
            const checked = values.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(o.value)}
                className={`flex w-full items-center gap-[8px] rounded-[6px] px-[8px] py-[6px] text-left text-[12.5px] ${
                  checked ? "bg-accent-wash font-medium text-accent-ink" : "text-ink hover:bg-inset"
                }`}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className={`shrink-0 ${checked ? "" : "opacity-0"}`}
                >
                  <path
                    d="M2.4 6.3l2.2 2.2 5-5.3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DataNotesDrawer({ notes }: { notes: QualityIssue[] }) {
  const [open, setOpen] = useState(false);
  const findings = notes.filter((n) => n.severity !== "info");

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
        <path d="M8 6.2v3.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
      </svg>
      {findings.length > 0 && (
        <span
          className="num absolute -right-1 -top-1 grid h-[15px] min-w-[15px] place-items-center rounded-[8px] border-[1.5px] border-surface px-[3px] text-[9.5px] font-bold"
          style={{ background: "var(--warn)", color: "#3a2a04" }}
        >
          {findings.length}
        </span>
      )}
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
            <article key={n.code} className="border-b border-hairline px-[18px] py-[13px]">
              <div className="mb-[5px] flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ background: QUALITY_STYLE[n.severity].mark }}
                />
                <span className="text-[12.5px] font-medium">{n.title}</span>
                {n.count > 0 && (
                  <span className="num inline-flex h-[17px] items-center rounded-[4px] border border-hairline-strong px-[5px] text-[10.5px] text-ink-3">
                    {n.count}
                  </span>
                )}
              </div>
              <p className="text-[12px] text-ink-2">{n.detail}</p>
              <p className="mt-[6px] text-[12px] font-medium text-accent-ink">{n.resolution}</p>
            </article>
          ))}
          <article className="px-[18px] py-[13px]">
            <div className="mb-[5px] text-[12.5px] font-medium">Why this panel exists</div>
            <p className="text-[12px] text-ink-2">
              Every number here is one join away from a judgement call. Putting those calls on
              screen lets a CSM tell the difference between{" "}
              <b className="font-medium text-ink">an account in trouble</b> and{" "}
              <b className="font-medium text-ink">an account we cannot see</b> - and lets a
              reviewer argue with the reasoning instead of guessing at it.
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
