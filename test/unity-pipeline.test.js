import { test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInputs, scanGuids, composeScene, runPipeline, writeJSON, diffTrees } from '../tools/unity/pipeline.mjs';
const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(engine, '.scratch');
fs.mkdirSync(scratch, {recursive:true});
const roots=[];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p,{recursive:true,force:true}); });
const guid = 'abcdef0123456789abcdef0123456789';
const direct = `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Root\n  m_Component:\n  - component: {fileID: 2}\n--- !u!4 &2\nTransform:\n  m_GameObject: {fileID: 1}\n  m_LocalPosition: {x: 2, y: 3, z: 4}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_Father: {fileID: 0}\n`;
const prefab = `--- !u!1001 &3\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}\n  m_Modification:\n    m_TransformParent: {fileID: 2}\n    m_Modifications:\n    - target: {fileID: 2, guid: ${guid}, type: 3}\n      propertyPath: m_LocalPosition.x\n      value: 5\n      objectReference: {fileID: 0}\n`;
function setup(text=direct) {
  const root=fs.mkdtempSync(path.join(scratch,'unity-pipeline-')); roots.push(root);
  const projectRoot=path.join(root,'source');
  fs.mkdirSync(path.join(projectRoot,'Assets'),{recursive:true}); fs.mkdirSync(path.join(projectRoot,'ProjectSettings'));
  fs.writeFileSync(path.join(projectRoot,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 6000.0.1f1');
  const scene=path.join(projectRoot,'Assets/test.unity');fs.writeFileSync(scene,text);
  return {projectRoot,scene,enginePath:engine,engineVersion:'engine/unity-port-fixes',outDir:path.join(root,'output')};
}
test('§7.1 validates root, scene, version and fresh output',()=>{
 const o=setup(); expect(validateInputs(o).engineBaseRevision).toHaveLength(40);
 expect(()=>validateInputs({...o,outDir:o.projectRoot})).toThrow('overlaps');
 expect(()=>validateInputs({...o,engineVersion:'missing-import-version'})).toThrow('engine version');
 fs.writeFileSync(path.join(o.outDir,'occupied'),'x');expect(()=>validateInputs(o)).toThrow('empty');
});
test('§7.1 rejects symlink output into source',()=>{
 const o=setup(); const link=path.join(path.dirname(o.outDir),'link');fs.symlinkSync(o.projectRoot,link);
 expect(()=>validateInputs({...o,outDir:path.join(link,'generated')})).toThrow('overlaps');
});
test('§7.2 scans Assets, embedded and cached packages; records missing assets',()=>{
 const o=setup();
 for(const [i,dir] of ['Assets','Packages/pkg','Library/PackageCache/pkg@1'].entries()) {
  fs.mkdirSync(path.join(o.projectRoot,dir),{recursive:true});
  fs.writeFileSync(path.join(o.projectRoot,dir,'thing.prefab.meta'),`guid: ${String(i).repeat(32)}\n`);
 }
 const db=scanGuids(o.projectRoot);expect(db.guidCount).toBe(3);expect(db.missingAssets).toHaveLength(3);
});
test('§7.2 missing required database fails; conflicts remain inspectable',()=>{
 const o=setup();expect(()=>scanGuids(o.projectRoot,{guidDatabase:'absent'})).toThrow('required GUID database');
 for(const f of ['a','b'])fs.writeFileSync(path.join(o.projectRoot,`Assets/${f}.meta`),`guid: ${guid}\n`);
 expect(scanGuids(o.projectRoot).conflicts).toHaveLength(1);
});
test('§7.3 parses prefab dependency and parent pose; keeps authored modifications',async()=>{
 const o=setup(direct+prefab);fs.writeFileSync(path.join(o.projectRoot,'Assets/p.prefab'),direct);
 const db={unityProjectRoot:o.projectRoot,guids:{[guid]:{path:'Assets/p.prefab'}}};
 const result=await composeScene(o.scene,db,o.outDir);
 expect(result.ir.documentCount).toBe(3);expect(result.ir.entities).toHaveLength(1);
 expect(result.ir.prefabInstances[0].transform.world.position.x).toBe(7);
 expect(result.ir.prefabInstances[0].prefab.modifications[0].properties.m_LocalPosition.x).toBe(5);
 expect(result.sources).toHaveLength(2);expect(result.unresolved).toHaveLength(0);
});
test('§7.3 missing prefab yields failed stage report, not success',async()=>{
 const o=setup(direct+prefab);const report=await runPipeline(o);
 expect(report.status).toBe('failed');expect(report.stages[2].counts.unresolved).toBe(1);
 expect(fs.existsSync(path.join(o.outDir,'03-compose/composition.json'))).toBe(true);
});
test('§7.3 detects prefab cycles',async()=>{
 const o=setup(direct+prefab);fs.writeFileSync(path.join(o.projectRoot,'Assets/p.prefab'),direct+prefab);
 await expect(composeScene(o.scene,{unityProjectRoot:o.projectRoot,guids:{[guid]:{path:'Assets/p.prefab'}}},o.outDir)).rejects.toThrow('cycle');
});
test('§7.4-9 adapter order, per-stage artifacts and explicit unverified play',async()=>{
 const o=setup(), order=[];const hooks={};
 for(const name of ['authoring','convert','emit','game-data','audit','play'])hooks[name]=async(c,dir)=>{
  order.push(name);writeJSON(path.join(dir,'fixture.json'),{name});return name==='play'?{status:'unverified',reason:'no live launch'}:{count:1};
 };
 const r=await runPipeline(o,hooks);expect(r.status).toBe('incomplete');expect(order).toHaveLength(6);expect(r.stages).toHaveLength(9);
 for(const row of r.stages) {expect(row.counts.documents).toBe(row.stage<3?0:2);expect(row.artifacts.length).toBeGreaterThan(0);}
});
test('§7.4 absent adapter is blocked; downstream cannot pass',async()=>{
 const o=setup();const r=await runPipeline(o);expect(r.status).toBe('incomplete');expect(r.stages.at(-1).status).toBe('blocked');expect(r.stages).toHaveLength(4);
});
test('§7.8 byte diff includes every added, removed and changed path',()=>{
 const o=setup(), a=path.join(path.dirname(o.outDir),'a'),b=path.join(path.dirname(o.outDir),'b');
 writeJSON(path.join(a,'same.json'),1);writeJSON(path.join(b,'same.json'),1);
 writeJSON(path.join(a,'old.json'),2);writeJSON(path.join(b,'new.json'),2);
 writeJSON(path.join(a,'edit.json'),1);writeJSON(path.join(b,'edit.json'),2);
 expect(diffTrees(a,b).map(r=>r.change).sort()).toEqual(['added','changed','removed']);
});
