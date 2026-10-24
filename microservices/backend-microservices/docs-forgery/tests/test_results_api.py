import os
import unittest
from unittest.mock import patch,AsyncMock
from uuid import uuid4
from fastapi import HTTPException
from fastapi.testclient import TestClient
import main
from tests.test_layer2 import text_pdf,INVOICE_LINES

class ResultApiTests(unittest.TestCase):
    def setUp(self):
        auth=patch.dict(os.environ,{'INTERNAL_API_SECRET':'test-internal'});auth.start();self.addCleanup(auth.stop)
        self.tenant,self.actor,self.result=uuid4(),uuid4(),uuid4()
        self.client=TestClient(main.app,headers={'X-Internal-Secret':'test-internal','X-Tenant-Id':str(self.tenant),'X-Actor-Id':str(self.actor)})

    def test_reserves_then_persists_full_report(self):
        record={'id':self.result}
        with patch.object(main.result_store,'create',new=AsyncMock(return_value=record)) as create,patch.object(main.result_store,'finish',new=AsyncMock(side_effect=lambda t,i,**k: {'id':i,'report':k['report']})) as finish:
            response=self.client.post('/results/analyze',files={'file':('test.pdf',text_pdf(INVOICE_LINES))},data={'max_pages':'1'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(create.call_args.args[:2],(self.tenant,self.actor))
        self.assertEqual(response.json()['report']['verdict'],'no_evidence')
        self.assertIn('performance',finish.call_args.kwargs['report'])

    def test_failed_policy_is_saved(self):
        with patch.object(main.result_store,'create',new=AsyncMock(return_value={'id':self.result})),patch.object(main.result_store,'finish',new=AsyncMock()) as finish,patch.object(main,'configuration',side_effect=HTTPException(503,'Policy unavailable')):
            response=self.client.post('/results/analyze',files={'file':('test.pdf',text_pdf(INVOICE_LINES))})
        self.assertEqual(response.status_code,503)
        self.assertEqual(finish.call_args.kwargs['error'],'Policy unavailable')

    def test_result_scope_and_required_identity(self):
        with patch.object(main.result_store,'get',new=AsyncMock(side_effect=HTTPException(404,'Analysis not found'))) as get:
            self.assertEqual(self.client.get('/results/'+str(self.result)).status_code,404)
            get.assert_awaited_once_with(self.tenant,self.result)
        client=TestClient(main.app,headers={'X-Internal-Secret':'test-internal'})
        self.assertEqual(client.get('/results').status_code,422)
        self.assertEqual(TestClient(main.app).get('/results').status_code,401)
