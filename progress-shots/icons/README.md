# Portraits (ICONS.md)

Before and after for the HUD portraits, which are now shots of the 3D
models. Shots 01–05 are the mock-ups the design was chosen from:
- The model shots came from the gallery's `?icon=` view (`tools/models.html`).
- The lift and rim were added afterwards with a short Pillow script; the
  shipped portraits bake the same finish in `tools/model-portraits.mjs`, with
  a neutral rim in place of the mock-ups' cool blue one.
- The build-bar mocks use the game's own `.bb` CSS at 2× on a 390 px phone
  width.

Shots 00, 06 and 07 are the real game, before and after, in skirmishes on
Riverlands. Shot 08 shows the shipped portrait files. Everything was
rendered in Chromium headless with SwiftShader on 2026-10-13.

| Image | What it shows |
|---|---|
| `00-build-bar-before-in-game.png` | Before: the four build-bar tabs in a real match. Fab, Bay, Depot and Radar look alike. Vehicles are thin slivers. Most of Infantry and Aircraft is padlocks. |
| `01-build-bar-today-vs-recommended.png` | Mock-up: every tab before, then with the recommended set (model shots in the ¾ view, one robot per squad, lift and rim). At the bottom, the locked Aircraft tab both ways. |
| `02-build-bar-four-options.png` | Mock-up of the options. A: before. B: model shots, nose north, 60°. C: model shots, ¾ view. D: C plus the HUD finish. Also the 22 px opener pills. |
| `03-red-ace-goliath-gantry.png` | Mock-up of the report's "Their ace" card: hue-rotated blue (amber turns cyan) vs a real `faction=red` shot. Then the Goliath and Gantry front-on before, and in the ¾ family. |
| `04-every-portrait.png` | Mock-up: all 28 portraits, before on the left, the model shot on the right. |
| `05-rim-baked-vs-css.png` | Mock-up: raw model shots, then the rim and lift baked in, then the same done with a CSS filter on the raw files. |
| `06-build-bar-after-in-game.png` | After: the same four tabs in a real match with the shipped portraits and the new locked buttons. |
| `07-red-selection-and-ace.png` | After: an enemy unit and building in the selection panel, and the report's MVP cards, with red portraits. |
| `08-every-portrait-shipped.png` | After: every portrait before, as shipped, and as shipped in red. |
