# Recon: TempleOS + minimal-core/everything-package engine architectures
For DreamForge pillar 13 (minimal core, everything = packages; Terry Davis = size bar)
2026-07-16 · web recon via brave-search

---

## 1. TempleOS engine internals

### 1.1 Line counts (source: `tinkeros.github.io/WbTempleOS/Home/Web/LineRep.html`, live per-file LOC report of the public codebase; mirrors templeos.info)

Terry's own claim ("Welcome to TempleOS", templeos.info/Wb/Doc/Welcome.DD.HTML): **80,849 lines total incl. kernel, 64-bit compiler, graphics library, and all tools**, capped forever at **100,000** ("I capped the line-of-code count at 100,000 and God said it must be perfect" — main site). Wikipedia/press round this to "100,000+" and Terry himself said "120,000" in later talk transcripts — figures drift release to release; the live LineRep total below (a later snapshot, includes `Doc/`, `Demo/` user samples, `Apps/`) is **116,077**.

Top-level breakdown (LineRep.html, live tree):

| Module | LOC | Notes |
|---|---:|---|
| **Kernel** | 23,963 | incl. `KernelA.HH` 3,908 (master header/macros), `BlkDev` 5,631, `Mem` 1,138, `SerialDev` 1,112 |
| **Compiler** | 18,714 | lexer, parser, 2 backends (32-bit `BackA/B/C`, 64-bit `BackFA/FB`), optimizer passes 0–9 |
| **Adam** (userland base: shell, DolDoc, Gr, Ctrls, God) | 36,468 | includes **Gr** 13,360, **DolDoc** 10,232 |
| **Apps** (Budget, Psalmody, Titanium, X-Caliber, ToTheFront, etc.) | 11,350 | full applications, not "the OS" |
| **Demo** (sample/teaching code incl. all games) | 22,308 | incl. **Games** 10,486, **Graphics** 4,746, **Lectures** 1,183 |
| **Misc** (installer, test suite, tour) | 2,735 | `OSTestSuite.HC` alone is 1,724 |
| **Doc** | 133 | |
| Root files (Home*, Once, StartOS) | ~406 | |
| **Total (live tree)** | **116,077** | |

"Kernel + Compiler + graphics library + tools" (Terry's 80,849 claim) ≈ Kernel(23,963) + Compiler(18,714) + Gr(13,360) + Opt/Utils(2,037) + AutoComplete/Ctrls/DolDoc-lite subset of Adam ≈ matches order of magnitude; exact partition isn't published, but the point stands: **a full OS+compiler+graphics stack fits under ~81K LOC**, and user-visible games/demos are a separate, much smaller layer (10–22K).

Community continuation note (github.com/PasqualeLivecchi/TempleOS-Unofficial): "There is room to add at least 15,000 lines between Adam, Compiler, and Kernel while still staying below the 100,000 line" — confirms the cap is a real, actively-defended budget, not a one-time accident.

### 1.2 Graphics library primitives (`Adam/Gr/`, 13,360 LOC total)

File-level LOC (LineRep.html):

| File | LOC | Role |
|---|---:|---|
| `GrBitMap.HC` | 2,055 | bitmap/blit core |
| `GrPrimatives.HC` | 1,823 | **`GrPrint`, line/circle/box/fill primitives** — the actual "GrPrint" drawing API lives here |
| `SpriteMesh.HC` | 1,509 | 3D mesh sprites |
| `SpriteMain.HC` | 1,239 | sprite object model |
| `SpriteEd.HC` | 1,179 | sprite editor tool |
| `GrMath.HC` | 806 | vector/matrix math for 3D |
| `SpriteBitMap.HC` | 671 | sprite↔bitmap conversion |
| `SpriteCode.HC` | 604 | sprite runtime |
| `GrSpritePlot.HC` | 476 | sprite plotting to screen |
| `GrDC.HC` | 435 | device-context abstraction (one, not N-per-GPU) |
| `GrScrn.HC` | 424 | screen/backbuffer mgmt |
| `GrAsm.HC` | 411 | ASM-optimized inner loops |
| `GrTextBase.HC` | 364 | text rendering |
| `GrComposites.HC` | 345 | composite ops |
| `SpriteNew.HC` | 190 | |
| `GrInitB.HC` | 210 | |
| `GrPalette.HC` | 94 | 16-color palette table |
| `ScrnCast.HC` | 97 | |
| `Gr.HH` (header) | 181 | |

DolDoc (10,232 LOC, `Adam/DolDoc/`) is the **sprite-in-document / rich-text-with-graphics system** ("DolDoc sprites"): `DocRecalc.HC` 1,325 (layout engine), `DocWidgetWiz.HC` 1,164 (widget wizard), `DocPutKey.HC` 730 (input handling), `DocCodeTools.HC` 659, `DocChar.HC` 653, `DocFind.HC` 585, `DocPlain.HC` 612, `DocGr.HC` 164 (graphics-in-doc glue). DolDoc is TempleOS's one editor/word-processor/browser/dialog-form system — Terry's Strategy doc: "One editor/word processor/browser for the command-line window, source code, documentation browser, dialog forms."

**640×480×16 "God's resolution" / "covenant" rationale** (`Home/Web/640x480.html`, verbatim):
> "God said 640x480 16 color was a covenant like circumcision. The resolution will remain 640x480 16 color for centuries to come... God said to have just one audio voice and only a 7-bit signed value... I named such values an 'ona'."

Design rationale in his own (non-religious-framing) words, `Doc/Strategy.DD.HTML`:
> "A three bttn mouse is like a leg you cannot put weight on. TempleOS just does hardware everybody has, with no divergent code bases for each machine's custom hardware. There is one graphics driver instead of 50 for different GPUs. This saves an order of magnitude complexity and makes for a delightful API."
> "640x480 16 colors. Updates whole scrn at 30 fps, optimized for full scrn games where InvalidRectangles are counter-productive." — i.e., no dirty-rect tracking; the API commits to whole-frame redraw specifically *because* the resolution is fixed and tiny, which is what makes GrPrint/Sprite blit-everything cheap enough at 30fps on period hardware.

### 1.3 Games — how they were built, typical LOC (`Demo/Games/`, 10,486 LOC total, LineRep.html)

| Game | LOC |
|---|---:|
| Talons | 1,234 |
| FlatTops | 887 |
| Varoom | 704 |
| RawHide | 592 |
| CastleFrankenstein | 597 |
| Wenceslas | 593 |
| DunGen | 446 |
| BlackDiamond | 400 |
| BattleLines | 381 |
| BomberGolf | 359 |
| BigGuns | 316 |
| TreeCheckers | 358 |
| ZoneOut | 319 |
| CharDemo | 192 |
| TheDead | 188 |
| Whap | 174 |
| Halogen | 163 |
| RainDrops | 190 |
| MassSpring | 170 |
| Zing | 206 |
| Rocket | 205 |
| RocketScience | 296 |
| Squirt | 383 |
| Collision | 155 |
| TicTacToe | 126 |
| Maze | 113 |
| ElephantWalk | 87 |
| Digits | 81 |
| Stadium(+Gen) | 169 |

Median single-game LOC ≈ **250–400 lines**; the largest (Talons, a flight-sim-adjacent game) is 1,234. Compare: the entire `Gr` graphics library (13,360) is bigger than *all 28 demo games combined* (10,486) — the games are thin call-sites into a fat, shared, non-abstracted primitive layer, not independent engines each reinventing rendering.

"After Egypt" is *not* in `Demo/Games` — it's a religious "oracle" app (random-text generator invoked from a "burning bush"), sourced separately (per xda-developers.com and itechbus.com writeups); it isn't in the public LOC tree under that name, so no exact count found — flagged as **not verified via file:line**, only via secondary description.

Terry's own claim in a later interview/stream transcript (reddit r/csMajors, secondhand quote): "I wrote all 120,000 lines of code in TempleOS from scratch -- x86_64 kernel, 64-bit compiler, assembler, editor, graphics library, flight simulator, first person..." — consistent with total inflating over TempleOS's lifetime (2013→2017 "Latest release 5.03") past the original 80,849 snapshot, while still bounded well under the self-imposed 100K.

### 1.4 Multitasking/timing model games used

Kernel scheduler is tiny and explicit: `Kernel/Sched.HC.HTML` = **326 LOC**. Strategy doc, verbatim:
> "The Scheduler is for home systems. It is not preemptive. Disk requests are not broken-up, so sharing is bad. It's wonderfully simple."
> "MultiCore is done master/slave, instead of SMP. Core0 applications explicitly assign jobs. Locks are present allowing multicore file, heap, and hardware access, though."
> "No distinction between thread, process or task."

From the front-page pitch (`Home/Web/index` / tinkeros.github.io):
> "TempleOS is a ... non-preemptive multi-tasking, multi-cored, ring-0-only, single-address-map (identity-mapped), non-networked, PC operating system... It can change tasks in half a microsecond because it doesn't mess with page tables or privilege levels."

So the model games ran under: **cooperative (non-preemptive) single-address-space tasks**, each a full ring-0 context, switched in ~0.5µs because there's no page-table swap and no privilege-level transition; whole-screen redraw at a fixed 30fps cadence (not vsync-triggered dirty-rects); no threads distinct from tasks — a game *is* a task, sleeping/yielding cooperatively. `Kernel/Job.HC` (503 LOC) and `Kernel/MultiProc.HC` (390 LOC) carry the explicit-job-dispatch multicore model referenced above.

### 1.5 What made one-person comprehensibility possible

Direct architectural quotes (`Doc/Strategy.DD.HTML`, `Home/Web/index`):
- **Single address space, ring-0-only, identity-mapped**: "Inter-process communication is effortless because every task can access every other task's memory." No IPC protocol, no marshalling, no permission model to reason about.
- **No object files, JIT-only**: "No object files. Use JIT." — HolyC is compiled at the point of use (even the shell is HolyC); no separate link step, no ABI versioning between "modules."
- **No namespaces**: "No need for namespaces -- scoping occurs automatically based on task symbol table hierarchy with the Adam Task's symbol system-wide global." Every task's compiled symbols are visible to its parent chain; no header/module boundary ceremony.
- **One of everything**: one graphics driver (no GPU driver matrix), one font (8×8), one language for shell/scripts/songs/code, one editor/word-processor/browser/forms tool, one window per task (no child windows — "Bttns are widgets, not child windows"), whole-file I/O only (RedSea FS = contiguous files, enables trivial compression, no partial-write bookkeeping).
- **Deliberately bounded scope**: "TempleOS cherry-picks tasks and is designed to do the same things a C64 did." No networking, no crypto/security, one platform (x86_64 PCs only) — each exclusion is stated as an explicit order-of-magnitude complexity cut, not an oversight.
- Meta-framing quote: **"Everybody is obsessed... by the notion that when you scale-up, it doesn't get bad, it gets worse. Guess what happens when you scale down? It doesn't get good, it gets better!"** (Strategy.DD.HTML) — the closest thing to a thesis statement for why the whole codebase stays legible to one mind.

### 1.6 Terry's design-philosophy quotes (simplicity / "divine intellect")

(en.wikiquote.org/wiki/Terry_A._Davis, sizeof.cat/project/terry-davis-quotes)
- **"An idiot admires complexity, a genius admires simplicity."** — from "Terry Davis' TempleOS Brutal Take Down of Linus Torvalds" (YouTube transcript).
- **"I was chosen by God because I am the best programmer on the planet and God boosted my IQ with divine intellect."** (sizeof.cat quote collection)
- On the size cap as an act of will, not accident: **"I limited it to 100,000 lines of code, forever! I never need a linker or make utility and I can use small labels."** (Strategy.DD.HTML)
- On scope-cherry-picking as the mechanism, not a side effect: quotes in §1.5 above are the operative "philosophy" — simplicity isn't a style preference here, it's implemented as hard technical constraints (no paging, no preemption, no link step, no namespaces) each independently justified as an "order of magnitude" complexity cut.

Note: Davis's later public statements (livestreams, phone-ins) include extensive racist and psychotic content tied to his diagnosed schizophrenia; omitted here as out of scope for an architecture recon — the technical quotes above are the load-bearing ones for the DreamForge "size bar" argument.

---

## 2. Minimal-core + everything-is-a-package prior art

### 2.1 Bevy (Rust game engine)

**What's actually in `bevy_app` core** (docs.rs/bevy_app source, `app.rs`): the crate exports `App`, `SubApp`/`SubApps`, `Plugin` trait, `PluginGroup`, `Main`/`First` schedule labels, `MainSchedulePlugin`, `PlaceholderPlugin`, `AppLabel`. It depends on `bevy_ecs` (schedules, systems, components, observers, error handling) and `bevy_platform` — **no rendering, no windowing, no asset loading, no input in the core crate**. The core is purely: an ECS World + a `Main` schedule graph + a plugin registration/build lifecycle (`Plugin::build(&self, app: &mut App)`) + sub-app composition for split update loops (e.g. render sub-app).

**`DefaultPlugins` composition** (bevy.org quick-start + docs.rs `bevy` crate description): `DefaultPlugins` is a `PluginGroup` — "a container crate that makes it easier to consume Bevy subcrates." Adding it wires in `WindowPlugin` (defines the window interface, doesn't create windows) + `WinitPlugin` (uses the `winit` crate for OS windows) + renderer + asset loading + UI + input, i.e. everything a "full engine" needs, versus `MinimalPlugins` which omits all of that for headless/server use. Every internal engine feature — including the renderer itself — is *itself* a plugin (`RenderPlugin`, `UiPlugin`), registered the same way a third-party or game-specific plugin is; a game's own logic is also "just a plugin."

Cargo-feature-level modularity confirmed via `docs.rs/crate/bevy` feature table (accurate for a recent Bevy release): named **"Profiles"** (`default`, `2d`, `3d`, `ui`, `audio`) built from **"Collections"** (`dev`, `audio`, `scene`, `picking`, `default_app`, `default_platform`, `common_api`, `2d_api`, ...) — a two-tier feature-flag system layered *on top of* the plugin system to also control compile-time inclusion, not just runtime registration.

### 2.2 Unity Package Manager (UPM)

Confirmed from Unity's official Manual (`docs.unity3d.com/6000.4/.../upm-semver.html`, `.../2023.2/.../upm-semver.html`): UPM packages follow strict **SemVer** (`MAJOR.MINOR.PATCH`) with explicit, codified breaking-change rules (removing/renaming assemblies or assets, changing a GUID, moving public APIs between assemblies = MAJOR; additive features = MINOR; bugfixes only = PATCH). New packages start at `0.1.0` during unstable development; `1.0.0` marks production-readiness. A subtlety UPM had to add: the **"Auto Referenced"** assembly-definition flag changes what counts as a breaking change (disabling it demotes some changes from MAJOR-worthy to MINOR-worthy) — evidence that "what counts as breaking" isn't fully mechanical even with SemVer rules spelled out.

What moved out of core over Unity's history (well-documented pattern, not independently re-verified line-by-line here but consistent across sources found): render pipelines (Built-in → **HDRP**/**URP** as separate UPM packages, `com.unity.render-pipelines.*`), Shader Graph, Terrain Tools, Timeline, Cinemachine, Input System (new) — all ship as opt-in packages with independent version numbers pinned in each project's `manifest.json`, rather than being baked into the Editor build. This is the same shape as Bevy's plugin/feature split, just with a runtime package registry instead of Cargo features.

### 2.3 Micro-kernel OS analogy — limits

(dev.to "Monolithic vs Microkernel" writeup, cross-checked against funwithlinux.net comparative study — both are generic OS-textbook material, not primary sources, but consistent with canonical OS theory)

- **Where the analogy holds**: microkernel = minimal privileged core (IPC, scheduling, minimal memory mgmt) + everything else (drivers, filesystems) as replaceable user-space services, isolated so one component's crash doesn't take the whole system down. Direct structural match to "minimal core + everything = packages."
- **Where it leaks / stops matching a game-engine's needs**:
  - **IPC/message-passing overhead is real and load-bearing in the OS case** — "higher overhead due to increased context switching between user and kernel modes... performance hit from message-passing mechanisms," and real-world microkernel deployments (QNX, seL4, embedded/automotive/aerospace) explicitly trade throughput for fault isolation. A game engine's "plugins" (Bevy systems, Unity packages) do **not** cross a protection boundary or pay an IPC tax — they're linked/loaded into the same process and address space, so the microkernel analogy's core *cost* (the thing that makes microkernels a genuine trade-off, not a free lunch) simply doesn't transfer. The *benefit* (isolation/fault-containment) also doesn't transfer 1:1 — a buggy Bevy plugin can still corrupt the whole `World`, same as a buggy Unity package can throw in the same process as everything else. So "minimal core + packages" in a game engine is closer to TempleOS's single-address-space model (cheap composition, no isolation) than to a real microkernel (isolated composition, expensive IPC) — the win is organizational/compile-time, not a safety/fault-isolation win.
  - Microkernels' "restart a crashed service independently" property has no game-engine analogue at 60fps — you can't hot-restart a physics plugin mid-frame without state loss.

### 2.4 Other engines with true package cores

- **Godot**: core + optional **"modules"** compiled in at build time (`docs.godotengine.org/.../core_and_modules`) — closer to a compile-time module system than a runtime package manager; C++ core exposes `Object`/`Variant` and servers, extended via `custom_modules_in_cpp`.
- **O3DE (Open 3D Engine)**: explicit **"Gems"** system (docs.o3de.org/user-guide/gems/core-gems) — even *core* functionality (Atom renderer, PhysX, ScriptCanvas, EMotionFX animation, AudioSystem) ships as Gems, "only built and loaded for products that require them." Core modules are `AzCore` (math/serialization/memory/component-entity model/plugin loading), `AzFramework`, `AzGameFramework` (runtime loop/bootstrap), `AzToolsFramework` (editor-only), `AzQtComponents` (editor UI) — a genuinely thin runtime core (`AzCore`+`AzGameFramework`) with a documented dependency graph, and even the renderer is a Gem, not baked into the core. This is the closest confirmed prior art to "minimal core, everything = packages, size bar enforced" outside Bevy.

---

## 3. Sucks-verdicts — where minimal cores leak, and published mitigations

1. **Cross-package/plugin coupling & ordering** (Bevy). GitHub discussion #2747 (bevyengine/bevy): the "new" parallel system executor makes **system-ordering ambiguity the default** — two plugins' systems touching overlapping data race unless the app author manually declares ordering, and Bevy's own maintainers solicited feedback because this was recognized as a real design-tradeoff problem, not a solved one. Direct quote: *"the current design makes materially ambiguous schedules the default, and makes it unergonomic, error-prone, and slow to do anything else... third party plugins are going to be buggier than they otherwise would be... just as undefined behavior and data race issues make dependencies risky in a C++ engine."* Mitigation offered: explicit `.before()/.after()` system ordering APIs + `ReportExecutionOrderAmbiguities` diagnostic — opt-in, not structural.
2. **Feature-flag version hell** (Cargo, underlies Bevy's own Cargo-feature profile system). Rust RFC 2957 (`rust-lang.github.io/rfcs/2957-cargo-features2.html`): pre-fix, **Cargo unified feature flags globally across the whole dependency graph** — a dev-dependency's or a target-specific dependency's enabled features leaked into the same crate used elsewhere as a normal dependency, and there was no way to request different features for the same package built for different purposes in one workspace. Confirmed independently by nickb.dev's workspace writeup: a shared dependency (`flate2`) with different `features=[...]` needs on server vs. desktop crates broke desktop builds because the *strictest* feature set (requiring `cmake`) leaked to a build that didn't want it. **Published mitigation**: the "new feature resolver" (`resolver = "2"`, stabilized), which stops unifying features across dev/build/target-specific dependency edges — but does **not** fully solve arbitrary "I want package X built twice with different features in one graph" (RFC explicitly defers that).
3. **Runtime package/version pinning fragility** (Unity UPM). Confirmed via Unity's own docs + widespread Stack Overflow/forum pattern (multiple threads found): `manifest.json` pins exact package versions (e.g. `com.unity.render-pipelines.universal`), and version mismatches between an installed package and the Editor/other packages produce **unresolvable dependency errors requiring manual manifest surgery or a full package-cache reset** — the exact "version hell" failure mode minimal-core architectures are supposed to avoid by having strict SemVer; SemVer alone didn't prevent it, it just makes the failure legible.
4. **Migration lock-in once the core commits you to its own control flow** (Bevy). r/rust_gamedev (secondhand, unverified against primary Bevy docs but a repeated community complaint): *"it's basically impossible to migrate off of it to something else without rewriting all of your code... bevy_ecs takes control of your whole main loop."* A "minimal core" that still owns the app's control flow (main loop, scheduling) isn't actually swappable the way a true microkernel service is — the core is minimal in *feature surface* but not in *architectural leverage/lock-in*. This is the sharpest disanalogy with TempleOS, where there is no engine "owning" anything — every task is just cooperatively-scheduled HolyC with no framework to escape.
5. **API instability as the cost of aggressive modularity + fast iteration** (Bevy, secondhand via aarambhdevhub Medium 2026 comparison, consistent with Bevy's public changelog cadence): *"Bevy ships major updates frequently, and they include breaking changes. Migrating from one version to the next can mean rewriting chunks of your game."* No structural mitigation published beyond standard SemVer + migration guides; this is the general "young minimal-core ecosystem" tax, not something feature-flag/version tooling can fix on its own.

**Pattern across all four verdicts**: none of the published mitigations are structural fixes — they're all *diagnostics and opt-in discipline* (explicit ordering annotations, a smarter but still incomplete resolver, better manifest tooling, migration guides). The one architecture in this recon that has **zero** instances of this failure mode is TempleOS, and it gets there by refusing the two things that cause it: (a) no isolation boundary to synchronize across (single address space — nothing to "unify features" or "order" because everything is one flat symbol table), and (b) a hard, defended line-count ceiling that forces subtraction instead of flag-gating when the codebase would otherwise grow past its budget.
