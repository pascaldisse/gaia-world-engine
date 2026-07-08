# `.vroid` Master Format — Structure & Parametric Model

Companion to `VRM-CHARACTER-EDITOR-SPEC.md`. That doc covers the **baked export**
(`.vrm`); this one covers the **editable master** (`.vroid`) — the file that holds
the live parametric slider state VRoid keeps and re-slides. This is the level
needed for full VRoid-parity ("route 2").

**All numbers below were measured** from a real master:
`~/Documents/model.vroid` (a Female N00 base saved from VRoid Studio 2.14.0).
Reproduce with the walker snippets in §6 / the extractor that wrote
`vroid-parameter-catalog.json`.

---

## 1. Container = ZIP

A `.vroid` is a plain **ZIP archive** (`PK\x03\x04`, deflate). Four entries:

| entry | size (sample) | content |
|---|---|---|
| `meta.json` | 317 B | top-level file metadata (JSON, §2) |
| `v1model/meta.json` | 54 B | model bin version (JSON, §2) |
| `v1model/data.bin` | 9.2 MB | **the model** — protobuf (§3–§5) |
| `thumbnails/thumbnail.jpg` | 73 KB | editor preview |

So reading/writing a `.vroid` = unzip → edit `v1model/data.bin` → rezip. The zip
layer is trivial; all the substance is in `data.bin`.

## 2. JSON metadata (verified, verbatim keys)

`meta.json`:
```json
{"metaDataVersion":2,"updateVroidVersionMajor":2,"updateVroidVersionMinor":14,
 "updateVroidVersionPatch":0,"updateVroidVersionExtra":"","baseModelId":"N00",
 "avatarCategory":"N00","vroidMetaDataVersion":2,"vroidVersionMajor":0,
 "vroidVersionMinor":9,"vroidVersionPatch":5,"vroidVersionExtra":"",
 "modelVariantType":"F00"}
```
`v1model/meta.json`:
```json
{"modelMetaDataVersion":1,"modelBinEncodingVersion":1}
```
Note: `baseModelId`/`avatarCategory` = **`N00`** (current base line), while
`modelVariantType` = **`F00`** (female variant). The VRM exporter tag was `0.8.1`;
the master's internal `vroidVersion` is `0.9.5`. Preserve every key on write.

## 3. `data.bin` = protobuf

`v1model/data.bin` is a standard Google-Protobuf-serialized message (verified by
parsing it with a generic protobuf wire walker — see §6). The whole payload
round-trips losslessly through parse→serialize, which is the trust anchor for
editing it.

Top-level wire layout (measured):

| field | wire | count | meaning |
|---|---|---|---|
| 1 | len(msg) | 1 | **header**: `{1:varint=6 (encoding ver), 2:GUID, 4:GUID, 5:varint=3}` |
| 2 | len(msg) | 1 | recipe / shared-asset id block |
| 3 | len(msg) | 1 | **big blob 418 KB** — geometry/recipe (sub-fields 1–6); the deformable mesh + attribute arrays |
| 4 | len(msg) | **41** | **part slots** — one per `TransferableType` (§4) |
| 5 | len(msg) | **16** | **shape-parameter groups** — `TransferableGroupType` carrying `Level*` keys (§4) |

Each `field 4` slot message: `{1: id-guid, 2: "TransferableType.N00.<Part>",
3: <~180B payload>, 4: varint, 5: varint}`.
Each `field 5` group message: `{1: id, 2: "TransferableGroupType.N00.LevelN.<Grp>",
3: "TransferableGroupEditType...", 4: id-ref, 5(repeated): "<Level*Key><id>"}`.

## 4. The parametric model (this is the "feature-complete" surface)

Three name-spaces, all extracted to `vroid-parameter-catalog.json`:

**(a) 41 part slots — `TransferableType.N00.*`** (the editable categories):
```
AllHair, Arm, BodySkin, Bottoms, Breast, Cheek, Ear, EyeHighlightTexture,
EyePosition, EyeShape, EyeWhiteTexture, EyebrowPosition, EyebrowTexture, Eyelash,
Eyelid, Eyeline, FaceShape, FaceSkin, FixedPreset, Foot, Hand, Head, InnerBottom,
InnerTop, IrisPosition, IrisShape, Leg, Lip, MouthLine, MouthShape, MouthTexture,
Neck, Nose, NoseLighting, Shoes, Shoulder, Socks, Tallness, Tops, Torso, Waist
```

**(b) 39 parameter groups — `TransferableGroupType.N00.Level{0..3}.*`**
(Level0.FaceSet, Level1.{Head,Arm,Leg,Torso,Waist,Nose,Mouth,Ear,Eyebrow,FaceShape,
Cheek,Lip,WholeBody,BodySkin,FaceSkin,AllHair,Tops,Bottoms,…}, Level2.{EyeballSet,
EyeSurrounding,Eyeline,Eyelash,Eyelid}, Level3.{Iris,EyeWhite,EyeHighlight}).

**(c) 328 parameter keys — `Level{N}<Group>_<Param>`**, of which **175 are pure
shape-deformation sliders** (the rest are material/color/texture params). These ARE
VRoid's sliders, verbatim. Examples by area:

- **Whole body:** `Level2WholeBody_FigureHeightFemale/Male/Neutral`,
  `Level2WholeBody_FigureSlender*`, `Level2WholeBody_WholeBodyScaleMag/Shrink`
- **Torso/waist/shoulder:** `Level2Torso_WaistLong/Short`,
  `Level2Waist_WaistScaleMag/Shrink`, `Level2Shoulder_ShoulderBroad/Narrow`,
  `Level2Shoulder_ClavicleLow`
- **Limbs:** `Level2Arm_ArmLong/Short`, `Level2Leg_LegLong/Short`,
  `Level2Hand_FingerThick/Thin`, `Level2Foot_FootScaleMag/Shrink`
- **Breast:** `Level2Breast_BustUp/Down/Open/Close`,
  `Level2Breast_BustScaleMag/Shrink/Shrink2`
- **Head/neck:** `Level2Head_HeadWide/Narrow`, `Level2Head_Neck{Long,Short,SpreadX/Z,NarrowX/Z,AdamsApple}`
- **Face contour:** `Level2FaceContour_{Chin*,Faceline*,FaceRound,MandibleSize,Sinciput*,HeadShapeFemale/Male}`
- **Eyes:** `Level2Eye_EyeSizeX/Y(+Shrink)`, `Level2Eye_EyePos{Up,Down,In,Out}`,
  `Level2Eye_EyeRotateInner/Outer`, `Level2EyeSurrounding_*` (droop, jitome, eyelid curves),
  `Level3Iris_EyeIrisScaleX/Y*`, `Level3Iris_Gaze{Up,Down,In,Out}ward`
- **Nose:** `Level2Nose_{NoseBig,NoseSmall,NoseWide,NoseBridgeNarrow/Wide,NoseUp/Down,NoseRootLow,NoseCurve,NoseWing*,NoseBottom*}`
- **Mouth:** `Level2Mouth_{MouthWide,MouthNarrow,MouthUp/Down,MouthCornerUp/Down,Lips*,Tooth*}`
- **Ear:** `Level2Ear_{EarScale*,EarStandUp,EarLieDown,EarRound,EarTip*}`
- **Colors/materials** (shared shape with §4 of the VRM spec):
  `Level1FaceSkin_MainColor/ShadowColor/HighlightColor`,
  `Level3Iris_LeftOverlayColor/RightOverlayColor`, `Level1Eyebrow_OverlayColor`,
  `Level1Clothing_MaterialColor/EmissionColor/ShadeColor`, `_NormalMap*`, `_MainImage`, …

→ full lists in `vroid-parameter-catalog.json` (`shapeDeformSliders`,
`allKeys_byGroup`, `partSlots_TransferableType`, `groups_TransferableGroupType`).

**Self-consistent naming:** inside the file, the group table and the slot table
share one vocabulary — the catalog key (`Level2Arm_ArmLong`), the short id
(`armLong`), and the on-disk string all line up. So an editor can read a slider's
label, its identity, and its value straight from the file's own strings, with
nothing external needed.

### 4.1 Value encoding (DECODED — read + write proven)

Each **slot** (`field 4`) carries the *current values* of its parameters at:
`slot.field3.field5.field2[]` — a repeated message, one per parameter:

```
field2 (repeated):  { field1: shortName (string),  field2: value (f32, wire type 5) }
```

- `shortName` is the lowercase id (e.g. `armLong`, `headNarrow`, `eyeSizeX`).
- The **group** (`field 5`) maps catalog key ↔ shortName
  (`group.field5[].field1 = Level2Arm_ArmLong`, `.field3.field1 = armLong`).
- **Default 0.0 values are omitted** (proto3) — a slider at rest has no `field2`,
  or the whole `field2` param entry is absent. Nonzero values are stored verbatim.

Worked example (from `model.vroid`): `Level2Head_HeadNarrow` → short `headNarrow`
→ value `1.31`, stored as a 4-byte little-endian f32 at `data.bin` offset **426**.

The join yields a full `{ catalogKey : float }` table. Sample non-default values
read from the reference master (22 of 145 present were nonzero):

```
Level2Eye_EyeSizeX = 0.634   Level2Head_HeadNarrow = 1.31
Level2Eye_EyeSizeY = 0.361   Level2Head_NeckLong = 0.44
Level2Eye_EyeRotateInner = 0.749   Level2Leg_LegLong = 0.702
Level2WholeBody_FigureHeightFemale = 0.298   Level2Torso_WaistLong = 0.428
Level2Shoulder_ShoulderNarrow = 0.716   Level2Waist_WaistScaleShrink = 0.539
Level2Breast_BustUp = 0.199   Level2FaceContour_FaceFemale = 1.0  ...
```

**Write, two cases:**
1. **Change an existing (nonzero) value** — in-place f32 patch, no length
   change, no protobuf re-encode. Locate the value offset, `struct.pack_into`,
   rezip. *Proven:* patched `headNarrow` 1.31→0.0, repacked, re-parsed = 0.0 (PASS).
2. **Set a currently-default (0.0) slider to nonzero** — the `field2` value (and
   possibly the param entry) doesn't exist yet, so this needs a real protobuf
   re-encode that grows the enclosing messages and fixes every parent length
   prefix. Use a proper protobuf encoder (or a generated schema, §5.3) for this
   path — not a byte patch.

## 5. What is decoded vs still open (honest status)

DECODED / DONE:
- Container (zip) layout + both JSON metas — complete.
- `data.bin` top-level protobuf tree + recursion into slots/groups/params.
- The full parametric **name catalog**: 41 slots, 39 groups, 328 keys (175 shape).
- **Per-slider VALUES** (§4.1): `{catalogKey -> float}` join proven; 145 sliders
  read from the reference master, 22 nonzero.
- **Lossless transcoder** (`vroid_master.py`): parse→serialize of the whole
  `data.bin` is **byte-identical** (TEST 1 PASS). This is the trust anchor for
  writing.
- **Write, all cases** (§4.1) — PROVEN via `vroid_master.py`:
  - case 1 (change an existing nonzero value): in-place f32, round-trips.
  - case 2 (set a currently-default/omitted slider): the transcoder creates the
    value field and fixes all parent length prefixes. Proof: set
    `Level2Nose_NoseBig` 0.0→0.85, `data.bin` grew exactly +5 B (1 key + 4 f32),
    re-read from disk = 0.85, **no other slider changed**, all 4 zip entries
    intact (TESTs 2–4 PASS). `model-anyslider.vroid` produced.
- **Geometry blob (`field 3`) structure** mapped: `field2` (356 KB) = mesh arrays
  (repeated f1/f2/f3/f5/f6/f9 per part), `field5` (60 KB) = texture/recipe,
  `field3` (3 KB). See §5a.

STILL OPEN (none block a parametric slider editor):
1. **VRoid GUI acceptance.** Byte-level + lossless round-trip pass; the last
   human-visible check is opening a patched master in VRoid Studio and seeing the
   moved slider. Call write "mechanically proven, GUI-confirmation pending" until
   someone eyeballs it.
2. **Full geometry decode.** Extracting actual vertex/normal/uv/index arrays from
   `field3.field2` — needed ONLY for GAIA to bake slider→mesh natively. For a
   slider editor that produces its VRM by exporting from VRoid Studio, not required.
3. **Formal `.proto` schema.** Not needed — the transcoder is schema-free and
   already reads/writes every slider by its own string name. Recovering the
   original protobuf field names would be cosmetic only; deferred.

### 5a. Geometry blob (`field 3`, 418 KB) — structural map
```
field3 (418540 B)
  field2 [355636 B]  mesh data — repeated subfields f1×14, f2×24, f3×4,
                     f5×26, f6×21, f9×24  (per-part vertex/normal/uv/index arrays)
  field5 [ 59864 B]  texture/recipe — subfields f3×5, f9×4, f4/f5/f6/f8/f10
  field3 [  3017 B]  small aux (f1×2)
  field1/field4/field6  empty or tiny
```
Editing sliders does NOT require touching this blob; it is the base/deform mesh the
sliders operate on. Decode it only to pursue GAIA-native baking (Open item 2).

## 6. Reader/writer implementation path

1. **Read:** `unzip → protobuf-decode v1model/data.bin` with a permissive wire
   walker (snippets below; `docs/vroid_master.py` is the full reference).
2. **Edit:** locate the target `Level*` key's value field; set the normalized float
   (shape) or RGBA/asset-id (material). Keep all other bytes intact.
3. **Write:** re-encode protobuf → replace `v1model/data.bin` in the zip → keep
   `meta.json`/thumbnail. Preserve field order where practical.
4. **Validate:** open the result in VRoid Studio (Open item 1); also re-run the
   extractor and diff catalogs.

Minimal wire walker (varint + length-delimited), proven on this file:
```python
def rv(b,p):
    r=s=0
    while True:
        c=b[p]; r|=(c&0x7f)<<s; p+=1; s+=7
        if not c&0x80: return r,p
def iter_field(b,target):        # yields payloads of a given field number
    p=0
    while p<len(b):
        k,p=rv(b,p); fn=k>>3; wt=k&7
        if wt==0: _,p=rv(b,p)
        elif wt==2:
            ln,p=rv(b,p)
            if fn==target: yield b[p:p+ln]
            p+=ln
        elif wt==5: p+=4
        elif wt==1: p+=8
        else: break
```

## 7. How this feeds the GAIA character editor

Two coherent products, share one UI:

- **Parametric editor (route 2):** the editor exposes the 175 shape sliders + color
  slots from §4 as native GAIA controls. Editing reads/writes the `.vroid` slider
  values directly (`docs/vroid_master.py`). Turning a slider set into a finished
  mesh (baking) requires either (a) decoding the `field 3` geometry so GAIA bakes it
  natively, or (b) opening the edited `.vroid` in VRoid Studio and exporting VRM.
- **VRM output (route 1):** produce the VRM by exporting the edited master from
  VRoid Studio, or via GAIA's own baker once the `field 3` geometry is decoded.

Recommended sequencing for Fable:
1. Ship the **VRM editor** (`VRM-CHARACTER-EDITOR-SPEC.md`) first — fully open,
   no gaps, real avatars today.
2. Add the **parametric layer**: load `.vroid`, present the §4 sliders with their
   values (`docs/vroid_master.py`), edit, save `.vroid`. Produce a VRM by exporting
   the edited master from VRoid Studio.
3. Long-term: decode `field 3` geometry to bake slider→mesh natively in GAIA,
   removing the VRoid dependency entirely.

## 8. Provenance
- Sample master: `~/Documents/model.vroid` (Female N00, VRoid 2.14.0).
- **Reference read/write implementation:** `docs/vroid_master.py`
  (lossless protobuf transcoder + `read_values()` / `set_value()`; a JS port of
  this is what the GAIA editor needs for `.vroid` I/O).
- Proof artifacts: `~/Documents/model-patched.vroid` (case-1),
  `~/Documents/model-anyslider.vroid` (case-2, `Level2Nose_NoseBig`=0.85).
- Extracted catalog: `docs/vroid-parameter-catalog.json`.
