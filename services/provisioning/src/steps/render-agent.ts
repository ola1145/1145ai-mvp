/**
 * Step: render-agent
 * Render the tenant's receptionist instructions from the pinned TEMPLATE version + owner-confirmed profile, store
 * PROFILE.rendered*, then VoiceEngine.updateTenantAgent + syncKnowledge (verified facts only).
 *
 * Tenant identity comes from the state machine input (system-generated at onboarding), never from model output.
 * Every write is idempotent, so a Step Functions retry re-renders the same version and pushes the same config.
 * Re-run after AwaitAgentName and on admin.change_applied: the pinned version keeps the tenant's prompt stable.
 */
import { asTenantId, type EngineAgentRef, type EngineId, type KnowledgeDoc, type TenantAgentConfig, type VoiceEngine } from '@1145/shared';
import {
  DEFAULT_AGENT_NAME, DEFAULT_RELEASES, confirmedFacts, renderTemplate, selectTemplateVersion, verticalFor,
  type BusinessHours, type FactInfo, type ServiceInfo, type TemplateRelease, type VerticalId,
} from '../templates/index.js';

/** PROFILE + HOURS + SERVICE# + FACT# items for one tenant, as confirmed by the owner. */
export interface ProfileSnapshot {
  businessName: string;
  businessType: string;
  timezone: string;
  language?: string;
  /** Set by AwaitAgentName; until then the template default is used. */
  agentName?: string;
  voiceId?: string;
  handoffNumber?: string;
  /** Pinned template version. Empty until the first render. */
  templateVersion?: string;
  engineRef?: EngineAgentRef;
  hours: BusinessHours;
  services: ServiceInfo[];
  facts: FactInfo[];
}

/** Written to PROFILE as rendered* attributes (plus templateVersion, which pins the tenant). */
export interface RenderedRecord {
  templateVersion: string;
  vertical: VerticalId;
  renderedInstructions: string;
  renderedDisclosureLine: string;
  renderedAt: string;
}

export interface ProfileStore {
  load(tenantId: string): Promise<ProfileSnapshot | undefined>;
  saveRendered(tenantId: string, rendered: RenderedRecord): Promise<void>;
}

export interface RenderAgentDeps {
  profiles: ProfileStore;
  /** TEMPLATE#frontdesk / V#<semver> items. */
  releases(): Promise<readonly TemplateRelease[]>;
  engineFor(engine: EngineId): Pick<VoiceEngine, 'updateTenantAgent' | 'syncKnowledge'>;
  now?: () => Date;
}

export interface RenderAgentInput { tenantId: string }

export interface RenderAgentOutput {
  tenantId: string;
  templateVersion: string;
  vertical: VerticalId;
  knowledgeDocs: number;
  renderedAt: string;
}

function localDate(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function renderAgent(input: RenderAgentInput, deps: RenderAgentDeps): Promise<RenderAgentOutput> {
  const tenantId = asTenantId(String(input?.tenantId ?? ''));
  const profile = await deps.profiles.load(tenantId);
  if (!profile) throw new Error(`ProfileNotFound: ${tenantId}`);
  const ref = profile.engineRef;
  if (!ref) throw new Error(`EngineNotBound: ${tenantId} has no engine agent yet`);
  if (ref.tenantId !== tenantId) throw new Error(`EngineRefMismatch: engine agent belongs to another tenant`);

  const releases = await deps.releases();
  const templateVersion = selectTemplateVersion({
    tenantId, pinned: profile.templateVersion, releases: releases.length ? releases : DEFAULT_RELEASES,
  });
  const now = (deps.now ?? (() => new Date()))();
  const vertical = verticalFor(profile.businessType);
  const agentName = profile.agentName?.trim() || DEFAULT_AGENT_NAME;

  const rendered = renderTemplate(templateVersion, {
    agentName,
    businessName: profile.businessName,
    businessType: profile.businessType,
    vertical,
    timezone: profile.timezone,
    hours: profile.hours,
    services: profile.services,
    facts: profile.facts,
    today: localDate(now, profile.timezone),
  });

  const renderedAt = now.toISOString();
  await deps.profiles.saveRendered(tenantId, {
    templateVersion: rendered.templateVersion,
    vertical,
    renderedInstructions: rendered.instructions,
    renderedDisclosureLine: rendered.disclosureLine,
    renderedAt,
  });

  const cfg: TenantAgentConfig = {
    agentName,
    businessName: profile.businessName,
    timezone: profile.timezone,
    language: profile.language || 'en-US',
    disclosureLine: rendered.disclosureLine,
    instructions: rendered.instructions,
    templateVersion: rendered.templateVersion,
    ...(profile.voiceId ? { voiceId: profile.voiceId } : {}),
    ...(profile.handoffNumber ? { handoffNumber: profile.handoffNumber } : {}),
  };
  const docs: KnowledgeDoc[] = confirmedFacts(profile.facts).map((f) => ({ id: f.id, text: f.text.trim(), source: f.source, verified: true }));

  const engine = deps.engineFor(ref.engine);
  await engine.updateTenantAgent(ref, cfg);
  await engine.syncKnowledge(ref, docs);

  return { tenantId, templateVersion: rendered.templateVersion, vertical, knowledgeDocs: docs.length, renderedAt };
}

/**
 * Lambda entry (state machine task RenderAgent, input `{ tenantId }`).
 * TODO(D7 follow-up): wire RenderAgentDeps once the DynamoDB profile store and the VoiceEngine factory exist
 * (bind-engine owns engine construction). Until then this fails loudly instead of rendering from partial data.
 */
export async function handler(_event: RenderAgentInput): Promise<RenderAgentOutput> {
  throw new Error('render-agent: deps not wired (profile store + engine factory pending)');
}
