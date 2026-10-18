import pytest
import claim_underwriting as module


@pytest.mark.parametrize('track', ['medical', 'financial'])
def test_recommendation_is_advisory_and_scoped(monkeypatch, track):
    captured = {}
    def invoke(prompt, schema, inputs, state, node):
        captured.update(inputs=inputs, state=state, prompt=prompt)
        return module.ClaimRecommendation(recommendation='Decline', summary='Review exclusion evidence',
            findings=[module.ClaimFinding(requirement='Exclusions', observation='Clause needs review', evidence=['Policy clause 2'])],
            missing_evidence=[])
    monkeypatch.setattr(module, '_invoke_structured', invoke)
    result = module.recommend_claim_review(track, {'claim': {'claim_number': 'CLM-1'}}, 'tenant-1')
    assert result['advisory'] is True and result['scope'] == 'claim' and result['track'] == track
    assert captured['inputs']['track'] == track and 'CLM-1' in captured['inputs']['evidence']
    assert captured['state']['tenant_id'] == 'tenant-1'
    assert 'never a binding' in captured['prompt'].format_messages(track=track, evidence='{}')[0].content


def test_provider_failure_never_invents_recommendation(monkeypatch):
    monkeypatch.setattr(module, '_invoke_structured', lambda *a: None)
    with pytest.raises(RuntimeError, match='No review or decision'):
        module.recommend_claim_review('medical', {}, 'tenant-1')
