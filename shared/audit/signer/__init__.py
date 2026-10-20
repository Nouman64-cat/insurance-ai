"""The checkpoint signer: the only component that ever holds an Ed25519 private key.

It runs as its own process/container (microservices/backend-microservices/audit-signer). The code lives here, under
shared/, so the Audit Service's tests can exercise the real signer in-process; production containers other than the
signer have no access to the key volume, the passphrase volume or the signer's state.
"""
