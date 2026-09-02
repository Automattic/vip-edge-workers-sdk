import { getRandomValues } from "../assembly/crypto";

export function fillsOnlyTheView(): bool {
  const backing = new ArrayBuffer(8);
  const view = Uint8Array.wrap(backing, 2, 4);
  getRandomValues(view);
  const all = Uint8Array.wrap(backing);
  for (let i = 0; i < 8; i++) {
    const inside = i >= 2 && i < 6;
    if (all[i] != (inside ? 0xab : 0)) return false;
  }
  return true;
}

export function returnsSameArray(): bool {
  const buf = new Uint8Array(16);
  return getRandomValues(buf) === buf;
}

export function requestsOverCap(): void {
  getRandomValues(new Uint8Array(65537));
}

export function requestsRefusedByHost(): void {
  getRandomValues(new Uint8Array(4));
}
