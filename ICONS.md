# Battle Drones — Portraits

## Status

Built. Every HUD portrait (`public/assets/icons/<kind>.webp`) is a shot of its
in-game 3D model, and every unit and building also has a red one
(`public/assets/icons/red/<kind>.webp`). `tools/model-portraits.mjs --all`
makes them all. `progress-shots/icons/` has the before and after: the
mock-ups the design was chosen from, and the shipped set in a real match.

The portraits appear in the build bar (44 px), the selection panel (46 px),
the training queue (32 px), group chips (30 px), the opener cards and their
pills (22–62 px), the after-action report (44 px) and the Vehicles page
(88 px).

| Decision | Chosen | Alternatives considered |
|---|---|---|
| Source | **Every portrait shot from its 3D model** | Keep the painted ones (they can't match the models); repaint from model renders |
| Camera | **A ¾ "showroom" view**: 50° pitch, nose turned 35° clockwise; robots and the Goliath 30° pitch, turned to face the viewer | Nose north at 60° (the Raptor, Lancer and Hornet had this briefly); straight down |
| Squads | **One robot, weapon up** | The whole formation (as painted) |
| Finish | **Lifted colour and a thin light rim**, baked in by the shooter | The same done in CSS; none |
| Red | **Real red portraits**, shot with `faction=red` | A CSS `hue-rotate` on the blue one (as the report did) |
| Locked | **The portrait stays readable, with a small corner padlock** | A 30%-opacity ghost under a big padlock (as before) |
| Size | **256 px** | 128 px (as before) |

## Why

The Raptor, Lancer and Hornet redesign (ART.md §1) swapped three painted
portraits for shots of their new 3D models. That left the set in three
styles, and showed how far the painted portraits had drifted from the game.
`00-build-bar-before-in-game.png` shows the old build bar in a real match on
a 390 × 844 phone. `04-every-portrait.png` shows every old portrait next to
its model.

1. **Three styles in one bar.** Twenty-three portraits were the painted
   top-down art from the 2D sprite era: detailed hand-painted gunmetal, lots
   of small surface detail, drawn straight down. The Goliath and Gantry were
   front-on model shots. The Raptor, Lancer and Hornet were model shots from
   60°, nose north. Next to each other they looked like parts of three
   different games.
2. **Many portraits weren't the model.** The build bar is where a player
   learns what each thing looks like, but many painted designs didn't exist
   on the map:
   - **Mender:** the portrait was a three-rotor drone. The model is a ring
     with a green cross.
   - **Tech Lab:** the portrait had an amber reactor core. The model is an
     orange dome on an octagon.
   - **Airpad:** the model has an "H" pad and a tower. The portrait had
     neither.
   - **Depot:** the portrait was machinery. The model is twin silos.
   - **Fab Plant:** the portrait was machinery. The model is a striped hall.
   - **Radar:** the portrait was a lattice. The model is a dish on a mast.
   - **SAM Site:** the portrait showed six white missiles. The model is a
     launcher box.
   - **Harvester:** the portrait was a tracked scrap hauler. The model is a
     blue tub truck.
   - **Scout:** the portrait had grey rotors. The model has blue rotor rings.
   - **Wasp:** the portrait was a twin-engine jet. The model has swept wings
     and an orange nozzle.
   - **Supply crate:** the portrait was a hazard-striped crate. The model is
     a black box with a yellow strap.
3. **Painted buildings looked alike at 44 px.** Fab, Bay, Depot and Radar
   were all grey squares with blue flecks. The models' silhouettes (a hall,
   an H pad, silos, a dish) are much easier to tell apart.
4. **Nose-north vehicles were thin slivers.** A long hull standing upright is
   about half as wide as it is tall, so it covered only 20–37% of the square.
   The ¾ shots cover 33–50%. In the 22 px opener pills, the Stinger, the
   Harvester and the Wasp were hard to make out.
5. **Squads were specks.** Five robots at 44 px showed neither a rifle nor a
   rocket tube.
6. **Dark gunmetal disappeared into the navy cards.** `GM_D` (#31353b) sits
   on cards that run from #141d2e to #22324f. The icons' black drop shadow
   doesn't show on a dark card.
7. **Locked items were just padlocks.** At the start of a match the Aircraft
   and Infantry tabs showed six and three padlocks. The icons underneath were
   at 30% opacity and greyscale, so you couldn't tell what you were
   unlocking.
8. **Red was faked.** The report's "Their ace" card hue-rotated the blue
   portrait by 140°. That also turned amber cyan: the Lancer's skirt and the
   Tech Lab's core came out teal (`03-red-ace-goliath-gantry.png`). The
   selection panel didn't try at all: an enemy unit, or either side's to a
   spectator, showed a blue portrait.

## What shipped

**Every portrait is shot from its model.** One source of truth: the build bar
shows what the map shows. A new unit gets its portraits from the same
command, without an image-generation round. `art/process.py` no longer makes
portraits at all. It still makes the key art, the PWA icons, and the atlas
the game no longer loads.

**One camera: a ¾ showroom view.** The camera is set by `FRAMING` at the top
of `tools/model-portraits.mjs`. Vehicles, aircraft, buildings and objectives
are shot at a 50° pitch, turned 35° clockwise so the nose points up and to
the right. That is close to the game camera, which runs from 47° to 62°. Long
hulls lie along the diagonal, so they fill the square. The ¾ angle also shows
the side features that tell units apart: the Radar's dish, the SAM's missile
rack, the Mortar's tube, the Flak's four barrels and the Lancer's skirt. The
Gantry shows its armament stage. The Radar's dish faces north when idle, so the
¾ turn would show its back; its head is turned to face the viewer instead.

**Robots and the Goliath are characters.** They are shot from 30° and turned
to face the viewer. A squad's portrait is one of its robots, weapon up: a
Trooper with its rifle, a Rocket robot with its tube, a cloaked Sniper with
its rail rifle. The squad's size is already shown in the name and the group
chips.

**A finish for the dark HUD.** The shooter fits each shot to 224 px in a
256 px square, then:
- lifts its colour (gamma 0.82, gain 1.06);
- draws a thin neutral light rim (#e2e8f0 at half strength) round the
  silhouette. The rim is the silhouette grown by 4 px and softened, about
  0.7 CSS px wide at 44 px.

The rim is neutral, not blue, so it suits both sides. `05-rim-baked-vs-css.png`
compares this with the same effect done in CSS, which came out softer.

**Real red portraits.** `--all` shoots every unit and building red as well,
into `icons/red/` (the objectives belong to no side). The service worker
precaches them alongside the blue ones (`vite.config.ts`). They are used:
- in the report's "Their ace" card, in place of the `hue-rotate`;
- in the selection panel, for any red unit or building and its queue, group
  chips, Condor seats and lifted Goliath.

The build bar and other "yours" places stay blue.

**Locked buttons stay readable.** A locked build button's portrait is at 60%
opacity with `grayscale(1) brightness(.8)`. The padlock is an 11 px badge in
the top-left corner; the queue badge uses the top right.

**The Vehicles page** (`vehicles.html`) shows each portrait on the same navy
card as the build buttons, which the finish is made for; before, it used a
black square. Its nav pills no longer crop the portraits into circles
(`09-vehicles-page.png`).

**256 px portraits.** The Vehicles page shows portraits at 88 CSS px, which
needs about 264 device pixels on a 3× phone. Each portrait is about 15 KB:
the 54 come to 780 KB, up from 175 KB for the old 28.

### What portraits can't fix

The Stinger, the Flak Crawler and the Mastodon have the same kind of hull: a
blue slab on tracks. At 44 px the turret is the only difference. The ¾ view
helps: the Flak's quad guns and the Mastodon's twin barrels show. A stronger
fix is a model pass like the one the Raptor, Lancer and Hornet just had,
giving each of the three its own hull shape and team-panel pattern.

## Making them

```bash
npx vite --port 5173 &
node tools/model-portraits.mjs --all              # everything, blue and red (about 7 minutes)
node tools/model-portraits.mjs lancer             # one kind's blue portrait...
node tools/model-portraits.mjs lancer --faction=red   # ...and its red one
node tools/model-portraits.mjs hq --out=/tmp/p    # try a look without touching the shipped ones
node tools/model-portraits.mjs radar --pitch=60 --turn=0 --out=/tmp/p   # override the framing
```

Each run loads the model gallery's `?icon=<kind>` view (`tools/models.ts`).
The view takes:
- any unit, building or objective;
- `?turn=rad`, the model turned clockwise from its resting pose;
- `?head=rad`, a building's turret or head turned on its mount;
- `?faction=red`;
- `?solo`, one robot of a squad with its weapon up.

Each kind is shot once on black and once on white; the pair gives a clean
alpha.

Vite restarts the dev server when `vite.config.ts` changes, which breaks a
run in progress, so don't edit it during a run. A new unit or building goes
into the lists at the top of `model-portraits.mjs`, and into `FRAMING` if the
¾ view doesn't suit it. `tests/portraits.test.ts` checks that every kind has
its portraits.
