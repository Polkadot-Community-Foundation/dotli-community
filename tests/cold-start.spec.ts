/**
 * dot.li — Cold Start Performance Test (multi-run with statistics)
 *
 * Runs the loading pipeline multiple times and computes p50, p95, p99,
 * mean, stddev, and coefficient of variation using simple-statistics.
 *
 * Usage:
 *   npm run test:perf               — run N iterations, save to last.json
 *   npm run test:perf:base          — save as base.json (immutable)
 *   npm run test:perf:compare       — compare base vs last
 *   PERF_RUNS=5 npm run test:perf   — override iteration count
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import * as ss from "simple-statistics";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────

interface PerfMark {
  name: string;
  startTime: number;
}

interface PhaseResult {
  phase: string;
  start: number;
  end: number;
  duration: number;
}

export interface PhaseStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  stddev: number;
  cv: number; // coefficient of variation (stddev/mean) — >0.3 = noisy
  min: number;
  max: number;
  values: number[];
}

export interface RunStats {
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

export interface SavedResults {
  cold: RunStats;
  warm: RunStats | null;
}

// ── Constants ──────────────────────────────────────────────

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const BASE_FILE = path.join(RESULTS_DIR, "base.json");
const LAST_FILE = path.join(RESULTS_DIR, "last.json");
const SAVE_AS_BASE = process.env.PERF_SAVE_BASE === "1";
const NUM_RUNS = parseInt(process.env.PERF_RUNS ?? "3", 10);

const PHASE_PAIRS: [string, string, string][] = [
  ["Total (main)", "dotli:main:start", "dotli:main:end"],
  ["Auth init", "dotli:auth:start", "dotli:auth:end"],
  ["SW registration", "dotli:sw:start", "dotli:sw:end"],
  ["Name resolution", "dotli:resolve:start", "dotli:resolve:end"],
  ["  Smoldot init", "dotli:smoldot:init:start", "dotli:smoldot:init:end"],
  ["    Relay chain", "dotli:smoldot:relay:start", "dotli:smoldot:relay:end"],
  [
    "    Parachain",
    "dotli:smoldot:parachain:start",
    "dotli:smoldot:parachain:end",
  ],
  ["    Chain sync", "dotli:smoldot:sync:start", "dotli:smoldot:sync:end"],
  ["Cache check", "dotli:cache-check:start", "dotli:cache-check:end"],
  ["Content fetch", "dotli:fetch:start", "dotli:fetch:end"],
  ["  P2P attempt", "dotli:fetch:p2p:start", "dotli:fetch:p2p:end"],
  ["  Gateway fetch", "dotli:fetch:gateway:start", "dotli:fetch:gateway:end"],
  ["  Archive parse", "dotli:fetch:parse:start", "dotli:fetch:parse:end"],
  ["Render", "dotli:render:start", "dotli:render:end"],
];

// ── Statistics (simple-statistics) ─────────────────────────

function computeStats(values: number[]): PhaseStats {
  const sorted = [...values].sort((a, b) => a - b);
  const m = ss.mean(values);
  const sd = ss.standardDeviation(values);
  return {
    p50: Math.round(ss.quantileSorted(sorted, 0.5)),
    p95: Math.round(ss.quantileSorted(sorted, 0.95)),
    p99: Math.round(ss.quantileSorted(sorted, 0.99)),
    mean: Math.round(m),
    stddev: Math.round(sd),
    cv: m > 0 ? Math.round((sd / m) * 100) / 100 : 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    values,
  };
}

// ── Helpers ────────────────────────────────────────────────

async function collectMarks(page: Page): Promise<PerfMark[]> {
  return page.evaluate(() => {
    return performance
      .getEntriesByType("mark")
      .filter((m) => m.name.startsWith("dotli:"))
      .map((m) => ({ name: m.name, startTime: m.startTime }));
  });
}

function computePhases(marks: PerfMark[]): PhaseResult[] {
  const byName = new Map<string, number>();
  for (const m of marks) {
    byName.set(m.name, m.startTime);
  }
  const phases: PhaseResult[] = [];
  for (const [label, startMark, endMark] of PHASE_PAIRS) {
    const start = byName.get(startMark);
    const end = byName.get(endMark);
    if (start !== undefined && end !== undefined) {
      phases.push({
        phase: label,
        start: Math.round(start),
        end: Math.round(end),
        duration: Math.round(end - start),
      });
    }
  }
  return phases;
}

async function waitForPipeline(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const marks = performance.getEntriesByType("mark").map((m) => m.name);
      return (
        marks.includes("dotli:main:end") ||
        marks.includes("dotli:render:end") ||
        document.querySelector("iframe") !== null
      );
    },
    { timeout: 90_000, polling: 500 },
  );
  await page.waitForTimeout(500);
}

async function getBrowserMetrics(
  page: Page,
): Promise<{ domContentLoaded: number; jsHeapUsed: number }> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    const memory = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number };
      }
    ).memory;
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      jsHeapUsed: memory?.usedJSHeapSize ?? 0,
    };
  });
}

function fmt(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDelta(current: number, reference: number): string {
  const diff = current - reference;
  const pct = reference > 0 ? ((diff / reference) * 100).toFixed(1) : "N/A";
  const sign = diff > 0 ? "+" : "";
  const arrow = diff < 0 ? "faster" : diff > 0 ? "slower" : "same";
  return `${sign}${fmt(diff)} (${sign}${pct}%) ${arrow}`;
}

function loadJson(filepath: string): SavedResults | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8")) as SavedResults;
  } catch {
    return null;
  }
}

function saveJson(filepath: string, data: SavedResults): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// ── Aggregate per-run data into stats ──────────────────────

interface SingleRun {
  phases: PhaseResult[];
  domContentLoaded: number;
  jsHeapUsed: number;
  requestCount: number;
  totalBytes: number;
}

function aggregateRuns(type: "cold" | "warm", runs: SingleRun[]): RunStats {
  const phaseNames = new Set<string>();
  for (const run of runs) {
    for (const p of run.phases) {
      phaseNames.add(p.phase);
    }
  }

  const phaseStats: Record<string, PhaseStats> = {};
  for (const name of phaseNames) {
    const values = runs
      .map((r) => r.phases.find((p) => p.phase === name)?.duration)
      .filter((v): v is number => v !== undefined);
    if (values.length > 0) {
      phaseStats[name] = computeStats(values);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    type,
    iterations: runs.length,
    phases: phaseStats,
    browserMetrics: {
      domContentLoaded: computeStats(runs.map((r) => r.domContentLoaded)),
      jsHeapUsed: computeStats(runs.map((r) => r.jsHeapUsed)),
    },
    networkStats: {
      requestCount: computeStats(runs.map((r) => r.requestCount)),
      totalBytes: computeStats(runs.map((r) => r.totalBytes)),
    },
  };
}

// ── Report printing ────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function cvFlag(cv: number): string {
  if (cv > 0.5) {
    return `${RED}!!${RESET}`;
  }
  if (cv > 0.3) {
    return `${YELLOW}!${RESET}`;
  }
  return "";
}

function printStatsTable(
  title: string,
  stats: RunStats,
  baseStats?: RunStats | null,
  lastStats?: RunStats | null,
): void {
  const div = "─".repeat(120);
  const hasBase =
    baseStats !== undefined &&
    baseStats !== null &&
    Object.keys(baseStats.phases).length > 0;
  const hasLast =
    lastStats !== undefined &&
    lastStats !== null &&
    Object.keys(lastStats.phases).length > 0;

  console.log(`\n${div}`);
  console.log(`  ${title}  (${String(stats.iterations)} iterations)`);
  console.log(div);

  // Browser metrics summary
  const dcl = stats.browserMetrics.domContentLoaded;
  const heap = stats.browserMetrics.jsHeapUsed;
  const reqs = stats.networkStats.requestCount;
  const bytes = stats.networkStats.totalBytes;
  console.log(
    `\n  DOMContentLoaded:  p50=${fmt(dcl.p50)}  p95=${fmt(dcl.p95)}  p99=${fmt(dcl.p99)}  cv=${dcl.cv.toFixed(2)}`,
  );
  console.log(
    `  JS Heap Used:      p50=${(heap.p50 / 1024 / 1024).toFixed(1)}MB  p95=${(heap.p95 / 1024 / 1024).toFixed(1)}MB`,
  );
  console.log(
    `  Network Requests:  p50=${String(reqs.p50)}  range=${String(reqs.min)}-${String(reqs.max)}`,
  );
  console.log(
    `  Bytes Transferred: p50=${(bytes.p50 / 1024 / 1024).toFixed(2)}MB`,
  );

  // Main stats table header
  let header = `\n  ${"Phase".padEnd(22)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"p99".padStart(9)} ${"Mean".padStart(9)} ${"StdDev".padStart(9)} ${"CV".padStart(6)}`;
  if (hasBase) {
    header += `  ${"vs Base (p50)".padStart(26)}`;
  }
  if (hasLast) {
    header += `  ${"vs Last (p50)".padStart(26)}`;
  }
  console.log(header);

  let line = `  ${"─".repeat(22)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(6)}`;
  if (hasBase) {
    line += `  ${"─".repeat(26)}`;
  }
  if (hasLast) {
    line += `  ${"─".repeat(26)}`;
  }
  console.log(line);

  const orderedPhases = PHASE_PAIRS.map(([name]) => name).filter(
    (name) => name in stats.phases,
  );

  for (const name of orderedPhases) {
    const s = stats.phases[name];
    const flag = cvFlag(s.cv);
    let row = `  ${name.padEnd(22)} ${fmt(s.p50).padStart(9)} ${fmt(s.p95).padStart(9)} ${fmt(s.p99).padStart(9)} ${fmt(s.mean).padStart(9)} ${("±" + fmt(s.stddev)).padStart(9)} ${s.cv.toFixed(2).padStart(5)}${flag}`;

    if (hasBase) {
      if (name in baseStats.phases) {
        row += `  ${fmtDelta(s.p50, baseStats.phases[name].p50).padStart(26)}`;
      } else {
        row += `  ${"—".padStart(26)}`;
      }
    }

    if (hasLast) {
      if (name in lastStats.phases) {
        row += `  ${fmtDelta(s.p50, lastStats.phases[name].p50).padStart(26)}`;
      } else {
        row += `  ${"—".padStart(26)}`;
      }
    }

    console.log(row);
  }

  // Per-iteration breakdown
  const totalPhase =
    "Total (main)" in stats.phases ? stats.phases["Total (main)"] : null;
  if (totalPhase !== null) {
    console.log(
      `\n  ${DIM}Iterations: [${totalPhase.values.map((v) => fmt(v)).join(", ")}]${RESET}`,
    );
    if (totalPhase.cv > 0.3) {
      console.log(
        `  ${YELLOW}Warning: CV=${totalPhase.cv.toFixed(2)} — high variance, results may not be reliable. Consider more iterations.${RESET}`,
      );
    }
  }

  console.log(`\n${div}\n`);
}

// ── Run iterations ─────────────────────────────────────────

async function runColdIteration(
  browser: Browser,
  index: number,
  total: number,
): Promise<SingleRun> {
  console.log(`  Cold iteration ${String(index + 1)}/${String(total)}...`);

  const context = await browser.newContext({
    storageState: undefined,
    serviceWorkers: "allow",
  });
  const page = await context.newPage();

  const requests: { size: number }[] = [];
  page.on("response", async (response) => {
    try {
      const body = await response.body().catch(() => null);
      requests.push({ size: body?.length ?? 0 });
    } catch {
      requests.push({ size: 0 });
    }
  });

  await page.goto("http://mytestapp.localhost:5173/", { waitUntil: "commit" });
  await waitForPipeline(page);

  const marks = await collectMarks(page);
  const phases = computePhases(marks);
  const bm = await getBrowserMetrics(page);

  await context.close();

  return {
    phases,
    domContentLoaded: bm.domContentLoaded,
    jsHeapUsed: bm.jsHeapUsed,
    requestCount: requests.length,
    totalBytes: requests.reduce((s, r) => s + r.size, 0),
  };
}

async function runWarmIteration(
  browser: Browser,
  index: number,
  total: number,
): Promise<SingleRun> {
  console.log(`  Warm iteration ${String(index + 1)}/${String(total)}...`);

  const context = await browser.newContext({
    storageState: undefined,
    serviceWorkers: "allow",
  });
  const page = await context.newPage();

  // First load — populate caches
  await page.goto("http://mytestapp.localhost:5173/", { waitUntil: "commit" });
  await waitForPipeline(page);

  // Clear marks, reload
  await page.evaluate(() => {
    performance.clearMarks();
  });
  await page.reload({ waitUntil: "commit" });
  await waitForPipeline(page);

  const marks = await collectMarks(page);
  const phases = computePhases(marks);
  const bm = await getBrowserMetrics(page);

  await context.close();

  return {
    phases,
    domContentLoaded: bm.domContentLoaded,
    jsHeapUsed: bm.jsHeapUsed,
    requestCount: 0,
    totalBytes: 0,
  };
}

// ── Tests ──────────────────────────────────────────────────

test.setTimeout(NUM_RUNS * 150_000 + 30_000);

test.describe("Cold Start Performance", () => {
  let coldStats: RunStats | null = null;
  let warmStats: RunStats | null = null;

  test(`measure cold start (${String(NUM_RUNS)} iterations)`, async ({
    browser,
  }) => {
    const runs: SingleRun[] = [];
    for (let i = 0; i < NUM_RUNS; i++) {
      runs.push(await runColdIteration(browser, i, NUM_RUNS));
    }

    coldStats = aggregateRuns("cold", runs);

    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);
    printStatsTable("COLD START", coldStats, base, last);

    expect(runs.length).toBe(NUM_RUNS);
  });

  test(`measure warm start (${String(NUM_RUNS)} iterations)`, async ({ browser }) => {
    const runs: SingleRun[] = [];
    for (let i = 0; i < NUM_RUNS; i++) {
      runs.push(await runWarmIteration(browser, i, NUM_RUNS));
    }

    warmStats = aggregateRuns("warm", runs);

    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);
    printStatsTable("WARM START", warmStats, base, last);

    expect(runs.length).toBe(NUM_RUNS);
  });

  test.afterAll(() => {
    if (!coldStats) {
      return;
    }

    const results: SavedResults = { cold: coldStats, warm: warmStats };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    saveJson(LAST_FILE, results);
    console.log(`  Results saved to ${LAST_FILE}`);

    if (SAVE_AS_BASE) {
      if (fs.existsSync(BASE_FILE)) {
        console.log(`  Base already exists — not overwritten.`);
        console.log(`  Delete ${BASE_FILE} manually to reset.`);
      } else {
        saveJson(BASE_FILE, results);
        console.log(`  Base results saved to ${BASE_FILE}`);
      }
    }
  });
});
