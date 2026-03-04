#!/usr/bin/env npx tsx
/**
 * dot.li — Performance Comparison Tool
 *
 * Compares base.json vs last.json using:
 *   - p50 (primary), p95 (tail), p99 (worst case)
 *   - stddev, cv (stability)
 *   - Mann-Whitney U test (statistical significance)
 *
 * Rules:
 *   1. Compare p50 first — did the typical experience improve?
 *   2. Compare p95 — did tail latency improve?
 *   3. Check cv — did stability change?
 *   4. Only trust mean if cv is low on BOTH runs
 *   5. Delta < 5% with < 30 samples? Likely noise unless Mann-Whitney confirms
 *
 * Run: npm run test:perf:compare
 */

import * as fs from "node:fs";
import * as path from "node:path";
// ── Types ──────────────────────────────────────────────────

interface PhaseStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  cv: number;
  min: number;
  max: number;
  values: number[];
  discarded?: number;
}

interface RunStats {
  timestamp: string;
  type: "cold" | "warm";
  iterations: number;
  phases: Record<string, PhaseStats>;
  browserMetrics: {
    domContentLoaded: PhaseStats;
    jsHeapUsed: PhaseStats;
  };
  networkStats: {
    requestCount: PhaseStats;
    totalBytes: PhaseStats;
  };
}

interface SavedResults {
  cold: RunStats;
  warm: RunStats | null;
}

// ── Paths ──────────────────────────────────────────────────

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const BASE_FILE = path.join(RESULTS_DIR, "base.json");
const LAST_FILE = path.join(RESULTS_DIR, "last.json");

// ── Colors ─────────────────────────────────────────────────

const R = "\x1b[0m";
const G = "\x1b[32m";
const RD = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const B = "\x1b[1m";

// ── Mann-Whitney U Test ────────────────────────────────────
// Non-parametric test for comparing two independent samples.
// Returns z-score and whether the difference is significant
// at the 0.05 level (|z| > 1.96).

function mannWhitneyU(
  a: number[],
  b: number[],
): { u: number; z: number; significant: boolean } {
  // Need at least 2 values per sample for any meaningful test
  if (a.length < 2 || b.length < 2) {
    return { u: 0, z: 0, significant: false };
  }

  // Combine and rank
  const combined = [
    ...a.map((v) => ({ v, group: 0 })),
    ...b.map((v) => ({ v, group: 1 })),
  ].sort((x, y) => x.v - y.v);

  // Assign ranks with tie correction
  const ranks = new Array<number>(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j < combined.length && combined[j].v === combined[i].v) {
      j++;
    }
    const avgRank = (i + 1 + j) / 2; // average rank for ties
    for (let k = i; k < j; k++) {
      ranks[k] = avgRank;
    }
    i = j;
  }

  // Sum ranks for group a
  let rankSumA = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 0) {
      rankSumA += ranks[k] ?? 0;
    }
  }

  const n1 = a.length;
  const n2 = b.length;
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  // Normal approximation (valid for n >= 3)
  const mu = (n1 * n2) / 2;
  const n = n1 + n2;

  // Tie correction
  const tieGroups: number[] = [];
  let ti = 0;
  while (ti < combined.length) {
    let tj = ti;
    while (tj < combined.length && combined[tj].v === combined[ti].v) {
      tj++;
    }
    if (tj - ti > 1) {
      tieGroups.push(tj - ti);
    }
    ti = tj;
  }
  const tieCorrection = tieGroups.reduce(
    (s, t) => s + (t * t * t - t) / (n * (n - 1)),
    0,
  );

  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieCorrection));
  const z = sigma > 0 ? (u - mu) / sigma : 0;

  return {
    u,
    z: Math.abs(z),
    significant: Math.abs(z) > 1.96, // p < 0.05
  };
}

// ── Formatting ─────────────────────────────────────────────

function fmt(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtPct(current: number, reference: number): string {
  if (reference === 0) {
    return "N/A";
  }
  const pct = ((current - reference) / reference) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtDelta(current: number, reference: number): string {
  const diff = current - reference;
  const sign = diff > 0 ? "+" : "";
  const color = diff < 0 ? G : diff > 0 ? RD : "";
  return `${color}${sign}${fmt(diff)} (${fmtPct(current, reference)})${R}`;
}

function cvColor(cv: number): string {
  if (cv > 0.5) {
    return RD;
  }
  if (cv > 0.3) {
    return Y;
  }
  return "";
}

function loadJson(filepath: string): SavedResults | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as SavedResults;
  } catch {
    return null;
  }
}

// ── Phase order ────────────────────────────────────────────

const ORDERED_PHASES = [
  "Total (main)",
  "Auth init",
  "SW registration",
  "Name resolution",
  "  Smoldot init",
  "    Relay chain",
  "    Parachain",
  "    Chain sync",
  "Cache check",
  "Content fetch",
  "  P2P attempt",
  "  Gateway fetch",
  "  Archive parse",
  "Render",
];

// ── Verdict logic ──────────────────────────────────────────

interface Verdict {
  label: string;
  color: string;
  icon: string;
}

function getVerdict(bStat: PhaseStats, lStat: PhaseStats): Verdict {
  const mw = mannWhitneyU(bStat.values, lStat.values);
  const p50Diff = lStat.p50 - bStat.p50;
  const p95Diff = lStat.p95 - bStat.p95;
  const p50Pct = bStat.p50 > 0 ? Math.abs(p50Diff / bStat.p50) : 0;

  // If Mann-Whitney says significant
  if (mw.significant) {
    if (p50Diff < 0 && p95Diff <= 0) {
      return { label: "improved", color: G, icon: "+" };
    }
    if (p50Diff < 0 && p95Diff > 0) {
      return { label: "mixed", color: Y, icon: "~" };
    } // p50 better but p95 worse
    if (p50Diff > 0) {
      return { label: "regressed", color: RD, icon: "-" };
    }
  }

  // Not significant
  if (p50Pct < 0.05) {
    return { label: "unchanged", color: D, icon: "=" };
  }

  // Big delta but not enough samples for significance
  return { label: "uncertain", color: Y, icon: "?" };
}

// ── Comparison ─────────────────────────────────────────────

function compareRuns(label: string, base: RunStats, last: RunStats): void {
  const div = "═".repeat(140);
  const thin = "─".repeat(140);

  console.log(`\n${div}`);
  console.log(`  ${B}${label}${R}`);
  console.log(
    `  Base: ${base.timestamp} (${String(base.iterations)} runs)    Last: ${last.timestamp} (${String(last.iterations)} runs)`,
  );
  console.log(div);

  // Phase comparison table
  const allPhases = ORDERED_PHASES.filter(
    (p) => p in base.phases || p in last.phases,
  );

  console.log(
    `\n  ${"Phase".padEnd(22)} ${"Base p50".padStart(9)} ${"Last p50".padStart(9)} ${"p50 Δ".padStart(24)}  ${"Base p95".padStart(9)} ${"Last p95".padStart(9)} ${"p95 Δ".padStart(24)}  ${"B cv".padStart(5)} ${"L cv".padStart(5)}  ${"Verdict".padStart(12)}`,
  );
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(24)}  ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(24)}  ${"─".repeat(5)} ${"─".repeat(5)}  ${"─".repeat(12)}`,
  );

  for (const phase of allPhases) {
    const hasB = phase in base.phases;
    const hasL = phase in last.phases;

    if (!hasB || !hasL) {
      const side = hasB ? "removed" : "new";
      console.log(
        `  ${phase.padEnd(22)} ${hasB ? fmt(base.phases[phase].p50).padStart(9) : "—".padStart(9)} ${hasL ? fmt(last.phases[phase].p50).padStart(9) : "—".padStart(9)} ${D}${side.padStart(24)}${R}`,
      );
      continue;
    }

    const bStat = base.phases[phase];
    const lStat = last.phases[phase];

    const p50Delta = fmtDelta(lStat.p50, bStat.p50);
    const p95Delta = fmtDelta(lStat.p95, bStat.p95);
    const verdict = getVerdict(bStat, lStat);

    const bCv = `${cvColor(bStat.cv)}${bStat.cv.toFixed(2)}${R}`;
    const lCv = `${cvColor(lStat.cv)}${lStat.cv.toFixed(2)}${R}`;

    // Raw (no ANSI) widths for padding calculation
    const p50DeltaRaw = `${lStat.p50 - bStat.p50 > 0 ? "+" : ""}${fmt(lStat.p50 - bStat.p50)} (${fmtPct(lStat.p50, bStat.p50)})`;
    const p95DeltaRaw = `${lStat.p95 - bStat.p95 > 0 ? "+" : ""}${fmt(lStat.p95 - bStat.p95)} (${fmtPct(lStat.p95, bStat.p95)})`;
    const p50Pad = 24 - p50DeltaRaw.length;
    const p95Pad = 24 - p95DeltaRaw.length;

    console.log(
      `  ${phase.padEnd(22)} ${fmt(bStat.p50).padStart(9)} ${fmt(lStat.p50).padStart(9)} ${" ".repeat(Math.max(0, p50Pad))}${p50Delta}  ${fmt(bStat.p95).padStart(9)} ${fmt(lStat.p95).padStart(9)} ${" ".repeat(Math.max(0, p95Pad))}${p95Delta}  ${bCv} ${lCv}  ${verdict.color}${(verdict.icon + " " + verdict.label).padStart(12)}${R}`,
    );
  }

  // Overall summary
  if ("Total (main)" in base.phases && "Total (main)" in last.phases) {
    const bTotal = base.phases["Total (main)"];
    const lTotal = last.phases["Total (main)"];
    const p50Diff = lTotal.p50 - bTotal.p50;
    const p95Diff = lTotal.p95 - bTotal.p95;
    const verdict = getVerdict(bTotal, lTotal);
    const mw = mannWhitneyU(bTotal.values, lTotal.values);

    console.log(`\n  ${B}Summary${R}`);
    console.log(thin);

    const p50Color = p50Diff < 0 ? G : p50Diff > 0 ? RD : "";
    const p95Color = p95Diff < 0 ? G : p95Diff > 0 ? RD : "";

    console.log(
      `  p50:  ${fmt(bTotal.p50)} → ${p50Color}${fmt(lTotal.p50)}${R}  (${p50Color}${fmtPct(lTotal.p50, bTotal.p50)}${R})`,
    );
    console.log(
      `  p95:  ${fmt(bTotal.p95)} → ${p95Color}${fmt(lTotal.p95)}${R}  (${p95Color}${fmtPct(lTotal.p95, bTotal.p95)}${R})`,
    );
    console.log(
      `  cv:   ${bTotal.cv.toFixed(2)} → ${lTotal.cv.toFixed(2)}  ${lTotal.cv > bTotal.cv + 0.1 ? `${Y}(less stable)${R}` : lTotal.cv < bTotal.cv - 0.1 ? `${G}(more stable)${R}` : "(stable)"}`,
    );
    console.log(
      `  Mann-Whitney: z=${mw.z.toFixed(2)}  ${mw.significant ? `${G}significant (p<0.05)${R}` : `${D}not significant${R}`}`,
    );
    console.log(
      `  Verdict: ${verdict.color}${B}${verdict.icon} ${verdict.label}${R}`,
    );

    // Warn about mean comparison
    if (bTotal.cv > 0.3 || lTotal.cv > 0.3) {
      console.log(
        `\n  ${Y}Note: CV > 0.3 on one or both runs — mean comparison unreliable. Use p50.${R}`,
      );
    }

    console.log(
      `\n  ${D}Base runs:  [${bTotal.values.map((v) => fmt(v)).join(", ")}]${R}`,
    );
    console.log(
      `  ${D}Last runs:  [${lTotal.values.map((v) => fmt(v)).join(", ")}]${R}`,
    );
  }

  console.log(`\n${thin}\n`);
}

// ── Main ──────────────────────────────────────────────────

const base = loadJson(BASE_FILE);
const last = loadJson(LAST_FILE);

if (!base) {
  console.error("No base results found. Run: npm run test:perf:base");
  process.exit(1);
}

if (!last) {
  console.error("No last results found. Run: npm run test:perf");
  process.exit(1);
}

console.log(`\n  ${B}dot.li Performance Comparison: Base vs Last${R}\n`);

compareRuns("COLD START", base.cold, last.cold);

if (base.warm !== null && last.warm !== null) {
  compareRuns("WARM START", base.warm, last.warm);
}
