# Battle Drones — Portraits

## Status

A proposal. Nothing shipped has changed: `public/assets/icons/` is as it was.
The pictures are in `progress-shots/icons/`. They are real shots of the
in-game models, shown with the build bar's own CSS at its real sizes.

The HUD portraits (`public/assets/icons/<kind>.webp`) appear in the build bar
(44 px), the selection panel (46 px), the training queue (32 px), group chips
(30 px), the opener cards and their pills (22–62 px), the after-action report
(44 px) and the Vehicles page (88 px). The Raptor, Lancer and Hornet redesign
(ART.md §1) swapped three painted portraits for shots of their new 3D models.
That left the set in three styles, and showed how far the painted portraits
have drifted from the game.

| Decision | Recommended | Alternatives |
|---|---|---|
| Source | **Every portrait shot from its 3D model** | Keep painting (they can't match the models); repaint from model renders |
| Camera | **A ¾ "showroom" view**: 50° pitch, nose turned 35° clockwise; robots and the Goliath 30° pitch, turned to face the viewer | Nose north at 60° (what the Raptor, Lancer and Hornet use now); straight down |
| Squads | **One robot, weapon up** | The whole formation (today) |
| Finish | **Lifted shadows and a thin light rim**, baked in by the shooter | The same done in CSS; none |
| Red | **Real red portraits**, shot with `faction=red` | The report's CSS `hue-rotate` (today) |
| Locked | **The silhouette stays readable, with a small corner padlock** | A 30%-opacity ghost under a big padlock (today) |
| Size | **256 px masters** | 128 px (today) |

## What's wrong today

`00-build-bar-today-in-game.png` shows the build bar in a real match, on a
390 × 844 phone. `04-every-portrait.png` shows every portrait next to its
model.

1. **Three styles in one bar.** Twenty-three portraits are the painted top-down
   art from the 2D sprite era: detailed hand-painted gunmetal, lots of small
   surface detail, drawn straight down. The Goliath and Gantry are front-on
   model shots. The Raptor, Lancer and Hornet are model shots from 60°, nose
   north. Next to each other they look like parts of three different games.
2. **The portrait often isn't the model.** The build bar is where a player
   learns what each thing looks like, but many painted designs don't exist
   on the map:
   - **Mender:** the portrait is a three-rotor drone. The model is a ring
     with a green cross.
   - **Tech Lab:** the portrait has an amber reactor core. The model is an
     orange dome on an octagon.
   - **Airpad:** the model has an "H" pad and a tower. The portrait has
     neither.
   - **Depot:** the portrait is machinery. The model is twin silos.
   - **Fab Plant:** the portrait is machinery. The model is a striped hall.
   - **Radar:** the portrait is a lattice. The model is a dish on a mast.
   - **SAM Site:** the portrait shows six white missiles. The model is a
     launcher box.
   - **Harvester:** the portrait is a tracked scrap hauler. The model is a
     blue tub truck.
   - **Scout:** the portrait has grey rotors. The model has blue rotor rings.
   - **Wasp:** the portrait is a twin-engine jet. The model has swept wings
     and an orange nozzle.
   - **Supply crate:** the portrait is a hazard-striped crate. The model is a
     black box with a yellow strap.
3. **Painted buildings look alike at 44 px.** Fab, Bay, Depot and Radar are
   all grey squares with blue flecks. The models' silhouettes (a hall, an H
   pad, silos, a dish) are much easier to tell apart.
4. **Nose-north vehicles are thin slivers.** A long hull standing upright is
   about half as wide as it is tall, so it covers only 20–37% of the square.
   The ¾ shots below cover 33–50%. In the 22 px opener pills, the Stinger,
   the Harvester and the Wasp are hard to make out.
5. **Squads are specks.** Five robots at 44 px show neither a rifle nor a
   rocket tube.
6. **Dark gunmetal disappears into the navy cards.** `GM_D` (#31353b)
   sits on cards that run from #141d2e to #22324f. The icons' black drop
   shadow doesn't show on a dark card.
7. **Locked items are just padlocks.** At the start of a match the Aircraft
   and Infantry tabs show six and three padlocks. The icons underneath are at
   30% opacity and greyscale, so you can't tell what you're unlocking.
8. **Red is faked.** `.mvp.red img` hue-rotates the blue portrait by 140°.
   That also turns amber cyan: the Lancer's skirt and the Tech Lab's core
   come out teal (`03-red-ace-goliath-gantry.png`).

## The proposal

**1. Shoot every portrait from its model.** One source of truth: the build
bar shows what the map shows. A new unit gets its portrait for free from the
same command, without an image-generation round. Red comes free too (item 5).
`art/process.py` already skips the three model-shot units (`MODEL_PORTRAITS`).
The skip list grows to every kind, or `process.py` stops making icons at all.
Its other outputs stay: key art, PWA icons, and the atlas the game no longer
loads.

**2. Use one camera, a ¾ showroom view** (`01-build-bar-today-vs-recommended.png`,
row C of `02-build-bar-four-options.png`). Vehicles, aircraft, buildings and
objectives are shot at a 50° pitch, turned 35° clockwise so the nose points
up and to the right. That is close to the game camera, which runs from 47° to
62°. Long hulls lie along the diagonal, so they fill the square. The ¾ angle
also shows the side features that tell units apart: the Radar's dish, the SAM's
missile rack, the Mortar's tube, the Flak's four barrels and the Lancer's skirt.
Robots and the Goliath are characters, so they get a lower 30° camera and face
the viewer. Nose north at 60° (row B, as the Raptor, Lancer and Hornet have
now) is the fallback. It is consistent, but it brings back the slivers, and
from that angle the Radar is just a dark trapezoid.

**3. Use one robot per squad.** A single Trooper with its rifle, a Rocket
robot with its tube, a cloaked Sniper with its rail rifle. Each is easy to
identify at 44 px, and the squad's size is already shown in the name and in
the group-chip counts.

**4. Add a HUD finish.** Raise the shadows (gamma 0.82, ×1.06) and add a
light rim about 0.7 CSS px wide around the silhouette, so dark metal separates
from the card (row D). `05-rim-baked-vs-css.png` compares the two ways to do
it:
- **Baked** (recommended): the shooter already handles the alpha per pixel,
  so growing the silhouette by a few pixels there is easy. It gives the
  crispest edge.
- **CSS:** `filter: brightness(1.15) drop-shadow(0 0 .6px rgba(226,232,240,.9))
  drop-shadow(0 2px 3px rgba(0,0,0,.7))` keeps the files clean and can be
  tuned per context. It is softer, and it could go on today's painted icons
  as a stopgap.

The prototypes used a cool blue-white rim. Ship a neutral one (about
#e2e8f0) so it also suits red portraits.

**5. Shoot real red portraits.** Write `icons/red/<kind>.webp` with
`faction=red`, and have the report's "Their ace" card use them in place of
the hue-rotate. It is only one card today, but MULTIPLAYER.md's "Playing red"
would need red portraits everywhere.

**6. Show what's locked.** For locked buttons, set the icon to 60% opacity
with `grayscale(1) brightness(.8)`, and move the padlock to a small corner
badge at the top left (the queue badge uses the top right). The bottom of
`01-build-bar-today-vs-recommended.png` shows the Aircraft tab at the start
of a match both ways. This is a CSS-only change, independent of the rest.

**7. Use 256 px masters.** The Vehicles page shows portraits at 88 CSS px,
which needs about 264 device pixels on a 3× phone. A 128 px master looks soft
there.

### What portraits can't fix

The Stinger, the Flak Crawler and the Mastodon have the same kind of hull: a
blue slab on tracks. At 44 px the turret is the only difference. The ¾ view
helps: the Flak's quad guns and the Mastodon's twin barrels show. A stronger
fix is a model pass like the one the Raptor, Lancer and Hornet just had, giving
each of the three its own hull shape and team-panel pattern.

## Trying it

The model gallery's `?icon=` view (`tools/models.ts`) now also takes:
- buildings and the objectives (`uplink`, `supply-crate`);
- `?turn=rad` (clockwise from the resting pose);
- `?faction=red`;
- `?solo` (one robot of a squad, weapon up).

`tools/model-portraits.mjs` passes these through as `--turn`, `--faction`
and `--solo`, and takes `--out=<dir>` so a look can be tried without
touching the shipped portraits:

```bash
npx vite --port 5173 &
mkdir -p /tmp/p
# vehicles, aircraft, buildings, objectives
node tools/model-portraits.mjs harvester stinger hq radar uplink --pitch=50 --turn=0.6 --out=/tmp/p
# robots and the Goliath
node tools/model-portraits.mjs trooper rocket-squad sniper --solo --pitch=30 --turn=2.5 --out=/tmp/p
node tools/model-portraits.mjs goliath --pitch=30 --turn=0.6 --out=/tmp/p
# red
node tools/model-portraits.mjs lancer --pitch=50 --turn=0.6 --faction=red --out=/tmp/p
```

The prototype finish (the lift and the rim) was applied to these shots
afterwards with a short Pillow script. Shipping it would mean:
- a per-kind framing table in `model-portraits.mjs` (pitch, turn, solo), so
  one run reshoots the whole set;
- the finish, the 256 px size and the red pass in the same script;
- `MODEL_PORTRAITS` covering every kind;
- ART.md §1 rewritten to say the portraits are model shots;
- the locked-button and red-ace CSS in `src/ui/style.css`.
