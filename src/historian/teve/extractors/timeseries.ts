/**
 * teve-ts-stat-v1 — deterministic time-series window embedding (no training, no model
 * download, pure TypeScript). Windows are z-normalized before featurization so the
 * embedding is invariant to the tag's scale and offset: a 0–1 bar sensor and a 0–100 %
 * valve with the same *shape* land near each other.
 *
 * 64-D layout, in five feature GROUPS. Each group is L2-normalized to a fixed weight
 * before the final whole-vector normalization — without this, groups with O(1) values
 * (like the pooled shape) numerically drown out groups with small values (like the
 * relative FFT band energies), and cosine similarity degenerates to shape-only:
 *
 *   A [0..7]   w=1.0   is_constant flag; min/max/median/IQR/skew/kurtosis of z; slope
 *   B [8..15]  w=1.0   autocorrelation at lags 1,2,4,8,16; zero-cross rate; peak rate; roughness
 *   C [16..19] w=1.0   spectral scalars: centroid, flatness, rolloff(0.85), peak-energy ratio
 *                      (phase-invariant "texture": tonal vs noisy vs drifting)
 *   D [20..35] w=1.0   16 log-spaced FFT band energies (relative)
 *   E [36..63] w=0.75  28-point average-pooled shape of z (down-weighted: epoch-aligned
 *                      windows of periodic signals have arbitrary phase, so raw shape
 *                      must not dominate)
 *
 * Returns null (never a garbage vector) for windows with <4 finite samples.
 */

export const TS_MODEL = 'teve-ts-stat-v1';
export const TS_DIMENSION = 64;

const RESAMPLE_N = 128;
const SHAPE_POOL = 28;
const FFT_BANDS = 16;
const AC_LAGS = [1, 2, 4, 8, 16];
const STAT_CLAMP = 10; // skew/kurtosis/slope live on unbounded scales; clamp so one wild window can't dominate

const GROUPS: { start: number; end: number; weight: number }[] = [
  { start: 0, end: 8, weight: 1.0 },   // A: distribution stats + slope
  { start: 8, end: 16, weight: 1.0 },  // B: autocorrelation + rates
  { start: 16, end: 20, weight: 1.0 }, // C: spectral scalars
  { start: 20, end: 36, weight: 1.0 }, // D: FFT bands
  { start: 36, end: 64, weight: 0.75 } // E: pooled shape
];

export interface WindowSample {
  time: number | Date;
  value: number;
}

export function embedTimeseriesWindow(samples: WindowSample[]): number[] | null {
  const pts = samples
    .map((s) => ({ t: s.time instanceof Date ? s.time.getTime() : s.time, v: s.value }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 4) return null;

  const r = resample(pts, RESAMPLE_N);
  const mean = avg(r);
  const sd = Math.sqrt(avg(r.map((v) => (v - mean) ** 2)));
  // Relative threshold, not absolute: "constant" must be scale-invariant, or scaling a
  // tiny-amplitude series flips it across the boundary and z-normalization amplifies
  // pure float noise into a full-scale shape.
  const maxAbs = r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const isConstant = !(sd > maxAbs * 1e-9);
  const z = isConstant ? new Array<number>(RESAMPLE_N).fill(0) : r.map((v) => (v - mean) / sd);

  const f = new Array<number>(TS_DIMENSION).fill(0);
  f[0] = isConstant ? 1 : 0;

  if (!isConstant) {
    // Group A: distribution stats + slope
    const sorted = [...z].sort((a, b) => a - b);
    f[1] = sorted[0]!;
    f[2] = sorted[sorted.length - 1]!;
    f[3] = quantile(sorted, 0.5);
    f[4] = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    f[5] = clamp(centralMoment(z, 3), STAT_CLAMP); // z has unit variance, so m3 = skewness
    f[6] = clamp(centralMoment(z, 4) - 3, STAT_CLAMP);
    f[7] = clamp(regressionSlope(z), STAT_CLAMP);

    // Group B: autocorrelation + rates
    AC_LAGS.forEach((lag, i) => {
      f[8 + i] = autocorrelation(z, lag);
    });
    f[13] = zeroCrossingRate(z);
    f[14] = peakRate(z);
    f[15] = clamp(diffStd(z), STAT_CLAMP);

    // Groups C+D: spectrum
    const mags = dftMagnitudes(z);
    const spectral = spectralScalars(mags);
    f[16] = spectral.centroid;
    f[17] = spectral.flatness;
    f[18] = spectral.rolloff;
    f[19] = spectral.peakRatio;
    const bands = logBands(mags, FFT_BANDS);
    for (let i = 0; i < FFT_BANDS; i++) f[20 + i] = bands[i]!;

    // Group E: pooled shape
    const pooled = averagePool(z, SHAPE_POOL);
    for (let i = 0; i < SHAPE_POOL; i++) f[36 + i] = pooled[i]!;
  }

  // Per-group normalization to fixed weights (see header comment), then final L2.
  for (const g of GROUPS) {
    let sum = 0;
    for (let i = g.start; i < g.end; i++) sum += f[i]! ** 2;
    const norm = Math.sqrt(sum);
    if (norm > 1e-12) {
      for (let i = g.start; i < g.end; i++) f[i] = (f[i]! / norm) * g.weight;
    }
  }

  let sum = 0;
  for (const v of f) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm < 1e-12) return null; // unreachable (f[0]=1 when constant) but never emit garbage
  return f.map((v) => v / norm);
}

/** Linear interpolation onto n evenly spaced points across the window's time span. */
function resample(pts: { t: number; v: number }[], n: number): number[] {
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const span = t1 - t0;
  if (!(span > 0)) {
    // All samples share one timestamp — fall back to index spacing.
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = pts[Math.min(pts.length - 1, Math.floor((i / n) * pts.length))]!.v;
    return out;
  }
  const out = new Array<number>(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (span * i) / (n - 1);
    while (j < pts.length - 2 && pts[j + 1]!.t < t) j++;
    const a = pts[j]!;
    const b = pts[Math.min(j + 1, pts.length - 1)]!;
    out[i] = b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return out;
}

const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

const clamp = (x: number, limit: number): number => Math.max(-limit, Math.min(limit, x));

function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

function centralMoment(z: number[], k: number): number {
  // z is already centered and unit-variance, so this is the standardized moment.
  return avg(z.map((v) => v ** k));
}

function regressionSlope(z: number[]): number {
  const n = z.length;
  const xMean = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * z[i]!;
    den += (i - xMean) ** 2;
  }
  // Normalize x to [0,1] so the slope is "change in z across the full window".
  return (num / den) * (n - 1);
}

function autocorrelation(z: number[], lag: number): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < z.length; i++) den += z[i]! ** 2;
  if (den < 1e-12) return 0;
  for (let i = 0; i + lag < z.length; i++) num += z[i]! * z[i + lag]!;
  return num / den;
}

function zeroCrossingRate(z: number[]): number {
  let crossings = 0;
  for (let i = 1; i < z.length; i++) {
    if ((z[i - 1]! >= 0) !== (z[i]! >= 0)) crossings++;
  }
  return crossings / (z.length - 1);
}

function peakRate(z: number[]): number {
  let peaks = 0;
  for (let i = 1; i < z.length - 1; i++) {
    if (z[i]! > z[i - 1]! && z[i]! > z[i + 1]!) peaks++;
  }
  return peaks / (z.length - 2);
}

function diffStd(z: number[]): number {
  const d: number[] = [];
  for (let i = 1; i < z.length; i++) d.push(z[i]! - z[i - 1]!);
  const m = avg(d);
  return Math.sqrt(avg(d.map((v) => (v - m) ** 2)));
}

/** Naive real DFT power spectrum, bins 1..N/2-1 (DC skipped; z is ~zero-mean). N=128 → trivial cost. */
function dftMagnitudes(z: number[]): number[] {
  const n = z.length;
  const maxBin = Math.floor(n / 2) - 1;
  const mags = new Array<number>(maxBin).fill(0);
  for (let k = 1; k <= maxBin; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * k * i) / n;
      re += z[i]! * Math.cos(angle);
      im -= z[i]! * Math.sin(angle);
    }
    mags[k - 1] = re * re + im * im;
  }
  return mags;
}

/**
 * Phase-invariant spectral texture: centroid (where the energy lives, log-frequency,
 * 0..1), flatness (geometric/arithmetic mean ratio — 1 for white noise, →0 for a pure
 * tone), rolloff (log-frequency below which 85% of energy sits), and peak-energy ratio
 * (energy share of the single strongest bin).
 */
function spectralScalars(mags: number[]): { centroid: number; flatness: number; rolloff: number; peakRatio: number } {
  const total = mags.reduce((s, x) => s + x, 0);
  if (total < 1e-12) return { centroid: 0, flatness: 0, rolloff: 0, peakRatio: 0 };
  const n = mags.length;
  const logPos = (i: number) => Math.log(i + 1) / Math.log(n); // 0..1 in log frequency

  let centroid = 0;
  let cumulative = 0;
  let rolloff = 1;
  let peak = 0;
  let logSum = 0;
  const eps = 1e-12;
  for (let i = 0; i < n; i++) {
    const p = mags[i]! / total;
    centroid += p * logPos(i);
    if (mags[i]! > peak) peak = mags[i]!;
    logSum += Math.log(mags[i]! + eps);
  }
  for (let i = 0; i < n; i++) {
    cumulative += mags[i]! / total;
    if (cumulative >= 0.85) {
      rolloff = logPos(i);
      break;
    }
  }
  const flatness = Math.exp(logSum / n) / (total / n + eps);
  return { centroid, flatness, rolloff, peakRatio: peak / total };
}

/** Group power-spectrum bins into log-spaced bands, returned as relative energies. */
function logBands(mags: number[], bandCount: number): number[] {
  const maxBin = mags.length;
  const edges: number[] = [];
  for (let b = 0; b <= bandCount; b++) {
    edges.push(Math.max(1, Math.round(Math.exp((Math.log(maxBin) * b) / bandCount))));
  }
  const bands = new Array<number>(bandCount).fill(0);
  for (let b = 0; b < bandCount; b++) {
    const lo = edges[b]!;
    const hi = Math.max(edges[b + 1]!, lo + 1);
    let energy = 0;
    for (let k = lo; k < hi && k <= maxBin; k++) energy += mags[k - 1]!;
    bands[b] = energy;
  }
  const total = bands.reduce((s, x) => s + x, 0);
  if (total < 1e-12) return bands.map(() => 0);
  return bands.map((e) => e / total);
}

function averagePool(z: number[], size: number): number[] {
  const block = z.length / size;
  const pooled = new Array<number>(size).fill(0);
  for (let i = 0; i < size; i++) {
    const lo = Math.floor(i * block);
    const hi = Math.floor((i + 1) * block);
    let s = 0;
    for (let j = lo; j < hi; j++) s += z[j]!;
    pooled[i] = hi > lo ? s / (hi - lo) : 0;
  }
  return pooled;
}
