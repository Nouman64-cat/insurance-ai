import os
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import main

class InternalAuthenticationTests(unittest.TestCase):
    def test_anonymous_engine_requests_cannot_analyze_or_read_metrics(self):
        client=TestClient(main.app)
        with patch.dict(os.environ,{"INTERNAL_API_SECRET":"test-internal"}):
            for path,method in (("/analyze","POST"),("/performance","GET"),("/metrics","GET")):
                response=client.request(method,path,**({"files":{"file":("x.pdf",b"%PDF-123")}} if method=="POST" else {}))
                self.assertEqual(response.status_code,401,response.text)
                self.assertEqual(client.request(method,path,headers={"X-Internal-Secret":"wrong"}).status_code,401)
            self.assertEqual(client.get("/health").status_code,200)
        with patch.dict(os.environ,{"INTERNAL_API_SECRET":""}):
            self.assertEqual(client.get("/performance").status_code,503)
