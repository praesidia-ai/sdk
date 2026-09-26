import asyncio
from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError
from praesidia_managed_client import invoke


class PraesidiaProvider(ToolProvider):
    def _validate_credentials(self, credentials):
        try:
            asyncio.run(invoke(credentials["endpoint"], credentials["token"], credentials["organization_id"],
                               credentials["installation_id"], {"operation": "connection"}))
        except Exception:
            raise ToolProviderCredentialValidationError("Authenticated Praesidia installation connection failed") from None
