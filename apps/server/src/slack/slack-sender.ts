import { Injectable } from "@nestjs/common";
import {
  SlackApiError,
  type SlackApi,
  type SlackMessagePayload,
  type SlackPostResult,
  type SlackUsergroup,
} from "./slack-api";
import { SlackChannelDirectory } from "./slack-channel-directory";
import { SlackConnectionsService } from "./slack-connections.service";

/** Slack channel ids (public, private, DM); anything else is a channel name. */
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;
/** Errors meaning a cached name → id mapping is stale (channel archived or deleted). */
const STALE_CHANNEL = new Set(["channel_not_found", "is_archived"]);

/** Sends messages to a tenant's Slack: channels (by `#name` or id) and DMs. */
@Injectable()
export class SlackSender {
  private readonly directories = new Map<
    string,
    { api: SlackApi; directory: SlackChannelDirectory }
  >();

  constructor(private readonly connections: SlackConnectionsService) {}

  async postToChannel(
    tenantId: string,
    channel: string,
    message: SlackMessagePayload,
  ): Promise<SlackPostResult> {
    const api = await this.requireApi(tenantId);
    if (SLACK_CHANNEL_ID.test(channel)) return api.postMessage(channel, message);
    const name = channel.replace(/^#/, "");
    const directory = this.directory(tenantId, api);
    const { id, listed } = await directory.find(name);
    try {
      return await api.postMessage(id, message);
    } catch (err) {
      // A remembered id may be stale (an archived channel recreated under the same name has
      // a new id): list once more. A freshly listed id is not worth a second try.
      if (listed || !(err instanceof SlackApiError && STALE_CHANNEL.has(err.code))) throw err;
      return api.postMessage((await directory.findAgain(name, id)).id, message);
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

  /** A tenant gets a new client when its workspace or token changes; so do its channels. */
  private directory(tenantId: string, api: SlackApi): SlackChannelDirectory {
    let entry = this.directories.get(tenantId);
    if (entry?.api !== api) {
      entry = { api, directory: new SlackChannelDirectory(api) };
      this.directories.set(tenantId, entry);
    }
    return entry.directory;
  }

  private async requireApi(tenantId: string): Promise<SlackApi> {
    const api = await this.connections.api(tenantId);
    if (!api) throw new SlackApiError("not_connected");
    return api;
  }
}
