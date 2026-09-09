const PALETTE = [
  '#e11d48', '#0284c7', '#7c3aed', '#ea580c',
  '#0d9488', '#c026d3', '#4f46e5', '#65a30d',
];

export function colorFor(clientId: string): string {
  let hash = 0;
  for (let index = 0; index < clientId.length; index += 1) {
    hash = (hash * 31 + clientId.charCodeAt(index)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
