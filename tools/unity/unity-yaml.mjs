import fs from 'node:fs/promises';
import path from 'node:path';

export const CLASS_NAMES = {
  1: 'GameObject', 4: 'Transform', 20: 'Camera', 23: 'MeshRenderer', 33: 'MeshFilter', 64: 'MeshCollider', 65: 'BoxCollider',
  108: 'Light', 114: 'MonoBehaviour', 135: 'SphereCollider', 136: 'CapsuleCollider', 156: 'TerrainData', 218: 'Terrain',
  224: 'RectTransform', 1001: 'PrefabInstance'
};

export function splitUnityDocuments(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const docs = [];
  let cur = null;
  const headerRe = /^---\s+!u!(\d+)\s+&(-?\d+)(?:\s+(\w+))?/;
  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m) {
      if (cur) docs.push(cur);
      cur = { classId: Number(m[1]), fileID: m[2], stripped: m[3] === 'stripped', header: line, lines: [] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('%YAML') || line.startsWith('%TAG')) continue;
    cur.lines.push(line);
  }
  if (cur) docs.push(cur);
  return docs;
}

function countIndent(s) {
  const m = /^( *)/.exec(s);
  return m ? m[1].length : 0;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if ((c === '"' || c === "'") && line[i - 1] !== '\\') quote = quote === c ? null : (quote ?? c);
    if (c === '#' && !quote && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line;
}

function prepareLines(lines) {
  return lines
    .map(raw => stripComment(raw.replace(/\t/g, '  ')))
    .filter(line => line.trim().length > 0)
    .map(line => ({ indent: countIndent(line), text: line.trim() }));
}

function findTopLevelColon(s) {
  let depth = 0, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && s[i - 1] !== '\\') { quote = quote === c ? null : (quote ?? c); continue; }
    if (quote) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s, sep = ',') {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c === '"' || c === "'") && s[i - 1] !== '\\') { quote = quote === c ? null : (quote ?? c); continue; }
    if (quote) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

function parseInlineMap(s) {
  const body = s.slice(1, -1).trim();
  const obj = {};
  if (!body) return obj;
  for (const part of splitTopLevel(body)) {
    const idx = findTopLevelColon(part);
    if (idx < 0) continue;
    obj[part.slice(0, idx).trim()] = parseScalar(part.slice(idx + 1).trim());
  }
  return obj;
}

function parseInlineArray(s) {
  const body = s.slice(1, -1).trim();
  if (!body) return [];
  return splitTopLevel(body).map(parseScalar);
}

function parseQuoted(s) {
  const quote = s[0];
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] === '\\' && quote === '"') {
      const n = s[++i];
      out += ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[n] ?? n);
    } else out += s[i];
  }
  return out;
}

export function parseScalar(s) {
  s = (s ?? '').trim();
  if (s === '') return '';
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s[0] === '{' && s.at(-1) === '}') return parseInlineMap(s);
  if (s[0] === '[' && s.at(-1) === ']') return parseInlineArray(s);
  if ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'")) return parseQuoted(s);
  if (/^(?:null|Null|NULL|~)$/.test(s)) return null;
  if (/^(?:true|True|TRUE)$/.test(s)) return true;
  if (/^(?:false|False|FALSE)$/.test(s)) return false;
  // GUIDs and Unity's zero-padded magic refs must stay strings.
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
    if (/^[-+]?0\d/.test(s)) return s;
    if (/^[+-]?\d+$/.test(s) && s.replace(/^[-+]/, '').length > 15) return s;
    return Number(s);
  }
  return s;
}

function parseBlock(lines, i, indent) {
  if (i >= lines.length || lines[i].indent < indent) return [null, i];
  if (lines[i].text.startsWith('-')) return parseSeq(lines, i, lines[i].indent);
  return parseMap(lines, i, lines[i].indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) { i++; continue; }
    if (line.text.startsWith('-')) break;
    const idx = findTopLevelColon(line.text);
    if (idx < 0) { i++; continue; }
    const key = line.text.slice(0, idx).trim();
    const rest = line.text.slice(idx + 1).trim();
    i++;
    if (rest === '') {
      // Unity YAML commonly writes a sequence directly under a key at the
      // same indentation as the key itself:
      //   m_Component:
      //   - component: {fileID: ...}
      const hasIndentedChild = i < lines.length && lines[i].indent > indent;
      const hasSameIndentSequenceChild = i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('-');
      if (hasIndentedChild || hasSameIndentSequenceChild) {
        const [child, ni] = parseBlock(lines, i, lines[i].indent);
        obj[key] = child;
        i = ni;
      } else obj[key] = null;
    } else obj[key] = parseScalar(rest);
  }
  return [obj, i];
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) { i++; continue; }
    if (!line.text.startsWith('-')) break;
    let rest = line.text.slice(1).trim();
    i++;
    let item;
    if (rest === '') {
      if (i < lines.length && lines[i].indent > indent) [item, i] = parseBlock(lines, i, lines[i].indent);
      else item = null;
    } else {
      const idx = findTopLevelColon(rest);
      if (idx > 0 && !rest.startsWith('{') && !rest.startsWith('[')) {
        item = {};
        const key = rest.slice(0, idx).trim();
        const val = rest.slice(idx + 1).trim();
        item[key] = val === '' ? null : parseScalar(val);
        if (i < lines.length && lines[i].indent > indent) {
          const [tail, ni] = parseMap(lines, i, lines[i].indent);
          if (tail && typeof tail === 'object' && !Array.isArray(tail)) Object.assign(item, tail);
          i = ni;
        }
      } else item = parseScalar(rest);
    }
    arr.push(item);
  }
  return [arr, i];
}

export function parseUnityYamlBody(lines) {
  const prepared = prepareLines(lines);
  if (!prepared.length) return null;
  const [obj] = parseBlock(prepared, 0, prepared[0].indent);
  return obj;
}

export async function loadGuidDb(defaultPath) {
  const text = await fs.readFile(defaultPath, 'utf8').catch(() => null);
  if (!text) return { unityProjectRoot: null, guids: {} };
  const db = JSON.parse(text);
  if (db.guids) return db;
  return { unityProjectRoot: null, guids: db };
}

export function normalizeFileID(v) {
  if (v == null) return '0';
  if (typeof v === 'object' && 'fileID' in v) return normalizeFileID(v.fileID);
  return String(v);
}

export function cleanRef(ref, guidDb) {
  if (!ref || typeof ref !== 'object') return null;
  const guid = typeof ref.guid === 'string' ? ref.guid.toLowerCase() : undefined;
  const rec = guid ? guidDb.guids?.[guid] : undefined;
  const out = { fileID: normalizeFileID(ref.fileID ?? 0) };
  if (guid) out.guid = guid;
  if (ref.type != null) out.type = ref.type;
  if (rec) Object.assign(out, { path: rec.path, kind: rec.kind });
  return out;
}

export function withoutKeys(obj, keys) {
  const set = new Set(keys);
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!set.has(k)) out[k] = v;
  return out;
}

export function pathBaseNoExt(p) {
  return path.basename(p, path.extname(p));
}
