import type { Channel } from "./channel";

/** The channels this server can deliver to, by id. */
export class ChannelRegistry {
  private readonly byId: Map<string, Channel>;

  constructor(channels: Channel[]) {
    this.byId = new Map(channels.map((c) => [c.id, c]));
  }

  get(id: string): Channel | undefined {
    return this.byId.get(id);
  }

  all(): Channel[] {
    return [...this.byId.values()];
  }
}
