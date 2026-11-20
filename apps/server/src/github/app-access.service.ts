import { Injectable } from "@nestjs/common";
import { accessGaps, hasGaps, type AccessGaps } from "./app-access";
import { GithubAppService } from "./github-app.service";

/** The admin UI polls for this; an App's permissions change a few times in its life. */
const CACHE_MS = 5 * 60_000;

/** Compares what an installation grants with what the server needs. */
@Injectable()
export class AppAccessService {
  private readonly checked = new Map<number, { at: number; gaps: AccessGaps | null }>();

  constructor(private readonly githubApp: GithubAppService) {}

  /** What the installation lacks; null when nothing, or when GitHub could not be asked. */
  async gaps(installationId: number | null | undefined): Promise<AccessGaps | null> {
    if (!installationId || !this.githubApp.enabled) return null;
    const cached = this.checked.get(installationId);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.gaps;
    try {
      const found = accessGaps(await this.githubApp.installationAccess(installationId));
      const gaps = hasGaps(found) ? found : null;
      this.checked.set(installationId, { at: Date.now(), gaps });
      return gaps;
    } catch {
      return null;
    }
  }

  /** An owner accepted new permissions, or the App was reinstalled. */
  forget(): void {
    this.checked.clear();
  }
}
