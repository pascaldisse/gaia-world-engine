import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { View } from '../client/kernel/view.js';
import { WorldStore } from '../client/kernel/world.js';

function fixture() {
 const store = new WorldStore();
 store.applySnapshot({ player: { presence:{kind:'player'}, scene:{name:'city'} } });
 const group = new THREE.Group();
 const view = Object.create(View.prototype);
 Object.assign(view, { store, groups:new Map([['player',group]]), activeScenes:new Set(['city']),
  showOwnBody:true, ownPresence:'player', player:{position:new THREE.Vector3(),bodyYaw:0},
  hideQueue:[],showQueue:[],buildQueue:[],buildSet:new Set(),motion:new Map(),sounds:new Map(),
  colliderIds:new Set(),waterIds:new Set(), buildVersion:0,
  instancedModels:{sync(){},markDirty(){}}, updateLights(){},syncImpostors(){},releaseSlot(){},
 });
 store.onChange(event=>view.handle(event));
 const stamp = scene => store.applyOps([{op:'set',id:'player',component:'scene',value:{name:scene}}]);
 return {view,group,stamp};
}
test('late authoritative presence scene stamp restores the body after a warp', () => {
 const {view,group,stamp}=fixture();
 view.setActiveScenes(new Set(['bank'])); view.update(0.016);
 expect(group.userData.hidden).toBe(true);
 stamp('bank'); view.update(0.016);
 expect(group.userData.hidden).toBe(false);
 expect(group.visible).toBe(true);
});
test('obsolete queued hide cannot erase a body after its scene stamp catches up', () => {
 const {view,group,stamp}=fixture();
 view.setActiveScenes(new Set(['bank']));
 expect(view.hideQueue).toEqual(['player']);
 stamp('bank'); view.update(0.016);
 expect(group.visible).toBe(true);
 expect(group.userData.hidden).not.toBe(true);
 view.setActiveScenes(new Set(['city'])); view.update(0.016);
 expect(group.visible).toBe(false);
 stamp('city'); view.update(0.016);
 expect(group.visible).toBe(true);
});
test('scene wake-up preserves first-person own-body hiding', () => {
 const {view,group,stamp}=fixture(); view.showOwnBody=false;
 view.setActiveScenes(new Set(['bank']));view.update(0.016);
 stamp('bank');view.update(0.016);
 expect(group.userData.hidden).toBe(false);
 expect(group.visible).toBe(false);
});
