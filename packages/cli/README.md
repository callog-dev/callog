# @callog/cli

`notify` command line and the config-repo CI action. Runs exactly the checks the server
runs when it loads the config: YAML and schema, cross-file references (teams and places a
route names), route `schema` (valid JSON Schema, `examples` match it), and rendering of every
example — the template, and the recipients and the grouping key a route takes from the data.

```bash
notify validate [dir] [--github-annotations]
notify preview [dir] [--route <id>]...
notify send --route e2e-failed --data '{"branch":"main"}' --to github:octocat \
  --url https://notify.acme.dev --api-key "$NOTIFY_API_KEY"
```

`--to` is a person, a team or a place (`github:octocat`, `team:frontend`, `place:deploys`);
repeat it for several. With a key created with _Direct messages_, `--route direct --data
'{"text":"…"}'` sends plain text without a route in the config.

A [preset](../../templates/presets) copied into `routes/` is checked like any other route: it
comes with an example of what its system sends.

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
      - uses: callog-dev/callog/packages/cli@v0.5.1
        with:
          path: . # config directory, default "."
```

Errors show up as annotations on the files and in the job summary. On pull requests the
action keeps one comment with a preview of every changed route's `examples` — a Slack
approximation with a Block Kit Builder link and the Telegram message (`preview: false` turns
it off). The action is a single
bundled file (`dist-action/index.js`, built by `pnpm --filter @callog/cli build`).
