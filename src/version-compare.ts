/** Dotted crew versions, shared by the floor check and the repo contract loader. */

/** `x.y.z` (a leading `v` and any `-pre`/`+build` suffix ignored) as numbers, or null when it is not one. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` < `b`, 0 when equal, positive when `a` > `b`; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}
