import type * as THREE from "three";

/**
 * Shader patches for the terrain's own materials (on top of the fog-of-war
 * patch every lit material gets, see materials.ts):
 *
 * - **Ground**: a fine procedural grain, embossed from the north-west like
 *   the painted hillshade, so the painted art stays crisp close in; and the
 *   world past the map's edge (the skirt) dims and greys, so the
 *   battlefield's bounds read at a glance, its mirrored paint blurring into
 *   the biome's open ground within a few tiles and fading into the sky.
 *   Where the outcrops' heightfield turns steep the draped paint would smear
 *   into streaks, so their cliff walls (on the rock tiles only: the slope's
 *   foot on the ground beyond keeps its paint) fade to the biome's rock
 *   material itself (the texture the painter used for the outcrops),
 *   projected sideways in world space: real stone, strata running level, in
 *   the colour of the painted rock around it.
 * - **Crags**: the same rock material projected in world space onto every
 *   facet along the axis it faces most, over the crag's own colour.
 * - **Liquids**: water with lapping shore foam and sun glints; an icy sea
 *   of drifting floes; lava with a cooled crust cracking over glowing flows.
 *   Past the edge the water and ice thin away within a few tiles.
 *
 * Under the fog of war the skirt shows exactly what's known of the map
 * tile it mirrors (its fog lookup is mirrored too), so it reveals nothing.
 *
 * All variation comes from uniforms, so every map shares the programs.
 */

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Declarations after the fog-of-war ones (they need its uniforms). */
const EDGE_DECL = /* glsl */ `
uniform sampler2D uTNoise;
uniform vec3 uFarColor;
uniform float uSkirt;
uniform float uNear;
/** How far outside the map (tiles) a world point is; 0 inside. */
float bdOutside( vec2 p ) {
  vec2 o = max( -p, p - ( uFowSize - 2.0 ) );
  return length( max( o, 0.0 ) );
}
/** The map point a point past the edge mirrors (the skirt is the map reflected across its edges). */
vec2 bdMirror( vec2 p ) {
  vec2 L = uFowSize - 2.0;
  return clamp( L - abs( abs( p ) - L ), vec2( 0.0 ), L );
}
/** Out of bounds: a little darker and greyer right from the edge. */
vec3 bdDim( vec3 c, float od ) {
  float k = smoothstep( 0.0, 0.9, od );
  float l = dot( c, vec3( 0.3, 0.55, 0.15 ) );
  return mix( c, vec3( l ), k * 0.4 ) * ( 1.0 - k * 0.3 );
}
`;

/** The fog of war past the edge: what's known of the map tile there mirrors. */
const FOG_LOOKUP = "fowAt( fp )";
const FOG_MIRRORED = "fowAt( bdMirror( fp ) )";

/** After everything, fog included: fade into the sky colour toward the skirt's end. */
const FAR_FADE = /* glsl */ `
  {
    float k = smoothstep( 0.0, uSkirt, bdOutside( vFowW.xz ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uFarColor, k );
  }
  #include <premultiplied_alpha_fragment>
`;

/** The rock material (declared after the fog-of-war ones). */
const ROCK_DECL = /* glsl */ `
uniform sampler2D uRock;
uniform vec3 uRockNorm;
uniform vec4 uRockK;
/**
 * The rock material's mip level for a footprint whose screen derivatives (in texture repeats) are dx, dy:
 * one level for every fetch (explicit, so the fetches can sit in branches and skip gradient sampling).
 */
float bdRockLod( vec3 dx, vec3 dy ) {
  return 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-12 ) ) + uRockK.w;
}
/**
 * The rock material's colour t as detail around 1: the texture's own average divided out, its contrast set
 * (on its brightness: its hues stay its own, so a grey pebble in red sandstone doesn't turn blue).
 */
vec3 bdRockDetail( vec3 t ) {
  vec3 d = t * uRockNorm;
  return d * max( 1.0 + ( dot( d, vec3( 0.3, 0.59, 0.11 ) ) - 1.0 ) * ( uRockK.y - 1.0 ), 0.0 );
}
`;

export interface RockUniforms {
  /** The biome's tileable rock material (sRGB). */
  uRock: { value: THREE.Texture | null };
  /** 1 / the texture's average colour (linear), per channel. */
  uRockNorm: { value: THREE.Color };
  /**
   * x: texture repeats per tile, y: detail contrast (1 = the texture's own), z: how much darker the cliff
   * walls' foot is, w: mip offset (log2 of the texture's size, plus a bias).
   */
  uRockK: { value: THREE.Vector4 };
}

export interface EdgeUniforms {
  uTNoise: { value: THREE.Texture | null };
  /** The sky (clear) colour, sRGB-encoded like the final fragment. */
  uFarColor: { value: THREE.Color };
  /** Skirt width (tiles): fully faded there. */
  uSkirt: { value: number };
  /** How far out (tiles) the mirrored paint has given way to open ground. */
  uNear: { value: number };
}

export interface GroundUniforms extends EdgeUniforms {
  /** Grain contrast, north-west emboss of the grain, sharpening of the paint. */
  uDetail: { value: THREE.Vector3 };
  /** The biome's open ground (linear), which the skirt eases into. */
  uFarGround: { value: THREE.Color };
}

/**
 * The cliff walls (ground shader, after the paint): where the land is steep and on the rock itself, fade to
 * the rock material projected onto the wall (so it never shows stretched down the slope like the paint does),
 * in the colour of the painted rock around it. The colour, the rock share and whether a vertex is steep at all
 * come per vertex (vStone, vSteep: see Terrain3D.stoneAt), so flat ground and flat rock tops skip it all; the
 * rest takes the two side projections, v up the wall (so strata lie level and line up where the two meet),
 * blended by the horizontal normal sharpened hard, so most of a wall fetches once.
 */
const CLIFF_WALLS = /* glsl */ `
      {
        // (the world position's screen derivatives, for the mip level: taken while control flow is uniform)
        vec3 rdx = dFdx( vFowW );
        vec3 rdy = dFdy( vFowW );
        if ( vStone.a > 0.45 && vSteep > 0.0 ) {
          vec3 wn = normalize( ( vec4( vNormal, 0.0 ) * viewMatrix ).xyz );
          vec2 w = wn.xz * wn.xz;
          w *= w;
          w *= w;
          w = max( w / max( w.x + w.y, 1e-6 ) - 0.1, 0.0 );
          w /= w.x + w.y;
          // steep enough that the projections aren't stretched much (on a slope that also faces between
          // them, the stone would smear along it like the paint): their foreshortening, 1 on a sheer face;
          // and on the rock (1 inside a rock tile, 1/2 on its edge)
          float wall = smoothstep( 0.45, 0.65, dot( w, abs( wn.xz ) ) ) * smoothstep( 0.45, 0.7, vStone.a );
          if ( wall > 0.004 ) {
            vec3 p = vFowW * uRockK.x;
            float lod = bdRockLod( rdx * uRockK.x, rdy * uRockK.x );
            vec3 t = vec3( 0.0 );
            if ( w.x > 0.0 ) t += textureLod( uRock, p.zy, lod ).rgb * w.x;
            if ( w.y > 0.0 ) t += textureLod( uRock, p.xy + vec2( 0.37, 0.0 ), lod ).rgb * w.y;
            // (darker toward the foot, where the wall is in its own and the ground's shade)
            float foot = 1.0 - uRockK.z * ( 1.0 - smoothstep( 0.3, 0.8, vFowW.y ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, bdRockDetail( t ) * vStone.rgb * foot, wall );
          }
        }
      }`;

/** Replace a shader chunk, or throw if it's gone (a three.js update renamed it): the patch would silently do nothing. */
function swap(src: string, anchor: string, by: string): string {
  if (!src.includes(anchor)) throw new Error(`terrain: ${anchor} not found`);
  return src.replace(anchor, by);
}

/**
 * Patch the painted ground material (call from `fogged`'s `also`); with `rock`, its cliff walls show the rock
 * material (the geometry then carries `aStone` and `aSteep`, see Terrain3D.stoneAt).
 */
export function patchGround(s: Shader, u: GroundUniforms, rock: RockUniforms | null = null): void {
  Object.assign(s.uniforms, u, rock ?? {});
  if (rock) {
    const decl = "attribute vec4 aStone;\nattribute float aSteep;\nvarying vec4 vStone;\nvarying float vSteep;";
    s.vertexShader = swap(s.vertexShader, "#include <common>", `#include <common>\n${decl}`);
    s.vertexShader = swap(s.vertexShader, "#include <begin_vertex>", "#include <begin_vertex>\nvStone = aStone;\nvSteep = aSteep;");
  }
  if (!s.fragmentShader.includes(FOG_LOOKUP)) throw new Error("terrain: fog lookup not found");
  s.fragmentShader = s.fragmentShader
    .replace(FOG_LOOKUP, FOG_MIRRORED)
    .replace(
      "#include <fog_pars_fragment>",
      `#include <fog_pars_fragment>\n${EDGE_DECL}\n${rock ? `${ROCK_DECL}\nvarying vec4 vStone;\nvarying float vSteep;` : ""}\nuniform vec3 uDetail;\nuniform vec3 uFarGround;`
    )
    .replace(
      "#include <map_fragment>",
      /* glsl */ `float od = bdOutside( vFowW.xz );
      #ifdef USE_MAP
      {
        // past the edge the mirrored paint blurs (a coarser mip), so it never reads as a copy of the map
        float blur = min( od * 1.3, 5.0 );
        diffuseColor *= texture2D( map, vMapUv, blur );
        // unsharp mask: the paint minus a softer mip of itself, so close in it reads crisp, not smeared
        // (high rock is softened a little instead: its paint is busy enough under the crags)
        vec3 soft = texture2D( map, vMapUv, blur + 1.5 ).rgb;
        float sharp = mix( uDetail.z, -0.5, smoothstep( 0.35, 0.8, vFowW.y ) ) * ( 1.0 - smoothstep( 0.0, 1.0, od ) );
        diffuseColor.rgb = max( diffuseColor.rgb + ( diffuseColor.rgb - soft ) * sharp, 0.0 );
      }
      #endif`
    )
    .replace(
      "#include <color_fragment>",
      /* glsl */ `#include <color_fragment>${rock ? CLIFF_WALLS : ""}
      {
        vec2 wp = vFowW.xz;
        if ( od > 0.0 ) {
          // past the edge the land gives way to the biome's open ground, rolling in tone
          float roll = texture2D( uTNoise, wp * 0.045 ).r;
          diffuseColor.rgb = mix( diffuseColor.rgb, uFarGround * ( 0.78 + 0.44 * roll ), smoothstep( 1.0, uNear, od ) );
        }
        // fine grain (on a grid turned off the tile axes, so its repeat never lines up), and the same
        // grain a hair to the south-east: their difference lights it from the north-west like the paint
        vec2 gp = mat2( 0.66, 0.29, -0.29, 0.66 ) * wp;
        float g0 = texture2D( uTNoise, gp ).r;
        float g1 = texture2D( uTNoise, gp + vec2( 0.0045, 0.0035 ) ).r;
        diffuseColor.rgb *= 1.0 + ( g0 - 0.5 ) * uDetail.x + ( g1 - g0 ) * uDetail.y;
        diffuseColor.rgb = bdDim( diffuseColor.rgb, od );
      }`
    )
    .replace("#include <premultiplied_alpha_fragment>", FAR_FADE);
}

/**
 * Patch the crags' material (call from `fogged`'s `also`): the rock material projected in world space onto
 * each flat facet along the axis it faces most (one fetch; where two facets meet, the stone breaks with the
 * light), as detail over the crag's own vertex colour.
 */
export function patchCrag(s: Shader, rock: RockUniforms): void {
  Object.assign(s.uniforms, rock);
  const f = swap(s.fragmentShader, "#include <fog_pars_fragment>", `#include <fog_pars_fragment>\n${ROCK_DECL}`);
  s.fragmentShader = swap(
    f,
    "#include <color_fragment>",
    /* glsl */ `#include <color_fragment>
      {
        // (flat facets: the face normal straight from the world position's screen derivatives)
        vec3 rdx = dFdx( vFowW ) * uRockK.x;
        vec3 rdy = dFdy( vFowW ) * uRockK.x;
        vec3 a = abs( cross( rdx, rdy ) );
        vec3 p = vFowW * uRockK.x;
        vec2 uv = a.x > max( a.y, a.z ) ? p.zy : a.z > a.y ? p.xy + vec2( 0.37, 0.0 ) : p.xz + vec2( 0.19, 0.53 );
        diffuseColor.rgb *= bdRockDetail( textureLod( uRock, uv, bdRockLod( rdx, rdy ) ).rgb );
      }`
  );
}

export interface LiquidUniforms extends EdgeUniforms {
  uShallow: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  /** The open sea's colour, far past the coastal shelf (only Terrain.Deep is that deep). */
  uAbyss: { value: THREE.Color };
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
  if (!s.fragmentShader.includes(FOG_LOOKUP)) throw new Error("terrain: fog lookup not found");
  s.fragmentShader = s.fragmentShader
    .replace(FOG_LOOKUP, FOG_MIRRORED)
    .replace("#include <common>", "#include <common>\nvarying float vDepth;\nvarying vec2 vXZ;")
    .replace("#include <fog_pars_fragment>", `#include <fog_pars_fragment>\n${EDGE_DECL}\nuniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uAbyss; uniform float uMode; uniform float uWT;`)
    .replace(
      "#include <color_fragment>",
      /* glsl */ `#include <color_fragment>
      float od = bdOutside( vXZ );
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
        // past the coastal shelf the open sea falls away into the abyss colour (rivers never get this deep)
        wc = mix( wc, uAbyss * ( 0.9 + 0.2 * n ), smoothstep( 0.5, 1.12, vDepth ) );
        alpha = mix( 0.2, 0.9, dk );
        // the reef crest: surf breaking where the shelf drops into the open sea (only open sea gets this deep)
        float crest = ( 1.0 - smoothstep( 0.0, 0.07, abs( vDepth - 0.58 ) ) ) * ( 0.55 + 0.45 * sin( uWT * 0.9 + n * 8.0 ) )
          * smoothstep( 0.3, 0.62, n2 );
        wc = mix( wc, vec3( 0.95, 0.99, 0.98 ), crest * 0.7 );
        alpha = max( alpha, crest * 0.75 );
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
        // (over the shallows the shelf is whole: only out over the deep do floes go missing)
        float has = 1.0 - smoothstep( 0.695, 0.705, ( c.a + 0.24 ) * deep );
        float plate = smoothstep( gap, gap + 0.025, c.b ) * has;
        float sunk = smoothstep( gap - 0.06, gap, c.b ) * has * ( 1.0 - plate );
        // the same a little toward the sun (north-west): a floe there shades this water
        vec4 c2 = texture2D( uTNoise, vXZ * 0.074 + wq * 0.12 + vec2( uWT * 0.0016, uWT * 0.0009 ) - vec2( 0.0055, 0.005 ) );
        float plate2 = smoothstep( gap, gap + 0.025, c2.b ) * ( 1.0 - smoothstep( 0.695, 0.705, ( c2.a + 0.24 ) * deep ) );
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
        lavaGlow *= smoothstep( 0.0, 0.08, vDepth ) * 0.7 + 0.3;
        wc = mix( vec3( 0.008, 0.005, 0.004 ), vec3( 0.022, 0.015, 0.012 ) * ( 0.7 + 0.6 * h2.x ), crust );
        alpha = 1.0;
      }
      // (past the edge the water and ice thin away within a few tiles, so lakes don't double)
      if ( uMode < 0.5 || uMode > 1.5 ) alpha *= 1.0 - smoothstep( 0.5, 2.5, od );
      diffuseColor = vec4( wc, alpha );`
    )
    .replace(
      "#include <normal_fragment_maps>",
      /* glsl */ `#include <normal_fragment_maps>
      if ( uMode < 0.5 ) {
        // wind ripples tilt the surface so the sun glints off it in small drifting patches
        vec2 t1 = texture2D( uTNoise, vXZ * 0.47 + vec2( uWT * 0.03, uWT * 0.02 ) ).rg;
        vec2 t2 = texture2D( uTNoise, vXZ * 0.33 - vec2( uWT * 0.024, -uWT * 0.033 ) ).gr;
        vec2 tilt = ( t1 + t2 - 1.0 ) * 0.12;
        normal = normalize( normal + ( viewMatrix * vec4( tilt.x, 0.0, tilt.y, 0.0 ) ).xyz );
      }`
    )
    .replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n      if ( uMode > 0.5 && uMode < 1.5 ) totalEmissiveRadiance = lavaGlow;"
    )
    // reflections: kept to a sheen, or the sun's glint off the ripples and the scene's studio environment
    // would wash whole stretches of water white; and past the edge, next to none (they'd outshine the dimmed water)
    .replace(
      "#include <lights_fragment_end>",
      /* glsl */ `#include <lights_fragment_end>
      {
        float rk = 0.5 * ( 1.0 - smoothstep( 0.0, 1.5, od ) * 0.9 );
        reflectedLight.directSpecular *= rk;
        reflectedLight.indirectSpecular *= rk;
      }`
    )
    // out of bounds dims everything it sends out, reflections and glow included, like the ground
    // (lava only darkens: greyed, its glow would turn salmon-pink)
    .replace(
      "#include <opaque_fragment>",
      /* glsl */ `#include <opaque_fragment>
      if ( uMode > 0.5 && uMode < 1.5 ) gl_FragColor.rgb *= 1.0 - smoothstep( 0.0, 0.9, od ) * 0.3;
      else gl_FragColor.rgb = bdDim( gl_FragColor.rgb, od );`
    )
    .replace("#include <premultiplied_alpha_fragment>", FAR_FADE);
}
