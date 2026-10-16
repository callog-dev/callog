import { setBounded } from "../common/bounded-map";

/** Destinations remembered; the oldest writes are long past their slot when dropped. */
const MAX_DESTINATIONS = 10_000;

/**
 * Spaces out messages per destination inside this process: Slack allows
 * about one message per second per channel, Telegram about 20 per minute in a group.
 */
export class DestinationRateLimiter {
  private readonly nextSlot = new Map<string, number>();

  constructor(private readonly intervals = { default: 1100, telegramGroup: 3100 }) {}

  async wait(
    key: string,
    kind: keyof DestinationRateLimiter["intervals"] = "default",
  ): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    setBounded(this.nextSlot, key, slot + this.intervals[kind], MAX_DESTINATIONS);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }
}

export const DESTINATION_RATE_LIMITER = Symbol("DESTINATION_RATE_LIMITER");
