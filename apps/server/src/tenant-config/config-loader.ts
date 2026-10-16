import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ConfigIssue, ConfigTree } from "@callog/config-schema";
import { validateConfigTree } from "@callog/templates";
import type { Pool } from "pg";
import { DB_POOL } from "../db/db";
import { GithubAppService, type InstallationOctokit } from "../github/github-app.service";
import { MetricsService } from "../metrics/metrics.service";
import { configRepoOf, TenantsService } from "../tenants/tenants.service";
import { TenantConfigService } from "./tenant-config.service";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;

export type LoadResult =
  | { status: "valid" | "invalid"; commitSha: string; versionId: string }
  | { status: "unchanged"; commitSha: string }
  | { status: "skipped"; reason: string };

interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

/**
 * Loads the config repo's default branch HEAD into a new config version.
 * Always reads the current HEAD (not the pushed sha), so out-of-order or
 * redelivered webhooks can never activate an older config — and loads of one tenant run
 * one at a time across processes (an advisory lock): two overlapping loads could
 * otherwise record HEADs in the wrong order (an admin reload next to a push job).
 */
@Injectable()
export class ConfigLoader {
  private readonly logger = new Logger(ConfigLoader.name);

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly githubApp: GithubAppService,
    private readonly tenants: TenantsService,
    private readonly configs: TenantConfigService,
    private readonly metrics: MetricsService,
  ) {}

  async load(tenantId: string): Promise<LoadResult> {
    const lock = await this.pool.connect();
    try {
      await lock.query("select pg_advisory_lock(hashtext($1))", [`config:${tenantId}`]);
      const result = await this.loadUnmetered(tenantId);
      this.metrics.configReloads.inc({ result: result.status });
      return result;
    } finally {
      // If unlocking fails, destroy the connection: closing the session releases the lock.
      const unlocked = await lock
        .query("select pg_advisory_unlock(hashtext($1))", [`config:${tenantId}`])
        .then(() => true)
        .catch(() => false);
      lock.release(!unlocked);
    }
  }

  private async loadUnmetered(tenantId: string): Promise<LoadResult> {
    const tenant = await this.tenants.findById(tenantId);
    if (!tenant || tenant.status !== "active" || !tenant.githubInstallationId) {
      return { status: "skipped", reason: "tenant is not active" };
    }
    const { owner, repo } = configRepoOf(tenant);
    const octokit = await this.githubApp.installationOctokit(tenant.githubInstallationId);

    let commitSha: string;
    try {
      const { data: repository } = await octokit.request("GET /repos/{owner}/{repo}", {
        owner,
        repo,
      });
      const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner,
        repo,
        ref: `heads/${repository.default_branch}`,
      });
      commitSha = ref.object.sha;
    } catch (err) {
      if (isStatus(err, 404) || isStatus(err, 409)) {
        // 404: no repo or no access; 409: empty repository.
        this.logger.warn(
          `Config repo ${owner}/${repo} is missing or empty for tenant ${tenant.id}`,
        );
        return { status: "skipped", reason: `config repo ${owner}/${repo} is missing or empty` };
      }
      throw err;
    }

    const latest = await this.configs.latest(tenant.id);
    const sameCommit = latest?.commitSha === commitSha;
    // A rejected commit is checked again: a newer server may accept it (fixed validation).
    if (sameCommit && latest.status === "valid") return { status: "unchanged", commitSha };

    const fetched = await this.fetchTree(octokit, owner, repo, commitSha);
    const result =
      "issue" in fetched
        ? { ok: false as const, errors: [fetched.issue], warnings: [] }
        : validateConfigTree(fetched.tree);

    if (result.ok) {
      const version = await this.configs.recordValid(
        tenant.id,
        commitSha,
        result.config,
        result.warnings,
      );
      this.logger.log(
        `Config ${short(commitSha)} activated for tenant ${tenant.id} (${owner}/${repo})`,
      );
      return { status: "valid", commitSha, versionId: version.id };
    }
    if (sameCommit) return { status: "unchanged", commitSha };
    const version = await this.configs.recordInvalid(
      tenant.id,
      commitSha,
      result.errors,
      result.warnings,
    );
    // TODO: notify tenant admins about a rejected config (today only logs and the admin UI).
    this.logger.warn(
      `Config ${short(commitSha)} rejected for tenant ${tenant.id}, keeping last valid: ` +
        result.errors.map(formatIssue).join("; "),
    );
    return { status: "invalid", commitSha, versionId: version.id };
  }

  private async fetchTree(
    octokit: InstallationOctokit,
    owner: string,
    repo: string,
    commitSha: string,
  ): Promise<{ tree: ConfigTree } | { issue: ConfigIssue }> {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: commitSha,
      recursive: "1",
    });
    if (data.truncated) return { issue: repoIssue("repository tree is too large to load") };

    const files = (data.tree as TreeEntry[]).filter(
      (e) => e.type === "blob" && e.path && e.sha && isConfigCandidate(e.path),
    );
    if (files.length > MAX_FILES) {
      return { issue: repoIssue(`too many config files (${files.length} > ${MAX_FILES})`) };
    }
    const tooBig = files.find((f) => (f.size ?? 0) > MAX_FILE_BYTES);
    if (tooBig) {
      return {
        issue: {
          file: tooBig.path!,
          path: [],
          message: `file is larger than ${MAX_FILE_BYTES} bytes`,
        },
      };
    }

    const tree: ConfigTree = {};
    for (const file of files) {
      const { data: blob } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
        {
          owner,
          repo,
          file_sha: file.sha!,
        },
      );
      tree[file.path!] = Buffer.from(blob.content, blob.encoding as BufferEncoding).toString(
        "utf8",
      );
    }
    return { tree };
  }
}

/** YAML outside dot-directories; parseConfigTree ignores everything else anyway. */
function isConfigCandidate(path: string): boolean {
  if (path.split("/").some((s) => s.startsWith("."))) return false;
  return path.endsWith(".yaml") || path.endsWith(".yml");
}

function repoIssue(message: string): ConfigIssue {
  return { file: "", path: [], message };
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === status;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function formatIssue(issue: ConfigIssue): string {
  const where = [issue.file, issue.path.join(".")].filter(Boolean).join(":");
  return where ? `${where} — ${issue.message}` : issue.message;
}
