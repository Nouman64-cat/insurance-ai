import os
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit,unquote
from database_settings import runtime_dsn

class DatabaseSettingsTests(unittest.TestCase):
    def test_private_password_is_encoded_and_shared_url_has_no_password(self):
        address='postgresql://docs_forgery_app@localhost:5432/insurance-ai'
        password='synthetic:/@?#% password'
        with patch.dict(os.environ,{'DOCS_FORGERY_DATABASE_URL':address,'DOCS_FORGERY_DB_PASSWORD':password},clear=True):
            value=urlsplit(runtime_dsn())
        self.assertIsNone(urlsplit(address).password)
        self.assertEqual(unquote(value.password),password)
        self.assertEqual(value.path,'/insurance-ai')
        self.assertEqual(value.username,'docs_forgery_app')

    def test_existing_full_url_keeps_its_credentials(self):
        with patch.dict(os.environ,{'DOCS_FORGERY_DATABASE_URL':'postgresql+asyncpg://test:existing@localhost/db','DOCS_FORGERY_DB_PASSWORD':'different'},clear=True):
            self.assertEqual(runtime_dsn(),'postgresql://test:existing@localhost/db')

    def test_missing_private_password_fails_without_exposing_credentials(self):
        with patch.dict(os.environ,{'DOCS_FORGERY_DATABASE_URL':'postgresql://app@localhost/db'},clear=True):
            with self.assertRaisesRegex(ValueError,'private document storage password'):
                runtime_dsn()
