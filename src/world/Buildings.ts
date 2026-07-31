import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * The city's buildings, with procedurally lit windows.
 *
 * The window pattern is computed in the shader from two per-vertex values the
 * pipeline supplies — wall-space UVs in metres, and a per-building seed — rather
 * than from textures. That matters for more than memory: a texture would have to
 * be scaled per building to keep floor heights consistent, and would tile
 * visibly across a 190 m tower. Deriving windows from real metres means every
 * building in the city shares one material and one draw call, while floors line
 * up at a believable height on all of them.
 *
 * This is the single effect that makes the night look work: the city has to
 * light itself.
 */

export interface BuildingMeshes {
  mesh: THREE.Mesh;
  vertexCount: number;
  triangleCount: number;
  chunkCount: number;
}

/** Storey height in metres — sets the vertical window rhythm. */
const FLOOR_HEIGHT = 3.6;
/** Horizontal window pitch in metres. */
const WINDOW_PITCH = 3.1;
/** Fraction of windows lit at night. */
const LIT_FRACTION = 0.55;

/**
 * Decodes the layout written by `tools/build-world.ts`:
 * `[u32 vertexCount, u32 indexCount, u32 chunkCount]`
 * `[f32 positions][f32 uvs][f32 seeds][u32 indices][i32 chunks×4]`
 */
export function buildBuildings(
  buffer: ArrayBuffer,
  physics?: { rapier: typeof RAPIER; world: RAPIER.World },
): BuildingMeshes {
  const header = new Uint32Array(buffer, 0, 3);
  const vertexCount = header[0]!;
  const indexCount = header[1]!;
  const chunkCount = header[2]!;

  let offset = 12;
  const positions = new Float32Array(buffer.slice(offset, offset + vertexCount * 3 * 4));
  offset += vertexCount * 3 * 4;
  const uvs = new Float32Array(buffer.slice(offset, offset + vertexCount * 2 * 4));
  offset += vertexCount * 2 * 4;
  const seeds = new Float32Array(buffer.slice(offset, offset + vertexCount * 4));
  offset += vertexCount * 4;
  const indices = new Uint32Array(buffer.slice(offset, offset + indexCount * 4));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('wallUv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // Wall quads do not share vertices with their neighbours, so averaged
  // normals still come out flat — which is what a building wants.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, createFacadeMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';

  // One static trimesh for the whole city. Rapier builds a BVH over it once at
  // load; because nothing here ever moves, queries stay cheap afterwards.
  if (physics) {
    const body = physics.world.createRigidBody(physics.rapier.RigidBodyDesc.fixed());
    physics.world.createCollider(
      physics.rapier.ColliderDesc.trimesh(positions, indices).setFriction(0.7),
      body,
    );
  }

  return { mesh, vertexCount, triangleCount: indexCount / 3, chunkCount };
}

function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0x1a1f2b,
    roughness: 0.72,
    metalness: 0.18,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms['uFloorHeight'] = { value: FLOOR_HEIGHT };
    shader.uniforms['uWindowPitch'] = { value: WINDOW_PITCH };
    shader.uniforms['uLitFraction'] = { value: LIT_FRACTION };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec2 wallUv;
         attribute float seed;
         varying vec2 vWallUv;
         varying float vSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWallUv = wallUv;
         vSeed = seed;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uFloorHeight;
         uniform float uWindowPitch;
         uniform float uLitFraction;
         varying vec2 vWallUv;
         varying float vSeed;

         float hash21(vec2 p) {
           vec3 p3 = fract(vec3(p.xyx) * 0.1031);
           p3 += dot(p3, p3.yzx + 33.33);
           return fract((p3.x + p3.y) * p3.z);
         }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // Seeds above 1 mark roof vertices: no windows up there.
           float isRoof = step(1.0, vSeed);
           float bSeed = fract(vSeed);

           // Window cell, in real metres, so floors line up across the city.
           vec2 grid = vec2(vWallUv.x / uWindowPitch, vWallUv.y / uFloorHeight);
           vec2 cell = floor(grid);
           vec2 f = fract(grid);

           // Glass occupies the middle of each cell, leaving spandrel around it.
           float inWindow =
             step(0.16, f.x) * step(f.x, 0.84) *
             step(0.30, f.y) * step(f.y, 0.86);

           // Ground floor is treated as street frontage, not offices.
           float aboveGround = step(1.6, vWallUv.y);

           float r = hash21(cell + bSeed * 137.0);
           float lit = step(1.0 - uLitFraction, r);

           // Vary brightness so a facade does not look like a checkerboard.
           float brightness = 0.45 + 0.55 * hash21(cell.yx + bSeed * 71.0);

           // Warm interiors mostly, some cooler fluorescent-looking floors.
           vec3 warm = vec3(1.00, 0.78, 0.46);
           vec3 cool = vec3(0.62, 0.79, 1.00);
           vec3 tint = mix(warm, cool, step(0.72, hash21(cell * 1.7 + bSeed * 23.0)));

           totalEmissiveRadiance +=
             tint * (inWindow * lit * aboveGround * (1.0 - isRoof) * brightness * 1.6);

           // Unlit glass still reads as glass: slightly darker than concrete.
           diffuseColor.rgb *= 1.0 - 0.35 * inWindow * (1.0 - lit) * (1.0 - isRoof);
         }`,
      );
  };

  return material;
}
