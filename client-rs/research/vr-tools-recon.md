# VR Content-Creation Tools Recon — for GAIA DreamForge spec
Compiled 2026-07-16. Sources inline.

---

## 1. TVORI (tvori.co) — Pascal's reference tool

**STATUS: ALIVE.** Founded 2016 (Dmitry Kurilchenko + Viktor Komarovskih, Russia-based
devs, SF-registered co). Unfunded/bootstrapped per Tracxn, 21 employees as of Apr 2026,
80 tracked competitors. tvori.co live, Steam page active (still "Early Access" tag,
last Steam dev note >5yr old but company site is current). No pivot/shutdown found —
Pascal's "greatest VR creation engine" call checks out as a going concern, not a corpse.
[tracxn.com/d/companies/tvori, tvori.co, store.steampowered.com/app/517170]

### Feature inventory
- **Puppeteering / mocap-style capture**: hit record, grab an object/character with a
  controller, move it like a toy — controller pose is recorded in real time as the
  animation curve. Two hands = two channels simultaneously (camera in one hand, prop
  in the other). This is literally "record-per-object performance capture," not full-
  body IK — you're animating whichever part you're holding.
  [uploadvr.com/tvori-now-available, animateclay.com]
- **Second animation mode — pose-to-pose / keyframe**: added in v0.3 (per UploadVR
  major-update piece), lets you set keyframes explicitly + add curves to travel paths
  for fine control, "familiar to anyone who's used Quill." Complements the real-time
  puppeteering mode — pick per shot.
- **Camera as a handheld object**: literally "pick up the camera, hit record, walk/fly
  it through the scene" — same recording pipeline as puppeteering a prop. Early
  criticism (UploadVR hands-on, pre-launch): raw controller shake produced "invisible
  ghost with shaky hands" camerawork; devs said stabilization/smoothing was in progress.
  By the major-update review, video export got smoother + up to 1080p/60, screenshots
  to 8K, time-slow while recording to nail hard moments.
- **Scene assembly**: table-centric UI — pull props/backdrops from drawers, teleport
  around like Valve's The Lab, teleport INTO a drawer to preview a prop at full scale
  before placing it, orbs to save/switch between scenes, self-scale down to walk your
  own set at "in-universe" scale.
- **Characters**: importable skinned/rigged characters, animate via puppeteer or
  keyframe; articulated multi-part rigs (demo: a multi-limb "monster").
- **Sound**: grab a virtual mic, record audio in-headset, audio appears as a movable
  orb you place at a sound's origin (e.g. inside a character's head to fake lip sync),
  blends into the timeline for cue timing.
- **Import**: 3D models, images, video, sound; skinned characters.
- **Export**: FBX + Alembic (interop with Maya/Blender/Houdini pipelines), plus native
  video/360-video/photo/360-photo/VR-experience exports, and a standalone VR-playable
  package (the "Tvori Viewer") for non-creators to walk through the result.
- **Platforms**: SteamVR + Oculus PC (Rift/Quest+Link), Windows only. Min spec GTX 1060/
  RX570, 16GB RAM; rec. GTX1070/RX Vega56, 32GB.

### Reception / dev quotes
- UploadVR (2017 hands-on): "the most impressive piece of VR creation software I've
  tried since Google's Tilt Brush."
  Cartoon Network VR Lab, Disney/ABC, NBCUniversal all cite production use — traditional
  2D animators/storyboard artists productive "within a few hours"; one Disney tester
  claimed 80% animation-time reduction vs traditional CG, 65% less time drawing-to-3D.
  Unity's XR Research director: "advanced IK and camera tooling to rival any previz
  pipeline."
- r/Vive skeptic take (2019): puppeteering ≠ real animation — "the message the video
  gets through is disingenuous to any actual animator" — i.e. raw recorded controller
  motion reads as toy-play, not performance-quality character acting, without cleanup.
- **Sucks-verdict**: real-time puppeteer capture is the headline feature but is raw/
  noisy by default (shake, no secondary motion) — Tvori's answer is smoothing + a
  separate keyframe mode, not full mocap-grade output. Strongest as ideation/previz/
  storyboard-in-3D, weakest as a final-animation tool without a cleanup pass elsewhere
  (their own pitch: "Develop" stage hands off to Unity/Unreal/traditional tools).

---

## 2. Dreams VR (Media Molecule, PS4/PS5)

**Editable in VR**: full Create Mode — sculpting, "gadgets" (custom logic/behavior
nodes), character rigging via IK-bound sculpted parts, a full node-based Logic system,
sound design, and the same Imp-pointer/menu system as flatscreen, now reachable with
Move controllers or (once released) DS4 motion. VR update ("Inside The Box," free,
shipped July 22 2020) added VR-specific gadgets: a character tool that pins UI/HUD
elements to the wearer's FOV, and a gadget to bind a sculpted object's transform
directly to a tracked controller (build a "weapon" that matches your hand 1:1).
[blog.playstation.com/2020/06/30, roadtovr.com/dreams-vr-create-mode-media-molecule]

**Move vs DS4**: sculpting is "a very one-to-one experience" with PS Move (co-founder/
technical director David Smith, TheSixthAxis interview) — direct hand-tracked clay
work. DS4 stays supported for people who want to "block out the world a bit more" —
i.e. more controlled/precise input when the raw hand tracking is too loose — you can
literally put the Moves down and pick up the DS4 mid-session and the game hot-swaps
input schemes ("the trackers switch and now you're using the right tool for the job").
Pre-VR flatscreen build (UploadVR hands-on, 2019) already praised the DS4-as-mouse/
keyboard/paintbrush scheme as "a stroke of genius" (motion controls + L1 modifier
shortcuts) — Move controllers were explicitly called out as comparatively "erratic and
overly sensitive" in that same preview, before the VR-specific tuning pass landed.

**Dev talks / reception**: Creative Director Mark Healey (UploadVR interview) stressed
VR support applies to ALL existing UGC by default — "it's not just 'Oh we've added VR
and it just means you can look at sculptures in VR', it's the full shebang" — any
Dreams creation, VR or not, becomes viewable/playable in VR unless the author opts out,
with automatic comfort remapping (rotate-camera → teleport-follow) for content not
designed for VR. No hard memory/complexity cap added for VR creators. Smith frames the
whole VR effort philosophically: "Dreams is a way you can have a dream... and Dreams is
just a bunch of stuff that lets you get these ideas out of your head."

**Status**: Dreams itself is legacy — no PSVR2 support was ever added (Media Molecule
confirmed, Jan 2023, no roadmap item), a sore point in the community since PSVR2
launched without backward compat for original PSVR titles' motion input. Media
Molecule's later projects (after Dreams) did not continue the VR creation line.

**Sucks-verdict**: best-in-class LAYERED PUPPETEERING model (see §5) and a genuinely
complete node-logic engine — but VR support arrived late (14 months after launch),
never got PSVR2, and Move-controller precision was a real complaint versus DS4 until
VR-specific tuning. The dual-input hot-swap (Move for organic sculpt, DS4 for precise
block-out) is the one idea worth stealing outright.

---

## 3. Unity EditorXR — the anti-reference

**What it was**: "Author XR in XR" — an experimental Unity Labs package (not shipped
product) letting you edit ANY Unity scene — not just XR content — from inside a
headset: place GameObjects, use the Inspector, hierarchy, drag-and-drop, a "Spatial
Menu" (one-handed radial menu independent of view direction), MiniWorld workspace
(bird's-eye scene overview + edit), console/profiler windows pulled into 3D, Poly
(Google) asset browser integration, play-mode + player-build support (subset of
features), annotation/note tool, block selection, mouse-locomotion fallback, gaze-
based adaptive UI positioning (GazeDivergenceModule).
[github.com/Unity-Technologies/EditorXR releases]

**Why it stalled**: GitHub repo shows steady 0.0.x→0.4 releases through ~2019-2020,
then goes quiet — last meaningful commit activity ~2020-2021, community threads ("Is it
dead?" #577, Sept 2021; r/unity "EditorXR status?" June 2023 — "a year since the last
commit"; r/vrdev June 2025 thread confirms it was dropped) span years asking if it's
abandoned. An official maintainer reply on #577 (2021): "not in its current form, but
XR authoring tools are still actively being worked on, which incorporate many of the
learnings from EditorXR" — i.e. Unity folded the R&D into other (unnamed, unshipped-as-
EditorXR) efforts rather than continuing the product. No formal postmortem blog was
found in this pass; the public record is silent releases + unanswered "is it dead"
issues, which is itself the postmortem: a research prototype that Unity never
productized, then quietly stopped maintaining once the internal team's learnings had
been extracted.

**Sucks-verdict / anti-reference lesson**: EditorXR proved the "put a full desktop-
class editor UI inside a headset, 1:1" approach is a research dead end when treated as
a permanent product — windows/inspectors/hierarchy panels translated directly into 3D
space don't get simpler in VR, they get harder to read and slower to navigate (no
keyboard, no precise mouse), and Unity's own team moved on to "learnings" rather than
iterating the tool itself. The lesson for DreamForge: don't port a flat editor's UI
verbatim into 3D — redesign the INTERACTION MODEL for hands/gaze (Dreams' gadget/Imp
system and Tvori's drawer-table are the working counter-examples), and ship narrow
workflows (sculpt, puppeteer, camera) rather than a general-purpose IDE-in-VR.

---

## 4. Other VR creation tools

**Quill (Oculus → Smoothstep, quill.art)** — VR drawing+ANIMATION tool, born as a
48-hour hackathon project (Oct 2015, Iñigo Quilez, ex-Pixar TD) inside Oculus Story
Studio to make _Dear Angelica_ (2017), the first fully hand-painted-in-VR short. Paint
strokes ARE 3D geometry (ribbon ranging ink, ranges depth/width via controller
pressure-analog), animation added later via onion-skinning/layers/keyframing similar
to traditional 2D frame-by-frame but in 3D space. Facebook handed full ownership +
IP back to Quilez's company Smoothstep in Sept 2021 (old Facebook-listed app pulled
Oct 18 2021, replaced by "Quill by Smoothstep" v2.9), and open-sourced the file format
as IMM (github.com/Immersive-Foundation/IMM) + an open IMM player, explicitly to seed
a wider creator/player ecosystem beyond Oculus hardware exclusivity. Same fate pattern
as Medium (see below) — Facebook incubated, then divested once "no long-term plans."
**Verdict**: best pure hand-drawn-animation-in-3D tool of its generation (Sundance/
Venice screenings for Quill shorts), but its independence came from Meta abandonment,
not strategic choice — a cautionary tale re: platform-owned creation tools.
[roadtovr.com/facebook-spins-open-sources-excellent-vr-animation-app-quill,
uploadvr.com/quill-smoothstep-facebook]

**Medium (Oculus → Adobe, now Substance 3D Modeler)** — VR SCULPTING (voxel/
volumetric clay, not mesh), started 2014 as a Touch-controller tech demo, shipped as
a Rift pack-in title Dec 2016 ($30, ReVive-compatible on Vive). Facebook explicitly
refused to downgrade it for standalone Quest, instead bundled it free with Rift S.
Adobe acquired Medium + much of its team Dec 2019, made it free (renamed "Adobe
Medium," 2020), then relaunched the tech as **Substance 3D Modeler** (2021+) — hybrid
VR+desktop sculpting that plugs into the full Substance 3D suite (Painter/Designer/
Sampler/Stager), aimed at professional pipelines rather than a standalone VR toy.
Lead designer Lydia Choy carried over to Adobe and led the Modeler evolution.
**Verdict**: the sculpting itself ("flow state," reshape-without-remeshing, instant
undo) was always praised; its real achievement was surviving the Meta-divests-VR-art-
tools pattern by landing inside a company (Adobe) that wanted a permanent pro pipeline
product, not just a headset demo.
[roadtovr.com/adobe-substance-3d-modeler-medium-vr-modeling-pro-workflows,
uploadvr.com/adobe-substance-3d-modeler-medium]

**Gravity Sketch (gravitysketch.com)** — INDUSTRIAL DESIGN in VR: custom 3D geometry
engine (SubD/NURBS/mesh strokes), no VR-native rigging/animation focus — it's a
sketch→surface→export tool for product/vehicle design. Real production adoption: Ford
deployed it across 5 design studios (2019) explicitly to skip the "2D sketch → scan →
CAD" pipeline and get to 3D in hours not weeks, at 1:1 scale; also cited users at
Adidas, Reebok, VW (Forbes, via Meta store page, 100k+ free-tier users). Supports
multiplayer design review rooms (VR + desktop joinable), AR placement/scale
validation, LandingPad for round-tripping reference content, OBJ/FBX/IGES export.
Company still actively shipping (site snapshot Mar 2026). **Verdict**: doesn't compete
with Tvori/Dreams on animation — it's the category leader for VR-native CAD ideation,
proven at real automotive/footwear scale, alive and funded-adjacent (VC-backed, not in
Tracxn's "unfunded" bucket like Tvori).
[gravitysketch.com/products, motorauthority.com/news/1121235]

**AnimVR (NVRMIND.io, Milan Grajetzki & Dario Seyb)** — closed beta ~2017-2018,
positioned explicitly as VR PREVIZ/STORYBOARDING: master timeline for shot sequencing,
animatable/recordable cameras with export to Maya/Blender/Cinema4D, audio import +
spatialized placement, mesh import from FBX/OBJ/glTF/USD, Alembic/USD export back into
DCC tools, Sketchfab upload integration, standalone .exe "Story Export" for non-VR
viewers, Unity toolkit for direct stage-file use. Positioned as complementary to
Quill/Medium/Tilt Brush/Gravity Sketch (explicitly imports their exports as set
dressing). **Status**: appears dormant — no updates/news found beyond the original
beta-era site content; small 2-person research-lab team, never a wide commercial
release found in this pass. **Verdict**: right feature set (timeline+camera+audio,
proper DCC round-trip) but a 2-person shop that seemingly never scaled past beta —
a spec/feature-list worth mining, not a company worth citing as "alive."
[nvrmind.io/animvr, nvrmind.io]

**Mindshow (Visionary VR → Mindshow)** — **STATUS: DEAD**, ceased operations + laid off
all staff, reported by Lowpass July 31 2025 ("Scoop: VR-powered animation studio
Mindshow shuts down"). Started 2014 as a consumer app: embody a full avatar (head+
controller tracking → puppeted character, closer to true performance-capture than
Tvori's prop-puppeteering) to "act out" your own animated show inside the headset,
covered by Variety 2017. Pivoted (leadership change + recap) to a professional
Hollywood virtual-production pipeline: storyboarding+layout+animation in one workflow,
partners included Mattel and Netflix; a Feb 2025 platform relaunch added AI-assisted
lip-sync from pre-recorded audio, multi-camera virtual studio capture, Vision Pro +
Quest MR/VR support, and mocap-suit ingestion — then folded 5 months later, reportedly
after a spring 2025 funding round fell through. Raised $17.03M total (Series A,
CBInsights), last raise ~2019/2020 era, 6 years before shutdown. **Verdict**: proof
that full-avatar embodied performance-capture is a compelling PITCH (Mattel/Netflix
signed on) but a hard business — a decade of pivots (consumer app → studio-tools
Hollywood pipeline) still couldn't find sustainable revenue before the money ran out.
[lowpass.cc/p/vr-animation-studio-mindshow-shuts-down, cbinsights.com/company/
visionary-vr, auganix.org Feb 2025 relaunch coverage]

**Horizon Worlds creation tools (Meta)** — in-headset (and now desktop/mobile) world-
building with a visual scripting layer, evolved via "Horizon Studio" (2025, desktop-
focused authoring) and "Meta Horizon Engine" (custom engine work aimed at making
worlds run acceptably on PHONES). **STATUS: strategic pivot Feb 19 2026** — Meta
explicitly decoupled Horizon Worlds from the Quest/VR platform ("Horizon OS 2.0" /
v85 dropped the "Worlds" tab from Quest's main nav) and reoriented Worlds to be
"almost exclusively mobile," per Meta's own dev blog (Samantha Ryan, VP Content,
Reality Labs): "we're doubling down on the VR developer ecosystem while shifting the
focus of Worlds to be almost exclusively mobile." Reasoning stated plainly: reach over
immersion — mobile audiences dwarf VR's. Existing worlds/creator work is NOT deleted,
but complex VR-exclusive scripts/assets may get simplified for phone performance.
Separately, Horizon WORKROOMS (the enterprise VR meeting product, unrelated but often
confused with Worlds) was fully shut down Feb 16 2026, servers off, unsaved data
deleted — the coincidence fueled "Meta killing VR" headlines that Meta had to publicly
correct. Reported MAU for Worlds: <200k, down from a ~300k early-2022 peak
(Grokipedia, citing multiple analyses) — a fraction of the "metaverse" ambition.
Creator economy stat Meta DOES tout: 4 creators past $1M lifetime revenue, ~100 past
six figures in 2025. **Verdict**: the most heavily funded VR creation platform in
existence just admitted VR-first creation didn't reach scale and is retreating to
mobile-first — a hard signal against betting a product's whole thesis on VR-native
authoring reaching a mass audience soon; the CREATOR TOOLING (scripting, in-headset
building) is real and still funded, the AUDIENCE is what got reprioritized.
[metoxa.de/horizon-worlds-2026-abschaltung-oder-meta-pivot,
developers.meta.com/horizon/blog/2026-vr-state-of-the-union-horizon-mobile-focus,
grokipedia.com/page/Horizon_Worlds]

**Masterpiece Studio / MasterpieceVR (San Mateo, masterpiecestudio.com)** — sculpt tool
(2017, MasterpieceVR proper — ZBrush-in-VR feel, up to 4 simultaneous co-sculptors +
20 spectators) plus **Masterpiece Motion** (2019) which is the standout: VR RIGGING —
draw bones directly onto an imported FBX/OBJ character by hand in 3D, AI-assisted
auto-rig + auto-skin (their pitch: minutes vs days), IK/FK posing by grabbing the
skeleton, weight-paint manually or auto, exports fully rigged/skinned/posed FBX to
Blender/Maya/3ds Max/C4D/MotionBuilder/Unity/Unreal/Marmoset/Sketchfab — AND directly
into other VR creation tools (Tvori, Gravity Sketch, Flipside, VRChat; Mindshow/AnimVR
listed as "to come"). Bundled as **Masterpiece Studio** (Jan 2020, Creator+Motion
combined) marketed as "10x faster than desktop tools" for concept→animated-model.
Rental pricing ($14.95-29.95/mo). Pitched explicitly as the MISSING PIECE other VR
animation tools lacked — rigging — rather than competing on sculpt or animate.
**Verdict**: narrowly-scoped, cross-tool-interop-first strategy (feed Tvori/Gravity
Sketch/etc. rather than replace them) is a smart lesson for DreamForge's own pipeline
boundaries — rigging-in-VR specifically solves a real pain point (bone placement by
touch beats mouse-dragging joints in flat 3D).
[cgchannel.com/2019/05/new-tool-masterpiece-motion-lets-you-rig-characters-in-vr,
roadtovr.com/masterpiece-studio-launch-vr-creation-animation, 80.lv/articles/
vr-animation-rigging-new-workflow]

---

## 5. Puppeteer / performance-animation prior art beyond VR

**Dreams' record-per-limb layered puppeteering** — the exact workflow (from Media
Molecule dev interviews + hands-on coverage): a rigged puppet's limbs/parts are each
bound to gadgets/controllers; you RECORD ONE LIMB'S MOTION AT A TIME as a pass (hit
record, move the DS4/Move stick to drive say the right arm, stop), then layer a second
pass on top for the next limb while the first plays back as reference/context (like a
DAW punching in overdub tracks), building up a full-body performance from N single-
channel passes rather than needing N simultaneous input channels. This is the
technique praised as accessible ("just move a stick, watch it play back, add the next
part") vs needing a full mocap rig — the tradeoff is you're synthesizing performance
across N un-simultaneous takes, so timing/weight has to read consistently pass to pass.
Camera and character motion both use the same record/layer primitive.

**Cascadeur (cascadeur.com, Nekki)** — standalone (non-VR) AI-assisted KEYFRAME tool,
grew out of Nekki's own fighting-game (_Shadow Fight_) production pipeline, spun out
standalone 2019. Core mechanics: **AutoPosing** (neural-net-assisted IK — move a few
control points, AI infers a natural full-body pose), **AutoPhysics** (suggests a
physically-plausible correction of your keyframed motion, shown as a translucent
"green double" overlay you can accept/blend in), **Animation Unbaking** (takes a fully
baked per-frame mocap/video-derived clip and automatically reduces it to a sparse,
EDITABLE keyframe+interpolation set — critical for cleaning up captured performance
into something an animator can actually adjust), **Video Mocap** (extract motion from
plain video), secondary-motion sliders (auto shake/bounce/overlap), copy/paste
RETARGETING across differently-proportioned humanoid rigs in 2 clicks, one-click rig
of standard skeletons (Mixamo/Metahuman/DAZ/Character Creator/UE). CTO interview
(Digital Production, Feb 2026) frames the founding insight as: traditional tools like
Maya are "almost completely disconnected from physics" — animation should be informed
by balance/weight/momentum computed, not hand-tuned by feel alone.
**Relevance to DreamForge**: Cascadeur's Unbaking + AutoPhysics pair is the best
existing answer to "how do you turn raw VR-recorded puppeteering into clean, editable,
physically-plausible animation" — exactly the gap Tvori/Dreams/Mindshow all leave open
(raw record = shaky/rough, no unbake step). Worth treating as the CLEANUP STAGE of a
DreamForge pipeline rather than reinventing it.
[cascadeur.com, digitalproduction.com/2026/02/18/cascadeur-on-physics-ai-and-control]

**Unreal Sequencer + Take Recorder** — the industry-standard non-VR-native take-
recording model. Take Recorder (Window > Cinematics > Take Recorder) captures live
sources — animated actors, Live Link streams (mocap suits, ARKit face, VCam), World
state, microphone — DIRECTLY INTO Sequencer as a new take, non-destructively (each
take is separate, doesn't overwrite prior ones), with Slate/take-number/description
metadata (film-set clapperboard conventions ported 1:1), multiple takes per shot for
alt performances, then edited on Sequencer's standard NLE-style timeline. This is the
"record → layer → edit on a timeline" loop DreamForge should structurally mirror.
[dev.epicgames.com/documentation/unreal-engine/take-recorder-in-unreal-engine]

**iPhone-as-virtual-camera** — two flavors:
1. **Epic's own free VCam app** ("Unreal VCam," iOS/Android): enable the VirtualCamera
   + Live Link + Take Recorder plugins, drop a VCam Actor in-scene, connect phone over
   Pixel Streaming on the same network — ARKit drives real 6DoF phone-as-viewfinder
   camera position/rotation live, record straight into Take Recorder/Sequencer. Epic's
   Meerkat Demo (Weta Digital short) is the reference sample project for this workflow.
2. **DragonFly (Glassbox Technologies)** — 3rd-party, cross-platform (Unreal + Maya),
   production-proven on real shows (Netflix's _Away_ for previz via Ingenuity Studios;
   Haz Dulull's _Battlesuit_ short shot entirely in-engine). ARKit-based lightweight
   phone tracking out of the box, scales up to OptiTrack/Vive professional tracking
   without relearning controls (same UI across tiers), lens/sensor/focal-length
   emulation of real cameras, post-hoc camera-move smoothing, works with Xsens/Manus
   mocap streamed live via MVN Live Link — a documented indie workflow (Creative
   Pinellas write-up) had ONE PERSON solo-shooting a full mocap scene at home: suit +
   gloves for body/finger animation in Sequencer, iPhone+DragonFly app for the camera,
   joystick buttons in-app for camera rig control, remote multi-user Unreal sessions
   with a mocap performer and a camera operator on different continents.
[glassboxtech.com/products/dragonfly, dev.epicgames.com/documentation/unreal-engine/
controlling-a-virtual-camera-actor-using-live-link-in-unreal-engine,
creativepinellas.org/magazine/experimenting-with-mocap-data-in-unreal-engine]

**Audio-DAW-style animation layering** — not a single named product but the pattern
underlying Dreams' limb-layering, Tvori's per-object recording passes, and Take
Recorder's multi-take/multi-source capture: treat each captured channel (limb, prop,
camera, voice) as an independent "track" recorded against a shared timeline/reference
playback, non-destructively stacked and re-recordable per track — the same mental
model as multitrack overdubbing in a DAW. All the serious tools above converge on this
shape; DreamForge should adopt it explicitly as the timeline data model rather than a
single monolithic "recording."

---

## 6. Vision Pro + Quest as EDITING clients for a remote-rendered scene

**visionOS OpenXR status (2026)**: Apple does NOT ship a native OpenXR runtime — apps
build against RealityKit/SwiftUI/CompositorServices or a 3rd-party ENGINE (Unity/
Unreal/Godot) that itself has visionOS support. Community project **OpenXRKit**
(github.com/warrenm/OpenXRKit) is an experimental, explicitly "not fit for production"
attempt to implement an embeddable OpenXR 1.0 runtime on top of Metal/ARKit/
CompositorServices — proof-of-concept only, single graphics API (Metal), no App-Store-
compatible dynamic loading. **The real bridge Apple ships is streaming, not local
OpenXR**: visionOS 26.4 introduced the **Foveated Streaming framework** — a session
API connecting Vision Pro to local/cloud streaming ENDPOINTS (PC, workstation, cloud
server) running an OpenXR app; the endpoint renders and streams gaze-prioritized video
back. WWDC26 (session "Build next-gen experiences with visionOS 27", Norman/Vision
Products Group) states plainly: "in one day you can start streaming your OpenXR
applications to Apple Vision Pro." Real 2026 production users cited: Autodesk VRED +
NVIDIA CloudXR + Foveated Streaming used by Kia and Innoactive for vehicle design
review; Laminar Research/X-Plane for training sims; Valve's Steam Link streams 2D
Mac/PC game libraries onto the "infinite canvas."
[developer.apple.com/visionos/whats-new, developer.apple.com/videos/play/wwdc2026/287]

**Hand tracking**: Vision Pro tracks hands natively at 90Hz (M5-gen hardware spec
quoted in the WWDC26 talk) for direct pinch/gaze interaction — this is visionOS-native,
NOT OpenXR-mediated, so a remote-rendered OpenXR scene streamed via CloudXR still gets
Vision Pro hand tracking sent BACK to the host as input (see CloudXR architecture
below), it's just not exposed as a generic OpenXR hand-tracking extension on-device.
Quest side: full OpenXR 1.0 adopter since Quest/Quest 2 generation, official
`XrHandsFB` extension family gives skinned hand mesh + collision capsules + ray-cast-
plus-pinch gestures at parity with the older proprietary VrApi hands API; sample
`XrHandsAndControllers` demonstrates simultaneous hand+controller tracking with
auto-detection of controller-in-hand state (useful for a DreamForge client that wants
to fall back seamlessly between controller-precision and bare-hand-gesture modes).
[developers.meta.com/horizon/documentation/native/android/mobile-openxr]

**Remote/hybrid rendering precedents**:
- **NVIDIA CloudXR 6.0 for Apple platforms** — the concrete architecture DreamForge
  should study: server runs an OpenXR app via the CloudXR Runtime (render → capture →
  encode → transmit compressed video + depth + alpha + spatial audio); client (Vision
  Pro via FoveatedStreaming.framework, or iPhone/iPad via StreamingSession.xcframework)
  hardware-decodes + displays, and sends head pose + controller input + (Vision-Pro-
  only) hand tracking + approximate gaze region BACK for the next frame — a standard
  low-latency XR streaming loop. Apple's privacy design explicitly keeps raw gaze data
  server-side-ephemeral, never exposed to the streamed app itself, only used by the
  CloudXR Runtime layer to prioritize encode quality where you're looking.
  [developer.nvidia.com/topics/ai/xr/cloudxr/apple-platforms]
- **Meta Quest Link / Air Link** — the older, Quest-side precedent: PC renders
  (SteamVR or Oculus PC runtime), Quest streams video wirelessly (Air Link, official
  Meta) or wired (Quest Link) or third-party (Virtual Desktop, $24.99, cited as
  "richest feature set, most stable connection" vs free Air Link's "decent comfort,
  not very high stability") or **Steam Link** (free, launched on Quest headset,
  streams the PC's full SteamVR runtime including flat 2D games + VR titles bought on
  Steam specifically — does NOT cover VR titles bought elsewhere, e.g. Meta PC Store
  or Epic, without Air Link/Virtual Desktop). This is today's dominant "cheap headset,
  expensive render box" pattern and the direct precedent for a DreamForge remote-
  render architecture on Quest — mature, consumer-proven, three competing client apps
  to benchmark stability/latency against.
  [vrpupu.com/en/2026/01/steamvr-setting-for-meta-quest]

**Verdict for a Vision Pro + Quest DreamForge editing client**: the infrastructure
Apple/NVIDIA shipped in 2026 (Foveated Streaming + CloudXR SDK integration, "one day"
bring-up per Apple's own claim) is BUILT FOR exactly this use case — a remote-rendered
OpenXR scene with gaze-prioritized encode and hand-tracking sent back as input — more
purpose-fit than repurposing Quest Link/Air Link's game-streaming pipes, which were
built for finished VR titles, not live bidirectional edit sessions. Quest remains the
more mature/cheaper client for OpenXR-native local rendering (no streaming needed at
all if the edit host has enough headroom); Vision Pro is currently STREAMING-ONLY for
third-party OpenXR content by design — there is no path to a native OpenXR DreamForge
build ON visionOS itself, only to a CloudXR-style remote host that a Vision Pro client
streams from.
