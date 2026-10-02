import { Duration } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { bundlingProps, fromRoot } from './paths.js';

/** One way to build a Node Lambda from a repo-relative entry, so every stack bundles the same way. */
export function nodeFn(scope: Construct, id: string, entry: string, opts: { timeoutSec?: number; memory?: number; env?: Record<string, string> } = {}) {
  return new nodejs.NodejsFunction(scope, id, {
    ...bundlingProps,
    entry: fromRoot(entry),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    timeout: Duration.seconds(opts.timeoutSec ?? 10),
    memorySize: opts.memory ?? 256,
    environment: opts.env ?? {},
    bundling: { format: nodejs.OutputFormat.ESM, minify: true, sourceMap: true },
  });
}
