export function newId(): string {
  return Bun.randomUUIDv7();
}
