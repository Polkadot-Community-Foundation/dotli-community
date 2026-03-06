// dot.li — Performance timing helpers

export function dur(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}
