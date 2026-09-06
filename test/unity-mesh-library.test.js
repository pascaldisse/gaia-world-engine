import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';
import {splitAssetMeshDocs,decodeUnityMeshBody,meshFromUnityAsset,writeSimpleGlb} from '../tools/unity/convert-model.mjs';
import {Box3,BufferAttribute,Vector3} from 'three';
const project=process.env.UNITY_PROJECT_ROOT??'/Users/pascaldisse/projects/boomtown-rampage';
const asset=path.join(project,'Assets/Modular Buildings/Meshes/Parts/Building_ApartmentSmall_Red 4/Windows Round Balcony Alt (Clone)_mesh.asset');
test('real serialized shards decode by exact fileID; independent vertex bounds and GLB accessor counts',()=>{
 const docs=splitAssetMeshDocs(fs.readFileSync(asset,'utf8'));expect(docs.size).toBeGreaterThan(140);
 const parent=path.join(import.meta.dir,'../.scratch');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'mesh-library-'));
 try{
  for(const [id,body] of [...docs].slice(0,8)){
   const mesh=decodeUnityMeshBody(body);expect(mesh.positions.every(Number.isFinite)).toBe(true);expect(mesh.indices.every(i=>i>=0&&i<mesh.positions.length/3)).toBe(true);
   const match=body.match(/m_LocalAABB:\s*\n\s*m_Center: \{x: ([^,]+), y: ([^,]+), z: ([^}]+)\}\s*\n\s*m_Extent: \{x: ([^,]+), y: ([^,]+), z: ([^}]+)\}/);expect(match).not.toBeNull();
   const a=match.slice(1).map(Number),box=new Box3().setFromBufferAttribute(new BufferAttribute(new Float32Array(mesh.positions),3));
   expect(box.getCenter(new Vector3()).distanceTo(new Vector3(a[0],a[1],-a[2]))).toBeLessThan(.001);
   expect(box.getSize(new Vector3()).distanceTo(new Vector3(...a.slice(3).map(n=>n*2)))).toBeLessThan(.001);
   const out=path.join(dir,id+'.glb');writeSimpleGlb(out,mesh);const bytes=fs.readFileSync(out),json=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
   expect(bytes.readUInt32LE(8)).toBe(bytes.length);expect(json.accessors[json.meshes[0].primitives[0].attributes.POSITION].count).toBe(mesh.positions.length/3);
  }
  expect(()=>meshFromUnityAsset(asset,'not-a-real-fileID')).toThrow('serialized mesh not-a-real-fileID missing');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
