import json
from lfx.custom import Component
from lfx.io import DropdownInput, MessageTextInput, MultilineInput, Output, SecretStrInput
from lfx.schema import Data
from praesidia_managed_client import invoke


class PraesidiaManagedAction(Component):
    display_name = "Praesidia managed action"
    description = "One installed target: prepare, separate human review, explicit resume. No automatic effect retry."
    name = "PraesidiaManagedAction"
    icon = "ShieldCheck"
    inputs = [
        MessageTextInput(name="endpoint", display_name="Companion HTTPS endpoint", required=True),
        SecretStrInput(name="token", display_name="Companion bearer token", required=True),
        MessageTextInput(name="organization_id", display_name="Organization UUID", required=True),
        MessageTextInput(name="installation_id", display_name="Installation UUID", required=True),
        DropdownInput(name="operation", display_name="Explicit operation", options=["connection", "prepare", "checkpoint", "resume", "list_actions"], value="connection"),
        MessageTextInput(name="operation_key", display_name="Operation key within operator host run", value=""),
        MultilineInput(name="body_json", display_name="Exact request body JSON", value="{}"),
        MessageTextInput(name="approval_id", display_name="Owned approval UUID", value=""),
        MessageTextInput(name="request_commitment", display_name="Original request commitment", value=""),
        MessageTextInput(name="confirm", display_name="Explicit RESUME approval commitment confirmation", value=""),
    ]
    outputs = [Output(name="result", display_name="Observed result", method="execute_managed")]

    async def execute_managed(self) -> Data:
        args = {"operation": self.operation}
        if self.operation == "prepare":
            args.update(operationKey=self.operation_key, body=json.loads(self.body_json))
        if self.operation in {"checkpoint", "resume"}:
            args["approvalId"] = self.approval_id
        if self.operation == "resume":
            args.update(requestCommitment=self.request_commitment, confirm=self.confirm)
        token = self.token.get_secret_value() if hasattr(self.token, "get_secret_value") else self.token
        result = await invoke(self.endpoint, token, self.organization_id, self.installation_id, args)
        self.status = result.get("outcome", result.get("status", "observed"))
        return Data(data=result)
