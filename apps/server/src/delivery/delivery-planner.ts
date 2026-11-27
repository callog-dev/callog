import { Injectable } from "@nestjs/common";
import type { Config, Ref, Route } from "@callog/config-schema";
import { ChannelRegistry } from "../channels/channel-registry";
import { defaultTargets, routeTargets, targetKey, type Target } from "./destinations";
import { PersonalCopies, type PersonalCopy, type PersonalPlan } from "./personal-copies";

/** A room the notification is posted to, or a personal copy with whom it is for. */
export type PlannedTarget = Target & Partial<Pick<PersonalCopy, "forPeople" | "fallbacks">>;

export interface DeliveryPlan {
  /** The rooms the route posts to whoever the recipients are. */
  rooms: Target[];
  /** Everything that gets a message: the rooms, personal copies, or the default place. */
  targets: PlannedTarget[];
  /** Set for routes with personal copies. */
  personal?: PersonalPlan;
}

/**
 * Decides where a notification is posted first: the rooms of its route and the places its
 * recipients name, a copy for each recipient when the route has them, and the route's
 * default place when all of that is nowhere. Changes nothing, so a preview can ask too.
 */
@Injectable()
export class DeliveryPlanner {
  constructor(
    private readonly channels: ChannelRegistry,
    private readonly personalCopies: PersonalCopies,
  ) {}

  async plan(
    tenantId: string,
    route: Route,
    config: Config,
    recipients: Ref[],
    places: string[],
  ): Promise<DeliveryPlan> {
    const planned = new Map<string, PlannedTarget>();
    const add = (copy: PlannedTarget) => {
      const key = targetKey(copy);
      const existing = planned.get(key);
      // A room that already gets the notification needs no second message, only the names.
      if (existing) existing.forPeople = [...(existing.forPeople ?? []), ...(copy.forPeople ?? [])];
      else planned.set(key, { ...copy });
    };
    const rooms = routeTargets(route, config, this.channels, places);
    rooms.forEach(add);
    const personal = route.dm
      ? await this.personalCopies.plan(tenantId, route, config, recipients)
      : undefined;
    personal?.copies.forEach(add);
    if (planned.size === 0) defaultTargets(route, config, this.channels).forEach(add);
    return { rooms, targets: [...planned.values()], personal };
  }
}
