import type { RouterDeps } from '../router.js';
// The signup stores and the deterministic YES / NO live with the rest of the signup flow (issue D4). The router imports them
// from there so there is one definition of "a plain yes/no from the identity the link was sent to" (CR D4-1, option A).
import { answerPendingBinding, createSignupStores } from '../../../provisioning/src/lib/signup-token.js';

export interface BindingAnswererConfig {
  /** The slice of DynamoDBDocumentClient the signup stores use. */
  doc: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Epoch seconds; tests pass a fixed clock. */
  nowSeconds?: () => number;
}

/**
 * RouterDeps.answerPendingBinding on top of ONBOARDING#<id>/BINDING (SEC-20). Needs GetItem and UpdateItem under the
 * `ONBOARDING#*` leading keys, which the router role already has; no new grant.
 */
export function createBindingAnswerer(cfg: BindingAnswererConfig): NonNullable<RouterDeps['answerPendingBinding']> {
  const { bindings } = createSignupStores({ doc: cfg.doc, tableName: cfg.tableName });
  return (input) => answerPendingBinding(input, bindings, cfg.nowSeconds?.());
}
