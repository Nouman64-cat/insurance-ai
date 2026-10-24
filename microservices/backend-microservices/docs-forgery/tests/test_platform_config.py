"""Runtime policy enforcement and actual token/compute metering, without paid calls."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from fastapi import HTTPException
from fastapi.testclient import TestClient
import main
import platform_config as platform
from docforensics import Analysis
from docforensics.report import Report


def config(**changes):
    settings = dict(enabled=True, content_enabled=True, pixel_enabled=True, visual_enabled=True,
                    provider='gemini', gemini_model='test-model', groq_model='test-groq', max_pages=4,
                    pixel_timeout_seconds=90, threshold_mode='manual', t95=.1, tmax=.2,
                    gemini_input_per_million=2, gemini_output_per_million=4, pixel_per_hour=1)
    return {'settings': settings | changes, 'updated_at':'2026-10-24T00:00:00'}


class PlatformTests(unittest.TestCase):
    def setUp(self):
        auth=patch.dict(os.environ,{"INTERNAL_API_SECRET":"test-internal"});auth.start();self.addCleanup(auth.stop)

    def test_disabled_options_and_page_limits_are_enforced(self):
        client = TestClient(main.app, headers={"X-Internal-Secret":"test-internal"})
        for policy, options, status in [(dict(enabled=False),{},503), (dict(content_enabled=False),{'layer2':'true'},403),
                                       (dict(pixel_enabled=False),{'layer3':'true'},403),
                                       (dict(visual_enabled=False),{'visual':'true','layer2':'true'},403),
                                       (dict(max_pages=1),{'max_pages':'2'},422),
                                       (dict(provider='groq'),{'layer2':'true','provider':'gemini'},422)]:
            with self.subTest(policy=policy), patch.object(main,'configuration',return_value=config(**policy)), patch.object(main,'analyze_document') as analyze:
                response = client.post('/analyze',files={'file':('test.pdf',b'%PDF-123')},data=options)
                self.assertEqual(response.status_code,status,response.text)
                analyze.assert_not_called()

    def test_saved_model_timeout_and_thresholds_reach_engine(self):
        result = Analysis(Report('test.pdf','pdf','hash',10))
        with patch.object(main,'analyze_document',return_value=result) as engine, patch.object(main,'make_client') as client:
            main._analyze(b'%PDF-123','test.pdf',None,True,main.Provider.gemini,False,2,True,config())
        client.assert_called_once_with('gemini',model='test-model')
        options = engine.call_args.kwargs['layer3_options']
        self.assertEqual(options.timeout_s,90)
        self.assertEqual(options.thresholds['tmax'],.2)
        self.assertEqual(options.thresholds['scope'],'superadmin_manual')
        summary=main.threshold_summary(options.thresholds)
        self.assertEqual(summary['n_calibration'],0)
        self.assertEqual(summary['n_validation'],0)
        self.assertIsNone(summary['fpr_at_tmax'])

    def test_platform_outage_fails_closed_after_cache_expiry(self):
        with patch.dict(os.environ,{'TENANT_SERVICE_URL':'http://tenant.invalid'}), patch.object(platform,'_cache',None), patch.object(platform,'_expires',0), patch.object(platform.httpx,'get',side_effect=OSError('offline')):
            with self.assertRaises(HTTPException) as exc: platform.configuration()
            self.assertEqual(exc.exception.status_code,503)

    def test_actual_usage_and_rates_are_recorded_with_stable_retry_id(self):
        analysis=SimpleNamespace(performance={'pixel_pages_scored':2,'pixel_inference_seconds':7.5,'complete':False})
        client=SimpleNamespace(calls=[SimpleNamespace(model='test-model',status='ok',tokens_in=100,tokens_out=20)])
        response=Mock(); response.raise_for_status.return_value=None
        with patch.dict(os.environ,{'TENANT_SERVICE_URL':'http://tenant.invalid'}), patch.object(platform.httpx,'post',side_effect=[OSError('temporary'),response]) as post:
            platform.record_usage(analysis,client,config())
        first,second=[call.kwargs['json'] for call in post.call_args_list]
        self.assertEqual(first['id'],second['id'])
        self.assertEqual(first['models'][0]['input_tokens'],100)
        self.assertEqual(first['models'][0]['input_rate'],2)
        self.assertEqual(first['pixel_seconds'],7.5)
        self.assertFalse(first['complete'])
        self.assertNotIn('file',first)
