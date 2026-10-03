// Humanoid kit — texture sharing (stage 7). Every glTF parse builds its OWN Texture per image: a base + `_lod1` + `_lod2`
// (and any costume piece) that carry the same atlas ⇒ 3 Textures ⇒ 3 GPU uploads/memory for ONE picture.
// internTextures() swaps every material texture of a freshly loaded template for ONE canonical Texture per
// (image identity, sampler config); the registry is refcounted: each template holds one ref per key, each live instance
// one more. refs 0 ⇒ texture.dispose() exactly once.
//   image identity = resolved image URL (external uri) · content hash (embedded bufferView / data: uri / raw pixel data).
//   sampler config = colourSpace, wrap, filters, flipY, mipmaps, anisotropy, channel, uv transform ⇒ the SAME picture
//   used under two different configs stays two Textures (never merges what would sample differently).
import { LoaderUtils } from 'three';
// 64-bit-ish non-crypto hash over bytes (two 32-bit lanes) + length. Asset dedupe only, never a security boundary
export function hashBytes(bytes) {
  let h1 = 0xdeadbeef ^ bytes.length;
  let h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}-${bytes.length}`;
}
const hashString = (s) => hashBytes(new TextEncoder().encode(s));
const bytesOf = (data) => (data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
// everything that changes how the SAME pixels sample/upload
export function samplerSig(t) {
  return [
    t.colorSpace, t.wrapS, t.wrapT, t.magFilter, t.minFilter, t.flipY ? 1 : 0, t.generateMipmaps ? 1 : 0, t.anisotropy,
    t.premultiplyAlpha ? 1 : 0, t.channel, t.format, t.type, t.mapping,
    t.offset?.x, t.offset?.y, t.repeat?.x, t.repeat?.y, t.rotation, t.center?.x, t.center?.y,
  ].join(',');
}
// `lod/../tex/a.png` and `tex/a.png` are one file: fold dot-segments the way the browser's fetch does
const normalizeUrl = (u) => { try { return new URL(u, typeof location !== 'undefined' ? location.href : 'http://localhost/').href; } catch { return u; } };
// identity of the picture behind a Texture, or null (unknown ⇒ left alone, never shared across files)
export async function imageIdentity(tex, gltf) {
  const parser = gltf?.parser;
  const idx = parser?.associations?.get(tex)?.textures;
  const def = Number.isInteger(idx) ? parser.json.textures?.[idx] : null;
  if (def) {
    const src = def.source ?? Object.values(def.extensions ?? {}).find((e) => Number.isInteger(e?.source))?.source;
    const img = parser.json.images?.[src];
    if (img) {
      if (Number.isInteger(img.bufferView)) return `bytes:${hashBytes(bytesOf(await parser.getDependency('bufferView', img.bufferView)))}`;
      if (typeof img.uri === 'string') {
        if (img.uri.startsWith('data:')) return `data:${hashString(img.uri)}`;
        return `uri:${normalizeUrl(LoaderUtils.resolveURL(img.uri, parser.options?.path ?? ''))}`; // what the loader fetched
      }
    }
  }
  const im = tex.image ?? tex.source?.data;
  if (im && ArrayBuffer.isView(im.data)) return `px:${im.width}x${im.height}:${hashBytes(bytesOf(im.data))}`;
  if (typeof im?.src === 'string' && !im.src.startsWith('blob:')) return `uri:${im.src}`;
  return null;
}
const REG = new Map(); // `${identity}|${samplerSig}` -> { texture, refs }
const isTex = (v) => v && v.isTexture === true;
// Canonicalise every texture of `scene`'s materials (+ the `masks` Map values) IN PLACE; returns the registry keys the
// caller now holds ONE ref on (give to releaseTextures once). Any failure to identify a texture leaves it untouched.
export async function internTextures(scene, gltf, masks = null) {
  const slots = [];
  const mats = new Set();
  scene?.traverse((o) => { for (const m of [].concat(o.material ?? [])) mats.add(m); });
  for (const m of mats) for (const [k, v] of Object.entries(m)) if (isTex(v)) slots.push({ tex: v, set: (c) => { m[k] = c; } });
  if (masks) for (const [id, v] of masks) if (isTex(v)) slots.push({ tex: v, set: (c) => { masks.set(id, c); } });
  const keyOf = new Map(); // Texture -> registry key | null (a Texture shared by several slots is identified once)
  for (const { tex } of slots) {
    if (keyOf.has(tex)) continue;
    let key = null;
    try {
      const id = await imageIdentity(tex, gltf);
      if (id) key = `${id}|${samplerSig(tex)}`;
    } catch (error) { console.warn('[humanoid] texture identity failed, not shared', error); }
    keyOf.set(tex, key);
  }
  // commit synchronously (no await between lookup and insert ⇒ concurrent loads cannot both register the same key)
  const held = new Set();
  for (const s of slots) {
    const key = keyOf.get(s.tex);
    if (!key) continue;
    let e = REG.get(key);
    if (!e) {
      e = { texture: s.tex, refs: 0 };
      e.texture.userData.shared = true;
      e.texture.userData.humanoidTexture = key;
      REG.set(key, e);
    }
    if (!held.has(key)) { held.add(key); e.refs++; }
    if (e.texture !== s.tex) s.set(e.texture); // duplicate (never uploaded) is dropped to GC
  }
  return [...held];
}
// +1 ref on every still-registered key; returns the keys actually retained (pass THAT to releaseTextures)
export function retainTextures(keys) {
  const out = [];
  for (const k of keys) {
    const e = REG.get(k);
    if (!e) continue;
    e.refs++;
    out.push(k);
  }
  return out;
}
export function releaseTextures(keys) {
  for (const k of keys) {
    const e = REG.get(k);
    if (!e) continue;
    if (--e.refs <= 0) {
      REG.delete(k);
      e.texture.dispose();
    }
  }
}
export const humanoidTextureStats = () => ({ textures: REG.size, refs: [...REG.values()].reduce((s, e) => s + e.refs, 0), keys: [...REG.keys()] });
