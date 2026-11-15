import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { DIRECT_ROUTE, type Route } from "@callog/config-schema";
import type { JWTVerifyGetKey } from "jose";
import { ENV, type Env } from "../config/env";
import type { NotificationSource } from "../db/schema";
import { TenantsService } from "../tenants/tenants.service";
import { ApiKeysService } from "./api-keys.service";
import { OIDC_KEY_RESOLVER, verifyGithubActionsToken } from "./github-oidc";
import { HooksService } from "./hooks.service";

export interface Producer {
  tenantId: string;
  source: NotificationSource;
  /** Human-readable, for logs and errors. */
  label: string;
  /** An API key that may send to the built-in `direct` route. */
  direct?: boolean;
}

/** Authenticates producers (GitHub Actions OIDC or API key) and checks route access. */
@Injectable()
export class ProducerAuthService {
  private readonly logger = new Logger(ProducerAuthService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(OIDC_KEY_RESOLVER) private readonly oidcKeys: JWTVerifyGetKey,
    private readonly apiKeys: ApiKeysService,
    private readonly hooks: HooksService,
    private readonly tenants: TenantsService,
  ) {}

  /** 401 for anything that is not a valid credential of an active tenant. */
  async authenticate(authorization: string | undefined): Promise<Producer> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new UnauthorizedException("Missing bearer token");
    return token.split(".").length === 3 ? this.fromOidc(token) : this.fromApiKey(token);
  }

  /** 401 for anything that is not the token of an active hook; the hook names its route. */
  async authenticateHook(token: string): Promise<{ producer: Producer; routeId: string }> {
    const hook = await this.hooks.verify(token);
    if (!hook) throw new UnauthorizedException("Invalid hook token");
    await this.requireActiveTenant(hook.tenantId);
    return {
      producer: {
        tenantId: hook.tenantId,
        source: { type: "hook", hookId: hook.id, hookName: hook.name, routeId: hook.routeId },
        label: `Hook "${hook.name}"`,
      },
      routeId: hook.routeId,
    };
  }

  /**
   * 403 unless the route lists this producer in `allowed_sources`. Admins may test any
   * route, a hook may send to the one route an admin bound it to, and the built-in route
   * takes the API keys that were given it.
   */
  assertAllowed(route: Route, producer: Producer): void {
    const { github_repos, api_keys } = route.allowed_sources;
    const source = producer.source;
    const allowed =
      source.type === "admin_test" ||
      (route.id === DIRECT_ROUTE.id && producer.direct === true) ||
      (source.type === "hook" && source.routeId === route.id) ||
      (source.type === "github_oidc" &&
        github_repos.some((r) => r.toLowerCase() === source.repository.toLowerCase())) ||
      (source.type === "api_key" && api_keys.includes(source.apiKeyName));
    if (!allowed) {
      throw new ForbiddenException(
        `${producer.label} is not in allowed_sources of route "${route.id}"`,
      );
    }
  }

  private async fromOidc(token: string): Promise<Producer> {
    let claims;
    try {
      claims = await verifyGithubActionsToken(token, this.oidcKeys, this.env.OIDC_AUDIENCE);
    } catch (err) {
      this.logger.debug(`OIDC token rejected: ${String(err)}`);
      throw new UnauthorizedException("Invalid GitHub Actions OIDC token");
    }
    const tenant = await this.tenants.findActiveByOrg(
      claims.repositoryOwner,
      claims.repositoryOwnerId,
    );
    if (!tenant) {
      throw new UnauthorizedException(`No active installation for "${claims.repositoryOwner}"`);
    }
    return {
      tenantId: tenant.id,
      source: { type: "github_oidc", repository: claims.repository },
      label: `GitHub Actions in ${claims.repository}`,
    };
  }

  private async fromApiKey(token: string): Promise<Producer> {
    const key = await this.apiKeys.verify(token);
    if (!key) throw new UnauthorizedException("Invalid API key");
    await this.requireActiveTenant(key.tenantId);
    return {
      tenantId: key.tenantId,
      source: { type: "api_key", apiKeyId: key.id, apiKeyName: key.name },
      label: `API key "${key.name}"`,
      direct: key.direct,
    };
  }

  private async requireActiveTenant(tenantId: string): Promise<void> {
    const tenant = await this.tenants.findById(tenantId);
    if (tenant?.status !== "active") throw new UnauthorizedException("Tenant is not active");
  }
}
