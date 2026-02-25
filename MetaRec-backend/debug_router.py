from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import json
import os
import secrets
import tempfile
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from conversation_storage import ConversationStorage

try:
    from llm_service import client as debug_llm_client, LLM_MODEL as DEBUG_LLM_MODEL
except Exception:
    debug_llm_client = None
    DEBUG_LLM_MODEL = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _serialize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_serialize(v) for v in value]
    if hasattr(value, "model_dump"):
        try:
            return _serialize(value.model_dump())
        except Exception:
            pass
    if hasattr(value, "dict"):
        try:
            return _serialize(value.dict())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        try:
            return _serialize(vars(value))
        except Exception:
            pass
    return str(value)


_SENSITIVE_PARTS = ("token", "api_key", "apikey", "authorization", "cookie", "secret", "password")


def _sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, val in value.items():
            if any(p in str(key).lower() for p in _SENSITIVE_PARTS):
                out[str(key)] = "[REDACTED]"
            else:
                out[str(key)] = _sanitize(val)
        return out
    if isinstance(value, list):
        return [_sanitize(v) for v in value]
    if isinstance(value, str) and len(value) > 4000:
        return value[:4000] + "...<truncated>"
    return _serialize(value)


class DebugTraceStorage:
    def __init__(self, storage_dir: str = "debug_traces"):
        self.base_dir = Path(__file__).parent / storage_dir
        self.base_dir.mkdir(exist_ok=True)
        self._lock = Lock()

    def _path(self, run_id: str) -> Path:
        return self.base_dir / f"{run_id}.json"

    def create_run(self, kind: str, config: Dict[str, Any]) -> Dict[str, Any]:
        run_id = str(uuid.uuid4())
        record = {
            "id": run_id,
            "kind": kind,
            "status": "queued",
            "created_at": _utc_now_iso(),
            "updated_at": _utc_now_iso(),
            "config": _sanitize(config),
            "events": [],
            "artifacts": {},
            "explanation": None,
            "error": None,
        }
        self.save(record)
        return record

    def load(self, run_id: str) -> Optional[Dict[str, Any]]:
        path = self._path(run_id)
        if not path.exists():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def save(self, record: Dict[str, Any]) -> None:
        with self._lock:
            record["updated_at"] = _utc_now_iso()
            with open(self._path(record["id"]), "w", encoding="utf-8") as f:
                json.dump(record, f, ensure_ascii=False, indent=2)

    def update(self, run_id: str, **fields: Any) -> Dict[str, Any]:
        record = self.load(run_id)
        if not record:
            raise FileNotFoundError(run_id)
        record.update(_serialize(fields))
        self.save(record)
        return record

    def append_event(
        self,
        run_id: str,
        *,
        event_type: str,
        label: str,
        status: str = "info",
        data: Any = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        record = self.load(run_id)
        if not record:
            raise FileNotFoundError(run_id)
        record.setdefault("events", []).append(
            {
                "timestamp": _utc_now_iso(),
                "type": event_type,
                "label": label,
                "status": status,
                "duration_ms": duration_ms,
                "data": _sanitize(data),
            }
        )
        self.save(record)

    def list_runs(self, limit: int = 50) -> List[Dict[str, Any]]:
        files = sorted(self.base_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        out: List[Dict[str, Any]] = []
        for path in files[:limit]:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    record = json.load(f)
                out.append(
                    {
                        "id": record.get("id"),
                        "kind": record.get("kind"),
                        "status": record.get("status"),
                        "created_at": record.get("created_at"),
                        "updated_at": record.get("updated_at"),
                        "event_count": len(record.get("events", [])),
                        "error": record.get("error"),
                    }
                )
            except Exception:
                continue
        return out


class DebugSessionStore:
    def __init__(self):
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._lock = Lock()

    def create(self, ttl_hours: int = 8) -> Tuple[str, Dict[str, Any]]:
        sid = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        session = {
            "id": sid,
            "role": "admin",
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(hours=ttl_hours)).isoformat(),
        }
        with self._lock:
            self._sessions[sid] = session
        return sid, session

    def get(self, sid: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            session = self._sessions.get(sid)
        if not session:
            return None
        try:
            if datetime.now(timezone.utc) >= datetime.fromisoformat(session["expires_at"]):
                self.delete(sid)
                return None
        except Exception:
            self.delete(sid)
            return None
        return session

    def delete(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)


class DebugConfig(BaseModel):
    enabled: bool
    llm_explain_enabled: bool
    auth_mode: str
    cookie_name: str


class DebugLoginRequest(BaseModel):
    token: str = Field(..., min_length=1)


class BehaviorTestCreateRequest(BaseModel):
    query: str = Field(..., min_length=1)
    user_id: str = "debug_user"
    conversation_id: Optional[str] = None
    use_online_agent: bool = False
    auto_confirm: bool = True
    confirm_message: str = "Yes, that's correct"
    max_wait_seconds: int = 90
    poll_interval_ms: int = 500


class BehaviorTrackRequest(BaseModel):
    task_id: str = Field(..., min_length=1)
    user_id: Optional[str] = None
    conversation_id: Optional[str] = None
    max_wait_seconds: int = 90
    poll_interval_ms: int = 500


class ExplainRequest(BaseModel):
    mode: str = "nl_explain"


class UnitRunRequest(BaseModel):
    unit_name: str
    input_data: Optional[Dict[str, Any]] = None
    input_mode: str = "manual"  # manual | sample | schema | llm
    use_llm_generation: bool = False


class UnitInputGenerateRequest(BaseModel):
    unit_name: str
    mode: str = "schema"  # schema | sample | llm


class UnitSpec(BaseModel):
    name: str
    description: str
    function_name: str
    input_schema: Dict[str, Any]
    expected_io: Dict[str, Any]
    sample_input: Dict[str, Any]


class UnitRegistry:
    def __init__(self, service_getter: Callable[[], Any]):
        self._service_getter = service_getter
        self._specs: Dict[str, UnitSpec] = {}
        self._handlers: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._register_defaults()

    def _register(self, spec: UnitSpec, handler: Callable[[Dict[str, Any]], Any]) -> None:
        self._specs[spec.name] = spec
        self._handlers[spec.name] = handler

    def _register_defaults(self) -> None:
        self._register(
            UnitSpec(
                name="metarec.analyze_user_intent",
                description="Rule-based fallback intent classifier for confirmation/new query.",
                function_name="MetaRecService.analyze_user_intent",
                input_schema={"type": "object", "required": ["query"], "properties": {"query": {"type": "string", "minLength": 1}}},
                expected_io={"output_type": "object", "notes": "Returns type/confidence/original_query"},
                sample_input={"query": "I want spicy Sichuan in Chinatown"},
            ),
            lambda p: self._service_getter().analyze_user_intent(p["query"]),
        )
        self._register(
            UnitSpec(
                name="metarec.extract_preferences_from_query",
                description="Rule-based preference extraction used as fallback and baseline behavior parser.",
                function_name="MetaRecService.extract_preferences_from_query",
                input_schema={
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string", "minLength": 1},
                        "user_id": {"type": "string"},
                        "session_id": {"type": "string"},
                    },
                },
                expected_io={"output_type": "object", "notes": "Preferences dict"},
                sample_input={"query": "spicy Sichuan for friends around Chinatown budget 20 to 60"},
            ),
            lambda p: self._service_getter().extract_preferences_from_query(
                p["query"], p.get("user_id", "debug_unit"), p.get("session_id", "debug_unit_session")
            ),
        )
        self._register(
            UnitSpec(
                name="metarec.preferences_to_agent_input",
                description="Converts query + preferences into planner JSON text.",
                function_name="MetaRecService._preferences_to_agent_input",
                input_schema={
                    "type": "object",
                    "required": ["query", "preferences"],
                    "properties": {"query": {"type": "string"}, "preferences": {"type": "object"}},
                },
                expected_io={"output_type": "string", "notes": "JSON string for planner"},
                sample_input={
                    "query": "Find spicy Sichuan for friends in Chinatown",
                    "preferences": {
                        "restaurant_types": ["casual"],
                        "flavor_profiles": ["spicy"],
                        "dining_purpose": "friends",
                        "budget_range": {"min": 20, "max": 60, "currency": "SGD", "per": "person"},
                        "location": "Chinatown",
                    },
                },
            ),
            lambda p: self._service_getter()._preferences_to_agent_input(p.get("query", ""), p["preferences"]),
        )
        self._register(
            UnitSpec(
                name="metarec.extract_restaurants_from_execution_data",
                description="Parses summary + executions into frontend restaurant objects.",
                function_name="MetaRecService._extract_restaurants_from_execution_data",
                input_schema={"type": "object", "required": ["execution_data"], "properties": {"execution_data": {"type": "object"}}},
                expected_io={"output_type": "array", "notes": "Restaurant dicts merged from summary and Google Maps"},
                sample_input={
                    "execution_data": {
                        "summary": {
                            "recommendations": [
                                {
                                    "name": "Test Sichuan House",
                                    "area": "Chinatown",
                                    "cuisine": "Sichuan",
                                    "price_per_person_sgd": "20-35",
                                    "why": "Fits spicy budget",
                                    "sources": {"xiaohongshu": "note_1"},
                                }
                            ]
                        },
                        "executions": [
                            {
                                "tool": "gmap.search",
                                "success": True,
                                "output": [
                                    {
                                        "title": "Test Sichuan House Singapore",
                                        "rating": 4.3,
                                        "reviews": 231,
                                        "price": "$$",
                                        "address": "72 Pagoda St",
                                        "gps_coordinates": {"latitude": 1.28, "longitude": 103.84},
                                        "open_state": "Open now",
                                    }
                                ],
                            }
                        ],
                    }
                },
            ),
            lambda p: self._service_getter()._extract_restaurants_from_execution_data(p["execution_data"]),
        )
        self._register(
            UnitSpec(
                name="conversation_storage.sandbox_lifecycle",
                description="Temp-dir conversation CRUD sandbox (isolated from production conversation files).",
                function_name="ConversationStorage lifecycle",
                input_schema={
                    "type": "object",
                    "required": ["user_id", "message"],
                    "properties": {
                        "user_id": {"type": "string"},
                        "message": {"type": "string"},
                        "title": {"type": "string"},
                        "preferences": {"type": "object"},
                    },
                },
                expected_io={"output_type": "object", "notes": "Returns final conversation snapshot"},
                sample_input={
                    "user_id": "unit_user",
                    "message": "I want spicy food",
                    "title": "Debug Sandbox",
                    "preferences": {"flavor_profiles": ["spicy"], "location": "Chinatown"},
                },
            ),
            self._conversation_sandbox_lifecycle,
        )

    def _conversation_sandbox_lifecycle(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="metarec_debug_conv_") as tmpdir:
            storage = ConversationStorage(storage_dir=tmpdir)
            conv = storage.create_conversation(
                user_id=payload.get("user_id", "unit_user"),
                title=payload.get("title", "Debug Sandbox"),
                model="DebugUnit",
            )
            storage.add_message(payload.get("user_id", "unit_user"), conv["id"], "user", payload.get("message", "Hello"))
            if payload.get("preferences"):
                storage.update_conversation_preferences(payload.get("user_id", "unit_user"), conv["id"], payload["preferences"])
            return {
                "conversation_id": conv["id"],
                "conversation": storage.get_full_conversation(payload.get("user_id", "unit_user"), conv["id"]),
            }

    def list_specs(self) -> List[Dict[str, Any]]:
        return [spec.model_dump() for spec in self._specs.values()]

    def get_spec(self, name: str) -> UnitSpec:
        spec = self._specs.get(name)
        if not spec:
            raise KeyError(name)
        return spec

    async def run(self, name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        handler = self._handlers[name]
        started = time.perf_counter()
        try:
            result = handler(payload)
            if inspect.isawaitable(result):
                result = await result  # type: ignore[assignment]
            return {"ok": True, "duration_ms": int((time.perf_counter() - started) * 1000), "output": _sanitize(result)}
        except Exception as exc:
            return {
                "ok": False,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }


def _validate_schema(data: Any, schema: Dict[str, Any], path: str = "$") -> List[str]:
    errors: List[str] = []
    t = schema.get("type")
    if t == "object":
        if not isinstance(data, dict):
            return [f"{path}: expected object"]
        for k in schema.get("required", []):
            if k not in data:
                errors.append(f"{path}.{k}: missing required field")
        props = schema.get("properties", {})
        for k, child in props.items():
            if k in data and isinstance(child, dict):
                errors.extend(_validate_schema(data[k], child, f"{path}.{k}"))
        return errors
    if t == "array":
        if not isinstance(data, list):
            return [f"{path}: expected array"]
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(data[:5]):
                errors.extend(_validate_schema(item, item_schema, f"{path}[{i}]"))
        return errors
    if t == "string":
        if not isinstance(data, str):
            return [f"{path}: expected string"]
        min_len = schema.get("minLength")
        if isinstance(min_len, int) and len(data) < min_len:
            errors.append(f"{path}: too short")
        return errors
    if t == "integer" and (not isinstance(data, int) or isinstance(data, bool)):
        return [f"{path}: expected integer"]
    if t == "number" and (not isinstance(data, (int, float)) or isinstance(data, bool)):
        return [f"{path}: expected number"]
    if t == "boolean" and not isinstance(data, bool):
        return [f"{path}: expected boolean"]
    return errors


def _generate_from_schema(schema: Dict[str, Any]) -> Any:
    if "example" in schema:
        return schema["example"]
    t = schema.get("type")
    if t == "object":
        props = schema.get("properties", {})
        req = schema.get("required", [])
        obj: Dict[str, Any] = {}
        for k in req:
            if isinstance(props.get(k), dict):
                obj[k] = _generate_from_schema(props[k])
        return obj
    if t == "array":
        child = schema.get("items", {"type": "string"})
        return [_generate_from_schema(child if isinstance(child, dict) else {"type": "string"})]
    if t == "string":
        if schema.get("enum"):
            return schema["enum"][0]
        return "test"
    if t == "integer":
        return 1
    if t == "number":
        return 1.0
    if t == "boolean":
        return False
    return None


async def _generate_llm_input(unit_spec: UnitSpec) -> Optional[Dict[str, Any]]:
    if debug_llm_client is None or not DEBUG_LLM_MODEL:
        return None
    prompt = (
        "Generate one JSON object satisfying this schema that asks about a Point of Interest including type and place. Return JSON only.\n"
        f"{json.dumps(unit_spec.input_schema, ensure_ascii=False)}"
    )
    try:
        resp = await debug_llm_client.chat.completions.create(
            model=DEBUG_LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        content = resp.choices[0].message.content if resp and resp.choices else ""
        parsed = json.loads(content) if isinstance(content, str) else None
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


async def _generate_unit_input(spec: UnitSpec, mode: str) -> Dict[str, Any]:
    if mode == "sample":
        return spec.sample_input
    if mode == "llm":
        generated = await _generate_llm_input(spec)
        if generated is not None:
            return generated
    return _generate_from_schema(spec.input_schema)


def _debug_user(user_id: str, run_id: str) -> str:
    if user_id.startswith("debug_"):
        return user_id
    return f"debug_{user_id}_{run_id[:8]}"


def _debug_session(session_id: Optional[str], run_id: str) -> str:
    return session_id or f"debug_session_{run_id[:8]}"


def _get_confirmation_message(response_obj: Any) -> str:
    """
    Support both dict payloads and Pydantic models for confirmation_request.
    """
    if response_obj is None:
        return ""
    if isinstance(response_obj, dict):
        confirmation = response_obj.get("confirmation_request")
        if isinstance(confirmation, dict):
            return str(confirmation.get("message", "") or "")
        if confirmation is not None:
            return str(getattr(confirmation, "message", "") or "")
        return ""
    confirmation = getattr(response_obj, "confirmation_request", None)
    if confirmation is None:
        return ""
    if isinstance(confirmation, dict):
        return str(confirmation.get("message", "") or "")
    return str(getattr(confirmation, "message", "") or "")


def create_debug_router(service_getter: Callable[[], Any]) -> APIRouter:
    router = APIRouter(prefix="/internal/debug", tags=["internal-debug"])
    trace_storage = DebugTraceStorage()
    session_store = DebugSessionStore()
    unit_registry = UnitRegistry(service_getter)
    jobs: Dict[str, asyncio.Task] = {}

    debug_enabled = _env_flag("DEBUG_UI_ENABLED", False)
    explain_enabled = _env_flag("DEBUG_LLM_EXPLAIN_ENABLED", True)
    cookie_name = os.getenv("DEBUG_SESSION_COOKIE_NAME", "metarec_debug_session")
    cookie_secure = _env_flag("DEBUG_SESSION_COOKIE_SECURE", False)
    debug_admin_token = os.getenv("DEBUG_ADMIN_TOKEN", "")
    debug_admin_token_hash = os.getenv("DEBUG_ADMIN_TOKEN_HASH", "")
    session_ttl_hours = int(os.getenv("DEBUG_SESSION_TTL_HOURS", "8"))

    def require_enabled() -> None:
        if not debug_enabled:
            raise HTTPException(status_code=404, detail="Debug UI is disabled")

    def verify_admin_token(candidate: str) -> bool:
        if not candidate:
            return False
        if debug_admin_token_hash:
            digest = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
            return hmac.compare_digest(digest, debug_admin_token_hash.strip())
        if debug_admin_token:
            return hmac.compare_digest(candidate, debug_admin_token)
        return False

    async def require_auth(request: Request) -> Dict[str, Any]:
        require_enabled()
        sid = request.cookies.get(cookie_name)
        if not sid:
            raise HTTPException(status_code=401, detail="Debug auth required")
        session = session_store.get(sid)
        if not session:
            raise HTTPException(status_code=401, detail="Debug session expired")
        return session

    def record_artifact(run_id: str, key: str, value: Any) -> None:
        rec = trace_storage.load(run_id)
        if not rec:
            return
        rec.setdefault("artifacts", {})[key] = _sanitize(value)
        trace_storage.save(rec)

    async def poll_task(
        run_id: str,
        task_id: str,
        user_id: Optional[str],
        session_id: Optional[str],
        max_wait_seconds: int,
        poll_interval_ms: int,
    ) -> Dict[str, Any]:
        service = service_getter()
        deadline = time.monotonic() + max(1, max_wait_seconds)
        last_sig: Optional[str] = None
        while time.monotonic() < deadline:
            status = service.get_task_status(task_id, user_id, session_id)
            if status is None:
                trace_storage.append_event(run_id, event_type="task_status", label="Task not found", status="warning", data={"task_id": task_id})
            else:
                safe = _serialize(status)
                sig = json.dumps(
                    {
                        "status": safe.get("status"),
                        "progress": safe.get("progress"),
                        "message": safe.get("message"),
                        "stage": safe.get("stage"),
                        "stage_number": safe.get("stage_number"),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                )
                if sig != last_sig:
                    last_sig = sig
                    trace_storage.append_event(
                        run_id,
                        event_type="task_status",
                        label=f"Task status: {safe.get('status', 'unknown')}",
                        data=safe,
                    )
                if safe.get("status") in {"completed", "error"}:
                    record_artifact(run_id, "task_status_final", safe)
                    return safe
            await asyncio.sleep(max(0.1, poll_interval_ms / 1000.0))
        timeout_status = {"status": "timeout", "task_id": task_id, "message": f"Timed out after {max_wait_seconds}s"}
        trace_storage.append_event(run_id, event_type="task_status", label="Task tracking timeout", status="error", data=timeout_status)
        record_artifact(run_id, "task_status_final", timeout_status)
        return timeout_status

    async def run_behavior_create(run_id: str, req: BehaviorTestCreateRequest) -> None:
        service = service_getter()
        user_id = _debug_user(req.user_id, run_id)
        session_id = _debug_session(req.conversation_id, run_id)
        try:
            trace_storage.update(run_id, status="running")
            trace_storage.append_event(
                run_id,
                event_type="behavior_test",
                label="Run started",
                data={
                    "query": req.query,
                    "user_id": user_id,
                    "session_id": session_id,
                    "use_online_agent": req.use_online_agent,
                    "auto_confirm": req.auto_confirm,
                },
            )
            t0 = time.perf_counter()
            initial = await service.handle_user_request_async(
                req.query,
                user_id=user_id,
                conversation_history=None,
                session_id=session_id,
                use_online_agent=req.use_online_agent,
            )
            trace_storage.append_event(
                run_id,
                event_type="service_call",
                label="Initial handle_user_request_async",
                status="completed",
                duration_ms=int((time.perf_counter() - t0) * 1000),
                data=initial,
            )
            record_artifact(run_id, "initial_response", initial)
            current = initial

            if current.get("type") == "confirmation" and req.auto_confirm:
                t1 = time.perf_counter()
                confirmation_message = _get_confirmation_message(current)
                confirm_resp = await service.handle_user_request_async(
                    req.confirm_message,
                    user_id=user_id,
                    conversation_history=[
                        {"role": "user", "content": req.query},
                        {"role": "assistant", "content": confirmation_message},
                    ],
                    session_id=session_id,
                    use_online_agent=req.use_online_agent,
                )
                trace_storage.append_event(
                    run_id,
                    event_type="service_call",
                    label="Auto-confirm follow-up",
                    status="completed",
                    duration_ms=int((time.perf_counter() - t1) * 1000),
                    data={"confirm_message": req.confirm_message, "response": confirm_resp},
                )
                record_artifact(run_id, "auto_confirm_response", confirm_resp)
                current = confirm_resp

            if current.get("type") == "task_created":
                task_id = current.get("task_id")
                record_artifact(run_id, "task_created", {"task_id": task_id})
                if task_id:
                    final_status = await poll_task(
                        run_id, task_id, user_id, session_id, req.max_wait_seconds, req.poll_interval_ms
                    )
                    if final_status.get("status") == "completed":
                        trace_storage.update(run_id, status="completed")
                    elif final_status.get("status") == "timeout":
                        trace_storage.update(run_id, status="timeout", error=final_status.get("message"))
                    else:
                        trace_storage.update(run_id, status="error", error=final_status.get("error") or final_status.get("message"))
                else:
                    trace_storage.update(run_id, status="error", error="task_created without task_id")
            else:
                record_artifact(run_id, "behavior_test_result", {"final_response": current})
                trace_storage.update(run_id, status="completed")
        except Exception as exc:
            trace_storage.append_event(
                run_id,
                event_type="behavior_test",
                label="Run failed",
                status="error",
                data={"error": str(exc), "traceback": traceback.format_exc()},
            )
            trace_storage.update(run_id, status="error", error=str(exc))

    async def run_behavior_track(run_id: str, req: BehaviorTrackRequest) -> None:
        try:
            trace_storage.update(run_id, status="running")
            final_status = await poll_task(
                run_id,
                req.task_id,
                req.user_id,
                req.conversation_id,
                req.max_wait_seconds,
                req.poll_interval_ms,
            )
            if final_status.get("status") == "completed":
                trace_storage.update(run_id, status="completed")
            elif final_status.get("status") == "timeout":
                trace_storage.update(run_id, status="timeout", error=final_status.get("message"))
            else:
                trace_storage.update(run_id, status="error", error=final_status.get("error") or final_status.get("message"))
        except Exception as exc:
            trace_storage.append_event(run_id, event_type="task_status", label="Tracker failed", status="error", data={"error": str(exc)})
            trace_storage.update(run_id, status="error", error=str(exc))

    async def explain_trace(run_id: str) -> Dict[str, Any]:
        rec = trace_storage.load(run_id)
        if not rec:
            raise HTTPException(status_code=404, detail="Debug run not found")
        if debug_llm_client is None or not DEBUG_LLM_MODEL:
            raise HTTPException(status_code=400, detail="LLM client unavailable")
        prompt = (
            "Explain this debug trace step-by-step for engineers. "
            "Label observed facts vs inferred causes, and give optimization suggestions.\n\n"
            f"{json.dumps(_sanitize(rec), ensure_ascii=False, indent=2)[:120000]}"
        )
        started = time.perf_counter()
        resp = await debug_llm_client.chat.completions.create(
            model=DEBUG_LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )
        content = (resp.choices[0].message.content if resp and resp.choices else "") or ""
        explanation = {
            "generated_at": _utc_now_iso(),
            "duration_ms": int((time.perf_counter() - started) * 1000),
            "content": content.strip(),
        }
        rec["explanation"] = explanation
        trace_storage.save(rec)
        trace_storage.append_event(run_id, event_type="llm_explain", label="Generated NL explanation", status="completed", data={"duration_ms": explanation["duration_ms"]})
        return explanation

    @router.get("/config")
    async def get_config():
        return DebugConfig(
            enabled=debug_enabled,
            llm_explain_enabled=bool(debug_enabled and explain_enabled and debug_llm_client and DEBUG_LLM_MODEL),
            auth_mode="cookie_session",
            cookie_name=cookie_name,
        )

    @router.post("/login")
    async def login(payload: DebugLoginRequest, response: Response):
        require_enabled()
        if not verify_admin_token(payload.token):
            raise HTTPException(status_code=401, detail="Invalid debug token")
        sid, session = session_store.create(ttl_hours=session_ttl_hours)
        response.set_cookie(
            cookie_name,
            sid,
            httponly=True,
            secure=cookie_secure,
            samesite="lax",
            path="/",
            max_age=int(timedelta(hours=session_ttl_hours).total_seconds()),
        )
        return {"ok": True, "session": session}

    @router.post("/logout")
    async def logout(request: Request, response: Response):
        require_enabled()
        sid = request.cookies.get(cookie_name)
        if sid:
            session_store.delete(sid)
        response.delete_cookie(cookie_name, path="/")
        return {"ok": True}

    @router.get("/session")
    async def session_info(session: Dict[str, Any] = Depends(require_auth)):
        return {"ok": True, "session": session}

    @router.get("/behavior-tests")
    async def list_behavior(_: Dict[str, Any] = Depends(require_auth)):
        return {"runs": trace_storage.list_runs()}

    @router.post("/behavior-tests")
    async def start_behavior(req: BehaviorTestCreateRequest, _: Dict[str, Any] = Depends(require_auth)):
        rec = trace_storage.create_run("behavior_create", req.model_dump())
        jobs[rec["id"]] = asyncio.create_task(run_behavior_create(rec["id"], req))
        return {"ok": True, "run_id": rec["id"], "status": rec["status"]}

    @router.post("/behavior-tests/track")
    async def start_track(req: BehaviorTrackRequest, _: Dict[str, Any] = Depends(require_auth)):
        # Preflight existence check: do not create a debug tracking run for a non-existent task.
        existing = service_getter().get_task_status(req.task_id, req.user_id, req.conversation_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Task ID not found; no tracking run created")
        rec = trace_storage.create_run("behavior_track", req.model_dump())
        jobs[rec["id"]] = asyncio.create_task(run_behavior_track(rec["id"], req))
        return {"ok": True, "run_id": rec["id"], "status": rec["status"]}

    @router.get("/behavior-tests/{run_id}")
    async def get_behavior(run_id: str, _: Dict[str, Any] = Depends(require_auth)):
        rec = trace_storage.load(run_id)
        if not rec:
            raise HTTPException(status_code=404, detail="Debug run not found")
        job = jobs.get(run_id)
        if job and job.done():
            jobs.pop(run_id, None)
        rec["job_running"] = bool(job and not job.done())
        return rec

    @router.post("/behavior-tests/{run_id}/explain")
    async def explain_endpoint(run_id: str, payload: ExplainRequest, _: Dict[str, Any] = Depends(require_auth)):
        require_enabled()
        if not explain_enabled:
            raise HTTPException(status_code=400, detail="LLM explanation disabled")
        try:
            explanation = await explain_trace(run_id)
            return {"ok": True, "mode": payload.mode, "explanation": explanation}
        except HTTPException:
            raise
        except Exception as exc:
            trace_storage.append_event(run_id, event_type="llm_explain", label="LLM explanation failed", status="error", data={"error": str(exc)})
            raise HTTPException(status_code=500, detail=f"LLM explanation failed: {exc}")

    @router.get("/unit-tests/units")
    async def list_units(_: Dict[str, Any] = Depends(require_auth)):
        return {"units": unit_registry.list_specs()}

    @router.post("/unit-tests/generate-input")
    async def generate_unit_input(payload: UnitInputGenerateRequest, _: Dict[str, Any] = Depends(require_auth)):
        try:
            spec = unit_registry.get_spec(payload.unit_name)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unit not found")
        generated = await _generate_unit_input(spec, payload.mode)
        return {
            "ok": True,
            "unit": spec.name,
            "mode": payload.mode,
            "input_data": _sanitize(generated),
            "validation_errors": _validate_schema(generated, spec.input_schema),
        }

    @router.post("/unit-tests/run")
    async def run_unit(payload: UnitRunRequest, _: Dict[str, Any] = Depends(require_auth)):
        try:
            spec = unit_registry.get_spec(payload.unit_name)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unit not found")
        input_mode = payload.input_mode
        input_data = payload.input_data
        if input_data is None or input_mode in {"sample", "schema"} or payload.use_llm_generation:
            input_mode = "llm" if payload.use_llm_generation else input_mode
            input_data = await _generate_unit_input(spec, input_mode)
        if not isinstance(input_data, dict):
            raise HTTPException(status_code=400, detail="input_data must be an object")
        return {
            "ok": True,
            "unit": spec.model_dump(),
            "input_source": input_mode,
            "input_data": _sanitize(input_data),
            "validation_errors": _validate_schema(input_data, spec.input_schema),
            "result": await unit_registry.run(spec.name, input_data),
        }

    return router
