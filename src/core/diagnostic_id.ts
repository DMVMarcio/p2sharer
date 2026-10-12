/** Matches native opaque IDs without retaining raw diagnostic identifiers. */
export function diagnosticOpaqueId(value: string): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}
