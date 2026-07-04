export function randHex(bytes: number): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    c.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < bytes * 2; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** Query strings and fragments routinely carry PII/tokens — never store them. */
export function stripQuery(url: string): string {
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  const cut = Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h);
  return url.slice(0, cut);
}
