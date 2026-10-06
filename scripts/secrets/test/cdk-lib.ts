// aws-cdk-lib is a dependency of infra/cdk only, so it does not resolve from scripts/. Re-export it by path
// (same files the stack itself loads) until this test moves to infra/cdk/test (see CHANGE_REQUESTS/P2-1.md).
export { App } from '../../../infra/cdk/node_modules/aws-cdk-lib/index.js';
export { Match, Template } from '../../../infra/cdk/node_modules/aws-cdk-lib/assertions/index.js';
