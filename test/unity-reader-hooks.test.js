// § Synthetic text only; canonical parser/material reader hooks, nested propagation, refusal identity.
import {test,expect} from 'bun:test';
import path from 'node:path';
import {parseFile} from '../tools/unity/parse.mjs';
import {parseUnityMaterial} from '../tools/unity/convert-model.mjs';
const root=path.resolve('.scratch/reader-hook-virtual');
const a='a'.repeat(32),b='b'.repeat(32);
const pi=(id,guid)=>`--- !u!1001 &${id}\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ${guid}, type: 3}\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications: []\n`;
const base=`--- !u!1 &100\nGameObject:\n  m_Name: Base\n  m_IsActive: 1\n--- !u!4 &101\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n  m_LocalPosition: {x: 1, y: 2, z: 3}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n`;
const db={unityProjectRoot:root,guids:{[a]:{path:'Variant.prefab',kind:'prefab'},[b]:{path:'Base.prefab',kind:'prefab'}}};
const files=new Map([['Main.prefab',pi(11,a)],['Variant.prefab',pi(22,b)],['Base.prefab',base]].map(([p,t])=>[path.join(root,p),t]));
test('parseFile routes main and every nested prefab through the same supplied reader',async()=>{
 const reads=[];const ir=await parseFile(path.join(root,'Main.prefab'),db,{readText:async file=>{reads.push(file);expect(files.has(file)).toBe(true);return files.get(file);}});
 expect(reads).toEqual([...files.keys()]);expect(ir.prefabInstances[0].transform.local.position).toEqual({x:1,y:2,z:3});
});
test('reader refusal propagates unchanged even when malformed-root reporting is collect mode',async()=>{
 for(const onUnresolvedRoot of ['throw','collect']){
  const denied=Object.assign(new Error('guarded reader refused'),{code:'ESCAPED_PATH'});let thrown;
  try{await parseFile(path.join(root,'Main.prefab'),db,{onUnresolvedRoot,readText:async file=>{if(file.endsWith('Base.prefab'))throw denied;return files.get(file);}});}catch(e){thrown=e;}
  expect(thrown).toBe(denied);
 }
});
test('material fields parse exactly the bytes supplied by the guarded synchronous reader',()=>{
 const file=path.join(root,'Material.mat'),reads=[];
 const result=parseUnityMaterial(file,new Map(),null,{readText:p=>{reads.push(p);return 'Material:\n  m_Name: Synthetic\n  m_SavedProperties:\n    m_Colors:\n    - _BaseColor: {r: 0.2, g: 0.3, b: 0.4, a: 1}\n';}});
 expect(reads).toEqual([file]);expect(result.name).toBe('Synthetic');expect(result.pbr.baseColor).toEqual([0.2,0.3,0.4,1]);
});
test('non-Error reader refusals propagate; ordinary malformed roots remain collectable',async()=>{
 let caught=false,payload='not caught';
 try{await parseFile(path.join(root,'Main.prefab'),db,{onUnresolvedRoot:'collect',readText:async file=>{if(file.endsWith('Base.prefab'))throw null;return files.get(file);}});}catch(e){caught=true;payload=e;}
 expect(caught).toBe(true);expect(payload).toBeNull();
 const ir=await parseFile(path.join(root,'Main.prefab'),db,{onUnresolvedRoot:'collect',readText:async file=>file.endsWith('Base.prefab')?'--- !u!1 &100\nGameObject:\n  m_Name: NoTransform\n':files.get(file)});
 expect(ir.rootProblems.length).toBeGreaterThan(0);
});
test('reader return types are strict; material reader must be synchronous',async()=>{
 await expect(parseFile(path.join(root,'Main.prefab'),db,{readText:()=>Buffer.from('not text')})).rejects.toThrow('UTF-8 text');
 expect(()=>parseUnityMaterial('virtual.mat',new Map(),null,{readText:async()=>''})).toThrow('synchronous UTF-8 text');
});
