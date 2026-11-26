// Runtime methods newer than the oldest Android System WebView the app installs on (minSdk 24 ships Chrome 51+,
// and phones without Google services can keep a WebView years old). Syntax is lowered by the build; methods are not.

type AtHost = { length: number; [i: number]: unknown };
function at(this: AtHost, n: number) {
  let i = Math.trunc(Number(n)) || 0;
  if (i < 0) i += this.length;
  return i < 0 || i >= this.length ? undefined : this[i];
}
function define(proto: object | undefined, name: string, fn: unknown) {
  if (proto && !(name in proto)) Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: false });
}

define(Array.prototype, 'at', at);
define(String.prototype, 'at', function (this: string, n: number) { return at.call(this as unknown as AtHost, n); });
if (typeof Int8Array !== 'undefined') define(Object.getPrototypeOf(Int8Array.prototype) as object, 'at', at);
define(Object, 'hasOwn', (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k));
