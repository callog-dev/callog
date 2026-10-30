# Callog Helm chart

Runs Callog as two Deployments:

- **api** — UI, API and GitHub webhooks (`api.replicas`, default 1). An upgrade starts the new
  pod before stopping the old one, so one replica is enough for it. While a node fails or the pod
  is evicted, though, the api is down: GitHub does not retry failed webhook deliveries and
  `/v1/notify` calls fail. If that matters, run 2 and add your own PodDisruptionBudget.
- **worker** — the queue, Slack Socket Mode and Telegram polling. Always **exactly one** replica,
  replaced with `Recreate`: a second worker would answer Slack and Telegram twice. Its `migrate`
  init container applies database migrations before it starts. Schedule it on nodes that are not
  reclaimed at short notice (on-demand rather than spot) with `worker.nodeSelector` /
  `worker.tolerations`.

Postgres is not part of the chart: point `DATABASE_URL` at your own (requirements in
[docs/setup.md](../../docs/setup.md)). To try the chart, `examples/postgres.yaml` runs a
throwaway one.

## Install

```bash
kubectl create namespace callog
kubectl -n callog apply -f examples/postgres.yaml   # only to try it
helm install callog oci://ghcr.io/callog-dev/charts/callog --version X.Y.Z -n callog -f values.yaml
```

A minimal `values.yaml`:

```yaml
secretEnv:
  DATABASE_URL: postgres://callog:callog@postgres:5432/callog
  ENCRYPTION_KEY: "" # openssl rand -base64 32 — keep it with your database backups
ingress:
  enabled: true
  className: nginx
  host: callog.example.com
```

Open `https://callog.example.com` and follow the setup page. It creates the GitHub App and shows
its credentials once, with the private key in base64 for a Secret. Add them to `secretEnv` and
run `helm upgrade`: pods restart when the chart's Secret changes. With your own Secret (below),
`kubectl create secret generic … --from-env-file` takes the lines as printed; restart the pods
yourself afterwards (`kubectl rollout restart deploy -l app.kubernetes.io/instance=callog`).

## Secrets

`secretEnv` becomes a Secret the chart creates. To manage it yourself (SOPS, External Secrets,
Vault), create a Secret with the same keys and set `existingSecret: <name>`; `secretEnv` is then
ignored.

| Key                                                |                                                   |
| -------------------------------------------------- | ------------------------------------------------- |
| `DATABASE_URL`                                     | Required                                          |
| `ENCRYPTION_KEY`                                   | Required; encrypts Slack and Telegram tokens      |
| `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`           | From the setup page                               |
| `GITHUB_APP_PRIVATE_KEY`                           | PEM or base64 of the PEM                          |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | Sign-in with GitHub                               |
| `METRICS_TOKEN`                                    | Optional; `/metrics` then requires a bearer token |

## An internal UI with public webhooks

GitHub has to reach `/webhooks/github`; nothing else needs to be public. Keep `ingress` on an
internal host and add `webhookIngress` on a public one: it serves only `/webhooks/github`, and
the setup page gives a new App that address (`GITHUB_WEBHOOK_URL`).

```yaml
ingress:
  enabled: true
  className: nginx
  host: callog.internal.example.com
  annotations:
    nginx.ingress.kubernetes.io/whitelist-source-range: 10.0.0.0/8
webhookIngress:
  enabled: true
  className: nginx
  host: callog-hooks.example.com
```

To limit the webhook host to GitHub, allow the `hooks` ranges from
`https://api.github.com/meta`; they change, so keep them current. The webhook signature is
checked either way. GitHub Actions call `/v1/notify`: runners inside the cluster can use the
api Service, `http://callog-api.<namespace>.svc.cluster.local:3000` for a release named
`callog` (`<release>-callog-api` for other names).

For an App created before the webhook host existed, change its Webhook URL in the App's settings
on GitHub.

## Values

The ones worth knowing; the rest (resources, scheduling, security contexts, pull secrets, pod
labels) are in [values.yaml](values.yaml).

| Value                            | Default                  |                                                                                     |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `publicUrl`                      | `https://<ingress.host>` | `PUBLIC_URL`: the address people open                                               |
| `githubWebhookUrl`               | webhook host + path      | `GITHUB_WEBHOOK_URL`, used when the setup page creates the App                      |
| `env`                            | `{}`                     | Plain environment variables (`LOG_LEVEL`, `OIDC_AUDIENCE`, …)                       |
| `secretEnv`, `existingSecret`    |                          | See [Secrets](#secrets)                                                             |
| `api.replicas`                   | `1`                      | The worker has no such setting                                                      |
| `migrations.enabled`             | `true`                   | Off when your DBA applies migrations ([setup.md](../../docs/setup.md#5-migrations)) |
| `ingress.*`, `webhookIngress.*`  | off                      | `enabled`, `className`, `annotations`, `host`, `tls`                                |
| `metrics.podMonitor.enabled`     | `false`                  | Prometheus Operator `PodMonitor` for api and worker pods                            |
| `metrics.podMonitor.bearerToken` | `false`                  | Send `METRICS_TOKEN` from the Secret                                                |

`values.schema.json` rejects unknown keys, so a typo fails the install instead of being ignored.
