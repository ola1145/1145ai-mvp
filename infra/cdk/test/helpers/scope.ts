import type { CfnElement } from 'aws-cdk-lib';
import type { Template } from 'aws-cdk-lib/assertions';
import type { DataStack } from '../../lib/data-stack.js';
import type { Built } from './app.js';
import { collectStatements, symbolTable, type Statement, type Symbols } from './policy.js';

/** Logical ids (in the data stack) of the resources the isolation rules talk about. */
export interface DataIds { table: string; tenantBucket: string; auditBucket: string; dataKey: string; tenantDataRole: string }

export interface Analysis {
  sym: Symbols;
  ids: DataIds;
  /** Every policy statement in every stack. */
  statements: Statement[];
  byStack(stack: string): Statement[];
}

/** Symbols and statements for any set of synthesized stacks that includes the data stack (under the key `data`). */
export function analyzeStacks(data: DataStack, templates: Record<string, Template>): Analysis {
  const child = (c: { node: { defaultChild?: unknown } }) => c.node.defaultChild as CfnElement;
  const constructs = {
    table: child(data.table), tenantBucket: child(data.tenantBucket), auditBucket: child(data.auditBucket),
    dataKey: child(data.dataKey), tenantDataRole: child(data.tenantDataRole),
  };
  const dataTemplate = templates.data;
  if (!dataTemplate) throw new Error('analyzeStacks needs the data stack template under the key "data"');
  const sym = symbolTable(data, dataTemplate, constructs);
  const ids: DataIds = {
    table: data.getLogicalId(constructs.table), tenantBucket: data.getLogicalId(constructs.tenantBucket), auditBucket: data.getLogicalId(constructs.auditBucket),
    dataKey: data.getLogicalId(constructs.dataKey), tenantDataRole: data.getLogicalId(constructs.tenantDataRole),
  };
  const statements = Object.entries(templates).flatMap(([key, template]) => collectStatements(key, template, sym));
  return { sym, ids, statements, byStack: (stack) => statements.filter((s) => s.stack === stack) };
}

/** The whole app, as bin/app.ts wires it. */
export function analyze(built: Built): Analysis {
  return analyzeStacks(built.data, built.templates);
}
