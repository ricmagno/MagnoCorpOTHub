/**
 * Backfill TEVE embeddings:
 *  - metric window embeddings for a tag (or all tags) over a time range
 *  - anomaly signature embeddings for any anomaly still missing one
 *
 * Usage:
 *   npm run historian:backfill -- --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z [--tag HMI-01.Temperature]
 *   npm run historian:backfill -- --anomalies-only
 */
import { Pool } from 'pg';
import config from '../../src/historian/config';
import { WindowEmbeddingService } from '../../src/historian/services/window-embedding';
import { AnomalyEmbeddingService } from '../../src/historian/services/anomaly-embedding';
import { parseTagId } from '../../src/historian/teve/engine';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main() {
  const pool = new Pool({ connectionString: config.database.url });
  const windows = new WindowEmbeddingService(pool);
  const anomalies = new AnomalyEmbeddingService(pool);

  try {
    if (!has('anomalies-only')) {
      const fromArg = arg('from');
      const toArg = arg('to');
      if (!fromArg || !toArg) {
        throw new Error('required: --from <ISO> --to <ISO> (or --anomalies-only)');
      }
      const from = new Date(fromArg);
      const to = new Date(toArg);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
        throw new Error('--from/--to must be valid ISO timestamps with from < to');
      }

      let tags: { scada_system_id: string; tag_name: string }[];
      const tagArg = arg('tag');
      if (tagArg) {
        const parsed = parseTagId(tagArg);
        if (!parsed) throw new Error('--tag must be System.TagName');
        tags = [{ scada_system_id: parsed.systemId, tag_name: parsed.tagName }];
      } else {
        const res = await pool.query(
          `SELECT DISTINCT scada_system_id, tag_name FROM historian.metrics
           WHERE time >= $1 AND time < $2`,
          [from, to]
        );
        tags = res.rows;
      }

      let stored = 0;
      let skipped = 0;
      for (const t of tags) {
        for (
          let ws = windows.windowStartFor(from).getTime();
          ws < to.getTime();
          ws += windows.windowMs
        ) {
          const r = await windows.embedWindow(t.scada_system_id, t.tag_name, new Date(ws));
          if (r.stored) stored++;
          else skipped++;
        }
      }
      console.log(`windows: ${stored} embedded, ${skipped} skipped (insufficient data) across ${tags.length} tag(s)`);
    }

    const embedded = await anomalies.embedMissing();
    console.log(`anomalies: ${embedded} signature(s) embedded`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
