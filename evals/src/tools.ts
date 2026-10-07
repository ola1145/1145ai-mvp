import type { AgentKind } from './scenarios.js';

/**
 * The tools each agent really gives its model. Scenarios may only name these (or a prefix glob like `propose_*`
 * that matches one), so a check can never pass because it names a tool that does not exist.
 * test/tools.test.ts keeps this in step with agents/onboarding/tools.py, agents/admin/tools.py and the
 * @function_tool methods in engines/livekit-agent/src/frontdesk/agent.py.
 */
export const AGENT_TOOLS: Readonly<Record<AgentKind, readonly string[]>> = {
  customer: ['check_availability', 'book_appointment', 'take_message', 'lookup_business_info', 'transfer_to_team'],
  onboarding: [
    'save_business_basics', 'send_signup_link', 'start_provisioning', 'provisioning_status', 'save_hours', 'save_services',
    'facts_to_confirm', 'confirm_facts', 'name_agent',
  ],
  admin: ['summary_report', 'list_bookings', 'recent_conversations', 'propose_hours_change', 'propose_closed_date', 'propose_service_change'],
};

/** `name` matches exactly; `prefix_*` matches any tool that starts with `prefix_`. */
export function toolMatches(pattern: string, tool: string): boolean {
  return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool;
}

export function isKnownTool(agent: AgentKind, pattern: string): boolean {
  return AGENT_TOOLS[agent].some((t) => toolMatches(pattern, t));
}
