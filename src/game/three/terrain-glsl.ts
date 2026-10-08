import type * as THREE from "three";

/**
 * Shader patches for the terrain's own materials (on top of the fog-of-war
 * patch every lit material gets, see materials.ts):
 *
 * - **Ground**: a fine procedural grain, embossed from the north-west like
 *   the painted hillshade, so the painted art stays crisp close in; and the
 *   world past the map's edge (the mirrored skirt) dims, desaturates and
 *   fades into the sky colour, so the battlefield's bounds read at a glance.
 * - **Liquids**: water with lapping shore foam and sun glints; an icy sea
 *   of drifting floes; lava with a cooled crust cracking over glowing flows.
 *
 * All variation comes from uniforms, so every map shares the programs.
 */

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Declarations after the fog-of-war ones (they need its uniforms). */
const EDGE_DECL = /* glsl */ `
uniform sampler2D uTNoise;
uniform vec3 uFarColor;
uniform float uSkirt;
/** How far outside the map (tiles) a world point is; 0 inside. */
float bdOutside( vec2 p ) {
  vec2 o = max( -p, p - ( uFowSize - 2.0 ) );
  return length( max( o, 0.0 ) );
}
/** Out of bounds: a little darker and greyer right from the edge. */
vec3 bdDim( vec3 c, float od ) {
  float k = smoothstep( 0.0, 0.9, od );
  float l = dot( c, vec3( 0.3, 0.55, 0.15 ) );
  return mix( c, vec3( l ), k * 0.4 ) * ( 1.0 - k * 0.3 );
}
`;

/**
 * After everything, fog included: fade into the sky colour toward the skirt's end. (Under the
 * fog of war the skirt stays dark: off the map the fog texture clamps to its unexplored border.)
 */
const FAR_FADE = /* glsl */ `
  {
    float k = clamp( bdOutside( vFowW.xz ) / uSkirt, 0.0, 1.0 );
    k = 1.0 - ( 1.0 - k ) * ( 1.0 - k ) * ( 1.0 - k );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uFarColor, k );
  }
  #include <premultiplied_alpha_fragment>
`;

export interface EdgeUniforms {
  uTNoise: { value: THREE.Texture | null };
  /** The sky (clear) colour, sRGB-encoded like the final fragment. */
  uFarColor: { value: THREE.Color };
  /** Skirt width (tiles): fully faded there. */
  uSkirt: { value: number };
}

export interface GroundUniforms extends EdgeUniforms {
  /** Grain contrast, north-west emboss of the grain, sharpening of the paint. */
  uDetail: { value: THREE.Vector3 };
}

/** Patch the painted ground material (call from `fogged`'s `also`). */
export function patchGround(s: Shader, u: GroundUniforms): void {
  Object.assign(s.uniforms, u);
  s.fragmentShader = s.fragmentShader
    .replace("#include <fog_pars_fragment>", `#include <fog_pars_fragment>\n${EDGE_DECL}\nuniform vec3 uDetail;`)
    .replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
      {
        vec2 wp = vFowW.xz;
        #ifdef USE_MAP
          // unsharp mask: the paint minus a softer mip of itself, so close in it reads crisp, not smeared
          // (high rock is softened a little instead: its paint is busy enough under the crags)
          vec3 soft = texture2D( map, vMapUv, 1.5 ).rgb;
          float sharp = mix( uDetail.z, -0.5, smoothstep( 0.35, 0.8, vFowW.y ) );
          diffuseColor.rgb = max( diffuseColor.rgb + ( diffuseColor.rgb - soft ) * sharp, 0.0 );
        #endif
        // fine grain (on a grid turned off the tile axes, so its repeat never lines up), and the same
        // grain a hair to the south-east: their difference lights it from the north-west like the paint
        vec2 gp = mat2( 0.66, 0.29, -0.29, 0.66 ) * wp;
        float g0 = texture2D( uTNoise, gp ).r;
        float g1 = texture2D( uTNoise, gp + vec2( 0.0045, 0.0035 ) ).r;
        diffuseColor.rgb *= 1.0 + ( g0 - 0.5 ) * uDetail.x + ( g1 - g0 ) * uDetail.y;
        diffuseColor.rgb = bdDim( diffuseColor.rgb, bdOutside( wp ) );
      }`
    )
    .replace("#include <premultiplied_alpha_fragment>", FAR_FADE);
}

export interface LiquidUniforms extends EdgeUniforms {
  uShallow: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  /** 0 water, 1 lava, 2 icy sea. */
  uMode: { value: number };
  uWT: { value: number };
}

/** Patch the water / lava / ice surface material (call from `fogged`'s `also`). */
export function patchLiquid(s: Shader, u: LiquidUniforms): void {
  Object.assign(s.uniforms, u);
  s.vertexShader = s.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float aDepth;\nvarying float vDepth;\nvarying vec2 vXZ;\nuniform float uWT;")
    .replace(
      "#include <begin_vertex>",
      /* glsl */ `#include <begin_vertex>
      vDepth = aDepth;
      vXZ = position.xz;
      transformed.y += sin( position.x * 1.7 + uWT * 1.3 ) * 0.008 + cos( position.z * 1.3 + uWT * 1.1 ) * 0.008;`
    );
  s.fragmentShader = s.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vDepth;\nvarying vec2 vXZ;")
    .replace("#include <fog_pars_fragment>", `#include <fog_pars_fragment>\n${EDGE_DECL}\nuniform vec3 uShallow; uniform vec3 uDeep; uniform float uMode; uniform float uWT;`)
    .replace(
      "#include <color_fragment>",
      /* glsl */ `#include <color_fragment>
      float dk = smoothstep( 0.0, 0.32, vDepth );
      vec3 lavaGlow = vec3( 0.0 );
      vec3 wc;
      float alpha;
      if ( uMode < 0.5 ) {
        // open water: depth tint, slow swells, and a shoreline that laps in and out
        float n1 = texture2D( uTNoise, vXZ * 0.06 + vec2( uWT * 0.009, uWT * 0.005 ) ).r;
        float n2 = texture2D( uTNoise, vXZ * 0.11 - vec2( uWT * 0.007, -uWT * 0.011 ) ).g;
        float n = ( n1 + n2 ) * 0.5;
        wc = mix( uShallow, uDeep, dk ) * ( 0.84 + 0.32 * n );
        alpha = mix( 0.2, 0.9, dk );
        float lap = 0.045 + 0.02 * sin( uWT * 1.4 + n * 10.0 );
        float foam = ( 1.0 - smoothstep( 0.0, lap, vDepth ) ) * ( 0.55 + 0.45 * n );
        float line = ( 1.0 - smoothstep( 0.0, 0.03, abs( vDepth - lap - 0.045 ) ) ) * smoothstep( 0.45, 0.65, n2 );
        foam = max( foam, line * 0.4 );
        wc = mix( wc, vec3( 0.9, 0.95, 0.96 ), foam );
        alpha = max( alpha, foam * 0.8 );
      } else if ( uMode > 1.5 ) {
        // icy sea: a solid shelf over the shallows breaking up into drifting floes over the deep
        vec2 wq = texture2D( uTNoise, vXZ * 0.031 + 0.5 ).rg - 0.5;
        vec4 c = texture2D( uTNoise, vXZ * 0.074 + wq * 0.12 + vec2( uWT * 0.0016, uWT * 0.0009 ) );
        float n = texture2D( uTNoise, vXZ * 0.21 ).r;
        float deep = smoothstep( 0.1, 0.34, vDepth );
        // further out the leads between floes widen and more of the floes are gone
        float gap = mix( 0.012, 0.1, deep ) + ( n - 0.5 ) * 0.05;
        float has = 1.0 - smoothstep( 0.695, 0.705, c.a + deep * 0.24 );
        float plate = smoothstep( gap, gap + 0.025, c.b ) * has;
        float sunk = smoothstep( gap - 0.06, gap, c.b ) * has * ( 1.0 - plate );
        // the same a little toward the sun (north-west): a floe there shades this water
        vec4 c2 = texture2D( uTNoise, vXZ * 0.074 + wq * 0.12 + vec2( uWT * 0.0016, uWT * 0.0009 ) - vec2( 0.0055, 0.005 ) );
        float plate2 = smoothstep( gap, gap + 0.025, c2.b ) * ( 1.0 - smoothstep( 0.695, 0.705, c2.a + deep * 0.24 ) );
        float shade = plate2 * ( 1.0 - plate );
        // each floe: snow-dusted in its middle, glassy blue toward its broken edge, hairline cracks
        float inner = smoothstep( gap, gap + 0.32, c.b );
        float crack = 1.0 - smoothstep( 0.0, 0.025, texture2D( uTNoise, vXZ * 0.23 + wq * 0.3 ).b );
        vec3 water = mix( uShallow * 0.5, uDeep, dk ) * ( 0.8 + 0.4 * n ) * ( 1.0 - shade * 0.4 );
        vec3 ice = mix( vec3( 0.55, 0.73, 0.87 ), vec3( 0.92, 0.96, 1.0 ), smoothstep( 0.2, 0.75, inner * 0.85 + ( n - 0.5 ) * 0.7 ) );
        ice *= 1.0 - crack * 0.2 * inner;
        // (and its sunward, north-west rim catches the light)
        ice = mix( ice, vec3( 1.0 ), ( 1.0 - plate2 ) * 0.5 );
        // (submerged ice shows pale cyan just under the surface at each floe's edge)
        wc = mix( mix( water, vec3( 0.42, 0.66, 0.78 ), sunk * 0.6 ), ice, plate );
        // (the shelf over the shallows lets the painted ford show through a little)
        alpha = mix( mix( 0.45, 0.93, dk ), mix( 0.82, 0.97, deep ), max( plate, sunk * 0.5 ) );
      } else {
        // lava: molten rock streaked yellow-hot along the flow, under drifting crust — torn,
        // uneven plates (a warped cell pattern), fewer and smaller where it runs hot
        vec2 flow = vec2( uWT * 0.012, uWT * 0.007 );
        float h1 = texture2D( uTNoise, vXZ * 0.045 - flow * 0.6 ).r;
        vec2 h2 = texture2D( uTNoise, vXZ * 0.17 + flow * 1.7 ).rg;
        float heat = clamp( h1 * 0.85 + h2.x * 0.4 - 0.2, 0.0, 1.0 );
        // (it cools toward the banks: more crust there)
        float cool = 1.0 - smoothstep( 0.04, 0.3, vDepth );
        vec4 c = texture2D( uTNoise, vXZ * 0.095 + flow + ( h2 - 0.5 ) * 0.07 );
        float rag = texture2D( uTNoise, vXZ * 0.7 + flow ).r - 0.5;
        float has = 1.0 - smoothstep( 0.42, 0.5, c.a * 0.55 + heat * 0.75 - cool * 0.35 );
        float crust = smoothstep( 0.1, 0.13, c.b + ( h2.y - 0.5 ) * 0.08 + rag * 0.07 ) * has;
        // yellow-hot veins wind along the flow (contours of the churn), in the hottest runs
        float vein = ( 1.0 - smoothstep( 0.0, 0.07, abs( h2.y - 0.5 ) ) ) * smoothstep( 0.35, 0.7, heat );
        vec3 open = mix( uDeep * ( 0.6 + 0.35 * heat ), uShallow, max( vein * 0.65, smoothstep( 0.7, 1.0, heat ) * 0.5 ) );
        // the crust glows where it's thin — round its rim and along the cracks splitting it
        float edge = 1.0 - smoothstep( 0.1, 0.26, c.b + rag * 0.07 );
        float split = 1.0 - smoothstep( 0.0, 0.05, texture2D( uTNoise, vXZ * 0.26 - flow * 0.5 + ( h2 - 0.5 ) * 0.1 ).b );
        vec3 seep = uDeep * ( 0.02 + 0.85 * edge * edge + 0.6 * split );
        lavaGlow = mix( open, seep, crust );
        lavaGlow *= ( smoothstep( 0.0, 0.08, vDepth ) * 0.7 + 0.3 ) * ( 1.0 - smoothstep( 0.0, 0.9, bdOutside( vXZ ) ) * 0.35 );
        wc = mix( vec3( 0.008, 0.005, 0.004 ), vec3( 0.022, 0.015, 0.012 ) * ( 0.7 + 0.6 * h2.x ), crust );
        alpha = 1.0;
      }
      diffuseColor = vec4( bdDim( wc, bdOutside( vXZ ) ), alpha );`
    )
    .replace(
      "#include <normal_fragment_maps>",
      /* glsl */ `#include <normal_fragment_maps>
      if ( uMode < 0.5 ) {
        // wind ripples tilt the surface so the sun glints off it in soft drifting patches
        vec2 t1 = texture2D( uTNoise, vXZ * 0.19 + vec2( uWT * 0.02, uWT * 0.013 ) ).rg;
        vec2 t2 = texture2D( uTNoise, vXZ * 0.13 - vec2( uWT * 0.016, -uWT * 0.022 ) ).gr;
        vec2 tilt = ( t1 + t2 - 1.0 ) * 0.2;
        normal = normalize( normal + ( viewMatrix * vec4( tilt.x, 0.0, tilt.y, 0.0 ) ).xyz );
      }`
    )
    .replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n      if ( uMode > 0.5 && uMode < 1.5 ) totalEmissiveRadiance = lavaGlow;"
    )
    .replace("#include <premultiplied_alpha_fragment>", FAR_FADE);
}
