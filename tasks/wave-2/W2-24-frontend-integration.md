# W2-24 · Frontend integration (tenant app + admin console)
**Owner:** you + the separate UI build

The Flutter tenant app and React admin console are built separately (see `apps/*/README.md`). Integrate against
`/dash/*` REST (Cognito) and AppSync Events `/tenants/<tid>/live`. Step-up confirmation screen for price changes,
deletions and bulk actions issues `X-Step-Up-Token`. Pending-change cards show the same code the chat shows.
## Status
- state: TODO
