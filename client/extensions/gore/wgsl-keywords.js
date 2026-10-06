// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// A geometry/TSL attribute NAME becomes a WGSL identifier verbatim in the
// generated shader; a name that collides with a WGSL keyword or reserved
// word fails shader compilation (live-found parent report: 'meta' as an
// attribute name → black screen). Sourced from the PUBLIC W3C WGSL spec
// (Keyword Summary + Reserved Words sections, gpuweb/gpuweb wgsl/index.bs +
// wgsl/wgsl.reserved.bs.include, fetched 2026-09-29) — not from any forbidden
// path. Every attribute name this extension creates is prefixed `goreX` and
// additionally checked against this table by test/gore-wgsl-identifiers.test.js.

export const WGSL_KEYWORDS = [
  'alias', 'break', 'case', 'const', 'const_assert', 'continue', 'continuing',
  'default', 'diagnostic', 'discard', 'else', 'enable', 'false', 'fn', 'for',
  'if', 'let', 'loop', 'override', 'requires', 'return', 'struct', 'switch',
  'true', 'var', 'while',
];

export const WGSL_RESERVED_WORDS = [
  'NULL', 'Self', 'abstract', 'active', 'alignas', 'alignof', 'as', 'asm',
  'asm_fragment', 'async', 'attribute', 'auto', 'await', 'become', 'cast',
  'catch', 'class', 'co_await', 'co_return', 'co_yield', 'coherent',
  'column_major', 'common', 'compile', 'compile_fragment', 'concept',
  'const_cast', 'consteval', 'constexpr', 'constinit', 'crate', 'debugger',
  'decltype', 'delete', 'demote', 'demote_to_helper', 'do', 'dynamic_cast',
  'enum', 'explicit', 'export', 'extends', 'extern', 'external',
  'fallthrough', 'filter', 'final', 'finally', 'friend', 'from', 'fxgroup',
  'get', 'goto', 'groupshared', 'highp', 'impl', 'implements', 'import',
  'inline', 'instanceof', 'interface', 'layout', 'lowp', 'macro',
  'macro_rules', 'match', 'mediump', 'meta', 'mod', 'module', 'move', 'mut',
  'mutable', 'namespace', 'new', 'nil', 'noexcept', 'noinline',
  'nointerpolation', 'non_coherent', 'noncoherent', 'noperspective', 'null',
  'nullptr', 'of', 'operator', 'package', 'packoffset', 'partition', 'pass',
  'patch', 'pixelfragment', 'precise', 'precision', 'premerge', 'priv',
  'protected', 'pub', 'public', 'readonly', 'ref', 'regardless', 'register',
  'reinterpret_cast', 'require', 'resource', 'restrict', 'self', 'set',
  'shared', 'sizeof', 'smooth', 'snorm', 'static', 'static_assert',
  'static_cast', 'std', 'subroutine', 'super', 'target', 'template', 'this',
  'thread_local', 'throw', 'trait', 'try', 'type', 'typedef', 'typeid',
  'typename', 'typeof', 'union', 'unless', 'unorm', 'unsafe', 'unsized',
  'use', 'using', 'varying', 'virtual', 'volatile', 'wgsl', 'where', 'with',
  'writeonly', 'yield',
];

export const WGSL_FORBIDDEN_IDENTIFIERS = new Set([...WGSL_KEYWORDS, ...WGSL_RESERVED_WORDS]);

/** @param {string} name @returns {boolean} true if `name` is safe to use as a WGSL identifier */
export function isWgslSafeIdentifier(name) {
  return typeof name === 'string' && name.length > 0 && !WGSL_FORBIDDEN_IDENTIFIERS.has(name);
}
