"""Structured API errors: {"error": {"code", "message", "details"}} with a stable machine-readable code."""
from typing import Any, Optional

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Optional[dict[str, Any]] = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details or {}


def unauthenticated(message: str = "Sign in again") -> ApiError:
    return ApiError(401, "UNAUTHENTICATED", message)


def forbidden(message: str, code: str = "FORBIDDEN", **details: Any) -> ApiError:
    return ApiError(403, code, message, details)


def not_found(what: str = "Request") -> ApiError:
    # Also used when a resource exists but the caller may not see it (another tenant, someone else's request),
    # so its existence isn't revealed.
    return ApiError(404, "NOT_FOUND", f"{what} not found")


def invalid_transition(action: str, status: str) -> ApiError:
    return ApiError(409, "INVALID_TRANSITION", f"'{action}' isn't allowed while the request is {status}", {"action": action, "status": status})


def stale_version(current: int) -> ApiError:
    return ApiError(409, "STALE_VERSION", "The request changed since you loaded it. Reload and try again.", {"current_version": current})


def stale_revision(reviewed: int, current: Optional[int]) -> ApiError:
    return ApiError(409, "STALE_REVISION", "The proposal changed since you reviewed it. Review the current revision.",
                    {"reviewed_revision": reviewed, "current_revision": current})


def validation(message: str, **details: Any) -> ApiError:
    return ApiError(422, "VALIDATION", message, details)


def routing_failed(message: str, **details: Any) -> ApiError:
    return ApiError(422, "ROUTING_FAILED", message, details)


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}})


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    problems = [{"field": ".".join(str(p) for p in err.get("loc", [])[1:]), "message": err.get("msg", "")} for err in exc.errors()]
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION", "message": "Some fields are invalid", "details": {"fields": problems}}})
