"""Unavailable creation must stop before intake, HTTP calls, or demo generation."""
import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import AIMessage

import graph
import group_tools
import tool_executor
from customer_availability import COMING_SOON_TOOLS, coming_soon_result


def assert_unavailable(result):
    assert result['success'] is False
    assert result['error_code'] == 'coming_soon'
    assert result['retryable'] is False
    assert 'coming soon' in result['message']
    assert 'Individual customer creation is available now' in result['message']
    assert result['quick_actions'] == [{'label': 'Add individual customer', 'actionType': 'submit',
                                        'payload': 'Add a new individual customer'}]
    assert 'last_action' not in result and 'proposal_journey' not in result


@pytest.mark.parametrize('name', COMING_SOON_TOOLS)
@pytest.mark.parametrize('args', [{}, {'name': 'Requested record'}, {'use_demo_data': True}])
@pytest.mark.parametrize('role,platform', [('Admin', 'web'), ('SuperAdmin', 'web'), ('Agent', 'web'), ('Agent', 'mobile')])
def test_creation_never_reaches_a_service(name, args, role, platform):
    ctx = tool_executor.ExecCtx(tenant_id='test', jwt_token='', role=role, platform=platform)
    with patch.object(tool_executor, '_shared_client', AsyncMock(side_effect=AssertionError('HTTP must not run'))) as client:
        result = asyncio.run(tool_executor.execute_tool(name, args, ctx))
    # Existing RBAC remains authoritative for roles/platforms that lack the tool.
    if result.get('error_code') != 'forbidden':
        assert_unavailable(result)
    client.assert_not_awaited()


@pytest.mark.parametrize('name', COMING_SOON_TOOLS)
def test_nested_handler_calls_cannot_bypass_availability(name):
    assert_unavailable(asyncio.run(tool_executor._HANDLERS[name]({'use_demo_data': True}, None)))


def test_direct_corporate_demo_cannot_bypass_availability():
    assert_unavailable(asyncio.run(group_tools.create_demo_corporate(None, None)))


@pytest.mark.parametrize('name', COMING_SOON_TOOLS)
def test_graph_stops_before_missing_fields_or_intake(name):
    state = {'messages': [AIMessage(content='', tool_calls=[{'name': name, 'args': {}, 'id': 'creation'}])],
             'tenant_id': 'test', 'jwt_token': '', 'user_role': 'Admin'}
    with patch.object(graph, '_ask_choice', side_effect=AssertionError('No intake for coming-soon creation')):
        command = asyncio.run(graph._permission_gate(state))
    assert_unavailable(json.loads(command.update['messages'][0].content))
    assert command.update['lead_tool'] is None
    assert command.update['lead_intake'] is False


@pytest.mark.parametrize('chosen', ['Family group', 'Corporate (Organization)'])
def test_guided_type_choice_offers_individual_instead_of_creation(chosen):
    state = {'messages': [AIMessage(content='', tool_calls=[{'name': 'resolve_customer_type', 'args': {}, 'id': 'type'}])],
             'tenant_id': 'test', 'jwt_token': '', 'user_role': 'Agent'}
    with patch.object(graph, '_ask_choice', return_value=chosen):
        command = asyncio.run(graph._permission_gate(state))
    assert_unavailable(json.loads(command.update['messages'][0].content))
    assert command.update['lead_tool'] is None


def test_individual_creation_and_existing_group_tools_are_not_disabled():
    for name in ['add_customer', 'quick_start_workflow', 'list_family_groups', 'list_organizations', 'get_group_scheme_status']:
        assert coming_soon_result(name) is None
    assert all(action['label'] not in {'Add family', 'Add corporate'} for action in tool_executor._DEFAULT_ACTIONS)
