import { setTimeout as sleep } from "node:timers/promises";
import {
  SlackApiError,
  type SlackApi,
  type SlackChannelPage,
  type SlackChannelScope,
} from "./slack-api";

/**
 * Where a name is looked for, cheapest first. A workspace has far fewer channels with the
 * bot in them than channels, and those are also the only private ones it can post to.
 */
const SCOPES = ["member", "public"] as const satisfies readonly SlackChannelScope[];
/** A name that was not found does not trigger another listing within this window. */
const RELIST_AFTER_MS: Record<SlackChannelScope, number> = { member: 60_000, public: 600_000 };
/**
 * The longest a lookup waits for Slack's rate limit to lift. Past that the error goes to
 * the caller, and its next attempt carries on from the page this one stopped at.
 */
const MAX_WAIT_MS = 30_000;

interface Listing {
  /** The next page to ask for; unset before the first page and after the last. */
  cursor?: string;
  /** When the listing last reached its end. */
  finishedAt?: number;
}

/**
 * One workspace's channel names → ids, filled page by page and only as far as a lookup
 * needs. Listing progress outlives a failed lookup, so a retry never starts over.
 */
export class SlackChannelDirectory {
  private readonly ids = new Map<string, string>();
  private readonly listings: Record<SlackChannelScope, Listing> = { member: {}, public: {} };
  /** Until when Slack refuses to list, from its last Retry-After. */
  private blockedUntil = 0;
  /** Lookups that list run one at a time: they share the cursors and Slack's rate limit. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: SlackApi) {}

  /** `listed` tells a fresh answer from Slack from a remembered one, which may be stale. */
  find(name: string): Promise<{ id: string; listed: boolean }> {
    const known = this.ids.get(name);
    if (known) return Promise.resolve({ id: known, listed: false });
    return this.queued((deadline) => this.lookUp(name, deadline));
  }

  /** Looks a name up again, from the start of the listings, after `id` stopped working. */
  findAgain(name: string, id: string): Promise<{ id: string; listed: boolean }> {
    return this.queued((deadline) => {
      // Unless a lookup that ran in between has already replaced it.
      if (this.ids.get(name) === id) {
        this.ids.delete(name);
        this.listings.member = {};
        this.listings.public = {};
      }
      return this.lookUp(name, deadline);
    });
  }

  private queued<T>(lookUp: (deadline: number) => Promise<T>): Promise<T> {
    // Counted from here, so that lookups queued behind a waiting one do not each wait anew.
    const deadline = Date.now() + MAX_WAIT_MS;
    const found = this.queue.then(() => lookUp(deadline));
    this.queue = found.catch(() => undefined);
    return found;
  }

  private async lookUp(name: string, deadline: number): Promise<{ id: string; listed: boolean }> {
    const known = this.ids.get(name);
    if (known) return { id: known, listed: false };
    for (const scope of SCOPES) {
      const listing = this.listings[scope];
      const { finishedAt } = listing;
      if (finishedAt !== undefined && Date.now() - finishedAt < RELIST_AFTER_MS[scope]) continue;
      do {
        const page = await this.nextPage(scope, listing, deadline);
        for (const channel of page.channels) this.ids.set(channel.name, channel.id);
        listing.cursor = page.nextCursor;
        if (!listing.cursor) listing.finishedAt = Date.now();
        const id = this.ids.get(name);
        if (id) return { id, listed: true };
      } while (listing.cursor);
    }
    throw new SlackApiError("channel_not_found");
  }

  private async nextPage(
    scope: SlackChannelScope,
    listing: Listing,
    deadline: number,
  ): Promise<SlackChannelPage> {
    for (;;) {
      const blockedMs = this.blockedUntil - Date.now();
      if (blockedMs > 0) {
        if (this.blockedUntil > deadline)
          throw new SlackApiError("ratelimited", Math.ceil(blockedMs / 1000));
        await sleep(blockedMs);
      }
      try {
        return await this.api.listChannelPage(scope, listing.cursor);
      } catch (err) {
        if (!(err instanceof SlackApiError)) throw err;
        if (err.code === "ratelimited" && err.retryAfter !== undefined && Date.now() < deadline) {
          this.blockedUntil = Date.now() + err.retryAfter * 1000;
        } else if (err.code === "invalid_cursor" && listing.cursor) {
          // Cursors expire; what was read before is kept, so only the paging starts again.
          delete listing.cursor;
        } else {
          throw err;
        }
      }
    }
  }
}
