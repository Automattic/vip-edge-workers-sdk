// Minimal stub for json-as consumed by TypeScript / TypeDoc.
// Prevents tsc from following "types": "assembly/index.ts" in the json-as package,
// which ships AS source files with no .d.ts equivalents.
export class JSON {
  static stringify<T>(value: T): string;
  static parse<T>(json: string): T;
}
