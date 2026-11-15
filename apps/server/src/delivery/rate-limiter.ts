import { setBounded } from "../common/bounded-map";

/** Destinations remembered; the oldest writes are long past their slot when dropped. */
const MAX_DESTINATIONS = 10_000;

/** Spaces out messages per destination inside this process; the channel names the gap. */
export class DestinationRateLimiter {
  private readonly nextSlot = new Map<string, number>();

  /** `scale` stretches or removes (0, in tests) every interval. */
  constructor(private readonly scale = 1) {}

  async wait(key: string, intervalMs: number): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    setBounded(this.nextSlot, key, slot + intervalMs * this.scale, MAX_DESTINATIONS);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

export const DESTINATION_RATE_LIMITER = Symbol("DESTINATION_RATE_LIMITER");
