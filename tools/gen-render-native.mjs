#!/usr/bin/env bun
// tools/gen-render-native.mjs — generate the GaiaRenderNative wire protocol from render-wasm's #[wasm_bindgen] exports.
//   source of truth : client-rs/packages/render-wasm/src/lib.rs  (+ tools/gen-render-native.config.json policy)
//   emits           : crates/gaia-render-host/src/commands.gen.rs  (Commands trait + opcode table + decoder dispatch)
//                     client/kernel/render-api/native/gaia-render-native.gen.js  (JS proxy class, identical method surface)
// usage: bun tools/gen-render-native.mjs [--check]      (--check: exit 1 if the checked-in outputs are stale)
// Adding/changing a render-wasm export + re-running this = JS proxy and Rust decoder change together; the Rust `Commands`
// trait has no default methods, so a Host/Session that lacks the new export does not compile (drift is a build error).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(resolve(root, 'tools/gen-render-native.config.json'), 'utf8'));
const check = process.argv.includes('--check');

// ---------- parse lib.rs ----------
const src = readFileSync(resolve(root, cfg.source), 'utf8');
const lines = src.split('\n');
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const fns = [];
// `#[wasm_bindgen] impl GaiaRender { ... }` exports EVERY `pub fn` in the block (js_name attribute optional).
const implStart = lines.findIndex((l) => /^impl\s+GaiaRender\s*\{/.test(l));
if (implStart < 0 || !/^#\[wasm_bindgen\]/.test(lines[implStart - 1])) throw new Error('#[wasm_bindgen] impl GaiaRender not found');
let implEnd = implStart, bd = 0, seen = false; // brace-match (the source's indentation is not reliable)
for (; implEnd < lines.length; implEnd++) { for (const ch of lines[implEnd]) { if (ch === '{') { bd++; seen = true; } else if (ch === '}') bd--; } if (seen && bd === 0) break; }
for (let j = implStart + 1; j < implEnd; j++) {
  if (!/^\s*pub\s+(async\s+)?fn\s/.test(lines[j])) continue;
  let a = j - 1, m = null;
  while (a > implStart && /^\s*(#\[|\/\/)/.test(lines[a])) { m = m ?? lines[a].match(/^\s*#\[wasm_bindgen\(js_name\s*=\s*(\w+)\)\]/); a--; }
  m = m ?? [];
  // signature up to the opening brace of the body
  let sig = '', k = j;
  for (; k < lines.length; k++) { sig += lines[k] + ' '; if (lines[k].includes('{')) break; }
  sig = sig.slice(0, sig.indexOf('{')).trim();
  // body by brace matching
  let depth = 0, body = '', started = false;
  for (let b = k; b < lines.length && !(started && depth === 0); b++) {
    const line = b === k ? lines[b].slice(lines[b].indexOf('{')) : lines[b];
    for (const ch of line) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    body += line + '\n';
  }
  const sm = sig.match(/pub\s+(async\s+)?fn\s+(\w+)\s*\(([\s\S]*)\)\s*(?:->\s*([\s\S]+))?$/);
  if (!sm) throw new Error(`cannot parse signature: ${sig}`);
  const [, isAsync, rname, rawParams, ret = ''] = sm;
  const jsName = m[1] ?? camel(rname);
  const parts = []; let d = 0, cur = '';
  for (const ch of rawParams) { if ('<(['.includes(ch)) d++; if ('>)]'.includes(ch)) d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  const recv = parts.shift()?.trim() ?? '';
  const params = isAsync ? [] : parts.map((p) => { const [n, ...t] = p.split(':'); return { name: n.trim(), type: t.join(':').trim() }; });
  const idKind = body.match(/self\.id\("([^"]+)"\)/)?.[1] ?? null;
  fns.push({ rname, jsName, isAsync: !!isAsync, recv, params, ret: ret.trim(), idKind });
}

// ---------- classify ----------
const SCALAR = { u32: 'u32', i32: 'i32', f32: 'f32', bool: 'bool' };
const ARR = { '&[f32]': 'f32s', '&[u32]': 'u32s', '&[u8]': 'u8s' };
const codecOf = (fn, p) => {
  const o = cfg.params[`${fn.jsName}.${p.name}`];
  if (o) return o;
  if (SCALAR[p.type]) return SCALAR[p.type];
  if (ARR[p.type]) return ARR[p.type];
  if (p.type === '&str' || p.type === 'String') return 'str';
  throw new Error(`${fn.jsName}.${p.name}: type '${p.type}' has no codec — add it to tools/gen-render-native.config.json "params"`);
};
const RUST_T = { u32: 'u32', i32: 'i32', f32: 'f32', bool: 'bool', f32s: '&[f32]', u32s: '&[u32]', u8s: '&[u8]', str: '&str', json: '&serde_json::Value', bindings: '&[gaia_render::MaterialBinding]', strlist: '&[String]' };
const isUnit = (r) => r === '' || /^Result<\(\)\s*,/.test(r);

const ops = [];      // wire commands (everything that mutates)
const queries = [];  // &self (or drain) → read from stats snapshot
const frames = [];   // render* → hand-written in runtime
const manual = [];
let commitOp = null;
for (const fn of fns) {
  if (cfg.manual.includes(fn.jsName)) { manual.push(fn.jsName); continue; }
  if (cfg.frame[fn.jsName]) {
    frames.push({ jsName: fn.jsName, kind: cfg.frame[fn.jsName] });
    if (fn.jsName === cfg.commitMethod) { commitOp = { jsName: fn.jsName, rname: 'frame_commit', params: [], codecs: [], create: null, local: null, op: ops.length + 1 }; ops.push(commitOp); }
    continue;
  }
  const codecs = fn.params.map((p) => codecOf(fn, p));
  const isQuery = fn.recv === '&self' || cfg.drain.includes(fn.jsName);
  if (isQuery) { queries.push({ jsName: fn.jsName, rname: fn.rname, drain: cfg.drain.includes(fn.jsName), type: cfg.queryTypes[fn.jsName] ?? null, params: fn.params }); if (fn.params.length) throw new Error(`query ${fn.jsName} takes params`); continue; }
  if (fn.recv !== '&mut self') throw new Error(`${fn.jsName}: unsupported receiver '${fn.recv}'`);
  const local = cfg.local[fn.jsName] ?? null;
  if (!fn.idKind && !isUnit(fn.ret) && local == null) throw new Error(`${fn.jsName}: returns '${fn.ret}' — classify in config (local / drain / frame)`);
  if (fn.idKind && !/^Result<u32\s*,|^u32$/.test(fn.ret)) throw new Error(`${fn.jsName}: id-allocating fn must return u32`);
  ops.push({ jsName: fn.jsName, rname: fn.rname, params: fn.params, codecs, create: fn.idKind, local, op: ops.length + 1 });
}
if (!commitOp) throw new Error('config.commitMethod not found');

// API hash (FNV-1a 32) over a canonical signature string: JS and Rust refuse to talk across drift.
const canon = ops.map((o) => `${o.op}:${o.jsName}(${o.create ? 'id,' : ''}${o.codecs.join(',')})`).join(';') + '|' + queries.map((q) => q.jsName).join(',');
let h = 0x811c9dc5; for (const ch of Buffer.from(canon)) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
const apiHash = h >>> 0;

// ---------- emit Rust ----------
const banner = (c) => `${c} @generated by tools/gen-render-native.mjs from ${cfg.source} — DO NOT EDIT (bun tools/gen-render-native.mjs)`;
const rustArgs = (o) => [o.create ? 'id: u32' : null, ...o.params.map((p, i) => `${p.name}: ${RUST_T[o.codecs[i]]}`)].filter(Boolean).join(', ');
let rs = `${banner('//')}\n#![allow(clippy::all, clippy::too_many_arguments)]\nuse crate::wire::{DecodeError, Reader};\n\n`;
rs += `/// FNV-1a over the canonical op signatures: the JS proxy sends it in HELLO; a mismatch refuses the stream.\npub const API_HASH: u32 = 0x${apiHash.toString(16).padStart(8, '0')};\n`;
rs += `/// Wire opcode of the frame-commit command (JS \`render()\`).\npub const OP_FRAME_COMMIT: u16 = ${commitOp.op};\n`;
rs += `pub const OP_COUNT: u16 = ${ops.length};\n\npub type CmdResult = Result<(), String>;\n\n`;
rs += `/// One method per render-wasm export (rust name; ids passed in by the JS allocator). No defaults on purpose.\npub trait Commands {\n`;
for (const o of ops) rs += `    /// op ${o.op} · JS \`${o.jsName}\`${o.create ? ` · allocates a "${o.create}" id` : ''}\n    fn ${o.rname}(&mut self${rustArgs(o) ? ', ' + rustArgs(o) : ''}) -> CmdResult;\n`;
rs += `    // ---- queries (read once per frame commit into the report; JS getters serve the cached value) ----\n`;
for (const q of queries) rs += `    /// JS \`${q.jsName}\`${q.drain ? ' (drain: value is consumed by this call)' : ''}\n    fn ${q.rname}(&mut self) -> serde_json::Value;\n`;
rs += `}\n\n`;
rs += `pub fn op_name(op: u16) -> &'static str {\n    match op {\n${ops.map((o) => `        ${o.op} => "${o.jsName}",`).join('\n')}\n        _ => "?",\n    }\n}\n\n`;
rs += `/// Result of one decoded command: \`id\` = the handle the command carried (creates) else 0.\npub struct Dispatched {\n    pub id: u32,\n    pub result: CmdResult,\n}\n\n`;
rs += `/// Decode one command payload (header already stripped) and invoke the matching \`Commands\` method.\n/// \`Err(DecodeError)\` = payload malformed / unknown op (the command is skipped; framing is intact).\npub fn dispatch<C: Commands + ?Sized>(c: &mut C, op: u16, r: &mut Reader<'_>) -> Result<Dispatched, DecodeError> {\n    Ok(match op {\n`;
const RD = { u32: 'u32', i32: 'i32', f32: 'f32', bool: 'bool', f32s: 'f32s', u32s: 'u32s', u8s: 'u8s', str: 'str', json: 'json', bindings: 'bindings', strlist: 'strlist' };
for (const o of ops) {
  rs += `        ${o.op} => {\n`;
  if (o.create) rs += `            let id = r.u32()?;\n`;
  o.params.forEach((p, i) => { rs += `            let ${p.name} = r.${RD[o.codecs[i]]}()?;\n`; });
  const callArgs = [o.create ? 'id' : null, ...o.params.map((p, i) => ['f32s', 'u32s', 'u8s', 'bindings', 'strlist', 'json'].includes(o.codecs[i]) ? `&${p.name}` : p.name)].filter(Boolean).join(', ');
  rs += `            Dispatched { id: ${o.create ? 'id' : '0'}, result: c.${o.rname}(${callArgs}) }\n        }\n`;
}
rs += `        _ => return Err(DecodeError::UnknownOp(op)),\n    })\n}\n\n`;
rs += `/// Every query once, keyed by JS name (the frame-commit report's \`q\` object).\npub fn collect_queries<C: Commands + ?Sized>(c: &mut C) -> serde_json::Map<String, serde_json::Value> {\n    let mut m = serde_json::Map::new();\n${queries.map((q) => `    m.insert("${q.jsName}".into(), c.${q.rname}());`).join('\n')}\n    m\n}\n`;

// ---------- emit JS ----------
const WR = { u32: 'u32', i32: 'i32', f32: 'f32', bool: 'bool', f32s: 'f32s', u32s: 'u32s', u8s: 'u8s', str: 'str', json: 'json', bindings: 'bindings', strlist: 'strlist' };
let js = `${banner('//')}\n// Method surface == render-wasm GaiaRender (names + argument order). Wire spec: crates/gaia-render-host/README.md · native-wire.js.\n`;
js += `export const API_HASH = 0x${apiHash.toString(16).padStart(8, '0')};\nexport const OP_FRAME_COMMIT = ${commitOp.op};\n`;
js += `export const OPS = Object.freeze({\n${ops.map((o) => `  ${o.jsName}: ${o.op},`).join('\n')}\n});\n`;
js += `export const QUERIES = Object.freeze({\n${queries.map((q) => `  ${q.jsName}: { drain: ${q.drain}, type: ${JSON.stringify(q.type)}, dflt: ${JSON.stringify(cfg.queryDefaults[q.jsName] ?? null)} },`).join('\n')}\n});\n\n`;
js += `/** rt = { w: Writer, alloc(kind) -> id, q(name) -> cached query value }. */\nexport class GaiaRenderNativeGen {\n  constructor(rt) { this._rt = rt; }\n`;
for (const o of ops) {
  if (o === commitOp) continue; // hand-written (flush)
  const args = o.params.map((p) => camel(p.name));
  js += `  ${o.jsName}(${args.join(', ')}) {\n`;
  if (o.create) js += `    const id = this._rt.alloc(${JSON.stringify(o.create)});\n`;
  js += `    const w = this._rt.w; w.begin(${o.op});\n`;
  if (o.create) js += `    w.u32(id);\n`;
  o.codecs.forEach((c, i) => { js += `    w.${WR[c]}(${args[i]});\n`; });
  js += `    w.end();\n`;
  if (o.create) js += `    return id;\n`;
  else if (o.local != null) js += `    return ${o.local};\n`;
  js += `  }\n`;
}
for (const q of queries) js += `  ${q.jsName}() { return this._rt.q(${JSON.stringify(q.jsName)}); }\n`;
js += `}\n`;

// ---------- write ----------
const outs = [[resolve(root, cfg.outRust), rs], [resolve(root, cfg.outJs), js]];
let stale = 0;
for (const [p, text] of outs) {
  if (check) { if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { console.error(`STALE ${p}`); stale++; } }
  else writeFileSync(p, text);
}
console.log(`${check ? 'checked' : 'wrote'}: ${ops.length} ops (${ops.filter((o) => o.create).length} allocating) · ${queries.length} queries · ${frames.length} frame ops · manual [${manual}] · api_hash 0x${apiHash.toString(16)}`);
if (stale) process.exit(1);
