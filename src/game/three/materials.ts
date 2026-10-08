import * as THREE from "three";
import { discTexture } from "./textures";

/**
 * Shared materials and the shader patches every lit object gets:
 *
 * - **Fog of war**: one (w+2)×(h+2) texture, a texel per tile, sampled by
 *   world position in every fogged material (terrain, models, trees, decals)
 *   and blended toward the fog colour — so the battlefield darkens under the
 *   fog exactly like the old 2D overlay did, but on 3D surfaces.
 * - **Cloud shadows**: a tiling noise texture drifting over the world.
 * - **Model shading**: vertex-coloured, flat-shaded models with a per-vertex
 *   glow attribute (lights, engines, crystals), and uniform variants for the
 *   hit flash, burnt wrecks, damaged buildings, elite shimmer and placement
 *   ghosts — variants share one shader program, so swapping is cheap.
 */

export const FOW_COLOR = 0x06090f;

export const fowUniforms = {
  uFowMap: { value: null as THREE.Texture | null },
  uFowSize: { value: new THREE.Vector2(1, 1) },
  uFowOn: { value: 1 },
  uFowColor: { value: new THREE.Color(FOW_COLOR) },
  uCloudMap: { value: null as THREE.Texture | null },
  uCloudOffset: { value: new THREE.Vector2() },
  uCloudK: { value: 0.3 },
  uTime: { value: 0 }
};

const VERT_DECL = /* glsl */ `
varying vec3 vFowW;
`;
const VERT_CODE = /* glsl */ `
  {
    vec4 fowW = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      fowW = instanceMatrix * fowW;
    #endif
    vFowW = ( modelMatrix * fowW ).xyz;
  }
`;
const FRAG_DECL = /* glsl */ `
varying vec3 vFowW;
uniform sampler2D uFowMap;
uniform vec2 uFowSize;
uniform float uFowOn;
uniform vec3 uFowColor;
uniform sampler2D uCloudMap;
uniform vec2 uCloudOffset;
uniform float uCloudK;
uniform float uTime;
float fowAt( vec2 p ) { return texture2D( uFowMap, ( p + 1.0 ) / uFowSize ).r; }
`;
const fragCode = (clouds: boolean) => /* glsl */ `
  {
    vec2 fp = vFowW.xz;
    float fw = fowAt( fp );
    fw = fw * fw * ( 3.0 - 2.0 * fw );
    ${clouds ? "float cl = texture2D( uCloudMap, fp * 0.032 + uCloudOffset ).r; gl_FragColor.rgb *= 1.0 - cl * uCloudK;" : ""}
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uFowColor, fw * uFowOn );
  }
`;

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Patch a material so the fog of war (and optionally cloud shadows) darken it. */
export function fogged<T extends THREE.Material>(
  m: T,
  o: { clouds?: boolean; key?: string; also?: (s: Shader) => void } = {}
): T {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fowUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_DECL}`)
      .replace("#include <fog_vertex>", `#include <fog_vertex>\n${VERT_CODE}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_DECL}`)
      .replace("#include <fog_fragment>", `#include <fog_fragment>\n${fragCode(o.clouds ?? true)}`);
    o.also?.(shader);
  };
  m.customProgramCacheKey = () => `fow:${o.clouds ?? true}:${o.key ?? ""}`;
  return m;
}

// ---------------------------------------------------------------- models --

export type Variant = "normal" | "flash" | "warm" | "burnt" | "damaged" | "elite" | "ghostOk" | "ghostBad";

interface VariantSpec {
  tint: number;
  flash: number;
  flashColor: number;
  glow: number;
  /** How far the flash also bleaches the diffuse colour. */
  bleach?: number;
  ghost?: boolean;
}

const VARIANTS: Record<Variant, VariantSpec> = {
  normal: { tint: 0xffffff, flash: 0, flashColor: 0xffffff, glow: 1 },
  flash: { tint: 0xffffff, flash: 0.85, flashColor: 0xffffff, glow: 1 },
  warm: { tint: 0xffffff, flash: 0.35, flashColor: 0xffc890, glow: 1 },
  burnt: { tint: 0x4a4440, flash: 0, flashColor: 0x000000, glow: 0 },
  damaged: { tint: 0xb0a89f, flash: 0, flashColor: 0x000000, glow: 0.6 },
  elite: { tint: 0xffffff, flash: 0.12, flashColor: 0xffb020, glow: 1.2, bleach: 0 },
  ghostOk: { tint: 0xb8ffc8, flash: 0.35, flashColor: 0x37d67a, glow: 1, ghost: true },
  ghostBad: { tint: 0xff9090, flash: 0.45, flashColor: 0xe25555, glow: 1, ghost: true }
};

/** The elite shimmer's strength (animated by the entity renderer). */
export const eliteUniform = { value: 0.12 };

function modelMaterial(v: VariantSpec, elite: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.58,
    metalness: 0.35,
    side: THREE.DoubleSide,
    transparent: !!v.ghost,
    opacity: v.ghost ? 0.6 : 1,
    depthWrite: !v.ghost
  });
  const tint = { value: new THREE.Color(v.tint) };
  const flash = elite ? eliteUniform : { value: v.flash };
  const flashColor = { value: new THREE.Color(v.flashColor) };
  const glowK = { value: v.glow };
  const bleach = { value: v.bleach ?? 0.5 };
  return fogged(m, {
    key: `model${v.ghost ? "g" : ""}`,
    also: (s) => {
      s.uniforms.uTint = tint;
      s.uniforms.uFlash = flash;
      s.uniforms.uFlashColor = flashColor;
      s.uniforms.uGlowK = glowK;
      s.uniforms.uBleach = bleach;
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;")
        .replace("#include <color_vertex>", "#include <color_vertex>\nvGlow = glow;");
      s.fragmentShader = s.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vGlow;\nuniform vec3 uTint;\nuniform float uFlash;\nuniform vec3 uFlashColor;\nuniform float uGlowK;\nuniform float uBleach;"
        )
        .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= uTint;")
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlowK * 2.4;
          totalEmissiveRadiance = mix( totalEmissiveRadiance, uFlashColor, uFlash );
          diffuseColor.rgb = mix( diffuseColor.rgb, uFlashColor, uFlash * uBleach );`
        );
    }
  });
}

let modelMats: Record<Variant, THREE.MeshStandardMaterial> | null = null;

/** The shared model material for a variant. */
export function modelMat(v: Variant = "normal"): THREE.MeshStandardMaterial {
  if (!modelMats) {
    const out = {} as Record<Variant, THREE.MeshStandardMaterial>;
    for (const k of Object.keys(VARIANTS) as Variant[]) out[k] = modelMaterial(VARIANTS[k], k === "elite");
    modelMats = out;
  }
  return modelMats[v];
}

/** Swap every swappable mesh under `root` to a material variant. */
export function setVariant(root: THREE.Object3D, v: Variant): void {
  const mat = modelMat(v);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.model) (o as THREE.Mesh).material = mat;
  });
}

// ------------------------------------------------------------- unlit fx --

/** An additive, unlit, fog-free material (beams, glows, tracers). */
export function glowMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false
  });
}

/** An additive soft disc (light pools, loot glow, beacons): use on a flat quad. */
export function discMat(color: number, opacity = 1): THREE.MeshBasicMaterial {
  const m = glowMat(color, opacity);
  m.map = discTexture();
  return m;
}
