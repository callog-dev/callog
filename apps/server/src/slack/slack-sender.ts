import { Injectable } from "@nestjs/common";
import {
  SlackApiError,
  type SlackApi,
  type SlackMessagePayload,
  type SlackPostResult,
  type SlackUsergroup,
} from "./slack-api";
import { SlackConnectionsService } from "./slack-connections.service";

/** Slack channel ids (public, private, DM); anything else is a channel name. */
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
/** An unknown name does not trigger another full channel listing within this window. */
const RELIST_AFTER_MS = 60_000;
/** Errors meaning a cached name → id mapping is stale (channel archived or deleted). */
const STALE_CHANNEL = new Set(["channel_not_found", "is_archived"]);

/** Sends messages to a tenant's Slack: channels (by `#name` or id) and DMs. */
@Injectable()
export class SlackSender {
  /** tenantId → channel name → id, refreshed on a miss (new or renamed channels). */
  private readonly channelIds = new Map<string, { ids: Map<string, string>; listedAt: number }>();

  constructor(private readonly connections: SlackConnectionsService) {}

  async postToChannel(
    tenantId: string,
    channel: string,
    message: SlackMessagePayload,
  ): Promise<SlackPostResult> {
    const api = await this.requireApi(tenantId);
    if (SLACK_CHANNEL_ID.test(channel)) return api.postMessage(channel, message);
    const name = channel.replace(/^#/, "");
    const { id, listed } = await this.resolveChannel(tenantId, api, name);
    try {
      return await api.postMessage(id, message);
    } catch (err) {
      // A cached id may be stale (an archived channel recreated under the same name has a
      // new id): list once more. A freshly listed id is not worth a second try.
      if (listed || !(err instanceof SlackApiError && STALE_CHANNEL.has(err.code))) throw err;
      this.channelIds.delete(tenantId);
      return api.postMessage((await this.resolveChannel(tenantId, api, name)).id, message);
    }
  }

  async postDirect(
    tenantId: string,
    slackUserId: string,
    message: SlackMessagePayload,
  ): Promise<SlackPostResult> {
    const api = await this.requireApi(tenantId);
    return api.postMessage(await api.openDm(slackUserId), message);
  }

  /** Edits a message by its ref (channel id + ts, as stored in deliveries). */
  async update(
    tenantId: string,
    channelId: string,
    ts: string,
    message: SlackMessagePayload,
  ): Promise<SlackPostResult> {
    const api = await this.requireApi(tenantId);
    return api.updateMessage(channelId, ts, message);
  }

  /** A Slack user group by its handle (`frontend-team`, with or without `@`). */
  async usergroup(tenantId: string, handle: string): Promise<SlackUsergroup> {
    const api = await this.requireApi(tenantId);
    const wanted = handle.replace(/^@/, "");
    const group = (await api.listUsergroups()).find((g) => g.handle === wanted);
    if (!group) throw new SlackApiError("usergroup_not_found");
    return group;
  }

  private async resolveChannel(
    tenantId: string,
    api: SlackApi,
    name: string,
  ): Promise<{ id: string; listed: boolean }> {
    let cached = this.channelIds.get(tenantId);
    let listed = false;
    if (!cached || (!cached.ids.has(name) && Date.now() - cached.listedAt >= RELIST_AFTER_MS)) {
      const ids = new Map((await api.listChannels()).map((c) => [c.name, c.id]));
      cached = { ids, listedAt: Date.now() };
      this.channelIds.set(tenantId, cached);
      listed = true;
    }
    const id = cached.ids.get(name);
    if (!id) throw new SlackApiError("channel_not_found");
    return { id, listed };
  }

  private async requireApi(tenantId: string): Promise<SlackApi> {
    const api = await this.connections.api(tenantId);
    if (!api) throw new SlackApiError("not_connected");
    return api;
  }
}
