"""Offline startup checks; synthetic license values never reach a real AIStor server."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT=Path(__file__).with_name('start.sh')

class StartupTests(unittest.TestCase):
    def run_wrapper(self,extra):
        with tempfile.TemporaryDirectory() as folder:
            mock=Path(folder)/'minio'
            mock.write_text('''#!/usr/bin/env python3
import os,sys,json,stat
from pathlib import Path
p=Path(sys.argv[sys.argv.index('--license')+1])
print(json.dumps({'license_matches':p.read_text().strip() == os.environ['EXPECTED_LICENSE'],'mode':stat.S_IMODE(p.stat().st_mode),'raw_key_removed':'AISTOR_LICENSE_KEY' not in os.environ}))
if os.environ.get('REMOVE_TEMP') == 'yes':p.unlink()
''')
            mock.chmod(0o755)
            env={'PATH':folder+os.pathsep+os.environ['PATH'],'MINIO_ROOT_USER':'synthetic-root','MINIO_ROOT_PASSWORD':'synthetic-test-password','MINIO_LICENSE':str(Path(folder)/'missing'),**extra}
            return subprocess.run(['/bin/sh',str(SCRIPT)],env=env,text=True,capture_output=True)

    def test_environment_key_is_materialized_privately_without_logging_it(self):
        key='SYNTHETIC-LICENSE-FOR-TESTING-ONLY'
        result=self.run_wrapper({'AISTOR_LICENSE_KEY':key,'EXPECTED_LICENSE':key,'REMOVE_TEMP':'yes'})
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout),{'license_matches':True,'mode':0o600,'raw_key_removed':True})
        self.assertNotIn(key,result.stdout+result.stderr)

    def test_existing_license_file_remains_supported(self):
        with tempfile.NamedTemporaryFile(mode='w') as license:
            license.write('SYNTHETIC-FILE-LICENSE');license.flush()
            result=self.run_wrapper({'MINIO_LICENSE':license.name,'EXPECTED_LICENSE':'SYNTHETIC-FILE-LICENSE'})
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertTrue(json.loads(result.stdout)['license_matches'])

    def test_missing_license_or_weak_credentials_stop_before_server(self):
        result=self.run_wrapper({})
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Set AISTOR_LICENSE_KEY',result.stderr)
        result=self.run_wrapper({'MINIO_ROOT_PASSWORD':''})
        self.assertNotEqual(result.returncode,0)
        self.assertIn('at least 16',result.stderr)

if __name__=='__main__':unittest.main()
