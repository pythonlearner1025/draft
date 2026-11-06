# `draft.explorer`: the morphology atlas

**The claim:** the engine carries no body plan of its own, so the space of
machines it can compile is far wider than the humanoid and quadruped it ships.
The atlas is a map of that space you can pan and zoom, so you can look across
body plans *before* committing to one and before the feasibility gate sees it.

```shell
python scripts/morphology_explorer.py    # http://127.0.0.1:8082
```

## What you are looking at

Every tile is one design, drawn in Draft's own palette with its actuators at the
size Draft's fitted airgap and slenderness relations give their class. Tiles
are tinted by body plan (radial ×n, bilateral, asymmetric, chain), so
territories show up as regions when you zoom out.

- **Zoom is semantic.** Tiles stay about the same size on screen. Zooming in
  halves the spacing in latent space, and the new tiles are the designs
  *between* the ones you were looking at. Zooming out widens the step until body
  plans change from tile to tile.
- **Explore around a design** replaces the world map with a flat slice through
  latent space centred on that design, along two random directions. Its
  neighbours are its mutations, and zoom sets the mutation size. **Turn the
  slice** picks two new directions.
- **Pin** keeps a shortlist in your browser.

## How the space is built (`web/genome.js`)

A design is a latent vector `z` of 73 standard-normal genes. `decode(z)` builds
the body tree.

| band | changes | genes |
|---|---|---|
| P | slowest | body plan (hub or chain), symmetry, radial order |
| T | slow | limb groups, segment count, effector, joint-axis pattern, placement |
| S | medium | scale, hub shape, elevation, sweep, limb length, rest bend |
| F | fast | segment proportions, taper, effector size |

The **world map** folds one infinite plane through that space: every gene is
its own smooth noise field over the plane, and slower bands use lower
frequencies and fewer octaves. Neighbouring tiles therefore share a body plan
and differ in proportion. A discrete gene's threshold moves across the map
instead of flickering.

A decoded design is a hub (a loft of stacked outlines, as `mesh.yaml` writes
it) with up to three limb groups:

- **Placements:** radial on faces, vertices, top or bottom; bilateral in side
  pairs, front, rear or top; asymmetric anywhere.
- **Chains:** a head followed by modules, each with legs, wheels or nothing.
- **Limbs:** one to four hinge segments ending in a ball foot, flat foot,
  wheel, gripper, peg or pad.

Every frame already follows `tree.yaml`'s conventions: joints about a body's own
x, y or z, members along +x, and each actuator drawn by the parent at the
child's joint. Rest bends are quantised to 90° wherever that keeps an actuator
on a body axis. A group whose bends would fold a limb back through the hub
relaxes them, all limbs together, because they share parameters.

## Taking a design to Draft (`web/draft_export.js`)

The sheet's **Copy install command** writes the design to
`src/draft/robots/atlas_<id>/`. When the page comes from the local server, it
also offers **Save to the repository**, **Run Draft's gate** and a `.zip`.
Then:

```shell
python scripts/generate_robot.py --robot atlas_<id>
```

The export is an ordinary robot directory:

- **Shared parameters.** Lengths, bends, radii, joint ranges and actuator
  classes become named parameters shared by a group's limbs (`g0_s2_length`),
  so the editor tunes all of them at once. Mount points on the hub are written
  as numbers.
- **Actuators.** Each class states peak torque, gear and the matching no-load
  speed. Draft derives the rest, and the atlas draws actuators at the same
  size.
- **Stated densities.** No measured population covers these body plans, so
  `mass_composition_reference` is left out. Members, hub and effectors are
  priced at stated densities: limbs at 600 kg/m³ (the middle of the measured
  limb effective densities) and the hub at the quadruped trunk median of
  654 kg/m³. The generator says so in its warnings.
- **No gate switches.** The export sets none, so the gate's verdict is the real
  one.

`tests/test_explorer.py` exports a sample of the map with Node and compiles
every design. Each one either compiles or is refused by the feasibility gate,
never rejected as malformed, and each compiled body sits where the atlas drew
it.

## What it is not

- **Not checked.** Nothing on the map has met the feasibility gate. The mass
  shown is an estimate: the actuator mass trend plus the stated densities.
- **Not optimised.** A design is a point in the space, not an answer to a task.
- **Not every mechanism.** Joints are hinges. There are no prismatic joints, no
  closed chains and no springs, because the format has none.

## Files

| file | job |
|---|---|
| `web/genome.js` | genes, world fields, slices, `decode`, forward kinematics |
| `web/draft_export.js` | design → `parameters.yaml`, `tree.yaml`, `mesh.yaml`; install command; zip |
| `web/render.js` | three.js thumbnails and the orbit view |
| `web/app.js`, `web/index.html` | the map, the sheet, pins |
| `server.py` | serves `web/`; `/api/save` and `/api/check` for the local page |

The page loads three.js from jsDelivr, so it needs a network connection.
