import { Headers, Response } from "../assembly/api";

export function setInvalidHeaderName(): void {
  new Headers().set("bad name", "value");
}

export function appendInvalidHeaderValue(): void {
  new Headers().append("x-test", "first\r\nsecond");
}

export function setOversizedHeaderName(): void {
  new Headers().set("x".repeat(1025), "value");
}

export function setOversizedHeaderValue(): void {
  new Headers().set("x-test", "x".repeat(65537));
}

export function acceptsValidLocalHeader(): bool {
  const headers = new Headers();
  headers.set("X-Test", "one\ttwo");
  return headers.get("x-test") == "one\ttwo";
}

export function varyAddMergesAndDedupes(): string {
  const r = new Response();
  r.headers.set("Vary", "Accept-Encoding");
  r.addVary("X-Device-Class");
  r.addVary("accept-encoding, x-locale");
  return r.headers.get("vary")!;
}

export function varySetReplacesAllLines(): string {
  const r = new Response();
  r.headers.append("vary", "a");
  r.headers.append("vary", "b");
  r.setVary(["X-Locale", "x-locale", " x-theme "]);
  return r.headers.get("vary")! + "|" + r.headers.entries().length.toString();
}

export function varySetEmptyRemoves(): bool {
  const r = new Response();
  r.headers.set("vary", "a");
  r.setVary([]);
  return !r.headers.has("vary");
}

export function varyRejectsStar(): void {
  new Response().addVary("*");
}

export function varyRejectsInvalidName(): void {
  new Response().setVary(["bad name"]);
}

export function varyRejectsTooLong(): void {
  const r = new Response();
  r.setVary(["accept-encoding", "accept-language", "x-device-class", "x-country-code"]);
  r.addVary("x-region, x-metro-code, x-ab-bucket, x-locale, x-theme, x-currency, x-experiment-group");
}

export function varyAcceptsExactly128(): bool {
  const r = new Response();
  r.setVary(["a".repeat(128)]);
  return r.headers.get("vary")!.length == 128;
}

export function decodesOnlyBodyView(): bool {
  const backing = String.UTF8.encode("xOKy");
  const body = Uint8Array.wrap(backing, 1, 2);
  return new Response(body).text() == "OK";
}
