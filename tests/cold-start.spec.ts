/**
 * dot.li — Cold Start Performance Test
 *
 * Measures the full loading pipeline from a fresh browser context:
 *   HTML parse → JS load → auth init → SW registration → smoldot sync →
 *   name resolution → content fetch → render
 *
 * Prerequisites:
 *   1. Run `npm run dev` in a separate terminal
 *   2. Run `npm run test:perf`        — saves results to tests/results/last.json
 *      Run `npm run test:perf:base`   — saves results to tests/results/base.json (once)
 *      Run `npm run test:perf:compare` — shows diff between base, last, and current
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
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

interface RunResult {
  timestamp: string;
  type: "cold" | "warm";
  phases: Record<string, number>; // phase name → duration ms
  browserMetrics: {
    domContentLoaded: number;
    jsHeapUsed: number;
  };
  networkStats: {
    requestCount: number;
    totalBytes: number;
  };
  marks: PerfMark[];
}

interface SavedResults {
  cold: RunResult;
  warm: RunResult | null;
}

// ── Constants ──────────────────────────────────────────────

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const BASE_FILE = path.join(RESULTS_DIR, "base.json");
const LAST_FILE = path.join(RESULTS_DIR, "last.json");
const SAVE_AS_BASE = process.env.PERF_SAVE_BASE === "1";

// ── Phase definitions (order matters for display) ──────────

const PHASE_PAIRS: [string, string, string][] = [
  ["Total (main)", "dotli:main:start", "dotli:main:end"],
  ["Auth init", "dotli:auth:start", "dotli:auth:end"],
  ["SW registration", "dotli:sw:start", "dotli:sw:end"],
  ["Name resolution", "dotli:resolve:start", "dotli:resolve:end"],
  ["  Smoldot init", "dotli:smoldot:init:start", "dotli:smoldot:init:end"],
  ["    Relay chain", "dotli:smoldot:relay:start", "dotli:smoldot:relay:end"],
  ["    Parachain", "dotli:smoldot:parachain:start", "dotli:smoldot:parachain:end"],
  ["    Chain sync", "dotli:smoldot:sync:start", "dotli:smoldot:sync:end"],
  ["Cache check", "dotli:cache-check:start", "dotli:cache-check:end"],
  ["Content fetch", "dotli:fetch:start", "dotli:fetch:end"],
  ["  P2P attempt", "dotli:fetch:p2p:start", "dotli:fetch:p2p:end"],
  ["  Gateway fetch", "dotli:fetch:gateway:start", "dotli:fetch:gateway:end"],
  ["  Archive parse", "dotli:fetch:parse:start", "dotli:fetch:parse:end"],
  ["Render", "dotli:render:start", "dotli:render:end"],
];

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

function phasesToMap(phases: PhaseResult[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const p of phases) {
    map[p.phase] = p.duration;
  }
  return map;
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
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
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

function saveJson(filepath: string, data: SavedResults): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function buildRunResult(
  type: "cold" | "warm",
  phases: PhaseResult[],
  marks: PerfMark[],
  browserMetrics: { domContentLoaded: number; jsHeapUsed: number },
  networkStats: { requestCount: number; totalBytes: number },
): RunResult {
  return {
    timestamp: new Date().toISOString(),
    type,
    phases: phasesToMap(phases),
    browserMetrics,
    networkStats,
    marks,
  };
}

/** Wait for the app pipeline to finish. */
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

async function getBrowserMetrics(page: Page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    const memory = (performance as any).memory;
    return {
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      jsHeapUsed: memory?.usedJSHeapSize ?? 0,
    };
  });
}

// ── Report printing ────────────────────────────────────────

function printPhaseTable(
  title: string,
  phases: PhaseResult[],
  browserMetrics: { domContentLoaded: number; jsHeapUsed: number },
  networkStats: { requestCount: number; totalBytes: number },
  basePhases?: Record<string, number>,
  lastPhases?: Record<string, number>,
) {
  const div = "─".repeat(90);
  const hasBase = basePhases && Object.keys(basePhases).length > 0;
  const hasLast = lastPhases && Object.keys(lastPhases).length > 0;

  console.log(`\n${div}`);
  console.log(`  ${title}`);
  console.log(div);

  console.log(`\n  DOMContentLoaded:  ${fmt(browserMetrics.domContentLoaded)}`);
  console.log(
    `  JS Heap Used:      ${(browserMetrics.jsHeapUsed / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(`  Network Requests:  ${networkStats.requestCount}`);
  console.log(
    `  Bytes Transferred: ${(networkStats.totalBytes / 1024 / 1024).toFixed(2)} MB`,
  );

  // Header
  let header = `  ${"Phase".padEnd(28)} ${"Duration".padStart(10)}`;
  if (hasBase) header += ` ${"vs Base".padStart(30)}`;
  if (hasLast) header += ` ${"vs Last".padStart(30)}`;
  console.log(`\n${header}`);

  let line = `  ${"─".repeat(28)} ${"─".repeat(10)}`;
  if (hasBase) line += ` ${"─".repeat(30)}`;
  if (hasLast) line += ` ${"─".repeat(30)}`;
  console.log(line);

  for (const p of phases) {
    let row = `  ${p.phase.padEnd(28)} ${fmt(p.duration).padStart(10)}`;

    if (hasBase && basePhases[p.phase] !== undefined) {
      row += ` ${fmtDelta(p.duration, basePhases[p.phase]).padStart(30)}`;
    } else if (hasBase) {
      row += ` ${"—".padStart(30)}`;
    }

    if (hasLast && lastPhases![p.phase] !== undefined) {
      row += ` ${fmtDelta(p.duration, lastPhases![p.phase]).padStart(30)}`;
    } else if (hasLast) {
      row += ` ${"—".padStart(30)}`;
    }

    console.log(row);
  }

  console.log(`\n${div}\n`);
}

// ── Tests ──────────────────────────────────────────────────

test.describe("Cold Start Performance", () => {
  let context: BrowserContext;
  let page: Page;
  let coldResult: RunResult | null = null;
  let warmResult: RunResult | null = null;

  test.beforeEach(async ({ browser }) => {
    context = await browser.newContext({
      storageState: undefined,
      serviceWorkers: "allow",
    });
    page = await context.newPage();
  });

  test.afterEach(async () => {
    await context.close();
  });

  test("measure cold start", async () => {
    // Track network
    const requests: { url: string; size: number }[] = [];
    page.on("response", async (response) => {
      try {
        const body = await response.body().catch(() => null);
        requests.push({ url: response.url(), size: body?.length ?? 0 });
      } catch {
        requests.push({ url: response.url(), size: 0 });
      }
    });

    await page.goto("http://mytestapp.localhost:5173/", {
      waitUntil: "commit",
    });
    await waitForPipeline(page);

    const marks = await collectMarks(page);
    const phases = computePhases(marks);
    const browserMetrics = await getBrowserMetrics(page);
    const networkStats = {
      requestCount: requests.length,
      totalBytes: requests.reduce((sum, r) => sum + r.size, 0),
    };

    // Load comparison data
    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);

    printPhaseTable(
      "COLD START",
      phases,
      browserMetrics,
      networkStats,
      base?.cold.phases,
      last?.cold.phases,
    );

    // Store for saving after all tests
    coldResult = buildRunResult("cold", phases, marks, browserMetrics, networkStats);

    expect(marks.length).toBeGreaterThan(0);
    expect(marks.find((m) => m.name === "dotli:main:start")).toBeDefined();
  });

  test("measure warm start", async () => {
    // First load — populate caches
    await page.goto("http://mytestapp.localhost:5173/", {
      waitUntil: "commit",
    });
    await waitForPipeline(page);

    // Reload in same context
    await page.evaluate(() => performance.clearMarks());
    await page.reload({ waitUntil: "commit" });
    await waitForPipeline(page);

    const marks = await collectMarks(page);
    const phases = computePhases(marks);
    const browserMetrics = await getBrowserMetrics(page);

    const base = loadJson(BASE_FILE);
    const last = loadJson(LAST_FILE);

    printPhaseTable(
      "WARM START (reload with caches)",
      phases,
      browserMetrics,
      { requestCount: 0, totalBytes: 0 },
      base?.warm?.phases,
      last?.warm?.phases,
    );

    warmResult = buildRunResult("warm", phases, marks, browserMetrics, {
      requestCount: 0,
      totalBytes: 0,
    });

    expect(marks.length).toBeGreaterThan(0);
  });

  test.afterAll(() => {
    if (!coldResult) return;

    const results: SavedResults = {
      cold: coldResult,
      warm: warmResult,
    };

    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    // Always save as "last"
    saveJson(LAST_FILE, results);
    console.log(`  Results saved to ${LAST_FILE}`);

    // Save as "base" only if explicitly requested and no base exists yet
    if (SAVE_AS_BASE) {
      if (fs.existsSync(BASE_FILE)) {
        console.log(
          `  Base already exists at ${BASE_FILE} — not overwritten.`,
        );
        console.log(
          `  To reset base, delete the file manually and re-run with PERF_SAVE_BASE=1`,
        );
      } else {
        saveJson(BASE_FILE, results);
        console.log(`  Base results saved to ${BASE_FILE}`);
      }
    }
  });
});
