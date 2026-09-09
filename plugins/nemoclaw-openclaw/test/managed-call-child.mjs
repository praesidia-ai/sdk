// Synthetic owner context exercises the real installed plugin handler; not host attestation.
import plugin from '../index.js';
const factories = [];
plugin.register({ pluginConfig: { mcpUrl: process.argv[2], configPath: process.argv[3], installationId: '11111111-1111-4111-8111-111111111111' },
  on() {}, registerTool: factory => factories.push(factory),
});
const result = await factories[0]({ sessionId: 'native-fixture-session', senderIsOwner: true }).execute('native-fixture-call', { operation: process.argv[4] ?? 'resume', approvalId: 'independently-approved-fixture', requestCommitment: 'exact-fixture-commitment', confirm: 'explicit-fixture-confirmation' });
process.stdout.write(JSON.stringify({ content: result.content, details: result.details }) + '\n');
