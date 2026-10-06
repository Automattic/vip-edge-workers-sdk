import { RegExp, RegExpMatch } from "../assembly/regex";

export function alloc(size: i32): i32 {
  return changetype<i32>(new ArrayBuffer(size));
}

function orNull(s: string | null): string {
  return s === null ? "null" : s;
}

function joinNullable(a: Array<string | null> | null): string {
  if (a === null) return "null";
  const parts = new Array<string>(a.length);
  for (let i = 0; i < a.length; i++) parts[i] = orNull(a[i]);
  return parts.join(",");
}

export function execGroups(): string {
  const re = new RegExp("^/blog/(\\d+)/(?<slug>[a-z-]+)$");
  const m = re.exec("/blog/42/hello-world")!;
  return m.index.toString() + "|" + orNull(m[0]) + "|" + orNull(m[1])
    + "|" + orNull(m.group("slug")) + "|" + orNull(m.groups.get("slug"))
    + "|" + m.length.toString() + "|" + m.start(2).toString() + "-" + m.end(2).toString();
}

export function execNoMatch(): bool {
  return new RegExp("z").exec("abc") === null;
}

export function absentGroupIsNull(): bool {
  const m = new RegExp("(a)(b)?(c)").exec("ac")!;
  return m[2] === null && m.start(2) == -1 && m.end(2) == -1 && orNull(m[3]) == "c";
}

export function unicodeIndices(): string {
  const a = new RegExp("é(\\d)").exec("aéé1b")!;
  const b = new RegExp("x(\\d)").exec("😀x1")!;
  return a.index.toString() + "|" + orNull(a[0]) + "|" + a.start(1).toString() + "|" + a.end(1).toString()
    + "|" + b.index.toString() + "|" + b.start(1).toString() + "|" + b.end(1).toString();
}

export function globalExecAdvancesLastIndex(): string {
  const re = new RegExp("\\d+", "g");
  const s = "a1b22c";
  const m1 = re.exec(s)!;
  const first = orNull(m1[0]) + "@" + m1.index.toString() + "," + re.lastIndex.toString();
  const m2 = re.exec(s)!;
  const second = orNull(m2[0]) + "@" + m2.index.toString() + "," + re.lastIndex.toString();
  const m3 = re.exec(s);
  return first + "|" + second + "|" + (m3 === null ? "null" : "match") + "," + re.lastIndex.toString();
}

export function testGlobalIsStateful(): string {
  const re = new RegExp("a", "g");
  const r1 = re.test("aa");
  const r2 = re.test("aa");
  const r3 = re.test("aa");
  return (r1 ? "1" : "0") + (r2 ? "1" : "0") + (r3 ? "1" : "0") + "|" + re.lastIndex.toString();
}

export function testNonGlobal(): bool {
  const re = new RegExp("^x", "i");
  return re.test("Xy") && !re.test("y") && re.lastIndex == 0;
}

export function flagsTranslate(): string {
  const m = new RegExp("^b$", "m").test("a\nb\nc");
  const s = new RegExp("a.b", "s").test("a\nb");
  const noS = new RegExp("a.b").test("a\nb");
  return (m ? "1" : "0") + "|" + (s ? "1" : "0") + "|" + (noS ? "1" : "0");
}

export function invalidFlagThrows(): void {
  new RegExp("a", "y");
}

export function badPatternThrows(): void {
  new RegExp("(");
}

export function lookaheadThrows(): void {
  new RegExp("(?=a)b");
}

export function matchNonGlobal(): string {
  return joinNullable(new RegExp("(\\d)(\\d)?").match("a1"));
}

export function matchGlobal(): string {
  return joinNullable(new RegExp("\\d+", "g").match("a1b22"))
    + "|" + joinNullable(new RegExp("\\d+", "g").match("abc"));
}

export function matchAllEmptyMatchesTerminate(): string {
  const all = new RegExp("x*", "g").matchAll("ab");
  const idx = new Array<string>(all.length);
  for (let i = 0; i < all.length; i++) idx[i] = all[i].index.toString();
  return all.length.toString() + "|" + idx.join(",");
}

export function matchAllWithGroups(): string {
  const all = new RegExp("(?<k>\\w+)=(\\w+)").matchAll("a=1&b=2");
  const parts = new Array<string>(all.length);
  for (let i = 0; i < all.length; i++) {
    parts[i] = orNull(all[i].group("k")) + ":" + orNull(all[i][2]) + "@" + all[i].index.toString();
  }
  return parts.join(",");
}

export function replaceFirstAndAll(): string {
  const first = new RegExp("(\\d+)").replace("a1b2", "[$1]");
  const all = new RegExp("(\\d+)", "g").replace("a1b2", "[$1]");
  const forced = new RegExp("(\\d+)").replaceAll("a1b2", "[$1]");
  const templates = new RegExp("(?<n>\\d)", "g").replace("1-2", "$<n>$&$$");
  const literal = new RegExp("\\d").replace("x1", "$ $1a");
  return first + "|" + all + "|" + forced + "|" + templates + "|" + literal;
}

function wrap(m: RegExpMatch): string {
  return "<" + orNull(m[0]) + ">";
}

export function replaceWithFn(): string {
  return new RegExp("\\d", "g").replaceWith("a1b2", wrap)
    + "|" + new RegExp("\\d").replaceWith("a1b2", wrap)
    + "|" + new RegExp("\\d").replaceWith("ab", wrap);
}

export function splitCases(): string {
  return new RegExp(",\\s*").split("a, b,c").join("|")
    + ";" + new RegExp("(-)").split("a-b").join("|")
    + ";" + new RegExp("x*").split("abc").join("|")
    + ";" + new RegExp(",").split("a,b,c", 2).join("|")
    + ";" + new RegExp("x").split("").join("|")
    + ";" + new RegExp("x*").split("").length.toString()
    + ";" + new RegExp("-").split("a-b-").join("|");
}

export function searchIndex(): string {
  return new RegExp("b").search("ab").toString() + "|" + new RegExp("z").search("ab").toString();
}

export function toStringAndProps(): string {
  const re = new RegExp("(a)+(?<b>b)", "gi");
  return re.toString() + "|" + (re.global ? "1" : "0") + (re.ignoreCase ? "1" : "0")
    + (re.multiline ? "1" : "0") + (re.dotAll ? "1" : "0")
    + "|" + re.groupCount.toString() + "|" + joinNullable(re.groupNames);
}
