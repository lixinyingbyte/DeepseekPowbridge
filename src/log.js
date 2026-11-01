export function tag(t, m) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log('[' + ts + '][' + t + '] ' + m);
}

export function trim(s, n) {
  s = s == null ? '' : String(s);
  return s.length <= n ? s : s.slice(0, n) + '\u2026';
}
