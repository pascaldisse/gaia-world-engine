# DREAMS music — INTERACTION PHENOMENOLOGY (not DSP) — PARKED EVIDENCE (sonnet, 07-16)

Feeds: CREATE.md AUDIO section — the FELT-EXPERIENCE spec (companion to
dreams-recon.md's DSP-architecture mining). Pascal's brief: "you don't
play notes, you move the fucking air... creating sound out of movement
and out of feeling." This doc = what the BODY does, step by step, with
verbatim testimony. NOT the engine internals.

## Core grammar: controller IS the instrument, body IS the note

- 8 face buttons = 8 scale-degree notes (major/natural/harmonic/melodic
  minor selectable — "clear a musician made this tool," Polygon).
  Press = play. TILT the controller left/right = octave shift, live,
  mid-phrase — "motion controls are everywhere in Dreams" (Polygon).
  Touchpad = pitch-bend (r/PS4Dreams f1vdry). So: hand posture (buttons)
  + arm tilt (octave) + thumb slide (bend) = ONE continuous playing
  gesture, no mode switch.
- The Imp (drawable cursor, moved by motion-sensor or sticks) walks a
  flat surface called the CANVAS. Hold a note-button while moving the Imp
  = you DRAW the note's pitch-line as a stroke on the canvas, in real
  time, as it plays (asoundeffect.com Colvin interview). Drawing IS
  performing — the gesture leaves a visible trace that IS the melody.
- EFFECT FIELDS = drawn circles on the canvas, each a bundle of arbitrary
  DSP params (pitch/distortion/reverb/whatever you assign) — literally
  "guitar effects pedals" laid out in space (Colvin). You don't select an
  effect from a menu — you WALK THE IMP THROUGH the circle. Closer to
  center = stronger effect (r/PS4Dreams f1vdry: "the closer you are to
  the centre the more strong the effect"). Crossing the field's edge
  live-bends the note; the sound audibly warps as your hand crosses the
  boundary. This is the "move through it to hear it change" mechanic
  Pascal is pointing at — spatial automation, not a slider you drag.
- Recording capture: perform on canvas → captured as raw performance →
  viewable/editable BOTH as traditional piano roll (note-fix mode) AND as
  the performance-surface view (the automation/DSP-motion view) — same
  data, two lenses, per Colvin. So freeform gesture always has a fallback
  edit surface; nothing performed is ever locked out of precision-editing.
- Granular engine underneath means even texture/stutter is gesture-
  controllable live (grain speed under a field) — pulling a sound apart
  physically, not parameter-typing it.

## Official tutorial stream — move-by-move timeline
(Twitch 18 May 2018, YouTube 21 May 2018, MM Audio team: Tom Colvin, Ed
Hargrave, Bogdan Vera — breakdown: dreamskool.wordpress.com/2018/06/06/
music-in-dreams-ps4-video-breakdown/)

- 12:48 create your own loop from scratch, live.
- 14:08–16:04 look at a Synth Bass instrument, then a piano-sample
  instrument — build a piece directly by playing it.
- 18:35 editing music by adding notes MANUALLY (the piano-roll fallback).
- 21:11 tweak an existing loop's effects/settings until it becomes a NEW
  instrument (sound design = playing with fields, not preset-picking).
- 24:18 the arpeggiator — turns held chords into rhythmic runs automatically.
- 26:59–31:20 mic workflow: sing/beatbox into the mic → the waveform
  becomes an instrument you can then play on the buttons; THEN build your
  own effect field around that new instrument.
- 34:24–38:50 Ed sings a single "lah" into the mic → Dreams turns ONE
  voice into a CHORUS (stacked/harmonized automatically) → then plays
  CHORDS with it → then layers a BASS made from the same voice. One
  vocal take becomes an entire vocal ensemble by feeding it back through
  the instrument-maker.
- 45:54 apply effects to the whole TIMELINE (not just a note) — same
  gesture vocabulary, larger scope.
- 48:35 wire the music to gameplay logic — character speed/action
  modulates the music live (bidirectional: game state → sound, sound →
  game state).
- 53:59 the playhead itself is grabbable and draggable — can run
  backward, stop, jump — "the timeline does not only have to go forward"
  (Q&A). Scrubbing the playhead by hand is itself a performance move
  (used live to re-trigger/reverse sections mid-set).
- 58:56 sequences can be turned into 3D OBJECTS placed in the world so
  sound emits from a location without being tied to that object's other
  behavior.
- 1:01:13 "Beatbox" — an instrument built specifically to be played live,
  in "play mode," as a real-time performance instrument, not a sequencer.

## Named interaction inventions (worth reusing as vocabulary in CREATE.md)

- **Canvas-as-instrument**: flat playable surface where position = sound
  parameter; the Imp's location is inherently the mouse/finger/plectrum.
- **Tilt-for-octave**: whole-body/wrist gesture maps continuously to
  register, no button for it — echoes real instrument technique (bowing
  angle, breath).
- **Drawing-pitch-as-gesture**: the melody's visual trace and its audible
  contour are the SAME stroke; you can literally see a melodic shape.
- **Performance fields as walk-through effect pedals**: spatial, radial-
  falloff automation zones you move your avatar through — turns "insert
  effect → tweak knob" into "walk toward/away from a point."
- **Possession-performance of instruments**: same Imp-possession model
  used for puppets (dreams-recon.md) applies to instruments — you
  "become" the thing you're playing, R2 to possess, direct control
  after.
- **Timeline-scrub-as-performance**: playhead is a physically grabbable,
  reversible object; scrubbing is a legitimate live-performance gesture,
  not just an editing convenience.
- **Voice-to-ensemble**: one mic take auto-multiplies into chorus/bass —
  turns a single embodied performance (singing) into a full arrangement
  without re-recording.

## Sónar+D 2018 — Colvin + Perry workshop (asoundeffect.com/dreams-game-audio/)

Colvin's own framing, in his words, of what an audience/workshop
participant watched him do:

> "Many things in Dreams are based on the idea of things being
> performative. So, gestural controls are in the art tools... The system
> is designed to work with the PlayStation controller movements."

> "If, for example, I play a synth note, I can draw through the user-
> configurable circles on the flat surface to change the sound of the
> note... As you draw through the pitch-control circle, you can bend the
> note in real-time."

> "It's like a container for lots of different things that you might
> want to do with automation. Your movement through the field applies
> the effects you assigned to it."

Colvin closed the workshop by building a generic game world with a basic
character live, then wiring the music he'd just made to that character's
movement — so the music sped up as the character sped up — proving
sound-object and game-object share one logic system in front of the
room (asoundeffect.com). Full video linked from that article.

E3 2018 aftershow: the in-house band "The Molecules" played a 15-minute
LIVE set performed entirely inside Dreams for the after-party — funk,
techno, metal genres running into each other, watched live by attendees
(pushsquare.com/news/2018/06/media_molecules_e3_2018..., YouTube "Music
in #DreamsPS4" watch?v=E3BPsKb8p6I, PS Blog 26 Jun 2018). MM framed it
as proof the tool is a real-time PERFORMANCE instrument, not just a
composition tool — confirmed by their own livestream days later
explaining "how it all worked."

## Player/musician testimony (verbatim, with source)

- "Dreams actually has a crazy performance mode that essentially turns
  the DS4 into a midi controller, with the touch pad acting as pitch
  bend and tilting the controller left and right to change octave... You
  can change what key and scale you are playing on the fly too. There is
  also something called effect fields which i think is one of the best
  things about Dreams music tool... the closer you are to the centre the
  more strong the effect." — r/PS4Dreams, "How hard is the music
  creation?" reddit.com/r/PS4Dreams/comments/f1vdry/

- "It takes real time to get used to Dreams. The workflow is completely
  different to any DAW out there." — r/PS4Dreams, "Some people have said
  you can't make music in Dreams..." reddit.com/r/PS4Dreams/comments/
  mc2rpd/

- "Having had experience with making music in Fruity Loops, making music
  in Dreams feels very familiar [once past the overwhelm]." —
  r/PS4Dreams, "Is anyone else completely overwhelmed by the music
  sequencer?" reddit.com/r/PS4Dreams/comments/bg4a9v/

- "Tilt the controller... Open up the Sound gadget of the instrument/
  Sound you've chosen with L1+Square. Go to the second tab 'Pitch'. Home
  Octave is the 3rd slider down [precision fallback for the gesture]." —
  r/PS4Dreams, "How do I change octaves?" reddit.com/r/PS4Dreams/
  comments/f4b5wk/

- "From what I saw in the streams I got the idea that tilting moved up &
  down octaves and a stick/s positioned the instrument in the window
  space altering what the designer referred to as being pedal-like
  effects." — ResetEra, "Dreams has an in depth music creator," page 2,
  resetera.com/threads/dreams-has-an-in-depth-music-creator.10456/page-2

- "There's a tactile feeling to using the various paint strokes or
  object moulding that's satisfying to play around with... The way you
  create sound and music is similarly freeform." — GameSpot review,
  gamespot.com/reviews/dreams-review/1900-6417414/

- Colvin (developer, but describing the player's own discovery): "The
  things that excite me the most are when people start doing things we
  didn't expect... There is a guy who released an album of music that
  he made in Dreams... There are people doing algorithmic-based music
  using Euclidean mathematics." — asoundeffect.com/dreams-game-audio/

### Musicians who shipped real releases made in Dreams
- @Byvsen — 15-track, 43m15s full album made entirely in Dreams,
  released on Spotify Jan 2020 (pushsquare.com/news/2020/01/
  dreams_creator_releases_entire_album..., source tweet twitter.com/
  Byvsen/status/1217090313686257664).
- r/PS4Dreams "All Chemical Dreams" — 30-minute album, self-released,
  Apr 2022 (reddit.com/r/PS4Dreams/comments/twxfim/).
- r/PS4Dreams "Sounds From The Underground" — 4-hour compilation album
  made in Dreams, Dec 2021, community members report using it as
  ambient work-music (reddit.com/r/PS4Dreams/comments/r92jux/).
- "Retro Instruments Collection" — an 80s/90s instrument pack released
  with a demo track, community praised both the instruments and the
  composition (reddit.com/r/PS4Dreams/comments/gm9k9q/).

## In-fiction proof: Art's Dream ties music to embodied action

- Two characters (guitars) "firing off notes... in time, in key, and in
  sync with the music" during a boss-adjacent sequence — logic and music
  share one clock (Colvin, asoundeffect.com).
- "The music even changes as the gameplay tempo changes. As you swing at
  the enemies with your mighty hammer as Frances, the tempo increases,
  and the drums swell." — docs.indreams.me "How We Made... Art's Dream."
  Combat INPUT directly drives musical INTENSITY — the player's own
  physical rhythm (button-mashing cadence) becomes the track's tempo.

## Why this beats piano-roll-first DAWs for beginners (found framing, no formal UX talk located)

- Repeated player framing: piano-roll/grid tools are described as the
  FALLBACK/precision layer, reached for AFTER something has already been
  performed — never the entry point. Entry is always a physical gesture
  (button+tilt+draw) that produces sound immediately, no note-placement
  literacy required first.
- "For experimenting with drums, instruments and effects it sounds like
  a great idea just to jump into dreams and see what you can make. but
  for the stuff that requires a little theory knowledge - ie writing
  melodies and chords - I think it would be hard... to learn all that
  stuff with only a piano roll to work with." — r/PS4Dreams, "Interested
  in making music in Dreams, but have no prior experience," reddit.com/
  r/PS4Dreams/comments/beitdc/ — i.e. the COMMUNITY itself treats the
  piano roll as the harder, more theory-gated mode; the performative
  surface is the accessible one.
- Colvin, asoundeffect.com: "On the creation side, we've done a lot to
  make music composition easier for people that don't know anything
  about music theory. The simplest thing you can do... is stamp in
  someone else's music... if you want to get involved in composition...
  You can publish [just a bass line or drum beat] and let other people
  use your stuff." — the tool deliberately supports STOPPING at any
  rung: stamp → arrange → perform → build → hardware-hook (ladder
  already captured in dreams-recon.md's "stealth-create ladder"). No
  DAW forces you to start at "I understand what a piano roll is."
- Note-buttons pre-mapped to a SCALE (not chromatic 12-tone) removes the
  #1 beginner failure mode of a DAW (playing wrong/dissonant notes) by
  construction — every button press in-key, "so if you got that going,
  you can play it by ear with some fumbling" (r/PS4Dreams, "Music in
  Dreams," reddit.com/r/PS4Dreams/comments/9bjlk4/).

## Sources (URLs)
- dreamskool.wordpress.com/2018/06/06/music-in-dreams-ps4-video-breakdown/
- dreamskool.wordpress.com/2018/06/06/music-in-dreams-my-thoughts/
- asoundeffect.com/dreams-game-audio/ (Tom Colvin interview, Sónar+D 2018 video embed)
- polygon.com/2018/7/20/17588224/dreams-ps4-preview/
- kotaku.com/psa-if-you-re-just-starting-dreams-leave-the-motion-c-1841702940
- docs.indreams.me/en/impsider/impsider-access/how-we-made-arts-dream
- pushsquare.com/news/2018/06/media_molecules_e3_2018_dreams_live_musical_performance_sure_is_something
- pushsquare.com/news/2020/01/dreams_creator_releases_entire_album_of_music_made_in_the_game_on_spotify
- blog.playstation.com/2018/06/26/watch-media-molecule-play-15-minute-musical-set-in-dreams/
- youtube.com/watch?v=E3BPsKb8p6I ("Music in #DreamsPS4")
- gamespot.com/reviews/dreams-review/1900-6417414/
- resetera.com/threads/dreams-has-an-in-depth-music-creator.10456/page-2
- reddit.com/r/PS4Dreams/comments/f1vdry/ (performance mode/effect fields)
- reddit.com/r/PS4Dreams/comments/f4b5wk/ (octave change)
- reddit.com/r/PS4Dreams/comments/mc2rpd/ (workflow vs DAW)
- reddit.com/r/PS4Dreams/comments/bg4a9v/ (overwhelm → familiarity)
- reddit.com/r/PS4Dreams/comments/beitdc/ (theory-gated piano roll)
- reddit.com/r/PS4Dreams/comments/9bjlk4/ (scale-mapped buttons)
- reddit.com/r/PS4Dreams/comments/twxfim/ ("All Chemical Dreams" album)
- reddit.com/r/PS4Dreams/comments/r92jux/ ("Sounds From The Underground")
- reddit.com/r/PS4Dreams/comments/gm9k9q/ (Retro Instruments Collection)
- twitter.com/Byvsen/status/1217090313686257664

## Gaps (next-pass, not blocking)
- Reddit content fetch blocked (403 to bot UA on old.reddit/.json/r.jina
  proxy alike) — testimony above is search-snippet-verbatim, not full
  threads; a human-logged-in pull would surface more.
- No formal UX talk/paper found contrasting Dreams vs piano-roll DAWs
  directly — framing above is synthesized from scattered player/dev
  testimony, not a single citable analysis. GDC 2020 "Architecture of
  Dreams" (de Valmency, still unmined per dreams-recon.md) may cover
  design rationale directly.
- Could not verify audience-eyewitness account of the Sónar+D room
  itself (only Colvin's own description + article framing) — no press
  writeup of the live session located separately from the asoundeffect
  interview.
