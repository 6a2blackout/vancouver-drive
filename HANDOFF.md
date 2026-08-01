# Handoff

Last session: 2026-07-31. Repo clean, everything pushed to
`https://github.com/6a2blackout/vancouver-drive` (private). Nothing is running.

## What this is

An open-world night driving game in a geometrically accurate Vancouver, built
entirely from the City's open data. **The target has since sharpened**: the user
named [quartz's chassis testing place](https://www.roblox.com/games/163501479/quartzs-chassis-testing-place)
on Roblox as the reference. That is a *vehicle physics tech demo* — visible
realistic suspension, manual gearbox with clutch, engine RPM, drift-focused
handling, tested on a simple pad rather than explored.

So this is drifting from "driving game in a city" toward "chassis sandbox that
happens to have a real city attached". Both still work; weight new decisions
toward the chassis-testing side.

## Run it

```bash
cd ~/personal/games/vancouver-drive
npm install          # only if node_modules is missing
npm run dev          # http://localhost:5173 — Ctrl+C to stop
```

World data is committed-around but generated; it already exists in
`public/world/`. Only re-run the pipeline if you change the map bounds:

```bash
npm run fetch        # City open data API → data/raw/ (~60 MB, cached)
npm run world        # → public/world/*.bin + data/preview/*.png
```

| Command | What it does |
|---|---|
| `npm test` | vehicle + terrain + roads suites |
| `npm run test:vehicle` | stance, acceleration, braking, cornering, handbrake, test pad |
| `npm run preview:car` | **software-renders the car to PNGs** — see "no eyes" below |
| `npm run typecheck` | tsc, no emit |

Controls: `WASD`/arrows, `Space` handbrake, `C` camera (chase/hood/wide/orbit),
`L` lighting (dusk/night/survey), `T` test pad, `R` reset, drag + scroll to orbit.

## State

Phases 0–4 of the original plan are done and verified
(`~/.claude/plans/i-want-to-make-velvety-duckling.md`).

- **Terrain** — 1,256 LiDAR contour lines → 1095×1393 heightfield, cascadic
  multigrid, ~1 s. Water pinned to sea level, depressions filled.
- **Roads** — 2,983 segments, 295 km, 1,510 junctions, burned into the heightmap.
- **Buildings** — 10,660 with real LiDAR heights, procedural emissive windows.
- **Car** — Porsche 911 GTS (992.2), lofted body, visible coilovers, torque
  curve + 8-speed gearbox + drag.
- **Test pad** — 8 obstacle lanes over Burrard Inlet, reached with `T`.

## User feedback so far

- Speed: good *(said when 0-100 was 3.45 s; it is now 2.82 s after the real
  drivetrain landed — worth re-asking)*
- Steering: good
- Car feels planted: good
- **Handbrake: "it slides and I can turn, but it's not like I'm drifting."**
  Diagnosis: it breaks traction but will not *hold* an angle — grip returns in
  0.15 s, so the slide snaps straight. Unfixed. This is the main handling
  complaint.
- Wants: free camera ✅, testing sandbox ✅, chassis-testing direction.

## Next, in priority order

1. **Live tuning panel.** On-screen sliders for spring rate, damping, ride
   height, grip, torque, weight distribution. This is what makes it a *testing
   place* rather than a game, and it would let the user solve the handbrake feel
   themselves instead of round-tripping through me. Needs `CarConfig` made
   mutable at runtime (currently `as const`) plus a `vehicle.applyTuning()`.
2. **Manual gearbox + clutch.** The reference has `V` to start the engine,
   shift with clutch. Currently automatic. `src/vehicle/Drivetrain.ts` already
   has gears and ratios; this is mostly input plumbing and a clutch term.
3. **Per-wheel telemetry** — slip angle and normal force per corner, on screen.
4. Then the original Phase 5 (bloom, street-lamp glows, wet roads) and Phase 6
   (chunk streaming, props, minimap).

## Things that cost time — do not rediscover these

**There is no browser in this environment.** No Chrome, no Claude-in-Chrome
extension. Visual work cannot be checked by looking at the running app. Two
workarounds, both already built:

- `npm run preview:car` — a small orthographic software rasteriser
  (`tools/preview-car.ts`) that renders the real game geometry to PNGs, which
  *can* be read back with the Read tool. Build this habit; a car shipped without
  looking at it had its body floating 0.65 m above its own wheels.
- The world pipeline writes `data/preview/*.png` every build. Read them.
- Physics is fully testable headless — Rapier runs under `tsx`.

**Rapier gotchas.**
- `body.addForce()` **persists across timesteps** until `resetForces()`. Not
  per-frame. Caused a violent oscillation before it was found.
- `world.castRay()` silently misses until `world.step()` has run once — the
  query pipeline is not populated before then.
- The forward-axis setter really is named `setIndexForwardAxis` (a setter
  property), while the getter is `indexForwardAxis`. Not a typo.

**Raycast vehicle artifact.** A rearward centre of mass makes the car sit
fractionally nose-up, tilting the suspension rays so they gain a horizontal
component — the car self-propels under zero throttle. Cancelled by rolling
resistance in `resistiveForce()`, clamped so it can never exceed what would stop
the car in one step (unclamped, it reverses the car and oscillates).

**Ground clearance is 23 cm.** Any test-pad obstacle taller than that beaches the
car with all four wheels in the air. There is a `CLEARANCE` constant and a
`capHeight()` guard in `Sandbox.ts` — use them.

**The car's forward axis is +Z.** The test pad course was originally laid out in
−Z and the car reversed into a kerb 9 m in.

**Body geometry is authored in height-above-ground**, then lowered by
`RIDE_HEIGHT` (0.653 m) onto the chassis origin. Anything added to the car —
lights, mirrors, spoilers — goes in the same ground-referenced space, inside the
`shell` group. Headlight *spotlights* in `Renderer.ts` are the exception: they
parent to the chassis directly, so they carry the offset themselves.

**Vancouver open data.**
- `webtransfer.vancouver.ca` is behind Cloudflare and 403s all scripted
  requests. The 2013 DEM raster and raw LiDAR tiles are manual downloads only.
  The Opendatasoft API is unrestricted and needs no key.
- Stanley Park Drive is **not** in `public-streets` — the City does not own it.
  It is in `non-city-streets`, along with the causeway.
- `building-footprints-2009` is the only layer with heights. 2015 has geometry
  only.

## Open questions

- Is 2.82 s to 100 km/h too quick now? The user liked 3.45 s.
- The car reads as a generic low sports car, not distinctly a 911 — the nose is
  still too long and wedgy. `npm run preview:car` to iterate.
- BBOX clips Prospect Point (northern tip of Stanley Park) at lat 49.31.
- Repo is private; user has not said whether to make it public.
- No fps figure has ever been reported. Terrain, roads and buildings are three
  large meshes with no culling (~1M triangles plus a shadow pass). If the user
  reports chugging, pull chunk streaming forward.

## Conventions

- Commits: **short, casual, lowercase. No Co-Authored-By, no session trailers.**
  The user was explicit about this.
- Comments explain *why*, not *what*. Several non-obvious decisions are
  documented at the top of their modules — read those before changing
  `terrain.ts`, `burn.ts`, `buildings.ts` or `Drivetrain.ts`.
