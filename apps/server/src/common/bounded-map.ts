/**
 * `map.set` that keeps at most `max` entries, dropping the least recently written ones:
 * in-memory caches keyed by data (routes, destinations, people) must not grow forever.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}
