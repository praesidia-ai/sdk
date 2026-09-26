"""Actual SDK/component invocation against the owned HTTP acceptance endpoint.

Only synthetic fixture configuration is accepted on stdin; credentials are never printed.
"""
import asyncio
import importlib.util
from importlib.metadata import version
import json
import os
from pathlib import Path
import sys

ROOT = Path(os.environ.get("PRAESIDIA_MANAGED_PACKAGE_DIRECTORY", Path(__file__).resolve().parents[1])).resolve()
sys.path.insert(0, str(ROOT / "clients/python"))
payload = json.load(sys.stdin)
runtime = payload["runtime"]

try:
    assert version('mcp') == '1.29.1' and version('httpx') == '0.28.1'
    if runtime == "dify":
        assert version('dify_plugin') == '0.10.2'
        plugin = ROOT / "clients/dify"
        os.chdir(plugin)
        sys.path.insert(0, str(plugin))
        from dify_plugin import DifyPluginEnv
        from dify_plugin.core.plugin_registration import PluginRegistration
        registration = PluginRegistration(DifyPluginEnv())
        if payload.get("metadata"):
            tool = registration.tools_configuration[0].tools[0]
            assert len(registration.tools_configuration) == 1 and len(registration.tools_configuration[0].tools) == 1
            assert next(p for p in tool.parameters if p.name == "operation").form.value == "form"
            assert next(p for p in tool.parameters if p.name == "confirm").form.value == "form"
            print(json.dumps({"provider": registration.tools_configuration[0].identity.name, "tools": [tool.identity.name]}))
        else:
            from provider.praesidia import PraesidiaProvider
            from tools.managed_action import ManagedActionTool
            c = payload["credentials"]
            if payload["parameters"].get("operation") != "checkpoint":
                PraesidiaProvider()._validate_credentials(c)
            messages = list(ManagedActionTool.from_credentials(c).invoke(payload["parameters"]))
            assert len(messages) == 1
            print(json.dumps(messages[0].message.json_object))
    elif runtime == "langflow":
        assert version('lfx') == '1.12.0'
        spec = importlib.util.spec_from_file_location("managed_langflow", ROOT / "clients/langflow/praesidia-managed-action.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        component = module.PraesidiaManagedAction()
        if payload.get("metadata"):
            token = next(i for i in component.inputs if i.name == "token")
            assert token.password is True
            assert next(i for i in component.inputs if i.name == "operation").value == "connection"
            print(json.dumps({"component": component.name, "secretInput": True}))
        else:
            component.set(**payload["credentials"], **payload["parameters"])
            result = asyncio.run(component.resolve_output("result"))
            print(json.dumps(result.data))
    else:
        raise ValueError("Unknown runtime")
except Exception as error:
    # The class helps diagnose runtime setup without exposing credential-bearing values.
    print(json.dumps({"errorClass": type(error).__name__}), file=sys.stderr)
    sys.exit(1)
