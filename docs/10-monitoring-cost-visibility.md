# PAIGE Cloud monitoring, recovery and costs

## Readback on November 20, 2026

- Hostinger hPanel showed KVM 2 running Ubuntu **26.04 LTS** in Boston 2, with 2 vCPU, 8 GB RAM, 100 GB disk and 8 TB monthly bandwidth. The earlier handoff listed Ubuntu 24.04. hPanel showed 2% CPU and 9% memory over the previous 24 hours, with 6 GB disk in use. Coolify sampled 1.9% CPU, 0.98 GB memory and 6.6% disk.
- Coolify Cloud 4.7.6 reported server `p2mh5nemklmkmb6rtnuw8swd` reachable and usable. Legacy F1, v3 and v4 were healthy, with Dockerfile healthchecks and the separate application-level health setting disabled. Three other legacy resources showed exited/unhealthy.
- Hostinger payment history showed **$13.99 paid November 19** for KVM 2. Subscriptions showed **$24.49 renewal before tax**, auto-renewing December 19. The prior Coolify receipt reports **$5/month**, pending current invoice readback. hPanel showed a weekly backup schedule and zero snapshots/backups during inspection.

| Legacy app | Deployment ID | Readback |
|---|---|---|
| `fxfz4l18wzsufmveobxljvce` | `4tsawvm684qvrx9eph2dr20e` | Finished, HTTPS health 200 `ok`, build `dev-mwo0rpxa` |
| `dbruxwisffft4ua1scxckjou` | `og8z57q2lnonrvawhrlvrlgh` | Finished, Coolify healthy |
| `x9mjc06noelwqupykogyppqj` | `dggrpvieekke4oruun3gasoz` | Finished, HTTPS health 200 `ok v3`, build `dev-mwp9juuh` |
| `2xohh97jxgrsjschqjcae6gn` | `07hfnz1k56kycjb0ijfmpgyf` | Finished, HTTPS health 200 `ok`, build `dev-mwp9juuh` |

Coolify reported `HEAD` for the legacy deployment records. The [digest release runbook](05-rollback-runbook.md) applies to the dedicated F2 app.

## Operating the governed preview

- Inspect Coolify application status and deployment logs, then probe `/healthz`, `/version.json` and `/release.json` over HTTPS. Use application logs for startup and requests.
- Verify the existing alert destinations for deployment failures, stopped containers, server reachability and disk usage. Record delivery after a controlled failure or notification test. Platform capability and configuration alone do not prove delivery.
- Keep the private Cloud repo, both GHCR images, release records and the nonsecret Coolify app settings. The static preview has no data volumes. Restore requires the saved configuration, registry access and TLS on a working host. Retrieve credentials from the approved secret store.
- Check GitHub usage and the spending stop before dispatch. One VPS hosts all previews. A host outage can affect each of them and there is no second host for failover.
