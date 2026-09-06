import fs from 'node:fs';
import path from 'node:path';
// § Fresh snapshot on boot/reset; invalid JSON throws before the caller replaces its old library.
export function readPrefabLibrary(worldDir) {
  const legacy=path.join(worldDir,'prefabs.json'),dir=path.join(worldDir,'prefabs');
  const rows=fs.existsSync(legacy)?JSON.parse(fs.readFileSync(legacy,'utf8')):[];
  if(!Array.isArray(rows))throw Error('prefabs.json must be a list');
  const library=new Map();
  const add=p=>{if(!p||typeof p.name!=='string'||!p.name||!p.components||typeof p.components!=='object'||Array.isArray(p.components))throw Error('invalid named prefab document');library.set(p.name,p);};
  rows.forEach(add);
  if(fs.existsSync(dir))for(const file of fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort())add(JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')));
  return [...library.values()];
}
