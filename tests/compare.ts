#!/usr/bin/env npx tsx
/**
 * dot.li — Performance Comparison Tool
 *
 * Compares base.json vs last.json and prints a side-by-side diff.
 * Run: npx tsx tests/compare.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface RunResult {
  timestamp: string;
  type: "cold" | "warm";
  phases: Record<string, number>;
  browserMetrics: {
    domContentLoaded: number;
    jsHeapUsed: number;
  };
  networkStats: {
    requestCount: number;
    totalBytes: number;
  };
}

interface SavedResults {
  cold: RunResult;
  warm: RunResult | null;
}

const RESULTS_DIR = path.join(import.meta.dirname, "results");
const BASE_FILE = path.join(RESULTS_DIR, "base.json");
const LAST_FILE = path.join(RESULTS_DIR, "last.json");

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDelta(current: number, reference: number): string {
  const diff = current - reference;
  const pct = reference > 0 ? ((diff / reference) * 100).toFixed(1) : "N/A";
  const sign = diff > 0 ? "+" : "";
  if (diff < 0) return `\x1b[32m${sign}${fmt(diff)} (${sign}${pct}%)\x1b[0m`;
  if (diff > 0) return `\x1b[31m${sign}${fmt(diff)} (${sign}${pct}%)\x1b[0m`;
  return `${fmt(diff)} (0%)`;
}

function loadJson(filepath: string): SavedResults | null {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

function compareRuns(label: string, base: RunResult, last: RunResult): void {
  const div = "═".repeat(92);
  const thin = "─".repeat(92);

  console.log(`\n${div}`);
  console.log(`  ${label}`);
  console.log(`  Base: ${base.timestamp}   Last: ${last.timestamp}`);
  console.log(div);

  // Browser metrics comparison
  console.log(`\n  ${"Metric".padEnd(24)} ${"Base".padStart(12)} ${"Last".padStart(12)} ${"Delta".padStart(30)}`);
  console.log(`  ${"─".repeat(24)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(30)}`);

  const metrics: [string, number, number][] = [
    ["DOMContentLoaded", base.browserMetrics.domContentLoaded, last.browserMetrics.domContentLoaded],
    ["JS Heap (MB)", Math.round(base.browserMetrics.jsHeapUsed / 1024 / 1024), Math.round(last.browserMetrics.jsHeapUsed / 1024 / 1024)],
    ["Network Requests", base.networkStats.requestCount, last.networkStats.requestCount],
    ["Bytes (MB)", Math.round(base.networkStats.totalBytes / 1024 / 1024 * 100) / 100, Math.round(last.networkStats.totalBytes / 1024 / 1024 * 100) / 100],
  ];

  for (const [name, bVal, lVal] of metrics) {
    const delta = fmtDelta(lVal, bVal);
    console.log(`  ${name.padEnd(24)} ${String(bVal).padStart(12)} ${String(lVal).padStart(12)} ${delta.padStart(44)}`);
  }

  // Phase comparison
  const allPhases = new Set([...Object.keys(base.phases), ...Object.keys(last.phases)]);

  // Ordered by PHASE_PAIRS definition
  const orderedPhases = [
    "Total (main)", "Auth init", "SW registration",
    "Name resolution", "  Smoldot init", "    Relay chain",
    "    Parachain", "    Chain sync", "Cache check",
    "Content fetch", "  P2P attempt", "  Gateway fetch",
    "  Archive parse", "Render",
  ].filter((p) => allPhases.has(p));

  console.log(`\n  ${"Phase".padEnd(24)} ${"Base".padStart(12)} ${"Last".padStart(12)} ${"Delta".padStart(30)}`);
  console.log(`  ${"─".repeat(24)} ${"─".repeat(12)} ${"─".repeat(12)} ${"─".repeat(30)}`);

  for (const phase of orderedPhases) {
    const bVal = base.phases[phase];
    const lVal = last.phases[phase];

    if (bVal !== undefined && lVal !== undefined) {
      const delta = fmtDelta(lVal, bVal);
      console.log(`  ${phase.padEnd(24)} ${fmt(bVal).padStart(12)} ${fmt(lVal).padStart(12)} ${delta.padStart(44)}`);
    } else if (bVal !== undefined) {
      console.log(`  ${phase.padEnd(24)} ${fmt(bVal).padStart(12)} ${"—".padStart(12)} ${"removed".padStart(30)}`);
    } else if (lVal !== undefined) {
      console.log(`  ${phase.padEnd(24)} ${"—".padStart(12)} ${fmt(lVal).padStart(12)} ${"new".padStart(30)}`);
    }
  }

  // Summary
  const baseTotal = base.phases["Total (main)"];
  const lastTotal = last.phases["Total (main)"];
  if (baseTotal !== undefined && lastTotal !== undefined) {
    const diff = lastTotal - baseTotal;
    const pct = ((diff / baseTotal) * 100).toFixed(1);
    const sign = diff > 0 ? "+" : "";
    const color = diff < 0 ? "\x1b[32m" : diff > 0 ? "\x1b[31m" : "";
    const reset = "\x1b[0m";
    console.log(`\n  ${color}Overall: ${sign}${fmt(diff)} (${sign}${pct}%) — ${fmt(baseTotal)} → ${fmt(lastTotal)}${reset}`);
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

console.log("\n  dot.li Performance Comparison: Base vs Last\n");

compareRuns("COLD START", base.cold, last.cold);

if (base.warm && last.warm) {
  compareRuns("WARM START", base.warm, last.warm);
}
