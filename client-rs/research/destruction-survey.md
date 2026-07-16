# Shipped destruction systems survey (ghoul, 2026-07-16)

Status: evidence only, extends physics-recon.md §3 (structural destruction).
Deeper pass on RFG/Frostbite/CryEngine + wider pass on Mercenaries/Finals/
Noita/Besiege. Nothing here is adopted; recon informs, Pascal rules.

## 1. Red Faction Guerrilla — Geo-Mod 2.0 (Volition, 2009)

**Architecture**
- Geo-Mod 1 (RF 2001) = runtime CSG subtract on world BSP: fire rocket →
  low-poly "cutter" shape intersected/subtracted from wall/floor geometry
  live. Volition programmer John Slagel built it solo in one summer,
  consulting Purdue CS prof Christoph Hoffmann's 1989 CSG textbook — Hoffmann
  initially told him real-time CSG "you can't do that."
  https://www.theringer.com/2024/02/02/video-games/destruction-video-games-battlefield-bad-company-red-faction-battlebit-teardown-the-finals
- Geo-Mod 2.0 (RFG) = NOT runtime CSG. Buildings are pre-broken into fixed
  chunks; a real-time **stress solver** evaluates every object continuously.
  Algo (Eric Arnold, senior programmer, via Digital Foundry): stress code
  scans structure top-to-bottom, sums mass-derived force from everything
  above a joint, compares to the material's strength; exceeding it snaps
  that connection. If it was the last connection to ground, the whole
  branch/building topples like a felled tree — not a scripted animation.
  https://www.eurogamer.net/articles/digitalfoundry-red-faction-guerrilla-big-bang-theory-article
- Built ON TOP of Havok (rigid bodies, vehicle sim, raycasts) — Havok's own
  engineers told Volition up front the stress/support idea "would NOT work,
  would put too much strain on their system." Custom destruction layer sits
  above Havok; heavy PS3 SPU-side customization was needed to hit framerate.
  Havok said RFG "stressed their code in ways no one else was coming close
  to." Same source.
- Environment art had to relearn structural modeling: buildings that "fell
  down in the engine" during dev because artists modeled static meshes with
  no real load path — had to add "proper steel beams" and real foundations
  so the solver would keep them up. Chunk pieces need extra unique textures
  (no instancing across broken faces) → real memory cost.
  https://www.theringer.com/2024/02/02/video-games/destruction-video-games-battlefield-bad-company-red-faction-battlebit-teardown-the-finals
- Audio is coupled to the stress signal directly: rising internal force
  triggers creak/groan cues before failure (tension sonification, not just
  post-hoc SFX).

**Published numbers / scope limits**
- Planning started ~2004, before X360 devkits or final PS3 hardware existed
  — pure bet, ~2 years before they could prove the concept worked at all.
- Terrain/ground is explicitly NOT destructible in Geo-Mod 2.0 (unlike Geo-Mod
  1) — cutting terrain under structures was judged too CPU-expensive on
  top of the stress sim. Destruction confined to man-made surface structures.
- Textures shipped lower-res than genre peers specifically to buy back RAM
  for the destruction system; the world map screen was implemented by
  UNLOADING the player's vehicle from memory to free space, then reloading it
  after — "literally stealing memory from other systems." Same Ringer piece
  (dev quotes from Matt Gawalek, RFG gameplay programmer).
- Console perf: variable 20–40 FPS on X360/PS3, no v-sync, >40% torn frames
  at 60Hz. PC (Core i7 920 + GTX275): 1080p high, drops only during big
  collapses. https://www.digitalfoundry.net/articles/digitalfoundry-red-faction-guerilla-pc-tech-comparison
- 16-player online multiplayer (vs. Bad Company 2's 32 the following year).
- Levels are compounds of separated buildings by design specifically so a
  collapse chain can't propagate past a handful of structures and blow the
  physics/rendering budget.
- Re-Mars-tered (2018, PS4/XOne) + Switch port (2019): purely a rendering
  upgrade (better textures/specular/crepuscular rays, tearing removed,
  dynamic resolution) — the stress/destruction SIMULATION itself is
  unchanged from 2009; Switch runs it on 3× 1GHz Cortex-A57 vs. the original
  3.2GHz PowerPC X360 cores and "works rather well," confirming the sim
  itself was always CPU-light relative to rendering.
  https://www.eurogamer.net/articles/digitalfoundry-2019-red-faction-guerrilla-switch-re-mars-tered-analysis

**Sucks-list**
- No published load-graph/connectivity representation ever — Volition never
  open a paper; everything above is reconstructed from interviews. Our own
  "stress from constraint-force readout" design (physics-recon.md §3) has
  no public prior to copy.
- Single monolithic material response ("felt like metal") — the stress model
  computes force thresholds per joint but public sources describe NO
  differentiated fracture behavior per material (no separate crumble/shatter
  visual language for stone vs concrete vs metal); look is uniform because
  chunks are pre-authored geometry, not simulated fracture.
- Never reused industry-wide in 15+ years — IGN (2019): "no one has reused
  Red Faction: Guerrilla's destruction technology... that is a disgrace."
  RFG's own sequel Armageddon (2011, added destruction REVERSAL) sold worse;
  Volition shut down 2023, IP now sits dormant at Plaion.
- Franchise commercial arc: RF1 profitable → declining slope → Armageddon
  "substantial loss" (THQ bankrupted 2012 partly on this). Market signal:
  destruction-as-core-mechanic didn't pay for its own R&D cost at the time.

## 2. Battlefield / Frostbite destruction evolution (DICE, 2008–2025)

**Architecture by generation**
- **Frostbite 1.0** (Bad Company, 2008): first Frostbite title, built
  explicitly to differentiate in a crowded FPS market and to make
  vehicle-vs-scenery combat feel right ("quite unsatisfying to drive your
  60-ton tank into a tree and the tree just says no" — Alan Kertz, DICE).
  Buildings can be blown OUT (walls/facades gone) but interior walls stay
  standing — structures cannot fully collapse yet.
  https://www.theringer.com/2024/02/02/video-games/destruction-video-games-battlefield-bad-company-red-faction-battlebit-teardown-the-finals
- **Frostbite 1.5, "Destruction 2.0"** (Bad Company 2, 2010): buildings can
  now lose structural integrity and fully collapse. Iron girders/reinforced
  concrete/elevated terrain stay indestructible (map-border control), but
  even those take superficial damage on hit — house rule: "if the player
  shoots at it, something should happen." 32-player online, bandwidth for
  destruction sync was the dominant cost ("substantially higher than other
  shooters" — Kertz) — solved with a player-relative importance bubble
  (everything <25 m = high priority, everything behind the camera
  deprioritized) rather than uniform replication.
- **Frostbite 2, "Destruction 3.0"** (BF3, 2011): players can now be killed
  by falling debris; SDF-based destruction masks for rendering (see
  physics-recon.md §3, Kihl SIGGRAPH 2010 talk — masks are render-oriented,
  no structural graph).
- **Frostbite 2/3, "Destruction 4.0 / Levolution"** (BF4, 2013): large-scale
  MAP CHANGES gated behind specific pre-authored trigger conditions, not
  free-form collapse. Concretely on Siege of Shanghai: 4 specific support
  pillars at the skyscraper base must be destroyed; once broken, a SCRIPTED
  collapse event plays, relocating the capture flag to ground level.
  Same mechanism on every Levolution map (Rogue Transmission's dish cables,
  Dawn Breaker's dual-valve bridge collapse, etc.) — confirmed by Reddit/dev
  consensus: "It is scripted, always has been... the networking for that
  \[free-form\] at the scale Battlefield operates just is not feasible."
  https://www.reddit.com/r/Battlefield/comments/1n7izyz/
  https://www.ign.com/wikis/battlefield-4/Siege_of_Shanghai
- **BF1/V/2042**: perceived destruction DECLINE — urban WWI/modern settings
  lean on big indestructible buildings to delineate paths; series never
  matched Bad Company 2's granularity again until BF6.
- **BF6 (Oct 2025)**: engine "majority rebuilt," destruction system
  explicitly revamped away from Levolution-style set pieces — dev quote:
  pre-canned destruction "becomes unspectacular" over time; goal is dynamic,
  not scripted, moment-to-moment destruction again.
  https://en.wikipedia.org/wiki/Frostbite_(game_engine)
  https://www.reddit.com/r/Battlefield/comments/1mh99lo/

**Why Frostbite never went fully dynamic (root causes, per DICE devs)**
- No occlusion once walls are destructible: a solid wall lets the engine
  skip rendering whatever's behind it; a destructible wall means the engine
  must be ready to draw/calc whatever COULD be revealed at any time — a
  permanent rendering tax, not just a physics one.
- Dynamic lighting cost: knocking a hole in a room exposes it to new light;
  a dynamically-lit room costs far more render budget than a statically
  baked/lightmapped one — full destructibility forecloses baked lighting
  as an option project-wide.
- Competitive-integrity argument (Kertz): "Would Counter-Strike be better if
  I could blow a hole in the wall to get to the guys?" — predictable,
  esports-legible maps are in tension with player-authored destruction;
  BattleBit tournaments explicitly BAN certain explosives to stop wall-breach
  cheese.
- ROI napkin math (Kertz): "if I can build two houses for the price of one
  destructible house and get two levels instead of one, is that worth more
  to players than one really highly destructible house?" — publishers
  reportedly never ran hard numbers proving destruction pays for its
  dev cost.
  All three points: https://www.theringer.com/2024/02/02/video-games/destruction-video-games-battlefield-bad-company-red-faction-battlebit-teardown-the-finals

**Sucks-list**
- Destruction is PR-legible but production-expensive in a way that never
  compounds: every new map still needs bespoke Levolution scripting, not a
  general capability — 15+ years in, DICE ships "trigger four pillars →
  play canned collapse," the same shape as BF4 in 2013.
- Series' own community consensus by 2021 (BF2042) was that Frostbite
  destruction had been quietly rolled back for a decade; DICE's own comms
  conceded the novelty just "wore off" rather than defending an unbroken
  tech trajectory.

## 3. Crysis / CryEngine — vegetation touch-bending + jointed breakables

**Architecture — vegetation (published, GPU Gems 3 ch.16, Tiago Sousa/Crytek)**
- Two-layer procedural animation on GPU: (1) MAIN bending — per-instance wind
  vector (sum of directional/omnidirectional wind sources, computed like a
  light-source sum) deforms the whole plant along wind direction, damped
  over time when wind stops; (2) DETAIL bending — leaves only, driven by an
  artist-painted per-vertex RGB map (R = leaf-edge stiffness, G = per-leaf
  phase offset so leaves don't move in lockstep, B = overall leaf stiffness,
  A = precomputed AO). Waves approximated with cheap triangle waves +
  cubic-smoothed (`SmoothTriangleWave`), NOT sine, for GPU cost.
  https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis
- "Touch bending" (physical, not just wind) is a separate CryEngine asset
  system (docs, not the GPU Gems chapter): a proxy collider on the tree
  triggers physicalized leaf response on contact/break — leaves get
  physicalized once the tree is destroyed and fall to ground individually.
  https://docs.cryengine.com/display/CEMANUAL/Vegetation+05+Trees+(Breakable)+3dsMax
- Tree CHOPPING is authored as a "breakable" vegetation asset: a cut plane
  separates trunk into pieces at authored break points; non-breakable
  foliage clusters are reassigned to whichever broken piece they belong to
  and their touch-bending reactivates on the new piece.
  https://docs.cryengine.com/pages/viewpage.action?pageId=24285901

**Architecture — building/object destruction (CryEngine "Breakable Objects")**
- Jointed Breakable Objects: artists model ALL pieces of the unbroken object
  in their final resting positions in one CGF asset (no instancing — shared
  geometry across pieces isn't allowed, a direct memory cost). Pieces are
  connected by an **internal breakable joint** system: each joint carries
  independent limits — Max Push/Pull/Shift Force, Max Bend/Twist Torque —
  plus a damage-accumulation fraction/threshold (so repeated sub-critical
  hits accumulate toward failure, not just one-shot force checks). On
  breach, the joint either fully separates (piece becomes a rigid PE_RIGID
  body) or — if only the twist limit broke — downgrades to a live 1-DOF
  hinge constraint (bend limit break → 2-DOF constraint) instead of fully
  disconnecting, letting a door-like partial break happen before full
  detachment. https://www.cryengine.com/docs/static/engines/cryengine-5/categories/23756816/pages/56655880
- Separate VOLUMETRIC fracture path exists alongside the joint system:
  console/cvar evidence (`p_lattice_max_iters` "limits iterations of lattice
  tension solver", `p_log_lattice_tension`, debug draw flag `l` = "show
  tetrahedra lattices for breakable objects") confirms CryEngine also runs a
  tetrahedral-lattice tension solver for "2D and 3D Procedural Breaking" —
  i.e. runtime fracture of a solid volume, distinct from the pre-authored
  jointed-piece system used for most set-dressing.
  https://www.cryengine.com/docs/static/engines/cryengine-3/categories/9895942/pages/9215960
- Asset taxonomy matters for perf: docs explicitly rank "Brush" (physics
  only, no script access, cheapest) < "Basic Entity" < "Breakable Entity"
  (full FlowGraph/script access + procedural crack params, most expensive)
  — CryEngine pushes authors to the cheapest tier that does the job.
  https://www.cryengine.com/docs/static/engines/cryengine-5/categories/23756816/pages/23308020

**Sucks-list**
- CRYTEK/CRYENGINE GitHub is source-available but access-gated behind a
  linked CRYENGINE account — `git clone` and GitHub code search both 401/404
  for an anonymous session (verified 2026-07-16: plain `git clone` asks for
  a username, `curl -I` on the repo root 404s, `api.github.com/search/code`
  requires auth, grep.app returns a bot-check page). Could NOT read actual
  source; every claim above is from official docs/GPU Gems only, not code.
- Jointed breakables are explicitly called out in Crytek's own docs as
  "a complex object that has a big impact on performance regarding
  drawcalls, memory impact and physics calculations" — this is Crytek
  self-reporting the cost, not a critic.
- No instancing across broken pieces (docs: "pieces that share geometry...
  don't save memory") — every destructible asset pays full unique-mesh
  memory whether or not most of its chunks are geometrically identical.

## 4. Mercenaries: Playground of Destruction (Pandemic Studios, 2005)

**Architecture**
- Proprietary "Zero" engine (Pandemic's in-house engine, also used for
  Battlezone II and early Star Wars: Battlefront titles) + Havok physics
  integrated specifically for Mercenaries' debris/ragdoll simulation.
  https://en.wikipedia.org/wiki/Pandemic_Studios
- Destruction model: **every building has ONE unique, pre-authored collapse
  ANIMATION**, not a simulated structural failure — confirmed directly by
  the Pandemic Studios wiki: "Every building in the game is destructible and
  has a unique collapse animation." This is categorically different from
  RFG's stress solver: no continuous force propagation, no partial-support
  states, just damage-threshold → play canned demolition clip → spawn Havok
  debris/rubble for the aftermath.
  https://pandemicstudios.fandom.com/wiki/Mercenaries:_Playground_of_Destruction
- Debris/dust/fire are the showcase, not structural logic — contemporary
  reviews single out physical debris flying + dust obscuring vision as the
  standout tech, i.e. the sell was PARTICLE/DEBRIS FIDELITY on top of
  scripted collapse, not simulated support.
- No public GDC talk, Gamasutra postmortem, or dev retrospective on the
  destruction tech specifically was found (checked Wikipedia, Grokipedia,
  ModDB/IndieDB Zero-engine pages, Old School Gamer interview with lead
  programmer Ronald Pieket — none go past "we used Havok for debris").
  Studio closed 2009; Zero engine's internals are effectively undocumented
  publicly.

**Sucks-list**
- Scripted-per-building = doesn't generalize: every destructible asset in
  the game needed its own hand-authored collapse animation — an O(n)
  content cost per building rather than an emergent system, the opposite of
  RFG's later approach 4 years later on the same generation of hardware.
  This is likely WHY Mercenaries never gets cited alongside RFG/Bad Company
  in "great destruction tech" retrospectives — it's mentioned only as
  a game that HAD destruction, in passing, in every source found, never
  analyzed as its own technical achievement.
- Total black box: unlike RFG (Digital Foundry got a full dev interview) or
  Battlefield (Ringer got Kertz/Gawalek/Högström on record), NOBODY
  published how Zero/Havok integration actually worked. Cannot verify claims
  about "procedural debris generation" (Grokipedia) beyond that one
  secondary source.

## 5. Others (lighter pass)

**Control (Remedy, 2019)** — see physics-recon.md §3: material-metadata +
procedural rules, 3 destruction layers (rigid chunks / mesh-particles+decals
/ particles), explicitly NO support propagation (confirmed by GameDeveloper
source already in evidence file). Sucks: no structural graph either, same
gap as everyone else pre-DreamForge.

**The Finals (Embark Studios, 2023–present)** — runs on Unreal Engine 5's
Chaos Physics: Voronoi-based rigid-body fracture, but the load-bearing
technical claim is that ALL destruction runs on a dedicated **authoritative
server**, not per-client — server computes each collapse ONCE, broadcasts
synchronized state, eliminating client-side prediction/desync entirely (no
player can see cover that doesn't exist on another player's screen).
GDC talk exists ("Engineering Mayhem: Technical Deep-Dive into Environmental
Destruction in THE FINALS," gdcvault.com/play/1034307, paywalled — abstract
only: destruction "enables most of the environment to be destroyed,
buildings to collapse, and debris... to re-shape the play-space, all while
being physically simulated"). Season 8 (Sep 2025) shipped "Smooth
Destruction," upgrading from largely independent local breaks to CASCADING
structural impacts — a falling structure transfers kinetic energy to
whatever it contacts, so collapse direction is now player-influenced
(destroy one side of a base → tower falls that way) rather than a fixed
canned animation; Galaxy Estates (Season 11, Jul 2026) is their first map
authored FOR Smooth Destruction from scratch rather than retrofitted.
PS4 support was dropped specifically because synchronized multi-body Chaos
Physics events + UE5 Lumen/Nanite exceeded Jaguar CPU/GDDR5 bandwidth.
Server-side physics justified on latency grounds too (per Embark: keeping
destruction state server-side avoids client rubber-banding).
https://www.reddit.com/r/thefinals/comments/18btn17/
https://naavik.co/digest/embark-technology-first-studio/
https://www.techtimes.com/articles/319995/20260709/finals-galaxy-masters-live-melee-gets-precision-stamina-systems.htm
Sucks: still UE5 Chaos underneath — no evidence Embark rolled a bespoke
solver; their innovation is architectural (server authority + cascading
energy transfer), not a new fracture algorithm.

**Noita (Nolla Games, 2019)** — 2D falling-sand cellular automaton, "every
pixel simulated." Bottom-up single-buffer sweep per material (sand: try
down → down-left → down-right; water: same + sideways; gas: inverted/up­ward
sweep) — explicitly NOT a true double-buffered CA (dev Petri Purho, GDC
talk) because double-buffering a sand sim doesn't parallelize cleanly
(write conflicts when multiple pixels target one destination cell) and
would cost MORE than single-buffer, not less. World divided into 64×64
chunks for multithreading (chunk-level dirty-rect/active-region skipping
implied). Static materials like stone stay inert UNTIL a large-enough
explosion flags contacted pixels as "good candidates" and converts them to
active falling-sand material on the spot — collapse is a MATERIAL STATE
FLIP, not a separate structural system. Rigid bodies are pixel COLLECTIONS
that track membership + local offset; destroying a member pixel triggers a
shape recompute that can SPLIT one rigid body into two. Chunk collapse
(buildings) reuses the same falling-pixel machinery, just carving rigid-body
shapes out of the newly-freed material instead of single loose pixels.
https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation/
https://blog.macuyiko.com/post/2020/an-exploration-of-cellular-automata-and-graph-based-game-systems-part-4.html
(GDC talk: gdcvault.com/play/1025695, paywalled)
Sucks: 2D only — the single-buffer bottom-up trick that makes this tractable
depends on gravity having one consistent direction per material sweep; the
inherent-parallelism problem gets much harder in 3D voxels (this is
Teardown's whole separate lineage, see physics-recon.md §1).

**Besiege (Spiderling Studios, Unity/PhysX)** — confirmed dev-forum answer:
runs on stock Unity PhysX rigid bodies + joints (HingeJoint etc.), NOT a
custom solver. Structural "failure" is emergent from PhysX joint break
limits, not an authored stress system — community mods exist specifically
to expose/raise PhysX's own solver-iteration and joint-break thresholds
because default Unity settings visibly jitter/fail under large machine
assemblies. https://steamcommunity.com/app/346010/discussions/0/135513901704426735/
Sucks: thinnest entry in this survey — no official postmortem, only a forum
one-liner confirming the base tech; Besiege's "destruction" is really
large-scale joint-based soft-machine collapse, closer to a design toy than
a structural-destruction case study.

## Read-through (ghoul, non-binding)

- RFG is still the ONLY shipped title with a genuine continuous stress
  solver driving collapse (not scripted, not per-object damage threshold).
  Nobody has matched or open-sourced it in 15+ years — confirms
  physics-recon.md's "open ground" call on structural load graphs.
- Frostbite's Levolution and Mercenaries' per-building animations are the
  SAME pattern at different scales: pre-authored collapse clips gated by a
  damage threshold. This is the industry default; RFG and (partially) The
  Finals are the exceptions, not the rule.
- The Finals is the one shipped precedent for SERVER-AUTHORITATIVE
  multiplayer destruction at scale — directly relevant if GAIA-World ever
  needs networked solver-native destruction; their answer was "compute once
  on the server, broadcast state," not client-side prediction/reconciliation.
- CryEngine's internal-joint damage-accumulation-fraction (repeated
  sub-critical hits count toward failure) is a small, concrete, DIRECTLY
  reusable idea distinct from RFG's instantaneous-force check — worth
  cross-referencing against our own constraint-force stress design.
- Every source in this survey converges on the same two-cost argument for
  why destruction stays niche: (1) render cost of losing static occlusion +
  baked lighting once anything can open up, (2) content-authoring cost
  scaling per-asset (RFG's steel-beam remodeling, Mercenaries' per-building
  animation, CryEngine's no-instancing memory tax). A solver-native /
  procedural approach (ours) is explicitly the bet that skips cost (2).
