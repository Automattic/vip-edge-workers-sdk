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

export function decodesOnlyBodyView(): bool {
  const backing = String.UTF8.encode("xOKy");
  const body = Uint8Array.wrap(backing, 1, 2);
  return new Response(body).text() == "OK";
}
