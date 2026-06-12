// Tiny DOM helpers shared by the kernel's HTML chrome (panel, outliner,
// console) — plus the two checks every pointer/keyboard handler needs.

export function div(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

export function button(text, onClick) {
  const el = document.createElement('button');
  el.textContent = text;
  el.onclick = onClick;
  return el;
}

// hotkeys must yield while the user types in any field
export function isTyping() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

// pointer event → normalized device coords, written into a THREE.Vector2
export function pointerNDC(event, target) {
  return target.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
}
