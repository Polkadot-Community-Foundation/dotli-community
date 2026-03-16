// dot.li — Performance timing helpers

export function dur(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

export function elapsed(t0: number): string {
  return `+${((performance.now() - t0) / 1000).toFixed(3)}s`;
}
