import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { AdminCheck } from "./admin-check";
import { SessionGuard, type SessionRequest } from "./session.guard";

/** A logged-in admin of the tenant: a GitHub org owner or a person granted the role in /manage. */
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionGuard,
    private readonly admins: AdminCheck,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.sessions.canActivate(context);
    const { tenantId, personId } = context.switchToHttp().getRequest<SessionRequest>().session!;
    if (!(await this.admins.isAdmin(tenantId, personId)))
      throw new ForbiddenException("Admins only");
    return true;
  }
}
