# Presets

Ready-made routes for systems that send their own webhooks. A preset is an ordinary route:
copy it into `routes/` of your config repo, point it at a place of yours, and change whatever
you like. Callog itself knows nothing about these systems — everything a preset does is in
its file.

| Preset                                       | For                                       |
| -------------------------------------------- | ----------------------------------------- |
| [`grafana-alerts.yaml`](grafana-alerts.yaml) | Grafana Alerting, a Webhook contact point |

Each file starts with the steps to connect the system. Run `notify validate` on your config
repo afterwards: it renders the preset on the example payload that comes with it.
