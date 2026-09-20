"use client";

import { useRef, useState } from "react";
import type { HealthTier } from "@/lib/types";
import { TIER_STYLE } from "@/lib/ui";

const W = 560;
const H = 190;
const PAD = { l: 30, r: 14, t: 12, b: 24 };

/**
 * The 13-week activity series, with a crosshair + tooltip. An HTML/SVG chart
 * is interactive by nature, so a line chart ships the hover layer rather than
 * making the reader squint at the shape.
 *
 * Weekly, not daily: the median account in this dataset produces 19 events in
 * 90 days, so a daily series is mostly zeroes with the odd spike - a shape
 * that reads as noise rather than as a trend. Thirteen weekly totals is the
 * same choice this dashboard makes everywhere else events are charted.
 */
export function TrendChart({
  weekly,
  tier,
  recentWeeks,
}: {
  weekly: number[];
  tier: HealthTier;
  /** How many trailing weeks the score's Recency/Breadth/Depth pillars look at. */
  recentWeeks?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const n = weekly.length;
  if (n === 0) {
    return (
      <div className="flex h-[190px] items-center justify-center px-3 pb-3 pt-2 text-[12px] text-ink-3">
        No activity to chart
      </div>
    );
  }
  const max = Math.max(...weekly, 1);
  /* Divisible by 4 so the 0 / mid / max ticks are all whole numbers: with a
     max of 5 the midpoint gridline sat at 2.5 but was labelled "3". */
  const niceMax = Math.max(4, Math.ceil(max / 4) * 4);
  const x = (i: number) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / niceMax) * (H - PAD.t - PAD.b);
  const colour = TIER_STYLE[tier].mark;

  let d = "";
  for (let i = 0; i < n; i += 1) d += `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(weekly[i]).toFixed(1)} `;
  const area = `${d}L${x(n - 1).toFixed(1)} ${y(0)} L${PAD.l} ${y(0)} Z`;

  const cutAtWeek = recentWeeks ? n - recentWeeks : null;

  const onMove = (clientX: number) => {
    const svg = ref.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const cx = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((cx - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="relative px-3 pb-3 pt-2">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full max-w-full"
        role="img"
        aria-label={`Weekly event volume over the last ${n} weeks`}
        onMouseMove={(e) => onMove(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => e.touches[0] && onMove(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        {[0, niceMax / 2, niceMax].map((v) => (
          <g key={v}>
            <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="var(--grid)" strokeWidth="1" />
            <text
              x={PAD.l - 7}
              y={y(v) + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--ink-3)"
              fontFamily="var(--font-mono)"
            >
              {Math.round(v)}
            </text>
          </g>
        ))}

        {cutAtWeek !== null && cutAtWeek > 0 ? (
          <g>
            <line
              x1={x(cutAtWeek)}
              y1={PAD.t}
              x2={x(cutAtWeek)}
              y2={y(0)}
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
            <text x={x(cutAtWeek) + 5} y={PAD.t + 11} fontSize="10" fill="var(--accent-ink)">
              scored window →
            </text>
          </g>
        ) : null}

        <path d={area} fill={colour} fillOpacity="0.1" />
        <path d={d} fill="none" stroke={colour} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(n - 1)} cy={y(weekly[n - 1])} r="4" fill={colour} stroke="var(--surface)" strokeWidth="2" />

        {hover !== null ? (
          <g>
            <line
              x1={x(hover)}
              y1={PAD.t}
              x2={x(hover)}
              y2={y(0)}
              stroke="var(--ink-3)"
              strokeWidth="1"
              opacity="0.45"
            />
            <circle cx={x(hover)} cy={y(weekly[hover])} r="4" fill={colour} stroke="var(--surface)" strokeWidth="2" />
          </g>
        ) : null}

        {[0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].map((i, idx) => (
          <text
            key={i}
            x={x(i)}
            y={H - 7}
            textAnchor={idx === 0 ? "start" : idx === 3 ? "end" : "middle"}
            fontSize="10"
            fill="var(--ink-3)"
          >
            {idx === 3 ? "latest" : `week ${i + 1}`}
          </text>
        ))}
      </svg>

      {hover !== null ? (
        <div
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-[7px] px-[9px] py-[7px] text-[11.5px] shadow-lg"
          style={{
            background: "var(--ink)",
            color: "var(--canvas)",
            left: `calc(${(x(hover) / W) * 100}% - 48px)`,
            top: `calc(${(y(weekly[hover]) / H) * 100}% - 8px)`,
          }}
        >
          <div className="font-semibold">Week {hover + 1}</div>
          <div className="num">{weekly[hover]} events</div>
        </div>
      ) : null}
    </div>
  );
}
