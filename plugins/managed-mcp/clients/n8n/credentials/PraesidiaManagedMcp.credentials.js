class PraesidiaManagedMcp {
  constructor() {
    this.name = 'praesidiaManagedMcp';
    this.displayName = 'Praesidia managed MCP';
    this.documentationUrl = 'https://praesidia.ai/start/';
    this.properties = [
      { displayName: 'Companion endpoint', name: 'endpoint', type: 'string', default: '', required: true },
      { displayName: 'Companion bearer token', name: 'token', type: 'string', typeOptions: { password: true }, default: '', required: true },
      { displayName: 'Organization UUID', name: 'organizationId', type: 'string', default: '', required: true },
      { displayName: 'Installation UUID', name: 'installationId', type: 'string', default: '', required: true },
    ];
  }
}
module.exports = { PraesidiaManagedMcp };
