/**
 * Admin console API: tenant list, usage, suspend/resume, template pinning, transcript and export reads, export/delete.
 * Owner: issue H2 (tasks/H2.md). Endpoint reference: services/control-plane/src/console/README.md.
 * Routing and rules live in routes.ts; this file only wires AWS clients.
 */
import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { auditWriter } from './audit-sink.js';
import { consoleEngineFor } from './engines.js';
import { handle } from './routes.js';
import { DdbConsoleStore } from './store.js';
import type { ConsoleDeps, ConsoleEvent, ConsoleResponse } from './types.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function createDeps(): ConsoleDeps {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({});
  const eb = new EventBridgeClient({});
  const table = need('TABLE_NAME');
  const store = new DdbConsoleStore({ ddb, s3, table, tenantBucket: need('TENANT_BUCKET') });
  return {
    store,
    audit: auditWriter(s3, need('AUDIT_BUCKET')),
    emit: async (event) => {
      await eb.send(new PutEventsCommand({
        Entries: [{ EventBusName: need('EVENT_BUS_NAME'), Source: '1145.control-plane', DetailType: event.type, Detail: JSON.stringify(event) }],
      }));
    },
    engineFor: consoleEngineFor({ ddb, table, store }),
    now: () => new Date(),
    newId: () => randomUUID(),
  };
}

let cached: ConsoleDeps | undefined;

export async function handler(event: ConsoleEvent): Promise<ConsoleResponse> {
  cached ??= createDeps();
  return handle(event, cached);
}
