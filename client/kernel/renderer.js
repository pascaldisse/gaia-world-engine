import * as THREE from 'three/webgpu';
import { pass, texture } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { cameraSpec } from './camera-config.js';
import { applyShadow } from './shadow-config.js';
export async function createRenderer() {
const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#101c30');
scene.fog = new THREE.Fog('#101c30', 60, 280);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 4000);
const orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
let activeCamera = camera;
let currentSpec = cameraSpec();
let pixelTarget = null;
let pixelQuad = null;
let pixelFrame = null;
let frameNumber = 0;
let postProcessing = null;
let bloomPass = null;
const hemi = new THREE.HemisphereLight('#8fb3ff', '#2c241a', 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#ffe2b0', 1.2);
sun.position.set(60, 90, 30);
// Shadow map + bias defaults live in shadow-config.js (SHADOW_DEFAULTS). The
// bias/normalBias are load-bearing: without them the sun shadow self-shadows
// flat roofs and the top-down city renders as black occluders. Worlds override
// per-field through the environment `sun.shadow` declaration.
applyShadow(sun);
scene.add(sun);
function applyProjection() {
const aspect = window.innerWidth / window.innerHeight;
camera.aspect = aspect;
camera.fov = currentSpec.fov;
camera.near = currentSpec.near;
camera.far = currentSpec.far;
camera.updateProjectionMatrix();
const halfHeight = currentSpec.orthoSize;
const halfWidth = halfHeight * aspect;
orthographicCamera.left = -halfWidth;
orthographicCamera.right = halfWidth;
orthographicCamera.top = halfHeight;
orthographicCamera.bottom = -halfHeight;
orthographicCamera.near = currentSpec.near;
orthographicCamera.far = currentSpec.far;
orthographicCamera.updateProjectionMatrix();
}
function rebuildPost() {
postProcessing = null;
bloomPass = null;
try {
const chain = new THREE.PostProcessing(renderer);
const scenePass = pass(scene, activeCamera);
const color = scenePass.getTextureNode('output');
bloomPass = bloom(color, 0.35, 0.4, 0.85);
chain.outputNode = color.add(bloomPass);
postProcessing = chain;
} catch (err) {
console.warn('[gaia] post chain unavailable, rendering plain:', err);
}
}
function setPixelTarget(pixel) {
pixelFrame = null;
if (!pixel) {
pixelTarget?.dispose();
pixelTarget = null;
pixelQuad?.material.dispose();
pixelQuad = null;
return;
}
if (!pixelTarget) {
pixelTarget = new THREE.WebGLRenderTarget(pixel.width, pixel.height, {
magFilter: THREE.NearestFilter,
minFilter: THREE.NearestFilter,
generateMipmaps: false,
});
const material = new THREE.MeshBasicNodeMaterial();
material.colorNode = texture(pixelTarget.texture);
pixelQuad = new THREE.QuadMesh(material);
} else {
pixelTarget.setSize(pixel.width, pixel.height);
}
}
function setPixelResolution(pixel) {
const limit = renderer.backend.device?.limits?.maxTextureDimension2D ?? renderer.backend.capabilities?.maxTextureSize;
if (pixel !== null && (!Number.isInteger(limit) || !Number.isInteger(pixel?.width) || !Number.isInteger(pixel?.height)
  || pixel.width < 1 || pixel.height < 1 || pixel.width > limit || pixel.height > limit)) throw Error('Invalid render resolution');
currentSpec = { ...currentSpec, pixel };
setPixelTarget(pixel);
}
function setCameraSpec(spec = null) {
currentSpec = cameraSpec(spec);
activeCamera = currentSpec.projection === 'orthographic' ? orthographicCamera : camera;
applyProjection();
setPixelTarget(currentSpec.pixel);
rebuildPost();
}
async function readPixelFrame() {
const target = pixelTarget;
if (!target || pixelFrame?.target !== target) return null;
const { width, height, frame } = pixelFrame;
const rgba = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
if (rgba.length !== width * height * 4) throw Error('Render-target readback size changed');
return { width, height, rgba, frame, source: 'world-render-target/pre-display/no-HUD', origin: renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? 'top-left' : 'bottom-left' };
}
function syncActiveCamera() {
if (activeCamera === camera) return;
activeCamera.position.copy(camera.position);
activeCamera.quaternion.copy(camera.quaternion);
activeCamera.scale.copy(camera.scale);
activeCamera.updateMatrixWorld();
}
function render() {
syncActiveCamera();
if (pixelTarget && pixelQuad) {
renderer.setRenderTarget(pixelTarget);
renderer.render(scene, activeCamera);
pixelFrame = { target: pixelTarget, width: pixelTarget.width, height: pixelTarget.height, frame: ++frameNumber };
renderer.setRenderTarget(null);
pixelQuad.render(renderer);
return;
}
if (postProcessing) postProcessing.render();
else renderer.render(scene, activeCamera);
}
window.addEventListener('resize', () => {
renderer.setSize(window.innerWidth, window.innerHeight);
applyProjection();
});
setCameraSpec();
const post = {
render,
setBloom: ({ strength, radius, threshold } = {}) => {
if (strength !== undefined) bloomPass && (bloomPass.strength.value = strength);
if (radius !== undefined) bloomPass && (bloomPass.radius.value = radius);
if (threshold !== undefined) bloomPass && (bloomPass.threshold.value = threshold);
},
};
return { renderer, scene, camera, hemi, sun, post, setCameraSpec, setPixelResolution, readPixelFrame, getActiveCamera: () => activeCamera, getCameraSpec: () => currentSpec, getPixelTargetSize: () => pixelTarget ? { width: pixelTarget.width, height: pixelTarget.height } : null };
}
