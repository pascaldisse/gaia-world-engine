# agni-thickness — P2 thickness debug world (atom2 step a)

Copy of `worlds/surya-optin` with ONE data difference: the fluid component's
`render.mode` is `thickness` (plus its two knobs `thicknessScale`,
`debugGain`). Nothing in the engine is thickness-specific — the pass is chosen
by world data, exactly like `sprites` and `surface`.

```sh
GAIA_WORLD=$PWD/worlds/agni-thickness node server/index.js
```

What must be visible: a GREY additive cloud where the liquid is — bright where
many particles overlap along the view ray, dark at the thin rim. That grey IS
the optical thickness the 8e28cd9 surface never had; it is a proof plate, not
the final look. Refraction/absorption/Fresnel arrive in atoms b–c.

`debugGain` only maps metres→white for this view; it never enters physics.
