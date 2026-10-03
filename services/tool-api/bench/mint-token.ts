/* Mint a short-lived customer-agent token for the benchmark.
 *   TOOL_API_TOKEN_SECRET=<tokenCurrent from the dev tool-api secret> TENANT_ID=<seeded dev tenant> \
 *   pnpm tsx services/tool-api/bench/mint-token.ts
 * The owner supplies the secret from the dev Secrets Manager entry; agents never read it. Token lives 15 minutes. */
import { mintTenantToken } from '@1145/shared';

const secret = process.env.TOOL_API_TOKEN_SECRET;
const tid = process.env.TENANT_ID;
if (!secret || !tid) { console.error('Set TOOL_API_TOKEN_SECRET and TENANT_ID.'); process.exit(2); }
console.log(mintTenantToken({ tid, prn: 'customer-agent', cid: `bench-${Date.now()}`, clr: '+12145550123', ch: 'voice' }, secret));
