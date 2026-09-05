class AgentKitError(Exception):
    """The transport failed. Nothing was decided; retrying is safe."""

    def __init__(self, message: str, status=None, reason_code=None, body=None):
        super().__init__(message)
        self.status = status
        self.reason_code = reason_code
        self.body = body


class AgentKitRefusal(AgentKitError):
    """The kernel refused. `reason_code` is stable and safe to branch on."""

    def __init__(self, reason_code: str, message: str, status=None, body=None):
        super().__init__(message, status=status, reason_code=reason_code, body=body)
