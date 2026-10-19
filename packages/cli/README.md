# @callog/cli

`notify` command line and the config-repo CI action. Runs exactly the checks the server
runs when it loads the config: YAML and schema, cross-file references, route `schema`
(valid JSON Schema, `examples` match it) and template rendering of every example.

```bash
notify validate [dir] [--github-annotations]
notify preview [dir] [--route <id>]...
notify send --route e2e-failed --data '{"branch":"main"}' --to github:octocat \
  --url https://notify.acme.dev --api-key "$NOTIFY_API_KEY"
```

## Config repo CI

```yaml
# .github/workflows/validate.yml in <org>/notify-config
on: [pull_request, push]
permissions:
  contents: read
  pull-requests: write # preview comment
jobs:
  notify-config:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: callog-dev/callog/packages/cli@v0.2.0
        with:
          path: . # config directory, default "."
```

Errors show up as annotations on the files and in the job summary. On pull requests the
action keeps one comment with a preview of every changed route's `examples` — a Slack
approximation with a Block Kit Builder link and the Telegram message (`preview: false` turns
it off). The action is a single
bundled file (`dist-action/index.js`, built by `pnpm --filter @callog/cli build`).
