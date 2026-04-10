# infra

Pulumi Go stack for confession.website. Mirrors the shape of
`../../ephemeral.website/infra/`.

## Resources

- **S3** `confession-audio` — audio blobs under `audio/<slug>/*.opus`, 8-day lifecycle
- **DynamoDB** `confession-meta` — single table, composite key (`PK`, `SK`), TTL on `expires_at`
- **Lambda** — 5 API handlers (`compose`, `probe`, `listen`, `rally_compose`, `subscribe`) + 1 catch-all site handler. All `provided.al2023` / arm64
- **API Gateway** HTTP API — routes `/api/*` to handlers, `$default` to site, CORS allowlist for the `.website` family
- **Route53** — hosted zone + A record alias
- **ACM** — DNS-validated cert for `confession.website`

## Prereqs

1. AWS credentials in env (or via `aws configure`)
2. Pulumi CLI installed + `pulumi login`
3. Backend built: `cd ../backend && ./build.sh` — Pulumi reads the zip artifacts at `../backend/dist/*/`

## Deploy

```bash
cd ../backend && ./build.sh
cd ../infra
pulumi preview
pulumi up
```

After first `up`, grab the `nameServers` output and point Namecheap's
nameservers for `confession.website` at them.

## Stack config

- `Pulumi.yaml` — project name, runtime
- `Pulumi.dev.yaml` — region (`us-east-1`)
