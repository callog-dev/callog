# Callog GitHub Action

Sends a notification to a route defined in your config repo. Where it goes, how it looks
and whom it mentions is configured centrally — the workflow only names the route.

```yaml
permissions:
  id-token: write # GitHub OIDC: no secrets in the repo
  contents: read

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - uses: callog-dev/callog/packages/action@v0.2.0
        if: failure()
        with:
          url: https://notify.company.internal
          route: e2e-failed
          mention-author: true
          thread-key: e2e/${{ github.ref_name }}
          data: |
            {
              "branch": "${{ github.ref_name }}",
              "run_url": "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
            }
```

The route must allow the repository: `allowed_sources.github_repos: [org/repo]`.

## Inputs

| Input             | Default  |                                                                             |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `url`             | —        | Callog server URL                                                           |
| `route`           | —        | Route id (`routes/<id>.yaml`)                                               |
| `data`            | `{}`     | JSON object for the template; validated against the route `schema`          |
| `recipients`      |          | `github:login`, `team:slug`, `email:…`, comma or newline separated          |
| `mention-author`  | `false`  | Add the commit/PR author (or the actor)                                     |
| `thread-key`      |          | Same key → same thread                                                      |
| `update`          | `false`  | Edit the thread's first message (needs `thread-key`)                        |
| `idempotency-key` | derived  | Default: run + attempt + job + request, so a retried step is not duplicated |
| `api-key`         |          | Use an API key instead of OIDC                                              |
| `audience`        | `callog` | OIDC audience expected by the server                                        |
| `fail-on-error`   | `false`  | By default a failed notification is only a warning                          |

Matrix legs share the job name, so legs that send identical requests get the same default key
and only the first one is delivered. Add the leg to the key when that can happen:

```yaml
idempotency-key: ${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}-${{ strategy.job-index }}
```

## Outputs

`notification-id` — id of the accepted notification (`GET /v1/notifications/:id`).

## Development

The action has no runtime dependencies: `pnpm --filter @callog/action build` compiles `src/` to
`dist/`, which `action.yml` runs on Node 24.
