// vt-pbf ships no type declarations (and none exist on DefinitelyTyped).
// Only the one function the overzoom path uses is declared; layer values are
// geojson-vt tiles, typed structurally so this shim stays decoupled from
// geojson-vt's types.
declare module 'vt-pbf' {
  export function fromGeojsonVt(
    layers: Record<string, { features: unknown[] }>,
    options?: { version?: number; extent?: number }
  ): Uint8Array;
}
