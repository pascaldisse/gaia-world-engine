# Adult Mode — porting the Intimacy Battle (H-duel) to the GAIA World Engine

> Source: `/Users/pascaldisse/projects/explicit/Intimacy-Battle.md`

This doc ports the "H-duel" — a turn-based intimacy minigame that reuses
§8 combat wholesale (same CTB-lite turn order, type/matchup layer,
Empathy-read, form-as-stance; only the win condition flips from HP-drain to
Arousal-fill) — onto GAIA's ECS/world-simulation substrate.

## 1. Gating

Adult Mode is off by default and gated at three levels so it can never
trigger incidentally:

- **World flag `world.mode = "adult"`** — a global sim flag, off unless the
  operator explicitly sets it. All H-duel systems (arousal ticking, move
  resolution, status application) are no-ops when the flag is unset. This
  mirrors the source doc's "Affection-gated, like everything (§8½): the duel
  only opens at the route's intimacy tier" — the world flag is the outermost
  gate, tier-gating is the inner one.
- **Private-space only** — the H-duel system only arms inside rooms flagged
  `space.private = true` with `space.locked = true` (locked interiors).
  Entering/exiting such a room emits `space.privacy.changed`; the duel
  controller subscribes and disarms immediately on unlock or on any
  third-party entity entering the room.
- **Per-participant consent handshake event** — before any move resolves,
  both participants' agent controllers must emit
  `intimacy.consent.offer` → `intimacy.consent.accept` within a timeout
  window. No accept from both sides, no session. The handshake is a first
  class event pair, logged like any other world event, and either side can
  emit `intimacy.consent.revoke` at any time, which force-ends the session
  (maps to a `Spent`-less abort, no scene resolution, no affection delta).

## 2. Components

ECS-style components carried per participant entity, mapped 1:1 from the
source's stat block:

- **`ArousalGauge { value: 0-100 }`** — one per participant ("you" and
  "partner" gauges in the source). Climax at 100; both gauges are watched
  every tick for the win/break/mutual conditions.
- **`Preferences { types: [Type], superEffectiveMul: 1.5-2.0 }`** and
  **`TurnOffs { types: [Type], resistedMul: 0.5 }`** — same erogenous "type"
  layer as the source's Pokémon-style chart (`Tender · Teasing · Worship ·
  Dominant · Submissive · Playful · Rough/Union · Oral · Sensory`).
- **`Tells { readable: bool, currentHint: Type|null }`** — populated/refreshed
  only by a `Read` move (Empathy check); holds the "what's super-effective
  right now" hint plus the visible tell used for spring-bone/animation cues
  in §4.
- **`PreferenceDrift`** — a scheduled system component that mutates
  `Preferences`/`TurnOffs` weights as a function of scene-elapsed time and
  current gauge %, directly porting "Preferences drift during the scene —
  what's super-effective at 30% isn't at 80%; re-scout." Drift invalidates
  stale `Tells`, forcing re-`Read`.
- **`MoveHistory { recent: [MoveId], decay: f32 }`** — tracks last-N moves
  per participant to compute **diminishing returns on repeat**: each repeat
  of the same move within the decay window multiplies its gauge delta down
  (e.g. ×0.85 per consecutive reuse), porting "reuse the same move and its
  value decays."
- **`RhythmMultiplier { value: f32 }`** — rises with move variety, decays
  with repetition; multiplies outgoing gauge deltas. Direct port of "Variety
  builds a Rhythm multiplier; repetition kills it."
- **`NeedStack { value: f32 }`** — accumulated by `Build` moves, consumed by
  `Edge/Deny` moves to produce the next hit's amplifier (the build-and-deny
  loop from the source).

## 3. Move categories

Each stance (Form) exposes the same five action slots as engine actions,
each an event with a gauge-delta resolver gated by the type chart and
current statuses:

- **`action.build`** (Teasing/Sensory) — low delta to partner gauge, ~0 to
  self; increments `NeedStack`. Safe setup move.
- **`action.worship`** (Worship/Oral) — high delta to partner gauge, low to
  self; usually hits a `Preferences` super-effective. Primary offense.
- **`action.union`** (Rough or Tender) — high delta to both gauges. High-risk
  tempo-gamble finisher; resolved against `Stamina/Resolve` defense stat.
- **`action.edgeDeny`** — lowers self gauge, consumes `NeedStack` into a
  multiplier applied to the resolver's next `action.worship`/`action.union`
  delta. Gated by a `Resolve` check (source: "Resolve-gated").
- **`action.read`** (Empathy) — no gauge change; refreshes `Tells` and
  `Preferences` snapshot, clearing drift staleness and priming the next
  super-effective call.

All five resolve through the existing §8 combat pipeline (CTB-lite turn
order, matchup multiplier, form-as-stance move-set swap), with the resolver
output redirected from HP-delta to `ArousalGauge`-delta.

## 4. Avatar integration

- **Spring-bone physics reactions** — each gauge-delta event above a
  threshold triggers a transient spring-bone impulse (hair/tail/ear jiggle,
  amplitude scaled to delta size) on the receiving avatar, giving physical
  read-out of a landed move without new animation state.
- **Touch-response zones** — avatar rigs expose named collision zones
  tagged with `Type` affinities (e.g. ears → Sensory, nape → Tender). A move
  resolves against the zone it targets; landing on a zone matching an active
  `Preferences` entry triggers the super-effective multiplier and marks that
  zone `Sensitive` (see §5).
- **Animation hooks per move category** — `action.build`/`worship`/`union`/
  `edgeDeny`/`read` each map to a distinct animation-layer trigger
  (`anim.intimacy.<category>`), blended additively over the idle/held pose so
  Form-stance swaps (Fox/Shiba/etc., §7) still show through as the base
  layer — porting "Forms as kinks: Fox/Shiba/later forms each unlock
  stance-specific moves."

## 5. Statuses

Status components, applied/cleared by the resolver and visible to both the
combat log and the avatar layer:

- **`Flustered`** — next incoming move's delta boosted; short duration.
- **`Sensitive`** — a specific touch-response zone is primed
  super-effective until next `Read`/drift tick.
- **`Edged`** — high `NeedStack`, next hit amplified but status is volatile
  (can flip to a self-gauge spike if not resolved via `edgeDeny`).
- **`Trance`** — dream-deep state (Dreamweaving/Form-linked); all gauge
  deltas scaled up and reality-bend flags enabled for scene FX.
- **`Spent`** — applied post-climax; suppresses further gauge gain and
  triggers the afterglow/second-round scene modifier.

Win/break/mutual resolution (partner hits 100 first = win; self hits 100
first = soft-lose/"break"; both within a 1-turn window = Mutual Climax, max
affection + CG-gallery "perfect" flag) is evaluated by the existing §8
victory-condition system, retargeted from HP to `ArousalGauge`.
