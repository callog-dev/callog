# notify-config

Routing for [Callog](https://github.com/callog-dev/callog): where engineering notifications
go, what they look like and whom they mention. Callog loads the default branch on every push;
a change that does not pass validation is rejected and the previous config stays active.

- `routes/*.yaml` — one file per route: who may send to it, where it goes, the message template.
- `teams.yaml` — teams as delivery addresses, with members from GitHub teams or Slack user groups.
- `config.yaml` — settings of the whole organization.

There are no logins or emails here: people link their accounts in Callog.

## First steps

1. In `routes/hello.yaml`, change `#general` to a channel of yours.
2. Open a pull request: the Validate workflow checks it and comments a preview of the message.
3. Merge it and send a test notification from Callog → Admin.

Then rename the route to what it announces and send to it from a workflow:

```yaml
- uses: callog-dev/callog/packages/action@v0.1.2
  with:
    url: https://callog.acme.dev # your Callog address
    route: hello
    data: '{"text": "Deployed ${{ github.sha }}"}'
```

The workflow needs `permissions: id-token: write`, and its repository must be listed in the
route's `allowed_sources.github_repos`. See the
[full reference](https://github.com/callog-dev/callog/tree/main/packages/config-schema/fixtures/valid)
for every option.
