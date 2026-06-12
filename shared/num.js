// Op-payload precision, decided once: positions/rotations round to 2
// decimals, sense output to 1. Client and server import the same rounding
// so a value never changes just by crossing the wire.
export function r2(v) {
  return Math.round(v * 100) / 100;
}

export function r1(v) {
  return Math.round(v * 10) / 10;
}
