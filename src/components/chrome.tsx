"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
      placeholder="Search account or domain"
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
