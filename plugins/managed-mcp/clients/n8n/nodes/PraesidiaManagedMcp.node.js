class PraesidiaManagedMcp {
  constructor() {
    this.description = {
      displayName: 'Praesidia managed action', name: 'praesidiaManagedMcp', group: ['transform'], version: 1,
      description: 'Explicit prepare, owned checkpoint and separately approved resume through one fixed target',
      defaults: { name: 'Praesidia managed action' }, inputs: ['main'], outputs: ['main'],
      credentials: [{ name: 'praesidiaManagedMcp', required: true }],
      properties: [
        { displayName: 'Operation', name: 'operation', type: 'options', default: 'connection', options: [
          { name: 'Check connection', value: 'connection' }, { name: 'Prepare and stop for review', value: 'prepare' },
          { name: 'Read owned checkpoint', value: 'checkpoint' }, { name: 'Explicitly resume approved request', value: 'resume' },
          { name: 'Read protected action list', value: 'list_actions' },
        ] },
        { displayName: 'Operation key', name: 'operationKey', type: 'string', default: '', displayOptions: { show: { operation: ['prepare'] } } },
        { displayName: 'Exact request body', name: 'body', type: 'json', default: '{}', displayOptions: { show: { operation: ['prepare'] } } },
        { displayName: 'Approval UUID', name: 'approvalId', type: 'string', default: '', displayOptions: { show: { operation: ['checkpoint', 'resume'] } } },
        { displayName: 'Request commitment', name: 'requestCommitment', type: 'string', default: '', displayOptions: { show: { operation: ['resume'] } } },
        { displayName: 'Explicit resume confirmation', name: 'confirm', type: 'string', default: '', description: 'RESUME followed by the exact approval UUID and request commitment, separated by spaces', displayOptions: { show: { operation: ['resume'] } } },
      ],
    };
  }
  async execute() {
    // A single explicit invocation prevents an imported item list from becoming bulk effects.
    if (this.getInputData().length !== 1) throw new Error('Praesidia requires exactly one workflow item per explicit invocation');
    const credentials = await this.getCredentials('praesidiaManagedMcp');
    const { callRemote } = await import('@praesidia/managed-mcp/client');
    const invoke = args => callRemote(credentials.endpoint, credentials.token, credentials.organizationId, 'praesidia_managed_action', args);
    const operation = this.getNodeParameter('operation', 0);
    if (!['connection', 'prepare', 'checkpoint', 'resume', 'list_actions'].includes(operation)) throw new Error('Unsupported operation');
    // Disabling new execution must preserve authenticated owned checkpoint readback.
    const connection = operation === 'checkpoint' ? null : await invoke({ operation: 'connection' });
    if (connection && (connection.installationId !== credentials.installationId || connection.status !== 'CONNECTED' || !connection.liveAuthorityChecked)) throw new Error('Installation connection is not current');
    const args = { operation };
    if (operation === 'prepare') {
      args.operationKey = this.getNodeParameter('operationKey', 0);
      const value = this.getNodeParameter('body', 0); args.body = typeof value === 'string' ? JSON.parse(value) : value;
    }
    if (['checkpoint', 'resume'].includes(operation)) args.approvalId = this.getNodeParameter('approvalId', 0);
    if (operation === 'resume') {
      args.requestCommitment = this.getNodeParameter('requestCommitment', 0); args.confirm = this.getNodeParameter('confirm', 0);
    }
    const result = operation === 'connection' ? connection : await invoke(args);
    if (result.installationId !== credentials.installationId) throw new Error('Installation response changed');
    return [[{ json: result, pairedItem: { item: 0 } }]];
  }
}
module.exports = { PraesidiaManagedMcp };
