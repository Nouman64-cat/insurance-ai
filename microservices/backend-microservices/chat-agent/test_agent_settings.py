"""SuperAdmin runtime settings and inventory contracts, without live providers."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from skills import settings
from skills.inventory import build
from tools import ALL_TOOLS


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    monkeypatch.setattr(settings, '_value', True)
    monkeypatch.setattr(settings, '_has_remote', False)
    monkeypatch.setattr(settings, '_at', 0.0)
    monkeypatch.setattr(settings, '_lock', asyncio.Lock())


def test_persisted_setting_overrides_old_environment_variable(monkeypatch):
    monkeypatch.setenv('SKILL_AGENT_ENABLED', 'true')
    async def work():
        with patch.object(settings, '_fetch', AsyncMock(return_value=False)):
            await settings.refresh(force=True)
        assert settings.enabled() is False
    asyncio.run(work())


def test_cached_settings_refresh_after_expiry():
    async def work():
        with patch.object(settings, '_fetch', AsyncMock(side_effect=[False, True])) as fetch:
            await settings.refresh(force=True)
            await settings.refresh()
            assert fetch.await_count == 1 and not settings.enabled()
            await settings.refresh(force=True)
            assert fetch.await_count == 2 and settings.enabled()
    asyncio.run(work())


def test_outage_preserves_disabled_setting_and_cold_start_fails_closed():
    import httpx
    async def work():
        with patch.object(settings, '_fetch', AsyncMock(side_effect=httpx.ConnectError('unreachable'))):
            await settings.refresh(force=True)
        assert not settings.enabled()
        with patch.object(settings, '_fetch', AsyncMock(return_value=False)):
            await settings.refresh(force=True)
        with patch.object(settings, '_fetch', AsyncMock(side_effect=httpx.ConnectError('unreachable'))):
            await settings.refresh(force=True)
        assert not settings.enabled()
    asyncio.run(work())


def test_internal_settings_request_uses_fixed_path_and_internal_secret(monkeypatch):
    import httpx
    monkeypatch.setenv('INTERNAL_API_SECRET', 'synthetic-internal-secret')
    seen = []
    def transport(request):
        seen.append(request)
        return httpx.Response(200, json={'skill_agent_enabled': False})
    async def work():
        client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        with patch('skills.settings.httpx.AsyncClient', return_value=client):
            assert await settings._fetch() is False
    asyncio.run(work())
    assert seen[0].url.path == '/internal/agent-config'
    assert seen[0].headers['x-internal-secret'] == 'synthetic-internal-secret'


def test_inventory_matches_real_registries_and_specialist_scopes():
    from claims_specialist import CLAIMS_TOOLS
    from track_specialists import SCOPES
    result = build(['SuperAdmin', 'Admin', 'Viewer', 'Finance', 'Medical Underwriter'])
    assert len(result['agents']) == 2
    assert len(result['subagents']) == 8
    assert len(result['skills']) == 23
    assert {tool['id'] for tool in result['tools']} == {tool.name for tool in ALL_TOOLS}
    subagents = {agent['id']: agent for agent in result['subagents']}
    assert set(subagents['claims']['tools']) == CLAIMS_TOOLS
    assert set(subagents['medical_underwriting']['tools']) == SCOPES['medical_underwriting']
    tools = {tool['id']: tool for tool in result['tools']}
    assert tools['configure_platform_model']['roles'] == ['SuperAdmin']
    assert tools['disburse_claim_settlement']['roles'] == ['Finance']
    assert all('schema' in tool for tool in result['tools'])


def test_inventory_uses_saved_flag_without_hiding_existing_agents(monkeypatch):
    monkeypatch.setattr(settings, '_value', False)
    result = build(['SuperAdmin'])
    assert not result['skill_agent_enabled']
    assert len(result['subagents']) == 8 and len(result['skills']) == 23
    assert not next(t for t in result['tools'] if t['id'] == 'search_capabilities')['available']


@pytest.mark.parametrize('role', ['Admin', 'Viewer', 'Agent', 'Medical Underwriter', 'Finance'])
def test_inventory_endpoint_refuses_non_superadmin_before_loading_data(role):
    from routers.chat import platform_inventory
    async def work():
        with patch('routers.chat._caller', AsyncMock(return_value={'role_name': role})), patch('skills.inventory.build') as inventory:
            with pytest.raises(HTTPException) as error:
                await platform_inventory('', 'Bearer synthetic-token')
        assert error.value.status_code == 403
        inventory.assert_not_called()
    asyncio.run(work())
