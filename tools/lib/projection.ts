/**
 * WGS84 (lon/lat) → UTM Zone 10N → game world metres.
 *
 * UTM 10N is used rather than a local tangent plane because every elevation
 * product the City publishes (the 2013 DEM, the 2022 LiDAR tiles) is already in
 * that projection — staying in it means those can be dropped in later without
 * re-registering anything.
 *
 * World axes follow three.js convention: +X east, +Y up, +Z **south**.
 */
import proj4 from 'proj4';
import { ORIGIN, BBOX } from '../config';

const WGS84 = 'EPSG:4326';
const UTM10N = '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs';

const project = proj4(WGS84, UTM10N);

export interface WorldPoint {
  x: number;
  z: number;
}

/** lon/lat → world metres relative to ORIGIN. */
export function toWorld(lon: number, lat: number): WorldPoint {
  const [easting, northing] = project.forward([lon, lat]) as [number, number];
  return {
    x: easting - ORIGIN.easting,
    // Northing grows north; +Z is south, hence the negation.
    z: -(northing - ORIGIN.northing),
  };
}

/** World metres → lon/lat. Used for the minimap and for debug output. */
export function toLonLat(x: number, z: number): { lon: number; lat: number } {
  const [lon, lat] = project.inverse([
    x + ORIGIN.easting,
    -z + ORIGIN.northing,
  ]) as [number, number];
  return { lon, lat };
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
}

/**
 * BBOX projected into world space.
 *
 * All four corners are projected rather than just two: UTM is conformal but not
 * axis-aligned with lon/lat, so the projected region is a slight quadrilateral
 * and taking only two corners would clip a sliver off the map.
 */
export function worldBounds(): WorldBounds {
  const corners = [
    toWorld(BBOX.minLon, BBOX.minLat),
    toWorld(BBOX.maxLon, BBOX.minLat),
    toWorld(BBOX.minLon, BBOX.maxLat),
    toWorld(BBOX.maxLon, BBOX.maxLat),
  ];
  const xs = corners.map((c) => c.x);
  const zs = corners.map((c) => c.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ };
}
