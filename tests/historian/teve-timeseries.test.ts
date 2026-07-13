/**
 * Unit tests for the teve-ts-stat-v1 time-series window extractor.
 * Model-free (pure TypeScript) — the CLIP-dependent retrieval quality gate lives in
 * scripts/historian/teve-eval.ts (npm run historian:eval), not in Jest.
 */
import {
  embedTimeseriesWindow,
  TS_DIMENSION,
  WindowSample,
} from '../../src/historian/teve/extractors/timeseries';

const mkSeries = (fn: (i: number) => number, n = 240): WindowSample[] =>
  Array.from({ length: n }, (_, i) => ({ time: i * 15_000, value: fn(i) }));

const l2 = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe('teve-ts-stat-v1 time-series extractor', () => {
  const sine = mkSeries((i) => 20 + 5 * Math.sin(i / 10));

  it('returns a 64-D unit vector', () => {
    const vec = embedTimeseriesWindow(sine);
    expect(vec).not.toBeNull();
    expect(vec!).toHaveLength(TS_DIMENSION);
    expect(l2(vec!)).toBeCloseTo(1, 6);
    expect(vec!.every(Number.isFinite)).toBe(true);
  });

  it('is deterministic', () => {
    expect(embedTimeseriesWindow(sine)).toEqual(embedTimeseriesWindow(sine));
  });

  it('is invariant to scale and offset (z-normalization)', () => {
    const scaled = mkSeries((i) => 5000 + 130 * (20 + 5 * Math.sin(i / 10)));
    const a = embedTimeseriesWindow(sine)!;
    const b = embedTimeseriesWindow(scaled)!;
    expect(cosine(a, b)).toBeGreaterThan(0.999);
  });

  it('is insensitive to sample order (sorts by time)', () => {
    const shuffled = [...sine].reverse();
    expect(embedTimeseriesWindow(shuffled)).toEqual(embedTimeseriesWindow(sine));
  });

  it('ignores non-finite samples', () => {
    const withNaNs: WindowSample[] = [
      ...sine,
      { time: 1, value: NaN },
      { time: 2, value: Infinity },
      { time: NaN, value: 5 },
    ];
    expect(embedTimeseriesWindow(withNaNs)).toEqual(embedTimeseriesWindow(sine));
  });

  it('returns null instead of a garbage vector when data is insufficient', () => {
    expect(embedTimeseriesWindow([])).toBeNull();
    expect(embedTimeseriesWindow(mkSeries((i) => i, 3))).toBeNull();
    expect(embedTimeseriesWindow([{ time: 0, value: NaN }, { time: 1, value: NaN }])).toBeNull();
  });

  it('embeds a constant series as a valid flag vector, not NaN', () => {
    const vec = embedTimeseriesWindow(mkSeries(() => 42));
    expect(vec).not.toBeNull();
    expect(vec![0]).toBeCloseTo(1, 6); // is_constant flag carries the whole norm
    expect(l2(vec!)).toBeCloseTo(1, 6);
  });

  it('accepts Date objects for time', () => {
    const withDates: WindowSample[] = sine.map((s) => ({
      time: new Date(s.time as number),
      value: s.value,
    }));
    expect(embedTimeseriesWindow(withDates)).toEqual(embedTimeseriesWindow(sine));
  });

  it('separates unlike shapes more than alike ones', () => {
    const sineA = embedTimeseriesWindow(mkSeries((i) => 10 + 3 * Math.sin(i / 8)))!;
    const sineB = embedTimeseriesWindow(mkSeries((i) => 500 + 40 * Math.sin(i / 9 + 2)))!;
    const ramp = embedTimeseriesWindow(mkSeries((i) => i * 0.5))!;
    expect(cosine(sineA, sineB)).toBeGreaterThan(cosine(sineA, ramp));
  });
});
