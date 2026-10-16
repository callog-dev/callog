import type { InstallationInfo } from "../../src/github/github-app.service";

interface RepoState {
  defaultBranch: string;
  head: string;
  files: Record<string, string>;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export interface FakeUser {
  login: string;
  id: number;
}

export interface FakeCommit {
  author: FakeUser | null;
  email: string;
}

/** In-memory stand-in for the GitHub API routes the server uses. */
export class FakeGithub {
  enabled = true;
  /** Simulates a GitHub outage: every API request fails with 502. */
  down = false;
  /** When set, the next git tree request waits for it (to interleave config loads). */
  treeGate: Promise<void> | undefined;
  installations: InstallationInfo[] = [];
  repos = new Map<string, RepoState>();
  requests: string[] = [];
  /** Org members (any org). */
  members: FakeUser[] = [];
  /** Other existing GitHub users (looked up by login). */
  users: FakeUser[] = [];
  /** Commits per "owner/repo", newest first. */
  commits = new Map<string, FakeCommit[]>();
  /** "owner/repo" → HTTP status its commit listing fails with. */
  commitErrors = new Map<string, number>();
  /** Logins with the org "admin" (owner) role. */
  orgAdmins = new Set<string>();
  /** GitHub team slug → member logins. */
  teams = new Map<string, string[]>();
  /** login → verified domain emails; `undefined` simulates a non-Enterprise org (GraphQL error). */
  verifiedDomainEmails: Record<string, string[]> | undefined;
  private commit = 0;

  /** Replaces the repo contents with a new commit and returns its sha. */
  push(fullName: string, files: Record<string, string>, defaultBranch = "main"): string {
    const head = `c${String(++this.commit).padStart(39, "0")}`;
    this.repos.set(fullName, { defaultBranch, head, files });
    return head;
  }

  async listInstallations() {
    return this.installations;
  }

  async installationOctokit(_installationId: number) {
    return {
      request: (route: string, params: Record<string, string>) => this.request(route, params),
      graphql: (_query: string, _vars: Record<string, unknown>) => this.graphql(),
    };
  }

  private async graphql() {
    if (!this.verifiedDomainEmails) {
      throw new Error("Field 'organizationVerifiedDomainEmails' requires GitHub Enterprise Cloud");
    }
    const emails = this.verifiedDomainEmails;
    return {
      organization: {
        membersWithRole: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: this.members.map((m) => ({
            login: m.login,
            databaseId: m.id,
            organizationVerifiedDomainEmails: emails[m.login] ?? [],
          })),
        },
      },
    };
  }

  private page<T>(items: T[], p: Record<string, unknown>): T[] {
    const perPage = Number(p.per_page ?? 30);
    const page = Number(p.page ?? 1);
    return items.slice((page - 1) * perPage, page * perPage);
  }

  private async request(route: string, p: Record<string, string>) {
    this.requests.push(route);
    if (this.down) throw new HttpError(502);
    switch (route) {
      case "GET /orgs/{org}/members": {
        const members =
          p.role === "admin"
            ? this.members.filter((m) => this.orgAdmins.has(m.login.toLowerCase()))
            : this.members;
        return { data: this.page(members, p) };
      }
      case "GET /orgs/{org}/memberships/{username}": {
        const member = this.members.some(
          (m) => m.login.toLowerCase() === p.username!.toLowerCase(),
        );
        if (!member) throw new HttpError(404);
        return {
          data: {
            state: "active",
            role: this.orgAdmins.has(p.username!.toLowerCase()) ? "admin" : "member",
          },
        };
      }
      case "GET /orgs/{org}/teams/{team_slug}/members": {
        const logins = this.teams.get(p.team_slug!);
        if (!logins) throw new HttpError(404);
        return {
          data: this.page(
            logins.map((login) => ({ login })),
            p,
          ),
        };
      }
      case "GET /users/{username}": {
        const user = [...this.members, ...this.users].find(
          (u) => u.login.toLowerCase() === p.username!.toLowerCase(),
        );
        if (!user) throw new HttpError(404);
        return { data: user };
      }
      case "GET /installation/repositories": {
        const names = [...new Set([...this.repos.keys(), ...this.commits.keys()])];
        const repositories = names.map((fullName) => {
          const [owner, name] = fullName.split("/");
          return { owner: { login: owner }, name };
        });
        return { data: { repositories: this.page(repositories, p) } };
      }
      case "GET /repos/{owner}/{repo}/commits": {
        const error = this.commitErrors.get(`${p.owner}/${p.repo}`);
        if (error) throw new HttpError(error);
        const commits = this.commits.get(`${p.owner}/${p.repo}`);
        if (!commits) throw new HttpError(409); // empty repository
        return {
          data: this.page(commits, p).map((c) => ({
            author: c.author,
            commit: { author: { email: c.email } },
          })),
        };
      }
    }
    const repo = this.repos.get(`${p.owner}/${p.repo}`);
    if (!repo) throw new HttpError(404);
    switch (route) {
      case "GET /repos/{owner}/{repo}":
        return { data: { default_branch: repo.defaultBranch } };
      case "GET /repos/{owner}/{repo}/git/ref/{ref}":
        return { data: { object: { sha: repo.head } } };
      case "GET /repos/{owner}/{repo}/git/trees/{tree_sha}": {
        const gate = this.treeGate;
        this.treeGate = undefined;
        await gate;
        return {
          data: {
            truncated: false,
            tree: Object.entries(repo.files).map(([path, content]) => ({
              path,
              type: "blob",
              sha: `blob:${path}`,
              size: Buffer.byteLength(content),
            })),
          },
        };
      }
      case "GET /repos/{owner}/{repo}/git/blobs/{file_sha}": {
        const path = p.file_sha!.slice("blob:".length);
        return {
          data: { content: Buffer.from(repo.files[path]!).toString("base64"), encoding: "base64" },
        };
      }
      default:
        throw new Error(`FakeGithub: unexpected route ${route}`);
    }
  }
}
