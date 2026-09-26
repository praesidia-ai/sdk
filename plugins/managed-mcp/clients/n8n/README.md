# Praesidia managed action node

Install reviewed local tarballs for `@praesidia/sdk`, `@praesidia/managed-mcp`, and this node into an operator-owned extension directory. Configure `N8N_CUSTOM_EXTENSIONS` to this package's installed directory, then restart your own n8n deployment. This is a local custom node; no community marketplace publication is claimed.

Create **Praesidia managed MCP** credentials with the companion endpoint, a private companion bearer token, organization UUID, and installation UUID. API caller credentials remain in the companion host. Use one installation credential per intended creator; this is not automatic per-workflow-user delegation.

Add a manual trigger and this node. Keep operation `connection` initially. For effects, explicitly run `prepare`, retain the returned IDs and commitment, and stop. After a different human approves the action in Praesidia, choose `resume` and supply `RESUME <approvalId> <requestCommitment>` exactly. Each execution accepts one input item. Do not enable **Retry on fail**, schedules, or automatic resume branches. Read the existing checkpoint after uncertainty; never recreate a run to repeat a possible effect.

The actual node class and credential schema have an acceptance harness against real MCP transport and an inert signed target. A deployed n8n editor/worker import remains an operator deployment acceptance step. Other native n8n nodes are outside this tool's enforcement boundary.
