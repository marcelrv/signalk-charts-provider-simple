/**
 * Tests for serve-time overzoom synthesis from vector MBTiles.
 *
 * The fixture (create-test-vector-mbtiles.cjs) advertises minzoom=2,
 * maxzoom=16 but contains only four tiles: z2 (0,1) with 'test-buoy' (id 42)
 * + an `areas` polygon, z3 (0,3) with 'z3-buoy' (id 43) at the same lon/lat,
 * z8 (56,86) with 'z8-buoy' (id 88) far away, and a corrupt-gzip z2 (1,1).
 * That reproduces the pyramid holes of a combined NOAA chart set: deep
 * requests inside coverage must synthesize from the NEAREST ancestor,
 * requests outside coverage must keep returning null (→ 404).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import type { Feature, Point } from 'geojson';

import { MBTilesReader } from '../dist/utils/mbtiles-reader.js';
import {
  getOverzoomedTile,
  MAX_OVERZOOM_DELTA,
  _overzoomCacheStats
} from '../dist/utils/tile-overzoom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VECTOR_MBTILES = path.join(__dirname, '..', 'test', 'fixtures', 'test-vector-chart.mbtiles');
const RASTER_MBTILES = path.join(__dirname, '..', 'test', 'fixtures', 'test-chart.mbtiles');

const POINT_LON = -157.9;
const POINT_LAT = 21.4;
const DEEP_LON = -100;
const DEEP_LAT = 50;
// One MVT extent unit at z3 ≈ 0.011°; allow generous slack for geojson-vt
// rounding on top of quantization.
const TOLERANCE_DEG = 0.05;

function decode(tile: Buffer): VectorTile {
  assert.strictEqual(tile[0], 0x1f, 'synthesized tile must be gzipped');
  assert.strictEqual(tile[1], 0x8b, 'synthesized tile must be gzipped');
  return new VectorTile(new Pbf(gunzipSync(tile)));
}

function pointCoords(vt: VectorTile, x: number, y: number, z: number): [number, number] {
  const geo = vt.layers.points.feature(0).toGeoJSON(x, y, z) as Feature<Point>;
  return [geo.geometry.coordinates[0], geo.geometry.coordinates[1]];
}

describe('getOverzoomedTile()', () => {
  let reader!: MBTilesReader;

  before(() => {
    reader = new MBTilesReader(VECTOR_MBTILES);
  });

  after(() => {
    reader?.close();
  });

  it('synthesizes a child tile one level below the ancestor', () => {
    const tile = getOverzoomedTile(reader, 3, 0, 3);
    assert.ok(tile, 'child quadrant containing the point should synthesize');

    const vt = decode(tile);
    assert.ok(vt.layers.points, 'points layer should survive re-slicing');
    assert.ok(vt.layers.areas, 'areas layer should survive re-slicing');
    assert.strictEqual(vt.layers.points.version, 2, 'must emit MVT v2 like tippecanoe');

    const feature = vt.layers.points.feature(0);
    assert.strictEqual(feature.id, 42, 'feature id should survive');
    assert.strictEqual(feature.properties.name, 'test-buoy');
    assert.strictEqual(feature.properties.kind, 'buoy');

    const [lon, lat] = pointCoords(vt, 0, 3, 3);
    assert.ok(
      Math.abs(lon - POINT_LON) < TOLERANCE_DEG,
      `lon should round-trip (got ${lon}, want ~${POINT_LON})`
    );
    assert.ok(
      Math.abs(lat - POINT_LAT) < TOLERANCE_DEG,
      `lat should round-trip (got ${lat}, want ~${POINT_LAT})`
    );
  });

  it('slices from the NEAREST ancestor, not just any', () => {
    // z4 (0,7) has two candidate ancestors: z3 (0,3) and z2 (0,1). The z3
    // tile must win — it carries 'z3-buoy' and has no `areas` layer.
    const tile = getOverzoomedTile(reader, 4, 0, 7);
    assert.ok(tile, 'z4 child should synthesize');

    const vt = decode(tile);
    const feature = vt.layers.points.feature(0);
    assert.strictEqual(feature.properties.name, 'z3-buoy', 'must slice from z3, not z2');
    assert.strictEqual(feature.id, 43);
    assert.strictEqual(vt.layers.areas, undefined, 'z2 content must not leak in');

    const [lon, lat] = pointCoords(vt, 0, 7, 4);
    assert.ok(Math.abs(lon - POINT_LON) < TOLERANCE_DEG);
    assert.ok(Math.abs(lat - POINT_LAT) < TOLERANCE_DEG);
  });

  it('synthesizes deep targets (z15) — pins the geojson-vt maxZoom option', () => {
    // geojson-vt's DEFAULT maxZoom is 14: without the explicit maxZoom: 24 in
    // buildAncestorEntry, any synthesis target deeper than z14 silently
    // returns null. Real combined sets advertise maxzoom 16+, so this is the
    // production shape: z15 request, nearest ancestor at z8 (delta 7).
    const tile = getOverzoomedTile(reader, 15, 7281, 11113);
    assert.ok(tile, 'z15 child of the z8 ancestor should synthesize');

    const vt = decode(tile);
    const feature = vt.layers.points.feature(0);
    assert.strictEqual(feature.properties.name, 'z8-buoy');
    assert.strictEqual(feature.id, 88);

    const [lon, lat] = pointCoords(vt, 7281, 11113, 15);
    assert.ok(Math.abs(lon - DEEP_LON) < TOLERANCE_DEG);
    assert.ok(Math.abs(lat - DEEP_LAT) < TOLERANCE_DEG);
  });

  it('returns null for empty sibling quadrants of an existing ancestor', () => {
    assert.strictEqual(getOverzoomedTile(reader, 3, 1, 3), null);
    assert.strictEqual(getOverzoomedTile(reader, 3, 0, 2), null);
    assert.strictEqual(getOverzoomedTile(reader, 3, 1, 2), null);
  });

  it('returns null outside ancestor coverage', () => {
    assert.strictEqual(getOverzoomedTile(reader, 3, 7, 7), null);
  });

  it('returns null at or below minzoom', () => {
    assert.strictEqual(getOverzoomedTile(reader, 2, 0, 1), null);
    assert.strictEqual(getOverzoomedTile(reader, 1, 0, 0), null);
  });

  it('synthesizes up to MAX_OVERZOOM_DELTA levels and no further', () => {
    // The S-57 pipeline can combine band 1 (ceiling z8) with band 6 (z18),
    // so the cap must span at least 10 levels.
    assert.strictEqual(MAX_OVERZOOM_DELTA, 10);
    // z13 (502,3597) → nearest ancestor z3 (0,3), delta exactly 10.
    const within = getOverzoomedTile(reader, 13, 502, 3597);
    assert.ok(within, 'delta 10 should synthesize');
    const vt = decode(within);
    assert.strictEqual(vt.layers.points.feature(0).properties.name, 'z3-buoy');
    // z14 (1005,7194) would need delta 11 to reach z3.
    assert.strictEqual(getOverzoomedTile(reader, 14, 1005, 7194), null);
  });

  it('degrades to null (not a throw) on a corrupt ancestor', () => {
    // z2 (1,1) holds gzip magic followed by garbage.
    let result: Buffer | null = null;
    assert.doesNotThrow(() => {
      result = getOverzoomedTile(reader, 3, 2, 2);
    });
    assert.strictEqual(result, null);
  });

  it('caches synthesized tiles, nulls, and ancestor indexes per reader', () => {
    const fresh = new MBTilesReader(VECTOR_MBTILES);
    try {
      const rawCalls: Array<[number, number, number]> = [];
      const realGetRawTile = fresh.getRawTile.bind(fresh);
      fresh.getRawTile = (z: number, x: number, y: number) => {
        rawCalls.push([z, x, y]);
        return realGetRawTile(z, x, y);
      };

      const first = getOverzoomedTile(fresh, 3, 0, 3);
      assert.ok(first);
      assert.deepStrictEqual(rawCalls, [[2, 0, 1]], 'first synthesis reads the ancestor once');

      const repeat = getOverzoomedTile(fresh, 3, 0, 3);
      assert.strictEqual(repeat, first, 'repeat request returns the cached Buffer instance');
      assert.strictEqual(rawCalls.length, 1, 'repeat request does no raw reads');

      assert.ok(getOverzoomedTile(fresh, 4, 0, 7));
      assert.deepStrictEqual(
        rawCalls,
        [
          [2, 0, 1],
          [3, 0, 3]
        ],
        'a different ancestor is read once, the z2 index is not re-read'
      );

      assert.strictEqual(getOverzoomedTile(fresh, 4, 0, 6), null, 'empty quadrant of z3');
      assert.strictEqual(
        rawCalls.length,
        2,
        'empty quadrant slices from the cached index without raw reads'
      );

      const stats = _overzoomCacheStats(fresh);
      assert.strictEqual(stats.indexes, 2, 'both ancestor indexes cached');
      assert.strictEqual(stats.tiles, 3, 'two tiles plus one null cached');

      assert.strictEqual(getOverzoomedTile(fresh, 4, 0, 6), null);
      assert.strictEqual(rawCalls.length, 2, 'null results are cached too');
      assert.deepStrictEqual(_overzoomCacheStats(fresh), stats);
    } finally {
      fresh.close();
    }
  });

  it('returns null for raster charts (overzoom is pbf-only)', () => {
    const raster = new MBTilesReader(RASTER_MBTILES);
    try {
      assert.strictEqual(raster.getInfo().format, 'png');
      assert.strictEqual(getOverzoomedTile(raster, 3, 0, 0), null);
    } finally {
      raster.close();
    }
  });
});
