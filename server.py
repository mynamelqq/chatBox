"""A small Anthropic Messages API proxy built with FastAPI."""

import asyncio
import base64
import json
import logging
import os
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime, timezone
from typing import Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
API_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")
MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
LOCAL_MODEL_PATH = os.getenv("VLLM_MODEL_PATH", r"F:\AAA model\Qwen3___5-9B")
LOCAL_MODEL_NAME = os.getenv("VLLM_MODEL_NAME", "Qwen3___5-9B")
MAX_TOKENS = int(os.getenv("ANTHROPIC_MAX_TOKENS", "4096"))
CONNECT_TIMEOUT = float(os.getenv("ANTHROPIC_CONNECT_TIMEOUT", "15"))
READ_TIMEOUT = float(os.getenv("ANTHROPIC_READ_TIMEOUT", "180"))
WRITE_TIMEOUT = float(os.getenv("ANTHROPIC_WRITE_TIMEOUT", "30"))
POOL_TIMEOUT = float(os.getenv("ANTHROPIC_POOL_TIMEOUT", "15"))
# Set this to a local HTTP proxy (for example Clash Verge: http://127.0.0.1:7890).
# An explicit proxy is more reliable than inheriting Windows system proxy settings.
UPSTREAM_PROXY_URL = os.getenv("UPSTREAM_PROXY_URL", "").strip() or None
MESSAGES_URL = f"{API_BASE_URL}/messages" if API_BASE_URL.endswith("/v1") else f"{API_BASE_URL}/v1/messages"
BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "chat.db"
TRANSIENT_STATUS_CODES = {429, 500, 502, 503, 504}
MAX_PROVIDER_ATTEMPTS = 3
MAX_IMAGES_PER_MESSAGE = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
ProviderFormat = Literal["anthropic", "openai"]
INITIAL_PROVIDER_FORMAT = os.getenv("CHAT_PROVIDER_FORMAT", "anthropic")

logger = logging.getLogger("uvicorn.error")


def normalize_base_url(value: str) -> str:
    """Normalize a provider base URL to its host or /v1 root."""
    url = value.strip().rstrip("/")
    for suffix in ("/chat/completions", "/messages"):
        if url.endswith(suffix):
            url = url[: -len(suffix)].rstrip("/")
    return url


def validate_images(images: list["ImageAttachment"]) -> None:
    for image in images:
        if image.media_type not in SUPPORTED_IMAGE_TYPES:
            raise HTTPException(status_code=422, detail="仅支持 JPEG、PNG、GIF 或 WebP 图片。")
        try:
            raw = base64.b64decode(image.data, validate=True)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="图片数据格式无效。") from exc
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=422, detail="单张图片不能超过 5MB。")


def serialize_user_content(text: str, images: list["ImageAttachment"]) -> str:
    if not images:
        return text
    return json.dumps(
        {"version": 1, "text": text, "images": [image.model_dump() for image in images]},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def parse_stored_content(value: str) -> tuple[str, list[dict[str, str]]]:
    try:
        decoded = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value, []
    if not isinstance(decoded, dict) or decoded.get("version") != 1:
        return value, []
    text = decoded.get("text", "")
    images = decoded.get("images", [])
    if not isinstance(text, str) or not isinstance(images, list):
        return value, []
    safe_images = [
        image for image in images
        if isinstance(image, dict)
        and image.get("media_type") in SUPPORTED_IMAGE_TYPES
        and isinstance(image.get("data"), str)
    ]
    return text, safe_images


def provider_history(rows: list[sqlite3.Row], provider_format: ProviderFormat) -> list[dict[str, object]]:
    history: list[dict[str, object]] = []
    for row in rows:
        text, images = parse_stored_content(row["content"])
        if provider_format == "anthropic":
            content: list[dict[str, object]] = []
            if text:
                content.append({"type": "text", "text": text})
            content.extend(
                {"type": "image", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}}
                for image in images
            )
        else:
            content = []
            if text:
                content.append({"type": "text", "text": text})
            content.extend(
                {"type": "image_url", "image_url": {"url": f"data:{image['media_type']};base64,{image['data']}"}}
                for image in images
            )
        history.append({"role": row["role"], "content": content if (images or provider_format == "anthropic") else text})
    return history


def anthropic_payload(model: str, history: list[dict[str, object]], thinking_level: str) -> dict[str, object]:
    payload: dict[str, object] = {"model": model, "max_tokens": MAX_TOKENS, "messages": history}
    # Claude 5 uses adaptive thinking and effort instead of a token budget.
    if model.lower().startswith("claude-") and any(
        model.lower().startswith(f"claude-{family}-5") for family in ("opus", "sonnet", "haiku", "fable", "mythos")
    ):
        payload["thinking"] = {"type": "adaptive"}
        payload["output_config"] = {"effort": thinking_level}
    elif thinking_level != "low":
        budget_ratio = {"medium": 0.55, "high": 0.9}[thinking_level]
        budget_tokens = max(1024, int(MAX_TOKENS * budget_ratio))
        payload["max_tokens"] = max(MAX_TOKENS, budget_tokens + 512)
        payload["thinking"] = {"type": "enabled", "budget_tokens": budget_tokens}
    return payload


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class ImageAttachment(BaseModel):
    media_type: str
    data: str = Field(min_length=1, max_length=MAX_IMAGE_BYTES * 4 // 3 + 16)
    name: str = Field(default="图片", max_length=240)


class ChatRequest(BaseModel):
    session_id: str
    content: str = ""
    images: list[ImageAttachment] = Field(default_factory=list, max_length=MAX_IMAGES_PER_MESSAGE)
    retry_of_message_id: int | None = Field(default=None, ge=1)


class SessionCreate(BaseModel):
    title: str = Field(default="新对话", min_length=1, max_length=80)


class SessionRename(BaseModel):
    title: str = Field(min_length=1, max_length=80)


class SessionDraft(BaseModel):
    content: str = ""
    images: list[ImageAttachment] = Field(default_factory=list, max_length=MAX_IMAGES_PER_MESSAGE)


class ChatResponse(BaseModel):
    message: Message


class SettingsUpdate(BaseModel):
    local_enabled: bool = False
    local_model_path: str = Field(default=LOCAL_MODEL_PATH, max_length=500)
    provider_format: ProviderFormat
    base_url: str = Field(min_length=1, max_length=300)
    api_key: str | None = Field(default=None, max_length=500)
    model: str = Field(min_length=1, max_length=160)
    thinking_level: Literal["low", "medium", "high"] = "medium"


class SettingsView(BaseModel):
    local_enabled: bool
    local_model_path: str
    provider_format: ProviderFormat
    base_url: str
    api_key_masked: str
    model: str
    thinking_level: Literal["low", "medium", "high"]
    active_profile_id: str


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    api_key: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=160)


class ProfileView(BaseModel):
    id: str
    name: str
    model: str
    api_key_masked: str
    active: bool


runtime_settings = {
    "local_enabled": False,
    "local_model_path": LOCAL_MODEL_PATH,
    "provider_format": INITIAL_PROVIDER_FORMAT if INITIAL_PROVIDER_FORMAT in ("anthropic", "openai") else "anthropic",
    "base_url": normalize_base_url(API_BASE_URL),
    "api_key": API_KEY,
    "model": MODEL,
    "thinking_level": "medium",
    "active_profile_id": "default",
}


app = FastAPI(title="留白 Chat API", version="0.1.0")
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def db_connection():
    DATA_DIR.mkdir(exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database() -> None:
    with db_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                draft_content TEXT NOT NULL DEFAULT '',
                title_edited INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, id);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                api_key TEXT NOT NULL,
                model TEXT NOT NULL
            );
            """
        )
        if "draft_content" not in {row["name"] for row in connection.execute("PRAGMA table_info(sessions)")}:
            connection.execute("ALTER TABLE sessions ADD COLUMN draft_content TEXT NOT NULL DEFAULT ''")
        if "title_edited" not in {row["name"] for row in connection.execute("PRAGMA table_info(sessions)")}:
            connection.execute("ALTER TABLE sessions ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0")
        defaults = {
            "local_enabled": str(runtime_settings["local_enabled"]),
            "local_model_path": runtime_settings["local_model_path"],
            "provider_format": runtime_settings["provider_format"],
            "base_url": runtime_settings["base_url"],
            "api_key": runtime_settings["api_key"],
            "model": runtime_settings["model"],
            "thinking_level": runtime_settings["thinking_level"],
            "active_profile_id": runtime_settings["active_profile_id"],
        }
        for key, value in defaults.items():
            connection.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
        stored = connection.execute("SELECT key, value FROM settings").fetchall()
        for row in stored:
            if row["key"] in runtime_settings:
                runtime_settings[row["key"]] = row["value"] == "True" if row["key"] == "local_enabled" else row["value"]
        connection.execute(
            "INSERT OR IGNORE INTO api_profiles (id, name, api_key, model) VALUES (?, ?, ?, ?)",
            ("default", "默认分组", runtime_settings["api_key"], runtime_settings["model"]),
        )
        active = connection.execute(
            "SELECT api_key, model FROM api_profiles WHERE id = ?", (runtime_settings["active_profile_id"],)
        ).fetchone()
        if active is None:
            runtime_settings["active_profile_id"] = "default"
            active = connection.execute("SELECT api_key, model FROM api_profiles WHERE id = 'default'").fetchone()
        runtime_settings["api_key"], runtime_settings["model"] = active["api_key"], active["model"]


initialize_database()


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "provider": runtime_settings["provider_format"], "model": runtime_settings["model"]}


def masked_key(key: str) -> str:
    if not key:
        return "未设置"
    return f"{key[:4]}{'•' * min(max(len(key) - 4, 4), 12)}"


def settings_view() -> SettingsView:
    return SettingsView(
        local_enabled=bool(runtime_settings["local_enabled"]),
        local_model_path=runtime_settings["local_model_path"],
        provider_format=runtime_settings["provider_format"],
        base_url=runtime_settings["base_url"],
        api_key_masked=masked_key(runtime_settings["api_key"]),
        model=runtime_settings["model"],
        thinking_level=runtime_settings["thinking_level"],
        active_profile_id=runtime_settings["active_profile_id"],
    )


@app.get("/api/settings", response_model=SettingsView)
async def get_settings() -> SettingsView:
    return settings_view()


@app.put("/api/settings", response_model=SettingsView)
async def update_settings(request: SettingsUpdate) -> SettingsView:
    if not request.model.strip():
        raise HTTPException(status_code=422, detail="模型不能为空。")
    if request.api_key and not request.api_key.startswith("••••") and not request.api_key.strip():
        raise HTTPException(status_code=422, detail="API Key 不能为空白字符。")
    runtime_settings["local_enabled"] = request.local_enabled
    runtime_settings["local_model_path"] = request.local_model_path.strip()
    runtime_settings["provider_format"] = request.provider_format
    runtime_settings["base_url"] = normalize_base_url(request.base_url)
    runtime_settings["model"] = request.model.strip()
    runtime_settings["thinking_level"] = request.thinking_level
    if request.api_key and not request.api_key.startswith("••••"):
        runtime_settings["api_key"] = request.api_key.strip()
    with db_connection() as connection:
        connection.execute(
            "UPDATE api_profiles SET api_key = ?, model = ? WHERE id = ?",
            (runtime_settings["api_key"], runtime_settings["model"], runtime_settings["active_profile_id"]),
        )
        for key in ("local_enabled", "local_model_path", "provider_format", "base_url", "api_key", "model", "thinking_level"):
            connection.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(runtime_settings[key]) if key == "local_enabled" else runtime_settings[key]),
            )
    return settings_view()


@app.get("/api/profiles", response_model=list[ProfileView])
async def list_profiles() -> list[ProfileView]:
    with db_connection() as connection:
        rows = connection.execute("SELECT id, name, api_key, model FROM api_profiles ORDER BY rowid").fetchall()
    return [ProfileView(id=row["id"], name=row["name"], model=row["model"],
                        api_key_masked=masked_key(row["api_key"]),
                        active=row["id"] == runtime_settings["active_profile_id"]) for row in rows]


@app.post("/api/profiles", response_model=ProfileView)
async def create_profile(request: ProfileCreate) -> ProfileView:
    name, api_key, model = request.name.strip(), request.api_key.strip(), request.model.strip()
    if not name or not api_key or not model:
        raise HTTPException(status_code=422, detail="分组名称、API Key 和模型均不能为空。")
    profile_id = str(uuid.uuid4())
    with db_connection() as connection:
        connection.execute(
            "INSERT INTO api_profiles (id, name, api_key, model) VALUES (?, ?, ?, ?)",
            (profile_id, name, api_key, model),
        )
    return ProfileView(id=profile_id, name=name, model=model, api_key_masked=masked_key(api_key), active=False)


@app.put("/api/profiles/{profile_id}/activate", response_model=SettingsView)
async def activate_profile(profile_id: str) -> SettingsView:
    with db_connection() as connection:
        row = connection.execute("SELECT api_key, model FROM api_profiles WHERE id = ?", (profile_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="分组不存在。")
        connection.execute(
            "INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (profile_id,),
        )
        for key in ("api_key", "model"):
            connection.execute("UPDATE settings SET value = ? WHERE key = ?", (row[key], key))
    runtime_settings["active_profile_id"] = profile_id
    runtime_settings["api_key"], runtime_settings["model"] = row["api_key"], row["model"]
    return settings_view()


@app.delete("/api/profiles/{profile_id}")
async def delete_profile(profile_id: str) -> dict[str, str]:
    if profile_id == "default":
        raise HTTPException(status_code=400, detail="默认分组不能删除。")
    with db_connection() as connection:
        cursor = connection.execute("DELETE FROM api_profiles WHERE id = ?", (profile_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="分组不存在。")
    if profile_id == runtime_settings["active_profile_id"]:
        await activate_profile("default")
    return {"status": "ok"}


@app.get("/api/sessions")
async def list_sessions() -> list[dict[str, object]]:
    with db_connection() as connection:
        rows = connection.execute(
            """
            SELECT s.id, s.title, s.created_at,
                   CASE WHEN s.draft_content <> '' THEN s.updated_at
                        ELSE COALESCE(MAX(m.created_at), s.created_at) END AS updated_at,
                   COUNT(m.id) AS message_count
            FROM sessions s
            LEFT JOIN messages m ON m.session_id = s.id
            GROUP BY s.id
            ORDER BY updated_at DESC, s.created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/sessions")
async def create_session(request: SessionCreate | None = None) -> dict[str, str]:
    session_id = str(uuid.uuid4())
    timestamp = now_iso()
    title = request.title.strip() if request else "新对话"
    with db_connection() as connection:
        connection.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (session_id, title or "新对话", timestamp, timestamp),
        )
    return {"id": session_id, "title": title or "新对话"}


@app.get("/api/sessions/{session_id}/messages")
async def session_messages(session_id: str) -> list[dict[str, object]]:
    with db_connection() as connection:
        session = connection.execute(
            "SELECT id FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=404, detail="会话不存在。")
        rows = connection.execute(
            "SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    result = []
    for row in rows:
        message = dict(row)
        message["content"], message["images"] = parse_stored_content(message["content"])
        result.append(message)
    return result


@app.patch("/api/sessions/{session_id}")
async def rename_session(session_id: str, request: SessionRename) -> dict[str, str]:
    title = request.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="标题不能为空。")
    with db_connection() as connection:
        result = connection.execute(
            "UPDATE sessions SET title = ?, title_edited = 1 WHERE id = ?",
            (title, session_id),
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="会话不存在。")
    return {"id": session_id, "title": title}


@app.get("/api/sessions/{session_id}/draft", response_model=SessionDraft)
async def get_session_draft(session_id: str) -> SessionDraft:
    with db_connection() as connection:
        row = connection.execute("SELECT draft_content FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="会话不存在。")
    content, images = parse_stored_content(row["draft_content"])
    return SessionDraft(content=content, images=images)


@app.put("/api/sessions/{session_id}/draft", response_model=SessionDraft)
async def update_session_draft(session_id: str, draft: SessionDraft) -> SessionDraft:
    validate_images(draft.images)
    stored_content = serialize_user_content(draft.content, draft.images)
    with db_connection() as connection:
        row = connection.execute(
            "SELECT title, title_edited, draft_content, (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS message_count "
            "FROM sessions WHERE id = ?", (session_id, session_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="会话不存在。")
        title = row["title"]
        if row["message_count"] == 0 and not row["title_edited"]:
            title = (draft.content.strip() or (draft.images[0].name if draft.images else "新对话"))[:32]
        if stored_content != row["draft_content"] or title != row["title"]:
            connection.execute(
                "UPDATE sessions SET draft_content = ?, title = ?, updated_at = ? WHERE id = ?",
                (stored_content, title, now_iso(), session_id),
            )
    return draft


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    with db_connection() as connection:
        result = connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="会话不存在。")
    return {"deleted": True}


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    provider_format = runtime_settings["provider_format"]
    api_key = runtime_settings["api_key"]
    base_url = normalize_base_url(runtime_settings["base_url"])
    model = runtime_settings["model"]
    thinking_level = runtime_settings["thinking_level"]
    is_local = bool(runtime_settings["local_enabled"])
    if is_local:
        provider_format = "openai"
        base_url = "http://127.0.0.1:8001/v1"
        model = LOCAL_MODEL_NAME
    if not api_key and not runtime_settings["local_enabled"]:
        raise HTTPException(
            status_code=503,
            detail="服务端尚未配置 API Key，请在右侧接口设置中填写。",
        )
    if request.retry_of_message_id is None and not request.content.strip() and not request.images:
        raise HTTPException(status_code=422, detail="请输入消息或选择图片。")
    if request.retry_of_message_id is None:
        validate_images(request.images)

    with db_connection() as connection:
        session = connection.execute(
            "SELECT id, title, title_edited FROM sessions WHERE id = ?", (request.session_id,)
        ).fetchone()
        if session is None:
            raise HTTPException(status_code=404, detail="会话不存在，请新建会话。")
        if request.retry_of_message_id is not None:
            target = connection.execute(
                "SELECT id, role FROM messages WHERE id = ? AND session_id = ?",
                (request.retry_of_message_id, request.session_id),
            ).fetchone()
            if target is None:
                raise HTTPException(status_code=404, detail="要重试的消息不存在。")
            user_id = target["id"] if target["role"] == "user" else connection.execute(
                "SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1",
                (request.session_id, target["id"]),
            ).fetchone()
            if user_id is None:
                raise HTTPException(status_code=422, detail="找不到对应的用户提问。")
            cutoff_id = user_id if isinstance(user_id, int) else user_id["id"]
            history_rows = connection.execute(
                "SELECT role, content FROM messages WHERE session_id = ? AND id <= ? ORDER BY id",
                (request.session_id, cutoff_id),
            ).fetchall()
        else:
            timestamp = now_iso()
            connection.execute(
                "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
                (request.session_id, serialize_user_content(request.content.strip(), request.images), timestamp),
            )
            connection.execute("UPDATE sessions SET draft_content = '' WHERE id = ?", (request.session_id,))
            if session["title"] == "新对话" and not session["title_edited"]:
                connection.execute(
                    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
                    ((request.content.strip() or request.images[0].name)[:32], timestamp, request.session_id),
                )
            else:
                connection.execute(
                    "UPDATE sessions SET updated_at = ? WHERE id = ?",
                    (timestamp, request.session_id),
                )
            history_rows = connection.execute(
                "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id",
                (request.session_id,),
            ).fetchall()

    history = provider_history(history_rows, provider_format)
    if provider_format == "anthropic":
        payload = anthropic_payload(model, history, thinking_level)
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        messages_url = f"{base_url}/messages" if base_url.endswith("/v1") else f"{base_url}/v1/messages"
    else:
        payload = {"model": model, "messages": history, "max_tokens": MAX_TOKENS}
        if is_local:
            payload["chat_template_kwargs"] = {"enable_thinking": thinking_level != "low"}
        elif thinking_level == "low":
            payload["reasoning_effort"] = "low"
        elif thinking_level == "medium":
            payload["reasoning_effort"] = "medium"
        else:
            payload["reasoning_effort"] = "high"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        messages_url = f"{base_url}/chat/completions" if base_url.endswith("/v1") else f"{base_url}/v1/chat/completions"

    async def event_stream():
        full_content = ""
        timeout = httpx.Timeout(connect=CONNECT_TIMEOUT, read=READ_TIMEOUT, write=WRITE_TIMEOUT, pool=POOL_TIMEOUT)
        try:
            async with httpx.AsyncClient(
                timeout=timeout,
                proxy=UPSTREAM_PROXY_URL,
                trust_env=False,
            ) as client:
                for attempt in range(MAX_PROVIDER_ATTEMPTS):
                    async with client.stream("POST", messages_url, json={**payload, "stream": True}, headers=headers) as response:
                        if response.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_PROVIDER_ATTEMPTS - 1:
                            await asyncio.sleep(0.6 * (2**attempt))
                            continue
                        if response.is_error:
                            body = await response.aread()
                            detail = "第三方 AI 服务返回了错误。"
                            try:
                                detail = response.json().get("error", {}).get("message", detail)
                            except (ValueError, AttributeError):
                                pass
                            yield f"event: error\ndata: {json.dumps({'detail': f'{detail}（上游状态码：{response.status_code}）'}, ensure_ascii=False)}\n\n"
                            return
                        async for line in response.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            raw = line[5:].strip()
                            if not raw or raw == "[DONE]":
                                continue
                            try:
                                data = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            text = ""
                            if provider_format == "anthropic":
                                if data.get("type") == "content_block_delta":
                                    text = data.get("delta", {}).get("text", "")
                            else:
                                text = data.get("choices", [{}])[0].get("delta", {}).get("content") or ""
                            if text:
                                full_content += text
                                yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"
                        break
            if not full_content:
                yield f"event: error\ndata: {json.dumps({'detail': '第三方 AI 服务没有返回文本内容。'}, ensure_ascii=False)}\n\n"
                return
            with db_connection() as connection:
                connection.execute("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)", (request.session_id, full_content, now_iso()))
                connection.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_iso(), request.session_id))
            yield "event: done\ndata: {}\n\n"
        except httpx.TimeoutException:
            yield f"event: error\ndata: {json.dumps({'detail': f'第三方 AI 服务在 {READ_TIMEOUT:g} 秒内没有完成响应。'}, ensure_ascii=False)}\n\n"
        except httpx.RequestError as exc:
            logger.warning("Upstream streaming connection failed: %s target=%s", type(exc).__name__, messages_url)
            yield f"event: error\ndata: {json.dumps({'detail': f'暂时无法连接第三方 AI 服务（{type(exc).__name__}）。'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
