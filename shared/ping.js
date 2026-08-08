export function classifyPing(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const quality = value < 30 ? 'good' : value < 60 ? 'warning' : 'bad';
  return { value, quality };
}
