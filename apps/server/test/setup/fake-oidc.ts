import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { GITHUB_ACTIONS_ISSUER } from "../../src/producers/github-oidc";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

/** A local stand-in for GitHub's OIDC issuer: its own key pair and JWKS. */
export class FakeOidc {
  private constructor(
    private readonly privateKey: PrivateKey,
    readonly keys: JWTVerifyGetKey,
  ) {}

  static async create(): Promise<FakeOidc> {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" };
    return new FakeOidc(privateKey, createLocalJWKSet({ keys: [jwk] }));
  }

  /** A GitHub Actions-like token for `owner/repo`. */
  sign(
    repository: string,
    overrides: {
      audience?: string;
      issuer?: string;
      expiresIn?: string;
      key?: PrivateKey;
      /** `repository_owner_id` claim (GitHub sends it as a string). */
      ownerId?: number;
    } = {},
  ): Promise<string> {
    const [owner] = repository.split("/");
    return new SignJWT({
      repository,
      repository_owner: owner,
      ...(overrides.ownerId === undefined
        ? {}
        : { repository_owner_id: String(overrides.ownerId) }),
      ref: "refs/heads/main",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(overrides.issuer ?? GITHUB_ACTIONS_ISSUER)
      .setAudience(overrides.audience ?? "callog")
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(overrides.key ?? this.privateKey);
  }
}
