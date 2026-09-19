/**
 * Prints the observed distribution of every raw health input across the book,
 * so TARGETS in src/lib/health.ts can be set from data instead of guessed.
 *
 * Run after dropping in a new export:  npm run calibrate
 *
 * Read the p80 column: that is "what good looks like" for this book. Targets
 * far below p80 make the score saturate and stop discriminating at the top;
 * targets far above it flatten everyone into the danger bands.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "ahc-calib-"));

try {
  execFileSync(
    "npx",
    ["tsc", "src/lib/types.ts", "src/lib/health.ts", "src/lib/pipeline.ts", "src/lib/service.ts",
     "--outDir", out, "--module", "commonjs", "--target", "es2022",
     "--moduleResolution", "node", "--skipLibCheck"],
    { cwd: ROOT, stdio: "inherit" },
  );
  cpSync(join(ROOT, "data"), join(out, "data"), { recursive: true });

  const { getBook } = await import(join(out, "service.js"));
  const scored = getBook().accounts.filter((a) => a.health.scored);
  if (!scored.length) {
    console.log("No scored accounts - nothing to calibrate.");
    process.exit(0);
  }

  const inputs = {
    "createsPerKnownSeat": (a) => a.metrics.createsPerKnownSeat,
    "activeShare": (a) => a.metrics.activeUsers30 / Math.max(1, a.metrics.knownUsers),
    "viewsPerLibraryGuide": (a) => a.metrics.libraryViewRate,
    "collabPer10Users": (a) => (a.metrics.shared30 + a.metrics.invited30) * 10 / Math.max(1, a.metrics.activeUsers30),
    "momentumRatio": (a) => a.metrics.events30 / Math.max(1, a.metrics.eventsPrior30),
    "daysSinceLastCreate": (a) => a.metrics.daysSinceLastCreate ?? 90,
  };
  const pct = (arr, p) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };

  console.log(`\n${scored.length} scored accounts\n`);
  console.log("TARGETS input".padEnd(24) + ["p10", "p50", "p80", "p90", "max"].map((h) => h.padStart(9)).join(""));
  console.log("-".repeat(69));
  for (const [name, f] of Object.entries(inputs)) {
    const v = scored.map(f);
    console.log(
      name.padEnd(24) +
        [pct(v, 10), pct(v, 50), pct(v, 80), pct(v, 90), Math.max(...v)]
          .map((n) => n.toFixed(2).padStart(9))
          .join(""),
    );
  }
  console.log("\nSet each TARGET to its p80 unless you have a product reason not to.");
  console.log("momentumRatio stays at 2.0 on purpose: flat should score 50, and");
  console.log("doubling - not the book's best - is what 'excellent' means there.\n");
} finally {
  rmSync(out, { recursive: true, force: true });
}
