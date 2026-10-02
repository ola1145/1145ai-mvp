# Gate 3 launch checklist

- [ ] Eval suite green on the pinned agent template version
- [ ] 20 real test calls reviewed by a human; no silent failures; disclosure on every call
- [ ] Tenant isolation test: token for tenant A cannot read tenant B (automated, in CI)
- [ ] Kill switch tested: suspend a tenant, call its number, hear the fallback message
- [ ] Minute caps and card-before-activation enforced
- [ ] Alarms firing to your phone: failed calls, tool p95 > 300 ms, webhook 5xx, DLQ depth > 0
- [ ] Data export and delete for one tenant tested
- [ ] Owner support path works ("talk to a human at 1145")
- [ ] Healthcare businesses are screened out at onboarding
- [ ] Terms of service + privacy policy live; recording disclosure text reviewed
