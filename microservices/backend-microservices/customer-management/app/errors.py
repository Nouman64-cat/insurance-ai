"""Structured API errors: {"error": {"code", "message", "details"}} with a stable machine-readable code.

The portal translates by `code`; `message` is an English fallback. Messages never contain internals (SQL, paths, upstream
bodies) — upstream failures are logged and reported as DOMAIN_UNAVAILABLE."""
import logging
from typing import Any, Optional

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger("customer-management")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Optional[dict[str, Any]] = None, headers: Optional[dict] = None):
        super().__init__(message)
        self.status, self.code, self.message, self.details, self.headers = status, code, message, details or {}, headers


def unauthenticated(message: str = "Please sign in again") -> ApiError:
    return ApiError(401, "UNAUTHENTICATED", message)


def forbidden(message: str = "You do not have access to this", code: str = "FORBIDDEN") -> ApiError:
    return ApiError(403, code, message)


def not_found(what: str = "Record") -> ApiError:
    # Also used when something exists but belongs to someone else, so its existence is not revealed.
    return ApiError(404, "NOT_FOUND", f"{what} not found")


def validation(message: str, **details: Any) -> ApiError:
    return ApiError(422, "VALIDATION", message, details)


def unavailable(message: str = "This service is temporarily unavailable. Please try again shortly.") -> ApiError:
    return ApiError(503, "DOMAIN_UNAVAILABLE", message)


async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, headers=exc.headers,
                        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}})


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    problems = [{"field": ".".join(str(p) for p in err.get("loc", [])[1:]), "message": err.get("msg", "")} for err in exc.errors()]
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION", "message": "Some fields are invalid",
                                                            "details": {"fields": problems}}})


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    log.error("unhandled error on %s %s: %s", request.method, request.url.path, type(exc).__name__, exc_info=exc)
    return JSONResponse(status_code=500, content={"error": {"code": "INTERNAL", "message": "Something went wrong. Please try again.", "details": {}}})
