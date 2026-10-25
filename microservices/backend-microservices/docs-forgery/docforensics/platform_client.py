"""Per-analysis clients from the platform's encrypted LLM task configuration.

Credentials and model names are explicit; this path never reads provider env vars.
No automatic cross-provider fallback: consent names exactly one provider.
"""
import base64

import httpx

from .gemini_client import (
    AuthError, BadRequest, BadResponse, Blocked, ConfigError, GeminiClient,
    RateLimited, Reply, ServiceError, Settings, Timeout, _sdk_transport,
)


def _failure(status):
    # Do not copy remote exception text/URLs into reports: they may contain keys.
    error = AuthError if status in (401, 403) else RateLimited if status == 429 else ServiceError if status >= 500 else BadRequest
    return error(f"Configured model request failed (HTTP {status}). Check the model, key and provider quota in LLM Configuration.")


class PlatformTransport:
    def __init__(self, provider, key):
        self.provider, self._key = provider, key

    def __call__(self, request, settings):
        if self.provider == "gemini":
            try:
                return _sdk_transport(request, settings, api_key=self._key)
            except (ConfigError, AuthError, BadRequest, Blocked, RateLimited, ServiceError, Timeout):
                raise
            except Exception as exc:
                status = getattr(exc, "code", None)
                raise _failure(status if isinstance(status, int) else 502) from None

        images = [(base64.b64encode(data).decode("ascii"), mime) for data, mime in request.images]
        if self.provider == "openai":
            url = "https://api.openai.com/v1/chat/completions"
            headers = {"Authorization": f"Bearer {self._key}"}
            content = [{"type": "text", "text": request.prompt}]
            content += [{"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}} for data, mime in images]
            body = {"model": settings.model, "messages": [{"role": "user", "content": content}],
                    "max_completion_tokens": settings.max_output_tokens}
            if request.json_mode:
                body["response_format"] = {"type": "json_object"}
        else:
            url = "https://api.anthropic.com/v1/messages"
            headers = {"x-api-key": self._key, "anthropic-version": "2023-06-01"}
            content = [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}} for data, mime in images]
            content.append({"type": "text", "text": request.prompt})
            body = {"model": settings.model, "max_tokens": settings.max_output_tokens,
                    "messages": [{"role": "user", "content": content}]}
        try:
            with httpx.Client(timeout=settings.timeout_s) as client:
                response = client.post(url, headers=headers, json=body)
        except httpx.TimeoutException:
            raise Timeout("Configured model request timed out.") from None
        except httpx.TransportError:
            raise ServiceError("Configured model provider is unreachable.") from None
        if response.status_code != 200:
            raise _failure(response.status_code)
        try:
            data = response.json()
            usage = data.get("usage") or {}
            if self.provider == "openai":
                choice = data["choices"][0]
                finish = {"stop": "STOP", "length": "MAX_TOKENS", "content_filter": "SAFETY"}.get(choice.get("finish_reason"), "UNKNOWN")
                return Reply(text=choice["message"].get("content") or "", finish_reason=finish,
                             tokens_in=usage.get("prompt_tokens"), tokens_out=usage.get("completion_tokens"))
            # Cache reads/writes are separate from uncached input in Anthropic usage.
            # Aggregate input at the configured input rate; this is an estimate, not an invoice.
            tokens_in = usage.get("input_tokens")
            if tokens_in is not None:
                tokens_in += (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
            finish = {"end_turn": "STOP", "stop_sequence": "STOP", "max_tokens": "MAX_TOKENS", "refusal": "SAFETY"}.get(data.get("stop_reason"), "UNKNOWN")
            return Reply(text="".join(b.get("text", "") for b in data["content"] if b.get("type") == "text"),
                         finish_reason=finish, tokens_in=tokens_in, tokens_out=usage.get("output_tokens"))
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise BadResponse("Configured model returned an unreadable response.") from None


def make_platform_client(config):
    if not config or config.get("provider") not in {"gemini", "openai", "anthropic"} or not config.get("api_key") or not config.get("model"):
        raise ConfigError("Configure a Document Forgery Detection model and provider key in SuperAdmin LLM Configuration.")
    # Construct defaults directly: do not load Settings.from_env or mutate os.environ.
    client = GeminiClient(Settings(model=config["model"]), transport=PlatformTransport(config["provider"], config["api_key"]))
    return client
