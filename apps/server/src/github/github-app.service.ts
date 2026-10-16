import { Inject, Injectable } from "@nestjs/common";
import { App } from "@octokit/app";
import { GITHUB_APP_CONFIG, type GithubAppConfig } from "./github.config";

export interface InstallationInfo {
  id: number;
  /** Numeric id of the org: stays the same across reinstalls and renames. */
  accountId: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;

/** Access to the GitHub API as the App (JWT) or as one of its installations. */
@Injectable()
export class GithubAppService {
  private app: App | undefined;

  constructor(@Inject(GITHUB_APP_CONFIG) private readonly config: GithubAppConfig | undefined) {}

  get enabled(): boolean {
    return this.config !== undefined;
  }

  async listInstallations(): Promise<InstallationInfo[]> {
    const installations: InstallationInfo[] = [];
    for await (const { installation } of this.getApp().eachInstallation.iterator()) {
      const account = installation.account as { id?: number; login?: string; type?: string } | null;
      installations.push({
        id: installation.id,
        accountId: account?.id ?? 0,
        accountLogin: account?.login ?? "",
        accountType: account?.type ?? "",
        suspended: installation.suspended_at != null,
      });
    }
    return installations;
  }

  installationOctokit(installationId: number): Promise<InstallationOctokit> {
    return this.getApp().getInstallationOctokit(installationId);
  }

  private getApp(): App {
    if (!this.config) throw new Error("GitHub App is not configured");
    this.app ??= new App({ appId: this.config.appId, privateKey: this.config.privateKey });
    return this.app;
  }
}
