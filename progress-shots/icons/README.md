# Portraits (ICONS.md)

A proposal for the HUD portraits. Model shots come from the gallery's `?icon=`
view (`tools/models.html`) via `tools/model-portraits.mjs --out=<scratch>`. The
lift and rim were added afterwards with a short Pillow script. The build-bar
mocks use the game's own `.bb` CSS at 2× on a 390 px phone width. The in-game
shot is a skirmish on Riverlands. Everything was rendered in Chromium headless
with SwiftShader on 2026-10-13. Nothing under `public/` changed.

| Image | What it shows |
|---|---|
| `00-build-bar-today-in-game.png` | The four build-bar tabs in a real match today. Fab, Bay, Depot and Radar look alike. Vehicles are thin slivers. Most of Infantry and Aircraft is padlocks. |
| `01-build-bar-today-vs-recommended.png` | Every tab today, then with the recommended set: model shots in the ¾ view, one robot per squad, lift and rim. At the bottom, the locked Aircraft tab both ways. |
| `02-build-bar-four-options.png` | A: today. B: model shots, nose north, 60°. C: model shots, ¾ view. D: C plus the HUD finish. Also the 22 px opener pills. |
| `03-red-ace-goliath-gantry.png` | The report's "Their ace" card: hue-rotated blue (amber turns cyan) vs a real `faction=red` shot. Then the Goliath and Gantry front-on today vs in the ¾ family. |
| `04-every-portrait.png` | All 28 portraits: today on the left, the recommended model shot on the right. |
| `05-rim-baked-vs-css.png` | Raw model shots, then the rim and lift baked in, then the same done with a CSS filter on the raw files. |
