/**
 * Property-based tests for the teve-ts-stat-v1 time-series extractor:
 * for ANY input — including NaN/Infinity values, unsorted times, duplicates —
 * the extractor must either return null or a finite, unit-norm, 64-D vector.
 */
import fc from 'fast-check';
import {
  embedTimeseriesWindow,
  TS_DIMENSION,
  WindowSample,
} from '../../src/historian/teve/extractors/timeseries';

const sampleArb: fc.Arbitrary<WindowSample> = fc.record({
  time: fc.oneof(
    fc.double({ min: 0, max: 2e12, noNaN: false }),
    fc.constant(NaN),
    fc.constant(Infinity)
  ),
  value: fc.oneof(
    fc.double({ noNaN: false }),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(-Infinity)
  ),
});

describe('teve-ts-stat-v1 embedding properties', () => {
  it('never crashes and never emits a non-finite or wrong-dimension vector', () => {
    fc.assert(
      fc.property(fc.array(sampleArb, { maxLength: 500 }), (samples) => {
        const vec = embedTimeseriesWindow(samples);
        if (vec === null) return true;
        if (vec.length !== TS_DIMENSION) return false;
        if (!vec.every(Number.isFinite)) return false;
        const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
        return Math.abs(norm - 1) < 1e-6;
      }),
      { numRuns: 300 }
    );
  });

  it('returns null whenever there are fewer than 4 finite samples', () => {
    fc.assert(
      fc.property(fc.array(sampleArb, { maxLength: 20 }), (samples) => {
        const finite = samples.filter(
          (s) => Number.isFinite(s.time as number) && Number.isFinite(s.value)
        );
        const vec = embedTimeseriesWindow(samples);
        return finite.length < 4 ? vec === null : true;
      }),
      { numRuns: 300 }
    );
  });

  it('is invariant under affine transforms of the values (a*v + b, a > 0)', () => {
    // Realistic-signal precondition: values at sensor-like precision with either zero
    // or non-vanishing spread. At float-epsilon spreads the constant/non-constant
    // classification necessarily has a discontinuity — that boundary is exercised by
    // the adversarial "never crashes" property above, not by this invariance one.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            time: fc.integer({ min: 0, max: 1_000_000 }),
            value: fc.double({ min: -1e3, max: 1e3, noNaN: true }).map((v) => Math.round(v * 100) / 100),
          }),
          { minLength: 8, maxLength: 200 }
        ),
        fc.double({ min: 0.1, max: 100, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        (samples, a, b) => {
          const values = samples.map((s) => s.value);
          const spread = Math.max(...values) - Math.min(...values);
          fc.pre(spread === 0 || spread >= 0.01);
          const orig = embedTimeseriesWindow(samples);
          const transformed = embedTimeseriesWindow(
            samples.map((s) => ({ time: s.time, value: a * s.value + b }))
          );
          if (orig === null || transformed === null) return orig === transformed;
          const dot = orig.reduce((s, x, i) => s + x * transformed[i]!, 0);
          return dot > 0.999;
        }
      ),
      { numRuns: 200 }
    );
  });
});
