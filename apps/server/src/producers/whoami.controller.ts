import { Controller, Get, Headers, NotFoundException, Query } from "@nestjs/common";
import { ownValue } from "@callog/config-schema";
import { TenantConfigService } from "../tenant-config/tenant-config.service";
import { ProducerAuthService } from "./producer-auth.service";

/**
 * Lets a producer check its credentials (and access to a route) without sending
 * anything — handy when wiring up a workflow or service.
 */
@Controller("v1/whoami")
export class WhoamiController {
  constructor(
    private readonly auth: ProducerAuthService,
    private readonly configs: TenantConfigService,
  ) {}

  @Get()
  async whoami(
    @Headers("authorization") authorization: string | undefined,
    @Query("route") routeId: string | undefined,
  ) {
    const producer = await this.auth.authenticate(authorization);
    if (routeId) {
      const active = await this.configs.getActive(producer.tenantId);
      const route = active && ownValue(active.config.routes, routeId);
      if (!route) throw new NotFoundException(`Route "${routeId}" not found`);
      this.auth.assertAllowed(route, producer);
    }
    return {
      producer: producer.label,
      source: producer.source,
      ...(routeId ? { route: routeId } : {}),
    };
  }
}
