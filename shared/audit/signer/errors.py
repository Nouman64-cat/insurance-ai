class SignerError(Exception):
    """A refusal or failure with a stable machine-readable code (never contains key material)."""

    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
