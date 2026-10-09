# Battle Drones — Art

Every image in the game — units, buildings, terrain materials, decorations,
scrap and crystals, explosions, the menu key art and the app icon — was
generated with OpenAI's **`gpt-image-2.5-sunburst`** (released 2026-09-08,
described by OpenAI as its most capable image generation and editing
model), then processed deterministically in Python into the assets the
engine loads.

> **The battlefield is now 3D (three.js).** Units, buildings, objectives,
> trees, rocks, scrap and crystals are procedural low-poly models built in
> code (`src/game/three/models.ts`, `three/terrain.ts`) in the same style
> contract — gunmetal, royal-blue/crimson team panels, amber lights — and
> particle textures are drawn at runtime (`src/game/three/textures.ts`).
> The painted **terrain** (section 3) is draped over the 3D heightfield as
> its albedo, and the four painted **rock materials** become small tileable
> textures (`art/textures.py` → `public/assets/textures/rock-<biome>.webp`,
> 512², seamless) that texture the outcrops' cliff walls and crags, so they
> are the same stone as the painted tops. The generated **unit and building art** still provides the
> HUD portraits (`public/assets/icons/`), and the key art and icons are
> unchanged. The sprite atlas (`public/assets/sprites/`) is still produced
> by `process.py` but is no longer loaded by the game.

The pipeline lives in `art/` (Python 3.10+, Pillow ≥ 10.1, numpy, scipy,
and the `openai` package for generation):

```bash
python3 art/generate.py            # generate any missing raws (needs OPENAI_API_KEY)
python3 art/generate.py 'tex-*' --force   # regenerate matching assets
python3 art/generate.py --list     # what exists
python3 art/process.py             # raws -> sprite atlas, icons, key art, PWA icons
npx vite-node tools/export-maps.ts # map grids -> art/maps/*.json
python3 art/terrain.py [map ids]   # paint each map's terrain (and refresh the rock textures)
python3 art/textures.py            # the biome rock textures alone (Pillow + numpy only)
```

## 1. Generation — `art/catalog.py`, `art/generate.py`, `art/imagegen.py`

`catalog.py` is the single source of truth for every prompt. Prompts are
built from shared *style contracts* so the whole set reads as one game:

- **STYLE** — strictly top-down orthographic, semi-realistic hand-painted
  sci-fi military, crisp edges, readable silhouettes at phone size, soft
  light from the upper left, weathered gunmetal with **royal-blue team
  panels** — and blue *only* on team panels (lights and glass are amber),
  so the red faction can be derived by hue-shifting. No text or logos.
- **ISOLATED** — native transparent background (`background="transparent"`,
  PNG), generous margins, no ground, shadows, glows or frames. The model
  supports true alpha, so no chroma keying is needed.
- **FACING** — every vehicle points north; the engine rotates sprites.
- **PAIR** — for turreted vehicles and turret buildings, one image shows the
  hull (with an empty turret ring) and the turret side by side at the same
  scale. Generating both parts in one image keeps them perfectly matched.
- **TEXTURE** — opaque, flat-lit, tileable top-down ground materials.
- **DOODADS** — 3×3 sheets of decorations per biome.

`generate.py` runs jobs concurrently (8 workers) with retry/backoff and
stores each raw as `art/raw/<name>.webp` (lossy colour, lossless alpha —
small enough to commit, faithful enough to reprocess). Sprites use
`quality="high"` at 1024² or 1536×1024; textures `quality="medium"`.

Inventory (61 raws): 11 units, 8 buildings, rubble, decals, scrap piles,
crystal clusters, an 8-frame explosion, 7 materials × 4 biomes (ground,
ground2, rough, rock, liquid, road, forest canopy), a doodad sheet per
biome, portrait and landscape key art, the icon, and the two map
objectives: the `uplink` relay (a round platform + its rotating dish, as a
PAIR) and the `supply-crate`. Those use a **NEUTRAL** contract instead of
STYLE — gunmetal with hazard-yellow stripes and amber lights, no blue or red
at all — because they belong to no side: the engine draws the holder's
colour as a ring, so they get no red variant.

## 2. Sprites — `art/process.py`

Deterministic (same raws → byte-identical output). It:

1. Splits multi-part images into parts via connected components on
   thresholded alpha (tiny satellites such as rotor discs are attached to
   the nearest part); rotates the Mender and Scout 180° (drawn facing south).
2. Scales each unit so its longest side matches a per-unit size in tiles
   (e.g. Scout 0.85, Titan 1.45, Hornet 1.5); turrets share their hull's
   scale; buildings fill their footprint.
3. Measures pivots: hull centre of mass; the empty **turret ring** on each
   hull by a gradient circle search + sub-pixel circle fit; the **turret
   pivot** as the centroid of the turret body after removing the barrel by
   morphological opening.
4. Derives the **red faction** by shifting saturated blue hues to crimson,
   leaving amber, green, grey and rust untouched.
5. Packs everything into one power-of-two page (mipmaps need POT) with 8 px
   padding, zeroes RGB under transparent pixels, and writes a Phaser
   multiatlas.

Outputs and the contract the engine relies on:

| File | Contents |
|---|---|
| `public/assets/sprites/game.json` + `game-0.webp` | 2048² multiatlas (~1.3 MB WebP) |
| `public/assets/sprites/meta.json` | `pxPerTile` (128), per-frame `origin` pivots, turret/head `mounts` (tiles, hull facing north), unit `sizes` |
| `public/assets/icons/<kind>.webp` | 128 px HUD portraits (blue, turrets composited) |
| `public/assets/ui/keyart-{portrait,landscape}.webp` | Menu backgrounds |
| `public/icons/icon-{192,512}.png` | PWA icons |
| `art/previews/atlas-preview.png` | QA contact sheet |

Frame names: `u/<faction>/<unit>` (hull or body), `u/<faction>/<unit>-turret`,
`u/<faction>/harvester-full`, `b/<faction>/<building>`,
`b/<faction>/<turret|sam-site|radar>-head`, `rubble/0-3`, `decal/0-5`,
`scrap/0-5`, `crystal/0-5`, `explosion/0-7`, and the neutral
`obj/uplink` (2.25 tiles across), `obj/uplink-head` (pivot on its hub; its
mount offset is `mounts.uplink`) and `obj/crate` (0.85 tiles). Art is authored at 128 texture
px per tile; the world is 64 px per tile, so sprites draw at 0.5×.

## 3. Terrain — `art/terrain.py`

Each map's grid (exported from `src/sim/maps.ts` by
`tools/export-maps.ts`) is painted into a full-map image at **48 px per
tile**, written as 1024 px WebP chunks (`public/assets/maps/<id>/t_<c>_<r>.webp`)
plus `meta.json` and a 256 px `thumb.webp` (map picker and minimap). It:

- makes the generated materials tile seamlessly and hides repetition with
  large-scale noise variation, blending in a secondary ground material;
- blends materials with noise-perturbed soft masks that stay within about
  a third of a tile of the true boundary, so passability stays readable;
- builds a height field for rock, hillshades it from the upper left, casts
  soft shadows and ambient occlusion;
- paints water with depth gradients, wet banks and shore foam — lava with a
  glow bleeding onto nearby ground — and shallows as see-through fords;
- draws bridges as built decks with railings and shadows, oriented along
  each bridge's principal axis;
- scatters tree-crown doodads through and over forest edges and other
  decorations sparsely (big ones only on unbuildable ground, never near an
  HQ), each with a soft drop shadow;
- chooses the highest WebP quality that keeps each map near 1.5 MB.

`python3 art/terrain.py --debug` also writes a grid-overlay QA image.

Scrap piles and crystals are *not* painted into the terrain — the game draws
them as sprites so they visibly shrink as they're mined.

## Changing art

- Tweak a prompt in `catalog.py`, then `generate.py <name> --force`,
  `process.py`, and rebuild. View `art/previews/*` before shipping.
- New unit kinds need a catalog entry, a size in `process.py`, and the
  renderer's frame names follow automatically.
- Changing a map in `src/sim/maps.ts` requires re-exporting and re-painting
  its terrain (`npm run maps && npm run art:terrain -- <id>`).
