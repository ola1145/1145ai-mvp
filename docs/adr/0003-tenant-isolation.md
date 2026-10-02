# ADR-0003: Tenant isolation enforced in IAM, not only in code

**Status:** Proposed · **Date:** 2026-10-02

## Decision
Single DynamoDB table. Tenant data lives under `PK = TENANT#<tenantId>`. The tool API verifies the caller's token,
then assumes `TenantDataRole` with session tag `tenant_id=<tenantId>`. The role's policy allows DynamoDB actions only
where `dynamodb:LeadingKeys` equals `TENANT#${aws:PrincipalTag/tenant_id}`; S3 access is limited to the
`tenants/${aws:PrincipalTag/tenant_id}/` prefix. Route items (`NUMBER#`, `IDENTITY#`, `ENGINEAGENT#`, `SIGNUP#`) are
readable only by the resolver role.

## Consequences
A bug that passes the wrong tenant ID fails at IAM. Cost: one STS call per cold container plus a short credential
cache keyed by tenant. Cross-tenant ops jobs use separate roles with reason codes, logged to the audit bucket.
