import fs from 'node:fs';
import path from 'node:path';
import { files, readJSON } from './pipeline.mjs';
export function auditWorld(world, {requiredFiles=[]}={}) {
 const errors=[],references=[],scenes=[],prefabs=new Map();
 for(const file of requiredFiles) if(!fs.existsSync(path.join(world,file)))errors.push({kind:'missing-required-file',file});
 function visit(value, file, pointer='') {
  if(typeof value==='string' && /^\/?assets\//.test(value)) {
   const relative=value.replace(/^\//,''), resolved=path.resolve(world,relative);
   const safe=resolved.startsWith(path.resolve(world)+path.sep);
   const exists=safe && fs.existsSync(resolved);
   references.push({file,pointer,path:value,exists});
   if(!exists)errors.push({kind:safe?'missing-asset':'unsafe-asset',file,pointer,path:value});
  } else if(Array.isArray(value)) value.forEach((v,i)=>visit(v,file,`${pointer}/${i}`));
  else if(value && typeof value==='object') for(const [k,v] of Object.entries(value))visit(v,file,`${pointer}/${k}`);
 }
 for(const file of files(world).filter(p=>p.endsWith('.json'))) {
  const rel=path.relative(world,file), doc=readJSON(file);
  if(!rel.startsWith('assets/') && rel!=='emission-report.json')visit(doc,rel);
  if(rel.startsWith('prefabs/'))prefabs.set(path.basename(file,'.json'),doc.components??doc);
  if(rel.startsWith('scenes/'))scenes.push({file:rel,doc});
 }
 let entities=0,colliderEntities=0,meshEntities=0;
 for(const {file,doc} of scenes)for(const [id,entity] of Object.entries(doc)) {
  entities++;
  if(entity.prefab && !prefabs.has(entity.prefab))errors.push({kind:'missing-prefab',file,id,prefab:entity.prefab});
  const effective={...(prefabs.get(entity.prefab)??{}),...entity};
  if(effective.collider)colliderEntities++;
  if(effective.mesh)meshEntities++;
 }
 for(const file of files(world).filter(f=>f.endsWith('.glb'))) {
  try {
   const b=fs.readFileSync(file);
   if(b.length<20 || b.readUInt32LE(0)!==0x46546c67 || b.readUInt32LE(4)!==2 || b.readUInt32LE(8)!==b.length)throw new Error('invalid GLB header/length');
   const n=b.readUInt32LE(12);if(n+20>b.length || b.readUInt32LE(16)!==0x4e4f534a)throw new Error('invalid JSON chunk');
   const gltf=JSON.parse(b.subarray(20,20+n).toString());
   for(const ref of [...(gltf.images??[]),...(gltf.buffers??[])])if(ref.uri && !ref.uri.startsWith('data:')) {
    const resolved=path.resolve(path.dirname(file),decodeURIComponent(ref.uri));
    if(!resolved.startsWith(path.resolve(world)+path.sep) || !fs.existsSync(resolved))errors.push({kind:'missing-sidecar',file:path.relative(world,file),uri:ref.uri});
   }
  }catch(error){errors.push({kind:'invalid-glb',file:path.relative(world,file),reason:error.message});}
 }
 const declaration=fs.existsSync(path.join(world,'world.json'))?readJSON(path.join(world,'world.json')):{};
 for(const name of Object.keys(declaration.scenes??{}))if(!fs.existsSync(path.join(world,'scenes',`${name}.json`)))errors.push({kind:'missing-scene',name});
 return {errors,references,counts:{scenes:scenes.length,entities,prefabs:prefabs.size,meshEntities,colliderEntities,assetReferences:references.length,missingAssets:references.filter(r=>!r.exists).length},capabilities:{declared:declaration.dotscity??{},runtime:'UNVERIFIED'},colliderCoverage:'presence census only; geometric/nested fidelity UNVERIFIED'};
}
