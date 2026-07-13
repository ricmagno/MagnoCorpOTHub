/**
 * TEVE retrieval-quality eval — the Stage 3 gate (replaces the retired
 * "replay legacy TEVE client queries" gate, which had no system to replay against).
 *
 * Model-in-process, no database: this scores the extractors themselves.
 * Deterministic (fixed fixtures, fixed model revision, CPU), so it's CI-safe.
 *
 * Thresholds:
 *   image  same-family P@3  >= 0.8
 *   text   top-1 family     >= 2/3 queries
 *   ts     same-family P@3  >= 0.9
 *
 * Exit code 0 = gate passed; 1 = below threshold or error.
 */
import sharp from 'sharp';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { TeveEngine } from '../../src/historian/teve/engine';
import { embedTimeseriesWindow } from '../../src/historian/teve/extractors/timeseries';

const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures', 'teve');
const FAMILIES = ['alarm', 'normal', 'trend'] as const;

const cosine = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s; // inputs are L2-normalized
};

interface Item { family: string; vec: number[] }

/** Fraction of each item's top-k neighbours that share its family, averaged. */
function precisionAtK(items: Item[], k: number): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const scored = items
      .map((it, j) => ({ j, sim: i === j ? -Infinity : cosine(items[i]!.vec, it.vec) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);
    const same = scored.filter((s) => items[s.j]!.family === items[i]!.family).length;
    total += same / k;
  }
  return total / items.length;
}

async function evalImagesAndText(engine: TeveEngine): Promise<{ imageP3: number; textTop1: number }> {
  // 5 deterministic variants per base fixture
  const variants: Record<string, (b: Buffer) => Promise<Buffer>> = {
    orig: async (b) => b,
    dark: (b) => sharp(b).modulate({ brightness: 0.85 }).png().toBuffer(),
    bright: (b) => sharp(b).modulate({ brightness: 1.15 }).png().toBuffer(),
    crop: (b) => sharp(b).extract({ left: 51, top: 32, width: 922, height: 576 }).resize(1024, 640).png().toBuffer(),
    rescale: (b) => sharp(b).resize(512).resize(1024).png().toBuffer(),
  };

  const items: Item[] = [];
  const baseVecs = new Map<string, number[]>();
  for (const family of FAMILIES) {
    const base = await sharp(join(FIXTURES, `${family}.png`)).png().toBuffer();
    for (const [vname, fn] of Object.entries(variants)) {
      const buf = await fn(base);
      const p = join(tmpdir(), `teve-eval-${family}-${vname}.png`);
      await writeFile(p, buf);
      const vec = await engine.embedImage(p);
      items.push({ family, vec });
      if (vname === 'orig') baseVecs.set(family, vec);
    }
  }
  const imageP3 = precisionAtK(items, 3);

  const queries: [string, string][] = [
    ['a dashboard with a red alarm warning banner', 'alarm'],
    ['a control panel showing all systems normal with green indicators', 'normal'],
    ['a line chart showing a temperature trend over time', 'trend'],
  ];
  let correct = 0;
  for (const [q, expected] of queries) {
    const qv = await engine.embedText(q);
    let best = '';
    let bestSim = -Infinity;
    for (const [family, vec] of baseVecs) {
      const sim = cosine(qv, vec);
      if (sim > bestSim) { bestSim = sim; best = family; }
    }
    const ok = best === expected;
    if (ok) correct++;
    console.log(`  text: "${q}" → ${best} (sim ${bestSim.toFixed(3)}) ${ok ? 'OK' : `EXPECTED ${expected}`}`);
  }
  return { imageP3, textTop1: correct / queries.length };
}

/** Deterministic PRNG (mulberry32) so the synthetic series are identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evalTimeseries(): number {
  const N = 240; // samples per window
  const mk = (fn: (i: number) => number) =>
    Array.from({ length: N }, (_, i) => ({ time: i * 15_000, value: fn(i) }));

  const items: Item[] = [];
  const families: [string, (rand: () => number) => { time: number; value: number }[]][] = [
    ['sine', (r) => { const period = 30 + r() * 30, phase = r() * 6.28, amp = 1 + r() * 4, off = r() * 100;
      return mk((i) => off + amp * Math.sin((i / period) * 2 * Math.PI + phase) + (r() - 0.5) * amp * 0.05); }],
    ['step', (r) => { const at = Math.floor(N * (0.3 + r() * 0.4)), lo = r() * 10, hi = lo + 5 + r() * 20;
      return mk((i) => (i < at ? lo : hi) + (r() - 0.5) * 0.2); }],
    ['ramp', (r) => { const slope = 0.5 + r(), off = r() * 50;
      return mk((i) => off + (slope * i) / N * 20 + (r() - 0.5) * 0.3); }],
    ['noise', (r) => { const off = r() * 100, scale = 1 + r() * 5;
      return mk(() => off + (r() - 0.5) * scale); }],
    ['spike', (r) => { const at = Math.floor(N * (0.4 + r() * 0.2)), base = r() * 20, mag = 10 + r() * 20;
      return mk((i) => base + (Math.abs(i - at) < 4 ? mag * (1 - Math.abs(i - at) / 4) : 0) + (r() - 0.5) * 0.2); }],
  ];

  let seed = 42;
  for (const [family, gen] of families) {
    for (let inst = 0; inst < 6; inst++) {
      const vec = embedTimeseriesWindow(gen(mulberry32(seed++)));
      if (!vec) throw new Error(`ts eval: ${family}#${inst} failed to embed`);
      items.push({ family, vec });
    }
  }
  return precisionAtK(items, 3);
}

async function main() {
  console.log('TEVE retrieval eval — Stage 3 gate\n');

  console.log('[1/3] time-series retrieval (5 families × 6 instances)');
  const tsP3 = evalTimeseries();
  console.log(`  ts same-family P@3 = ${tsP3.toFixed(3)} (threshold 0.9)\n`);

  console.log('[2/3] image retrieval (3 families × 5 variants) — loading CLIP...');
  const engine = new TeveEngine();
  const { imageP3, textTop1 } = await evalImagesAndText(engine);
  console.log(`  image same-family P@3 = ${imageP3.toFixed(3)} (threshold 0.8)\n`);

  console.log('[3/3] text→image top-1 family');
  console.log(`  text top-1 = ${(textTop1 * 100).toFixed(0)}% (threshold 66%)\n`);

  const failures: string[] = [];
  if (tsP3 < 0.9) failures.push(`ts P@3 ${tsP3.toFixed(3)} < 0.9`);
  if (imageP3 < 0.8) failures.push(`image P@3 ${imageP3.toFixed(3)} < 0.8`);
  if (textTop1 < 2 / 3) failures.push(`text top-1 ${(textTop1 * 100).toFixed(0)}% < 66%`);

  if (failures.length > 0) {
    console.error(`GATE FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('GATE PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
