/**
 * Serve-time overzoom fallback for vector (pbf) MBTiles.
 *
 * Chart sets combined from multiple ENC bands (tippecanoe + tile-join) have
 * spatially varying max zoom: in areas covered only by a low band, tiles for
 * the advertised deeper zooms don't exist, so clients render black instead of
 * overzooming (OpenLayers/MapLibre only overzoom past the advertised maxzoom,
 * never for mid-pyramid holes). When a pbf tile is missing, this module walks
 * up the ancestor pyramid and re-slices the nearest existing ancestor MVT into
 * the requested child tile — lossless for vector data, so clients render it
 * exactly like native overzoom.
 *
 * Nothing is written back to the MBTiles; synthesis is on demand with two
 * in-memory LRUs per reader. The first miss touching an ancestor pays one
 * decode+index (~30–300 ms); further children of the same ancestor are served
 * from cache in ~1 ms.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import geojsonvt from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import type { Feature } from 'geojson';
import type { MBTilesReader } from './mbtiles-reader.js';

// Must span the band ceilings the S-57 pipeline can combine: BAND_MAX_ZOOM
// runs z8 (band 1) to z18 (band 6), so a band-1-only area of a full-district
// set needs delta 10 at the deepest advertised zoom. Walk cost doesn't scale
// with delta (one indexed SELECT per probe).
export const MAX_OVERZOOM_DELTA = 10;

// geojson-vt indexes keep growing after construction: every getTile() caches
// the intermediate tiles it materializes and never evicts. Measured on the
// largest hole-adjacent ancestor in a real combined set (157 KB gzipped MVT):
// ~7 MB at build, ~15 MB after a 60-tile pan. Typical band-edge ancestors are
// ≤70 KB (~2 MB indexes). The caps below bound the worst case to tens of MB:
// 4 index slots, and each entry is dropped (rebuilt on next miss) after
// INDEX_SLICE_BUDGET slices so a long pan can't grow one entry unboundedly.
const INDEX_CACHE_SIZE = 4;
const INDEX_SLICE_BUDGET = 64;

// Stored (gzipped) ancestors beyond this size would index into hundreds of MB
// (tippecanoe runs with --no-tile-size-limit). Real hole-adjacent ancestors
// measure ≤160 KB; anything bigger keeps today's 404 rather than risking an
// OOM on small-RAM hosts.
const MAX_ANCESTOR_BYTES = 256 * 1024;

const TILE_CACHE_SIZE = 256;

class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) {
      return undefined;
    }
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
      }
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

interface AncestorEntry {
  // One geojson-vt index per source layer; empty when the ancestor was
  // skipped as oversized (children then resolve to null/404 naturally).
  indexes: Map<string, ReturnType<typeof geojsonvt>>;
  slices: number;
}

interface OverzoomState {
  indexes: LruMap<string, AncestorEntry>;
  // Cached nulls matter: empty ocean quadrants inside ancestor coverage get
  // hammered while panning and must not re-slice on every request.
  tiles: LruMap<string, Buffer | null>;
}

// Keyed by reader instance: chart reload/rename/delete builds fresh readers,
// so stale entries are unreachable and collected without explicit eviction.
const states = new WeakMap<MBTilesReader, OverzoomState>();

function getState(reader: MBTilesReader): OverzoomState {
  let state = states.get(reader);
  if (!state) {
    state = {
      indexes: new LruMap(INDEX_CACHE_SIZE),
      tiles: new LruMap(TILE_CACHE_SIZE)
    };
    states.set(reader, state);
  }
  return state;
}

/** Test hook: cache occupancy for a reader (entries, not bytes). */
export function _overzoomCacheStats(reader: MBTilesReader): { indexes: number; tiles: number } {
  const state = states.get(reader);
  return { indexes: state?.indexes.size ?? 0, tiles: state?.tiles.size ?? 0 };
}

function buildAncestorEntry(raw: Buffer, az: number, ax: number, ay: number): AncestorEntry {
  const indexes: AncestorEntry['indexes'] = new Map();

  if (raw.byteLength > MAX_ANCESTOR_BYTES) {
    console.warn(
      `Overzoom: ancestor tile ${az}/${ax}/${ay} is ${raw.byteLength} bytes ` +
        `(> ${MAX_ANCESTOR_BYTES}); descendants keep returning 404`
    );
    return { indexes, slices: 0 };
  }

  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const tile = new VectorTile(new Pbf(bytes));

  for (const [name, layer] of Object.entries(tile.layers)) {
    if (layer.length === 0) {
      continue;
    }
    const features: Feature[] = [];
    for (let i = 0; i < layer.length; i++) {
      features.push(layer.feature(i).toGeoJSON(ax, ay, az));
    }
    indexes.set(
      name,
      // maxZoom: 24 is required — geojson-vt's default of 14 makes getTile()
      // silently return null for deeper children. tolerance 3 (the default)
      // simplifies the intermediate drill-down tiles; at the requested zoom
      // it is ~3/4096 of a tile, below what the ancestor's own quantization
      // already lost, and it nearly halves index memory vs tolerance 0.
      geojsonvt(
        { type: 'FeatureCollection', features },
        { maxZoom: 24, indexMaxZoom: 0, tolerance: 3, buffer: 64, extent: 4096 }
      )
    );
  }

  return { indexes, slices: 0 };
}

/**
 * Synthesize a missing pbf tile from the nearest existing ancestor.
 * Returns a gzipped MVT buffer, or null when the chart is not pbf, the
 * nearest ancestor is more than MAX_OVERZOOM_DELTA levels up (or none exists
 * at all — genuinely outside coverage), or the child quadrant is empty — all
 * of which should keep today's 404.
 */
export function getOverzoomedTile(
  reader: MBTilesReader,
  z: number,
  x: number,
  y: number
): Buffer | null {
  try {
    const info = reader.getInfo();
    if (info.format !== 'pbf') {
      return null;
    }
    const minzoom = info.minzoom ?? 0;
    if (z <= minzoom) {
      return null;
    }

    const state = getState(reader);
    const tileKey = `${z}/${x}/${y}`;
    const cached = state.tiles.get(tileKey);
    if (cached !== undefined) {
      return cached;
    }

    // Levels above the advertised maxzoom hold no tiles; start probing below.
    const maxzoom = info.maxzoom ?? z - 1;
    const dStart = Math.max(1, z - maxzoom);

    let entry: AncestorEntry | undefined;
    let entryKey = '';
    for (let d = dStart; d <= MAX_OVERZOOM_DELTA; d++) {
      const az = z - d;
      if (az < minzoom) {
        break;
      }
      const ax = x >> d;
      const ay = y >> d;
      entryKey = `${az}/${ax}/${ay}`;
      entry = state.indexes.get(entryKey);
      if (entry) {
        break;
      }
      const raw = reader.getRawTile(az, ax, ay);
      if (raw) {
        entry = buildAncestorEntry(raw, az, ax, ay);
        state.indexes.set(entryKey, entry);
        break;
      }
    }

    if (!entry) {
      state.tiles.set(tileKey, null);
      return null;
    }

    const layers: Record<string, { features: unknown[] }> = {};
    let hasFeatures = false;
    for (const [name, index] of entry.indexes) {
      const sliced = index.getTile(z, x, y);
      if (sliced && sliced.features.length > 0) {
        layers[name] = sliced;
        hasFeatures = true;
      }
    }

    // geojson-vt retains every intermediate tile a slice materializes, so an
    // entry grows with use; retire it after a budget of slices and let the
    // next miss rebuild it fresh (already-synthesized children stay cached).
    entry.slices++;
    if (entry.slices >= INDEX_SLICE_BUDGET) {
      state.indexes.delete(entryKey);
    }

    if (!hasFeatures) {
      state.tiles.set(tileKey, null);
      return null;
    }

    // version: 2 is required — vt-pbf defaults to MVT v1, tippecanoe emits v2.
    const encoded = fromGeojsonVt(layers, { version: 2, extent: 4096 });
    const result = gzipSync(encoded);
    state.tiles.set(tileKey, result);
    return result;
  } catch (err) {
    // A corrupt ancestor must degrade to 404, never bubble into the route's
    // 500 path. Not cached so a transient failure can recover.
    console.error(`Error synthesizing overzoom tile ${z}/${x}/${y}:`, err);
    return null;
  }
}
