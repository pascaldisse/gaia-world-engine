// § Optional game-feel adapter: traction-bounded longitudinal response.
// Source sphere angular-velocity target is NOT an instantaneous chassis speed.
// This is functional arcade tuning, not a reproduction of PhysX sphere contact.
export function validateTraction({acceleration,braking,coast,lateralDamping=0}) {
  if (!Number.isFinite(lateralDamping)||lateralDamping<0) throw Error('invalid arcade lateral damping');
  if (![acceleration,braking,coast].every(v=>Number.isFinite(v)&&v>0)) throw Error('invalid arcade traction tuning');
}
export function tractionSpeed(previous,target,dt,{acceleration,braking,coast},pedal,brake) {
  if (![previous,target,dt,pedal].every(Number.isFinite)||dt<=0) throw Error('invalid traction step');
  validateTraction({acceleration,braking,coast});
  const stopping=brake || (Math.abs(previous)>.1 && pedal*previous<0);
  const rate=stopping?braking:Math.abs(pedal)<.1?coast:acceleration;
  if(stopping||Math.abs(pedal)<.1)target=0;
  return previous+Math.max(-rate*dt,Math.min(rate*dt,target-previous));
}

// § Functional tyre grip + brakes act on lateral slip too; wall slides settle.
export function tractionLateral(previous,dt,{braking,lateralDamping=0},brake) {
  if (![previous,dt,braking,lateralDamping].every(Number.isFinite)||dt<=0||braking<=0||lateralDamping<0) throw Error('invalid lateral traction step');
  const speed=Math.abs(previous)*Math.exp(-lateralDamping*dt);
  return Math.sign(previous)*Math.max(0,speed-(brake?braking*dt:0));
}
