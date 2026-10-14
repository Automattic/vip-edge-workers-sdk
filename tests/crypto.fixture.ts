import { getRandomValues, hmacSha256, sha256, secureCompare, jwtVerifyHs256 } from "../assembly/crypto";

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

export function requestsRandom(): void {
  getRandomValues(new Uint8Array(4));
}

export function hmacDigestLength(): i32 {
  return hmacSha256(new Uint8Array(4), new Uint8Array(8)).byteLength;
}

export function hmacCall(): void {
  hmacSha256(new Uint8Array(4), new Uint8Array(8));
}

export function sha256Call(): void {
  sha256(new Uint8Array(8));
}

export function compareCall(): bool {
  return secureCompare(new Uint8Array(4), new Uint8Array(4));
}

export function jwtCall(): bool {
  return jwtVerifyHs256("a.b.c", "secret") === null;
}
