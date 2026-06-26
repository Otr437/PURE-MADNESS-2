"""
Model Router — Python
Unified interface over multiple frontier model providers using their official SDKs:

  - Anthropic Claude   → `anthropic` SDK, https://api.anthropic.com
  - DeepSeek           → `anthropic` SDK pointed at DeepSeek's Anthropic-compatible
                          endpoint (https://api.deepseek.com/anthropic), OR
                          `openai` SDK pointed at DeepSeek's OpenAI-compatible
                          endpoint (https://api.deepseek.com)
  - OpenAI GPT         → `openai` SDK, https://api.openai.com

pip install anthropic==0.50.0 openai==2.30.0

Configuration (env vars):
  MODEL_PROVIDER   = "anthropic" | "deepseek" | "deepseek-openai" | "openai"   (default: "anthropic")
  MODEL_NAME       = provider-specific model id (sane defaults below if unset)
  ANTHROPIC_API_KEY
  DEEPSEEK_API_KEY
  OPENAI_API_KEY

Usage:
    from model_router import ModelRouter

    router = ModelRouter()  # reads MODEL_PROVIDER / MODEL_NAME from env
    response = router.create(
        messages=[{"role": "user", "content": "Hello"}],
        tools=TOOLS,
        system="You are a helpful assistant.",
    )
    # response.content -> list[TextBlock | ToolUseBlock]
    # response.stop_reason -> "end_turn" | "tool_use"
    # response.usage -> Usage(input_tokens=.., output_tokens=..)
"""

import json
import os
from dataclasses import dataclass, field
from typing import Any, Literal

import anthropic
import openai


# ── Unified response types ───────────────────────────────────────────────────
@dataclass
class TextBlock:
    type: Literal["text"] = field(default="text", init=False)
    text: str = ""


@dataclass
class ToolUseBlock:
    type: Literal["tool_use"] = field(default="tool_use", init=False)
    id: str = ""
    name: str = ""
    input: dict = field(default_factory=dict)


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    def model_dump(self) -> dict:
        return {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens}


@dataclass
class UnifiedResponse:
    content:     list                     # list[TextBlock | ToolUseBlock]
    stop_reason: str                      # "end_turn" | "tool_use"
    usage:       Usage
    raw:         Any = None               # original SDK response, for debugging

    def to_assistant_message(self) -> dict:
        """Convert to an Anthropic-style assistant message dict for the messages array."""
        blocks = []
        for b in self.content:
            if isinstance(b, TextBlock):
                blocks.append({"type": "text", "text": b.text})
            elif isinstance(b, ToolUseBlock):
                blocks.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
        return {"role": "assistant", "content": blocks}


# ── Default model names per provider ──────────────────────────────────────────
DEFAULT_MODELS = {
    "anthropic":       "claude-opus-4-6",
    "deepseek":        "deepseek-v4-pro",        # via Anthropic-compatible endpoint
    "deepseek-openai": "deepseek-v4-pro",        # via OpenAI-compatible endpoint
    "openai":          "gpt-5.5",
}

DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_OPENAI_BASE_URL    = "https://api.deepseek.com"


# ── Tool schema conversion (Anthropic input_schema → OpenAI function format) ──
def _to_openai_tools(tools: list[dict] | None) -> list[dict] | openai.NotGiven:
    if not tools:
        return openai.NOT_GIVEN
    converted = []
    for t in tools:
        converted.append({
            "type": "function",
            "function": {
                "name":        t["name"],
                "description": t.get("description", ""),
                "parameters":  t.get("input_schema", {"type": "object", "properties": {}}),
            },
        })
    return converted


# ── Message format conversion (Anthropic-style → OpenAI-style) ────────────────
def _to_openai_messages(messages: list[dict], system: str | None) -> list[dict]:
    """
    Convert Anthropic-style messages (content can be a string or a list of blocks
    including tool_use / tool_result) into OpenAI chat-completions messages.
    """
    out: list[dict] = []
    if system:
        out.append({"role": "system", "content": system})

    for msg in messages:
        role = msg["role"]
        content = msg["content"]

        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue

        # content is a list of blocks
        if role == "assistant":
            text_parts = []
            tool_calls = []
            for block in content:
                btype = block["type"] if isinstance(block, dict) else block.type
                if btype == "text":
                    text_parts.append(block["text"] if isinstance(block, dict) else block.text)
                elif btype == "tool_use":
                    bid    = block["id"] if isinstance(block, dict) else block.id
                    bname  = block["name"] if isinstance(block, dict) else block.name
                    binput = block["input"] if isinstance(block, dict) else block.input
                    tool_calls.append({
                        "id":   bid,
                        "type": "function",
                        "function": {
                            "name":      bname,
                            "arguments": json.dumps(binput),
                        },
                    })
            entry: dict = {"role": "assistant", "content": "\n".join(text_parts) or None}
            if tool_calls:
                entry["tool_calls"] = tool_calls
            out.append(entry)

        elif role == "user":
            # user content list may contain tool_result blocks
            tool_results = [b for b in content if (b.get("type") if isinstance(b, dict) else b.type) == "tool_result"]
            if tool_results:
                for tr in tool_results:
                    tool_use_id = tr["tool_use_id"] if isinstance(tr, dict) else tr.tool_use_id
                    tr_content  = tr["content"] if isinstance(tr, dict) else tr.content
                    out.append({
                        "role": "tool",
                        "tool_call_id": tool_use_id,
                        "content": tr_content if isinstance(tr_content, str) else json.dumps(tr_content),
                    })
            else:
                # plain text blocks
                text_parts = []
                for block in content:
                    btype = block["type"] if isinstance(block, dict) else block.type
                    if btype == "text":
                        text_parts.append(block["text"] if isinstance(block, dict) else block.text)
                out.append({"role": "user", "content": "\n".join(text_parts)})

    return out


# ── Provider clients ───────────────────────────────────────────────────────────
class ModelRouter:
    """
    Provider-agnostic chat-completion client.

    Reads `MODEL_PROVIDER` and `MODEL_NAME` from the environment unless
    explicit `provider` / `model` arguments are supplied.
    """

    def __init__(self, provider: str | None = None, model: str | None = None):
        self.provider = (provider or os.environ.get("MODEL_PROVIDER", "anthropic")).lower()
        self.model    = model or os.environ.get("MODEL_NAME") or DEFAULT_MODELS.get(self.provider)

        if self.provider not in DEFAULT_MODELS:
            raise ValueError(
                f"Unknown MODEL_PROVIDER '{self.provider}'. "
                f"Valid options: {list(DEFAULT_MODELS)}"
            )

        if self.provider == "anthropic":
            self._client = anthropic.Anthropic(
                api_key=os.environ["ANTHROPIC_API_KEY"], timeout=60.0, max_retries=0,
            )
            self._kind = "anthropic"

        elif self.provider == "deepseek":
            # DeepSeek's Anthropic-compatible endpoint — same SDK, different base_url + key
            self._client = anthropic.Anthropic(
                api_key=os.environ["DEEPSEEK_API_KEY"],
                base_url=DEEPSEEK_ANTHROPIC_BASE_URL,
                timeout=60.0,
                max_retries=0,
            )
            self._kind = "anthropic"

        elif self.provider == "deepseek-openai":
            self._client = openai.OpenAI(
                api_key=os.environ["DEEPSEEK_API_KEY"],
                base_url=DEEPSEEK_OPENAI_BASE_URL,
                timeout=60.0,
                max_retries=0,
            )
            self._kind = "openai"

        elif self.provider == "openai":
            self._client = openai.OpenAI(
                api_key=os.environ["OPENAI_API_KEY"], timeout=60.0, max_retries=0,
            )
            self._kind = "openai"

    # ── Unified create() ──────────────────────────────────────────────────────
    def create(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        system: str | None = None,
        max_tokens: int = 4096,
    ) -> UnifiedResponse:
        if self._kind == "anthropic":
            return self._create_anthropic(messages, tools, system, max_tokens)
        return self._create_openai(messages, tools, system, max_tokens)

    # ── Anthropic / DeepSeek (Anthropic-compatible) ───────────────────────────
    def _create_anthropic(
        self, messages: list[dict], tools: list[dict] | None, system: str | None, max_tokens: int
    ) -> UnifiedResponse:
        kwargs: dict[str, Any] = dict(
            model=self.model,
            max_tokens=max_tokens,
            messages=messages,
        )
        if tools:
            kwargs["tools"] = tools
        if system:
            kwargs["system"] = system

        resp = self._client.messages.create(**kwargs)

        content = []
        for block in resp.content:
            if block.type == "text":
                content.append(TextBlock(text=block.text))
            elif block.type == "tool_use":
                content.append(ToolUseBlock(id=block.id, name=block.name, input=block.input))

        return UnifiedResponse(
            content=content,
            stop_reason=resp.stop_reason,
            usage=Usage(
                input_tokens=resp.usage.input_tokens,
                output_tokens=resp.usage.output_tokens,
            ),
            raw=resp,
        )

    # ── OpenAI / DeepSeek (OpenAI-compatible) ─────────────────────────────────
    def _create_openai(
        self, messages: list[dict], tools: list[dict] | None, system: str | None, max_tokens: int
    ) -> UnifiedResponse:
        oa_messages = _to_openai_messages(messages, system)
        oa_tools    = _to_openai_tools(tools)

        kwargs: dict[str, Any] = dict(
            model=self.model,
            messages=oa_messages,
            max_tokens=max_tokens,
        )
        if oa_tools is not openai.NOT_GIVEN:
            kwargs["tools"] = oa_tools
            kwargs["tool_choice"] = "auto"

        resp = self._client.chat.completions.create(**kwargs)
        choice = resp.choices[0]
        msg = choice.message

        content: list = []
        if msg.content:
            content.append(TextBlock(text=msg.content))

        stop_reason = "end_turn"
        if msg.tool_calls:
            stop_reason = "tool_use"
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}
                content.append(ToolUseBlock(id=tc.id, name=tc.function.name, input=args))

        usage = resp.usage
        return UnifiedResponse(
            content=content,
            stop_reason=stop_reason,
            usage=Usage(
                input_tokens=usage.prompt_tokens if usage else 0,
                output_tokens=usage.completion_tokens if usage else 0,
            ),
            raw=resp,
        )


# ── Tool-result message helper (provider-agnostic) ────────────────────────────
def make_tool_result_message(tool_use_id: str, content: str, is_error: bool = False) -> dict:
    """
    Build a 'user' message containing a tool_result block, in Anthropic format.
    `_to_openai_messages` converts this to the OpenAI 'tool' role automatically.
    """
    block = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}
    if is_error:
        block["is_error"] = True
    return {"role": "user", "content": [block]}


# ── CLI demo ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    provider = sys.argv[1] if len(sys.argv) > 1 else None
    prompt   = " ".join(sys.argv[2:]) or "Say hello in exactly five words."

    router = ModelRouter(provider=provider)
    print(f"[model_router] provider={router.provider} model={router.model}\n")

    response = router.create(
        messages=[{"role": "user", "content": prompt}],
        system="You are a concise assistant.",
    )

    for block in response.content:
        if isinstance(block, TextBlock):
            print(block.text)
        elif isinstance(block, ToolUseBlock):
            print(f"[tool_use] {block.name}({json.dumps(block.input)})")

    print(f"\nstop_reason={response.stop_reason} usage={response.usage.model_dump()}")
