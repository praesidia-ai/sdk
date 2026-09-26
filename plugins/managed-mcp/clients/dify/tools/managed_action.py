import asyncio
import json
from dify_plugin import Tool
from praesidia_managed_client import invoke


class ManagedActionTool(Tool):
    def _invoke(self, tool_parameters):
        c = self.runtime.credentials
        operation = tool_parameters.get("operation", "connection")
        args = {"operation": operation}
        if operation == "prepare":
            args.update(operationKey=tool_parameters["operation_key"], body=json.loads(tool_parameters["body_json"]))
        if operation in {"checkpoint", "resume"}:
            args["approvalId"] = tool_parameters["approval_id"]
        if operation == "resume":
            args.update(requestCommitment=tool_parameters["request_commitment"], confirm=tool_parameters["confirm"])
        result = asyncio.run(invoke(c["endpoint"], c["token"], c["organization_id"], c["installation_id"], args))
        yield self.create_json_message(result)
