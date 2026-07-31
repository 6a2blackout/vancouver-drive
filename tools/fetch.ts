/**
 * Pulls every source layer from the City of Vancouver open data API into
 * `data/raw/`. Run with `npm run fetch` (add `--force` to ignore the cache).
 *
 * Everything here comes from the Opendatasoft Explore v2.1 API, which serves
 * plain GeoJSON over HTTPS with no key. Note that the two *raster* products —
 * the 2013 DEM and the raw LiDAR tiles — live on webtransfer.vancouver.ca
 * behind Cloudflare, which rejects scripted requests; those are manual browser
 * downloads and are deliberately not attempted here.
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, BBOX, LAYERS, bboxFilter, type Layer } from './config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'raw');

const FORCE = process.argv.includes('--force');
const MAX_RETRIES = 3;
/** Enough parallelism to be quick, low enough to stay a polite API citizen. */
const CONCURRENCY = 4;

interface FeatureCollection {
  type: 'FeatureCollection';
  features: Array<{ type: string; geometry: unknown; properties: Record<string, unknown> }>;
}

interface Result {
  layer: Layer;
  count: number;
  bytes: number;
  cached: boolean;
  error?: string;
}

function url(layer: Layer): string {
  const params = new URLSearchParams({
    where: bboxFilter(),
    select: layer.select.join(','),
  });
  return `${API_BASE}/${layer.id}/exports/geojson?${params}`;
}

async function fetchLayer(layer: Layer): Promise<Result> {
  const path = join(OUT_DIR, `${layer.id}.geojson`);

  if (!FORCE) {
    try {
      const info = await stat(path);
      const cached = JSON.parse(await readFile(path, 'utf8')) as FeatureCollection;
      return { layer, count: cached.features.length, bytes: info.size, cached: true };
    } catch {
      // Not cached, or unreadable — fall through and fetch it.
    }
  }

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url(layer), { headers: { Accept: 'application/geo+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const text = await res.text();
      const json = JSON.parse(text) as FeatureCollection;
      if (!Array.isArray(json.features)) throw new Error('response had no feature array');

      await writeFile(path, text);
      return { layer, count: json.features.length, bytes: text.length, cached: false };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  return { layer, count: 0, bytes: 0, cached: false, error: lastError };
}

/** Simple bounded-concurrency map, avoiding a dependency for one small need. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  console.log('Fetching City of Vancouver open data');
  console.log(`  bbox   ${BBOX.minLat}, ${BBOX.minLon} → ${BBOX.maxLat}, ${BBOX.maxLon}`);
  console.log(`  out    data/raw/${FORCE ? '   (--force: ignoring cache)' : ''}\n`);

  const results = await mapLimit(LAYERS, CONCURRENCY, async (layer) => {
    const r = await fetchLayer(layer);
    const status = r.error
      ? 'FAILED'
      : r.cached
        ? 'cached'
        : 'fetched';
    console.log(
      `  ${status.padEnd(8)} ${layer.id.padEnd(42)} ` +
      `${String(r.count).padStart(6)} features  ${kb(r.bytes).padStart(8)}` +
      (r.error ? `\n           └─ ${r.error}` : ''),
    );
    return r;
  });

  // --- Verification --------------------------------------------------------
  // A silently-empty layer is the failure mode that would waste the most time
  // later, so check counts against what the API returned when this was written.
  const problems: string[] = [];
  for (const r of results) {
    if (r.error) {
      problems.push(`${r.layer.id}: ${r.error}${r.layer.required ? ' (REQUIRED)' : ''}`);
      continue;
    }
    if (r.count === 0) {
      problems.push(`${r.layer.id}: returned zero features`);
      continue;
    }
    const exp = r.layer.expected;
    if (exp !== undefined) {
      const drift = Math.abs(r.count - exp) / exp;
      if (drift > 0.2) {
        problems.push(
          `${r.layer.id}: expected ~${exp} features, got ${r.count} ` +
          `(${(drift * 100).toFixed(0)}% drift — bbox or upstream data changed?)`,
        );
      }
    }
  }

  const total = results.reduce((a, r) => a + r.count, 0);
  console.log(`\n  ${total.toLocaleString()} features across ${results.length} layers`);

  if (problems.length > 0) {
    console.log('\nWarnings:');
    for (const p of problems) console.log(`  ! ${p}`);
  }

  const failedRequired = results.filter((r) => r.error && r.layer.required);
  if (failedRequired.length > 0) {
    console.error(`\nAborting: ${failedRequired.length} required layer(s) failed.`);
    process.exit(1);
  }
  console.log('\nDone. Next: npm run world\n');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
