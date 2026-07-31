/**
 * Authoring configuration for the world pipeline.
 *
 * Changing BBOX here and re-running `npm run fetch && npm run world` is the
 * whole procedure for growing the map — nothing downstream hard-codes an extent.
 */

/**
 * Downtown Vancouver peninsula: downtown core, West End, Coal Harbour,
 * Yaletown, Stanley Park, and a strip across False Creek.
 */
export const BBOX = {
  minLat: 49.26,
  minLon: -123.15,
  maxLat: 49.31,
  maxLon: -123.09,
} as const;

/**
 * World origin in UTM Zone 10N (EPSG:32610), near downtown.
 *
 * All source elevation data (the 2013 DEM and the LiDAR tiles) is published in
 * UTM 10N, so the game world uses it directly rather than a tangent-plane
 * approximation. World coordinates are metres relative to this point.
 */
export const ORIGIN = { easting: 491_000, northing: 5_459_000 } as const;

/**
 * Where the player starts. Robson & Burrard, in the middle of the downtown
 * grid — surrounded by towers, a short drive from Stanley Park, the seawall and
 * the bridges. The pipeline projects this and writes world coordinates into the
 * manifest so the runtime never needs a projection library.
 */
export const SPAWN = { lon: -123.1207, lat: 49.2856, headingDeg: 45 } as const;

/** Terrain heightmap sample spacing, in metres. */
export const TERRAIN_RESOLUTION = 4;

/** Edge length of a streaming chunk, in metres. */
export const CHUNK_SIZE = 250;

export const API_BASE = 'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets';

export interface Layer {
  /** Opendatasoft dataset id. */
  id: string;
  /** What this layer is for, in the game. */
  purpose: string;
  /** Fields to request. `geom` is always required for GeoJSON output. */
  select: string[];
  /**
   * Approximate feature count expected inside BBOX, verified against the live
   * API on 2026-07-31. A large deviation means the bbox, the filter or the
   * upstream dataset changed — `fetch.ts` warns rather than silently
   * producing an empty world.
   */
  expected?: number;
  /** If true, a fetch failure aborts the run. */
  required: boolean;
}

export const LAYERS: Layer[] = [
  {
    id: 'public-streets',
    purpose: 'Road centrelines — the backbone of the drivable network',
    select: ['hblock', 'streetuse', 'geom'],
    expected: 2123,
    required: true,
  },
  {
    id: 'one-way-streets',
    purpose: 'One-way flags for the road graph (needed by AI traffic later)',
    select: ['hblock', 'streetuse', 'geom'],
    expected: 268,
    required: false,
  },
  {
    id: 'lanes',
    purpose: 'Back alleys — narrow drivable connectors between blocks',
    select: ['std_street', 'geom'],
    required: false,
  },
  {
    id: 'non-city-streets',
    purpose:
      'Roads the City does not own — most importantly Stanley Park Drive and ' +
      'the causeway, which are absent from public-streets entirely',
    select: ['streetname', 'type', 'geom'],
    required: false,
  },
  {
    id: 'right-of-way-widths',
    purpose: 'Real road widths, refining the per-class defaults',
    select: ['width', 'geom'],
    required: false,
  },
  {
    id: 'street-intersections',
    purpose: 'Named junctions, used for the minimap and navigation',
    select: ['xstreet', 'geom'],
    required: false,
  },
  {
    id: 'traffic-signals',
    purpose: 'Real signal positions — props now, working lights in Phase 7',
    select: ['type', 'geom'],
    expected: 337,
    required: false,
  },
  {
    id: 'building-footprints-2009',
    purpose: 'Buildings, with LiDAR-derived heights already attached',
    select: ['topelev_m', 'baseelev_m', 'hgt_agl', 'rooftype', 'geom'],
    expected: 10660,
    required: true,
  },
  {
    id: 'elevation-contour-lines-1-metre-contours',
    purpose: 'Terrain source — rasterised into the heightmap',
    select: ['elevation', 'geom'],
    expected: 1256,
    required: true,
  },
  {
    id: 'shoreline-2002',
    purpose: 'Coastline, so the sea can be cut out of the terrain',
    select: ['geom'],
    required: false,
  },
  {
    id: 'parks-polygon-representation',
    purpose: 'Park areas — grass instead of asphalt, notably Stanley Park',
    select: ['park_name', 'classification', 'geom'],
    required: false,
  },
  {
    id: 'street-lighting-poles',
    purpose: 'Street lamps, rendered as instanced glows at night',
    select: ['geom'],
    expected: 12426,
    required: false,
  },
  {
    id: 'public-trees',
    purpose: 'Street trees, with real height and species',
    select: ['height_m', 'diameter_cm', 'genus_name', 'geom'],
    expected: 25013,
    required: false,
  },
];

/** ODSQL spatial filter matching BBOX. */
export function bboxFilter(): string {
  return `in_bbox(geom, ${BBOX.minLat}, ${BBOX.minLon}, ${BBOX.maxLat}, ${BBOX.maxLon})`;
}
