import * as THREE from 'three';
import type { Heightmap } from './Heightmap';

/**
 * Builds the visible road surface from the generated `roads.bin`.
 *
 * The pipeline emits geometry with y = 0 and burns the matching corridors into
 * the terrain, so all that remains here is to lift each vertex onto the ground
 * it was flattened against. Roads carry no collider of their own — the car
 * drives on the terrain heightfield underneath.
 */

/**
 * How far the road sits above the terrain, in metres.
 *
 * Large enough to beat depth-buffer precision at distance, small enough that
 * the wheels do not visibly hover. The car's contact is with the terrain
 * below, so this offset is purely cosmetic.
 */
const ROAD_LIFT = 0.07;

export interface RoadMeshes {
  surface: THREE.Mesh;
  vertexCount: number;
  triangleCount: number;
}

/**
 * Decodes the binary layout written by `tools/build-world.ts`:
 * `[u32 vertexCount, u32 indexCount][f32 positions][f32 edgeOffset][u32 indices]`
 */
export function buildRoads(buffer: ArrayBuffer, heightmap: Heightmap): RoadMeshes {
  const header = new Uint32Array(buffer, 0, 2);
  const vertexCount = header[0]!;
  const indexCount = header[1]!;

  let offset = 8;
  const positions = new Float32Array(buffer.slice(offset, offset + vertexCount * 3 * 4));
  offset += vertexCount * 3 * 4;
  const edgeOffset = new Float32Array(buffer.slice(offset, offset + vertexCount * 4));
  offset += vertexCount * 4;
  const indices = new Uint32Array(buffer.slice(offset, offset + indexCount * 4));

  // Seat every vertex on the burned terrain.
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]!;
    const z = positions[i * 3 + 2]!;
    positions[i * 3 + 1] = heightmap.sample(x, z) + ROAD_LIFT;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Signed distance from the centreline, normalised. Kept for lane markings
  // and wet-road shading in Phase 5.
  geometry.setAttribute('edgeOffset', new THREE.BufferAttribute(edgeOffset, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const surface = new THREE.Mesh(geometry, createAsphaltMaterial());
  surface.receiveShadow = true;
  surface.name = 'roads';

  return { surface, vertexCount, triangleCount: indexCount / 3 };
}

/**
 * Wet night asphalt: dark, fairly smooth, quite metallic.
 *
 * The low roughness is doing the heavy lifting — it is what makes headlights
 * and street lamps streak along the road instead of falling on it flatly, and
 * that specular response is most of what reads as "wet" at night.
 */
function createAsphaltMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0x14171d,
    roughness: 0.34,
    metalness: 0.55,
  });

  // A faint centreline, derived from the edgeOffset attribute rather than a
  // texture, so it costs no memory and never mismatches the road width.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float edgeOffset;\nvarying float vEdge;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvEdge = edgeOffset;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEdge;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         // Brighten the very centre of the carriageway and darken the gutters.
         float centre = 1.0 - smoothstep(0.0, 0.06, abs(vEdge));
         float gutter = smoothstep(0.82, 1.0, abs(vEdge));
         gl_FragColor.rgb += vec3(0.16, 0.15, 0.11) * centre;
         gl_FragColor.rgb *= 1.0 - 0.35 * gutter;`,
      );
  };

  return material;
}
