"""Entry point of the isolated audit checkpoint signer. All logic is in shared/audit/signer (so it can be tested in-process)."""
import logging

from shared.audit.signer.app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
app = create_app()
