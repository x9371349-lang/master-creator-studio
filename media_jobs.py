"""Durable, serial article2media jobs. The workspace JSON is never modified here."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import inspect
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from typing import Any, Callable, Literal
from urllib.parse import quote, urlparse
import uuid
import zipfile

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator

THEMES = {
    "editorial": "编辑杂志", "swiss": "瑞士网格", "quiet": "静谧留白",
    "bento": "便当格", "brutal": "粗野主义", "dopamine": "多巴胺",
    "midnight": "午夜", "film": "胶片", "guochao": "国潮",
    "shanshui": "山水", "notebook": "手账", "y2k": "千禧",
}
TERMINAL = {"completed", "failed", "cancelled"}
FORMAT_LAYOUTS = {"cards": "card", "long": "long", "wechat": "wechat"}
SOURCE_KEYS = {"url", "title", "author", "platform"}
# Article pipelines resolve image URLs and local files themselves; this MVP
# deliberately refuses image-bearing input rather than silently altering it.
IMAGE_INPUT = re.compile(r"!\s*\[|<\s*(?:img|picture|svg|video|audio|iframe|object|embed|script|style|link)\b", re.I)
PREVIEW_CSP = (
    "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
    "img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def find_node() -> str | None:
    """Finder-launched apps do not inherit the interactive shell's fnm PATH."""
    configured = os.environ.get("ARTICLE2MEDIA_NODE")
    candidates = [Path(configured)] if configured else []
    found = shutil.which("node")
    if found:
        candidates.append(Path(found))
    candidates.extend([Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node")])
    fnm = Path.home() / ".local/share/fnm/node-versions"
    installed = list(fnm.glob("*/installation/bin/node"))
    def version_key(path):
        return tuple(int(part) for part in re.findall(r"\d+", path.parts[-4]))
    candidates.extend(sorted(installed, key=version_key, reverse=True))
    seen = set()
    for candidate in candidates:
        value = str(candidate)
        if value not in seen and candidate.is_file() and os.access(candidate, os.X_OK):
            return value
        seen.add(value)
    return None


class MediaJobInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str = Field(min_length=1, max_length=160)
    document_version: StrictInt | StrictStr = 0
    title: str = Field(default="未命名稿件", max_length=300)
    text: str = Field(min_length=1, max_length=120_000)
    formats: list[Literal["cards", "long", "wechat"]] = Field(default_factory=lambda: ["cards"], min_length=1, max_length=3)
    theme: str = "editorial"
    mode: Literal["original", "summary"] = "original"
    source: dict[str, Any] = Field(default_factory=dict)

    @field_validator("document_id")
    @classmethod
    def clean_document_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请选择需要制作的稿件")
        return value.strip()

    @field_validator("document_version")
    @classmethod
    def valid_version(cls, value):
        if isinstance(value, int) and value < 0 or isinstance(value, str) and len(value) > 100:
            raise ValueError("稿件版本无效")
        return value

    @field_validator("theme")
    @classmethod
    def allowed_theme(cls, value: str) -> str:
        if value not in THEMES:
            raise ValueError("请选择支持的主题")
        return value

    @field_validator("formats")
    @classmethod
    def unique_formats(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("输出格式不能重复")
        return value

    @field_validator("text")
    @classmethod
    def plain_article(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("稿件正文不能为空")
        if "\x00" in value:
            raise ValueError("稿件包含无效字符")
        if IMAGE_INPUT.search(value):
            raise ValueError("当前仅支持纯文字稿件，请移除 Markdown 或 HTML 图片、嵌入内容后再制作")
        # Prevent user front matter from selecting media, SVGs or brand assets.
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", value, re.S)
        if match and re.search(r"^\s*(?:hero|cover|avatar|brand|image\w*|illustration\w*|figure\w*)\s*:", match[1], re.I | re.M):
            raise ValueError("当前不支持稿件元数据中的图片或品牌素材")
        return value

    @field_validator("source")
    @classmethod
    def source_metadata(cls, value):
        clean = {key: str(item)[:2000] for key, item in value.items()
                 if key in SOURCE_KEYS and isinstance(item, str)}
        if clean.get("url"):
            parsed = urlparse(clean["url"])
            if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError("来源链接仅支持不含登录凭据的 http 或 https 地址")
        return clean


class MediaJobManager:
    """One worker owns all render subprocesses, including their Chrome children."""

    def __init__(self, db_path, data_dir, model_settings_loader, http_client_factory,
                 *, engine_dir=None, command_timeout=180.0, job_timeout=600.0):
        self.db_path = Path(db_path)
        self.data_dir = Path(data_dir)
        self.jobs_dir = self.data_dir / "media-jobs"
        self.engine_dir = Path(engine_dir) if engine_dir else Path(__file__).parent / "vendor/article2media/skills/article2media/engine"
        self.model_settings_loader = model_settings_loader
        self.http_client_factory = http_client_factory
        self.command_timeout = command_timeout
        self.job_timeout = job_timeout
        self._started = False
        self._closing = False
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self._active_task: asyncio.Task | None = None
        self._active_job_id: str | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._cap_cache: tuple[float, dict] | None = None
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS media_jobs (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
                document_id TEXT NOT NULL, data TEXT NOT NULL, input TEXT NOT NULL
            )""")
            conn.execute("CREATE INDEX IF NOT EXISTS media_jobs_document ON media_jobs(document_id, created_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS media_jobs_queue ON media_jobs(status, created_at)")

    def _connect(self):
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        return conn

    def _row(self, job_id: str):
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM media_jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "媒体制作任务不存在")
        return row

    def get(self, job_id: str) -> dict:
        return json.loads(self._row(job_id)["data"])

    def list(self, document_id: str = "") -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute("SELECT data FROM media_jobs" +
                                (" WHERE document_id = ?" if document_id else "") +
                                " ORDER BY created_at DESC, id DESC LIMIT 100",
                                (document_id,) if document_id else ()).fetchall()
        return [json.loads(row["data"]) for row in rows]

    def _update(self, job_id: str, *, only_running=False, **changes) -> dict:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT data,status FROM media_jobs WHERE id = ?", (job_id,)).fetchone()
            data = json.loads(row["data"])
            if only_running and row["status"] != "running":
                return data
            data.update(changes)
            conn.execute("UPDATE media_jobs SET status=?,data=? WHERE id=?",
                         (data["status"], json.dumps(data, ensure_ascii=False), job_id))
        return data

    async def start(self):
        if self._started:
            return
        self._started = True
        self._closing = False
        # A restart is not permission to replay an expensive generation. Keep the
        # immutable input and explain the interruption so Retry is explicit.
        with self._connect() as conn:
            rows = conn.execute("SELECT id,data FROM media_jobs WHERE status IN ('running','queued')").fetchall()
            for row in rows:
                data = json.loads(row["data"])
                data.update(status="failed", phase="interrupted", finished_at=utc_now(),
                            error="上次媒体制作因服务中断而停止，请点击重试", artifacts=[])
                conn.execute("UPDATE media_jobs SET status='failed',data=? WHERE id=?",
                             (json.dumps(data, ensure_ascii=False), row["id"]))
        self._worker = asyncio.create_task(self._worker_loop(), name="article2media-worker")

    async def stop(self):
        self._closing = True
        if self._worker:
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)
        if self._process:
            await self._terminate_process(self._process)
        self._worker = None
        self._started = False

    async def _settings(self) -> dict:
        value = self.model_settings_loader()
        return await value if inspect.isawaitable(value) else value

    def _available_themes(self) -> list[dict]:
        catalog = self.engine_dir / "themes/catalog.json"
        try:
            ids = json.loads(catalog.read_text(encoding="utf-8"))["main"]
        except (OSError, ValueError, KeyError):
            ids = []
        return [{"id": key, "name": THEMES[key]} for key in ids
                if key in THEMES and (self.engine_dir / "themes" / (key + ".css")).is_file()]

    _node_path = staticmethod(find_node)

    @staticmethod
    def _chrome_path() -> str | None:
        configured = os.environ.get("ARTICLE2MEDIA_CHROME") or os.environ.get("CHROME_PATH")
        if configured:
            return configured if Path(configured).is_file() else None
        candidates = []
        if sys.platform == "darwin":
            for root in (Path("/Applications"), Path.home() / "Applications"):
                for name in ("Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Google Chrome for Testing"):
                    executable = "Brave Browser" if name == "Brave Browser" else name
                    candidates.append(root / (name + ".app") / "Contents/MacOS" / executable)
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))
        return str(next((item for item in candidates if item.is_file()), "")) or None

    def _detect_runtime(self) -> dict:
        node = self._node_path()
        version = ""
        if node:
            try:
                run = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=3)
                version = run.stdout.strip() if run.returncode == 0 else ""
            except (OSError, subprocess.SubprocessError):
                pass
        match = re.fullmatch(r"v(\d+)(?:\.\d+){1,2}", version)
        node_ready = bool(match and int(match[1]) >= 22)
        chrome = self._chrome_path()
        themes = self._available_themes()
        scripts_ready = all((self.engine_dir / "scripts" / name).is_file() for name in ("render.mjs", "export.mjs"))
        engine_version = "local"
        for name in ("UPSTREAM_REVISION", "REVISION", "UPSTREAM_COMMIT"):
            for base in (self.engine_dir, self.engine_dir.parents[2]):
                file = base / name
                if file.is_file():
                    engine_version = file.read_text(encoding="utf-8").strip()[:100]
                    break
        return {
            "ready": bool(node_ready and chrome and themes and scripts_ready),
            "node": {"available": node_ready, "version": version},
            "chrome": {"available": bool(chrome), "name": Path(chrome).name if chrome else ""},
            "themes": themes, "engine_version": engine_version,
        }

    async def capabilities(self) -> dict:
        if not self._cap_cache or time.monotonic() - self._cap_cache[0] > 30:
            self._cap_cache = (time.monotonic(), await asyncio.to_thread(self._detect_runtime))
        data = dict(self._cap_cache[1])
        try:
            settings = await self._settings()
            data["model_ready"] = bool(settings.get("api_key") and settings.get("model"))
        except Exception:
            data["model_ready"] = False
        return data

    async def submit(self, payload: MediaJobInput) -> dict:
        await self.start()
        caps = await self.capabilities()
        if not caps["ready"]:
            raise HTTPException(503, "媒体引擎未就绪，需要 Node.js 22、Chrome 及完整的 article2media 引擎")
        if payload.theme not in {item["id"] for item in caps["themes"]}:
            raise HTTPException(400, "当前引擎未安装所选主题")
        if payload.mode == "summary" and not caps["model_ready"]:
            raise HTTPException(400, "请先在文案工作台设置并验证模型，再生成总结图文")
        raw = payload.model_dump()
        job_id = uuid.uuid4().hex
        job = {
            "id": job_id, "title": payload.title.strip() or "未命名稿件",
            "document_id": payload.document_id, "document_version": payload.document_version,
            "formats": payload.formats, "theme": payload.theme, "mode": payload.mode,
            "status": "queued", "phase": "queued", "created_at": utc_now(),
            "finished_at": None, "error": "", "warnings": [], "artifacts": [],
            "snapshot_sha256": hashlib.sha256(payload.text.encode("utf-8")).hexdigest(),
        }
        with self._connect() as conn:
            conn.execute("INSERT INTO media_jobs(id,created_at,status,document_id,data,input) VALUES(?,?,?,?,?,?)",
                         (job_id, job["created_at"], "queued", payload.document_id,
                          json.dumps(job, ensure_ascii=False), json.dumps(raw, ensure_ascii=False)))
        self._wake.set()
        return job

    def _claim(self) -> dict | None:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT id,data FROM media_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").fetchone()
            if row is None:
                return None
            data = json.loads(row["data"])
            data.update(status="running", phase="preparing")
            conn.execute("UPDATE media_jobs SET status='running',data=? WHERE id=?",
                         (json.dumps(data, ensure_ascii=False), row["id"]))
            return data

    async def _worker_loop(self):
        while not self._closing:
            self._wake.clear()
            job = self._claim()
            if job is None:
                await self._wake.wait()
                continue
            self._active_job_id = job["id"]
            self._active_task = asyncio.create_task(self._run_job(job), name="media-" + job["id"])
            try:
                await asyncio.wait_for(self._active_task, timeout=self.job_timeout)
            except asyncio.CancelledError:
                if self._closing:
                    self._update(job["id"], only_running=True, status="failed", phase="interrupted",
                                 error="服务已关闭，媒体制作未完成，请重试", finished_at=utc_now(), artifacts=[])
                    raise
                self._update(job["id"], only_running=True, status="cancelled", phase="cancelled",
                             error="", finished_at=utc_now(), artifacts=[])
            except asyncio.TimeoutError:
                self._update(job["id"], only_running=True, status="failed", phase="failed",
                             error="媒体制作超时，已清理渲染进程，请缩短稿件后重试", finished_at=utc_now(), artifacts=[])
            except Exception as exc:
                error = str(exc).strip()[:800] or "媒体制作失败，请重试"
                self._update(job["id"], only_running=True, status="failed", phase="failed",
                             error=error, finished_at=utc_now(), artifacts=[])
            finally:
                self._active_task = None
                self._active_job_id = None

    def _write_snapshot(self, work_dir: Path, payload: dict, job: dict):
        work_dir.mkdir(parents=True, exist_ok=True)
        raw_text = payload["text"]
        body = raw_text
        original_meta = {}
        match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", raw_text, re.S)
        if match:
            lines = [line for line in match[1].splitlines() if line.strip() and not line.lstrip().startswith("#")]
            pairs = [re.fullmatch(r"([\w-]+):\s*(.*)", line) for line in lines]
            # Handle the simple scalar front matter understood by the renderer.
            # An ordinary Markdown horizontal-rule block is not metadata.
            if pairs and all(pairs):
                body = raw_text[match.end():].lstrip("\r\n")
                for pair in pairs:
                    key, value = pair.groups()
                    if key not in {"title", "url", "author", "platform", "source_title", "date"}:
                        continue
                    if value.startswith('"'):
                        try:
                            value = json.loads(value)
                        except ValueError:
                            continue
                    else:
                        value = value.strip("'")
                    if isinstance(value, str):
                        original_meta[key] = value[:2000]
        source = dict(payload.get("source", {}))
        for field, key in {"url": "url", "author": "author", "platform": "platform", "title": "source_title"}.items():
            if not source.get(field) and original_meta.get(key):
                source[field] = original_meta[key]
        if source.get("url"):
            try:
                parsed = urlparse(source["url"])
                if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
                    source.pop("url", None)
            except ValueError:
                source.pop("url", None)
        meta = {**original_meta, "title": job["title"], "theme": job["theme"]}
        for field, key in {"url": "url", "author": "author", "platform": "platform", "title": "source_title"}.items():
            if source.get(field):
                meta[key] = source[field]
        front = "---\n" + "\n".join(key + ": " + json.dumps(value, ensure_ascii=False) for key, value in meta.items()) + "\n---\n\n"
        (work_dir / "article.md").write_text(front + body, encoding="utf-8")
        # The SHA is of this exact editor snapshot, before metadata normalization.
        (work_dir / "snapshot.txt").write_bytes(raw_text.encode("utf-8"))
        # Always prefer this empty explicit local brand over any global settings.
        (work_dir / "brand.json").write_text("{}", encoding="utf-8")
        (work_dir / "metadata.json").write_text(json.dumps({
            "job_id": job["id"], "title": job["title"], "document_id": job["document_id"],
            "document_version": job["document_version"], "snapshot_sha256": job["snapshot_sha256"],
            "mode": job["mode"], "theme": job["theme"], "formats": job["formats"],
            "source": source, "created_at": job["created_at"],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        return source

    async def _create_plan(self, payload, job, work_dir):
        from media_planner import build_content_plan
        return await build_content_plan(payload["text"], job["title"], payload.get("source", {}),
                                        job["theme"], await self._settings(), self.http_client_factory, work_dir)

    async def _run_job(self, job: dict):
        payload = json.loads(self._row(job["id"])["input"])
        work_dir = self.jobs_dir / job["id"]
        payload["source"] = self._write_snapshot(work_dir, payload, job)
        content_input = work_dir / "article.md"
        warnings = []
        if job["mode"] == "summary":
            self._update(job["id"], only_running=True, phase="planning")
            await self._create_plan(payload, job, work_dir)
            content_input = work_dir / "content.json"
            if not content_input.is_file():
                raise ValueError("模型未生成有效的图文结构，请重试")
            warning_path = work_dir / "plan-warnings.json"
            if warning_path.is_file():
                values = json.loads(warning_path.read_text(encoding="utf-8"))
                if isinstance(values, dict):
                    values = values.get("warnings", [])
                if isinstance(values, list):
                    warnings.extend(str(value)[:400] for value in values[:30])
        for format_name in job["formats"]:
            self._update(job["id"], only_running=True, phase="rendering_" + format_name)
            layout = FORMAT_LAYOUTS[format_name]
            render_input = content_input
            if format_name == "wechat" and job["mode"] == "summary":
                await self._run_command(job["id"], ["export.mjs", str(content_input), "--theme", job["theme"], "--out", str(work_dir)], work_dir)
                render_input = work_dir / "rewrite.md"
                if not render_input.is_file():
                    raise ValueError("公众号改写稿导出失败，未找到 rewrite.md")
            args = ["render.mjs", str(render_input), "--layout", layout, "--theme", job["theme"],
                    "--out", str(work_dir / "outputs" / format_name), "--brand", str(work_dir / "brand.json")]
            if format_name == "cards":
                args.extend(["--ratio", "3:4"])
            await self._run_command(job["id"], args, work_dir)
            output_dir = work_dir / "outputs" / format_name
            if not any(path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                       for path in output_dir.rglob("*")):
                raise ValueError("未生成" + {"cards": "卡片", "long": "长图", "wechat": "公众号"}[format_name] + "图片，任务未完成")
            if not any(output_dir.rglob("qa.json")):
                raise ValueError("缺少排版验收报告，任务未完成，请重试")
        self._update(job["id"], only_running=True, phase="checking")
        warnings.extend(self._qa_warnings(work_dir))
        artifacts = self._collect_artifacts(job["id"], work_dir)
        if not any(item["kind"] == "image" for item in artifacts):
            raise ValueError("渲染未生成图片，任务未完成，请查看任务并重试")
        # ZIP inclusion comes from the same bounded manifest as file serving.
        self._create_archive(work_dir, artifacts)
        artifacts.append(self._artifact(job["id"], "results.zip", "archive"))
        (work_dir / "manifest.json").write_text(json.dumps(artifacts, ensure_ascii=False, indent=2), encoding="utf-8")
        self._update(job["id"], only_running=True, status="completed", phase="completed", finished_at=utc_now(),
                     warnings=list(dict.fromkeys(warnings))[:50], artifacts=artifacts, error="")

    async def _run_command(self, job_id: str, args: list[str], work_dir: Path):
        node = self._node_path()
        if not node:
            raise ValueError("未找到 Node.js 22，请安装后重试")
        command = [node, str(self.engine_dir / "scripts" / args[0]), *args[1:]]
        env = dict(os.environ)
        env["ARTICLE2MEDIA_CACHE"] = str(self.data_dir / "media-engine-cache")
        env["ARTICLE2MEDIA_CHROME"] = self._chrome_path() or ""
        process = await asyncio.create_subprocess_exec(
            *command, cwd=str(work_dir), env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        self._process = process
        communication = asyncio.create_task(process.communicate())
        try:
            output, _ = await asyncio.wait_for(asyncio.shield(communication), self.command_timeout)
            text = output.decode("utf-8", errors="replace")
            with (work_dir / "render.log").open("a", encoding="utf-8") as stream:
                stream.write(text[-128_000:] + "\n")
            if process.returncode:
                # Do not turn raw provider responses or process environment into
                # a user-visible error. These commands only receive file paths.
                messages = [line.strip() for line in text.splitlines() if re.search(r"[✗错误]|error|Error", line)]
                detail = "；".join(messages[-3:])[:500]
                raise ValueError("排版验收未通过" + ("：" + detail if detail else "，请缩短段落或换主题后重试"))
        except asyncio.TimeoutError:
            raise ValueError("渲染超过时间限制，已停止；请缩短稿件或减少输出格式") from None
        finally:
            await self._terminate_process(process)
            if not communication.done():
                try:
                    await asyncio.wait_for(communication, timeout=3)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    communication.cancel()
            self._process = None

    async def _terminate_process(self, process):
        # start_new_session gives this process and its headless Chrome children
        # their own process group; no existing user browser is touched.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            await process.wait()
        # Node may have exited before Chrome. Its process group can still exist.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def _qa_warnings(self, work_dir: Path) -> list[str]:
        warnings = []
        for path in (work_dir / "outputs").rglob("qa.json"):
            raw = json.loads(path.read_text(encoding="utf-8"))
            reports = raw if isinstance(raw, list) else [raw]
            if not reports or any(not isinstance(report, dict) for report in reports):
                raise ValueError("排版验收报告格式无效，任务未完成")
            for report in reports:
                issues = report.get("issues", [])
                if not isinstance(issues, list):
                    raise ValueError("排版验收报告格式无效，任务未完成")
                errors = [str(item.get("msg", "排版错误")) for item in issues
                          if isinstance(item, dict) and item.get("level") == "error"]
                if report.get("verify") == "fail":
                    errors.append("原文逐字校验未通过")
                if errors:
                    raise ValueError("排版检查未通过：" + "；".join(errors[:3])[:500])
                warnings.extend(str(item.get("msg", ""))[:400] for item in issues
                                if isinstance(item, dict) and item.get("level") in {"warn", "warning"})
        return warnings

    @staticmethod
    def _artifact(job_id: str, relative: str, kind: str) -> dict:
        url = "/api/media/jobs/" + job_id + "/files/" + quote(relative, safe="/")
        return {"name": relative, "path": relative, "kind": kind, "url": url, "download_url": url + "?download=true"}

    def _collect_artifacts(self, job_id, work_dir):
        extensions = {".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image",
                      ".html": "html", ".md": "text", ".txt": "text", ".json": "text"}
        artifacts = []
        for path in sorted(work_dir.rglob("*")):
            if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(work_dir.resolve()):
                continue
            relative = path.relative_to(work_dir).as_posix()
            if path.name not in {"article.md", "snapshot.txt", "metadata.json", "content.json", "rewrite.md", "plan-warnings.json"} and not relative.startswith(("outputs/", "rewrite-assets/")):
                continue
            kind = extensions.get(path.suffix.lower())
            if kind:
                artifacts.append(self._artifact(job_id, relative, kind))
        rank = {"image": 0, "html": 1, "archive": 2, "text": 3}
        artifacts.sort(key=lambda item: (rank[item["kind"]], item["path"] in {"metadata.json", "snapshot.txt"}, item["path"]))
        return artifacts

    def _create_archive(self, work_dir, artifacts):
        with zipfile.ZipFile(work_dir / "results.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for artifact in artifacts:
                path = work_dir / artifact["path"]
                if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(work_dir.resolve()):
                    archive.write(path, artifact["path"])

    async def cancel(self, job_id: str) -> dict:
        current = self.get(job_id)
        if current["status"] in TERMINAL:
            raise HTTPException(409, "任务已结束，无法取消")
        current = self._update(job_id, status="cancelled", phase="cancelled", finished_at=utc_now(), error="", artifacts=[])
        if self._active_job_id == job_id and self._active_task:
            self._active_task.cancel()
            if self._process:
                await self._terminate_process(self._process)
        return current

    async def retry(self, job_id: str) -> dict:
        row = self._row(job_id)
        if row["status"] not in {"failed", "cancelled"}:
            raise HTTPException(409, "仅失败或取消的任务可以重试")
        return await self.submit(MediaJobInput.model_validate(json.loads(row["input"])))

    def artifact_file(self, job_id: str, relative: str) -> tuple[Path, str]:
        job = self.get(job_id)
        path = PurePosixPath(relative)
        if not relative or path.is_absolute() or ".." in path.parts or "\\" in relative or "\x00" in relative:
            raise HTTPException(404, "产物文件不存在")
        found = next((item for item in job["artifacts"] if item["path"] == relative), None)
        if not found:
            raise HTTPException(404, "产物文件不存在")
        work_dir = (self.jobs_dir / job_id).resolve()
        file = work_dir.joinpath(*path.parts)
        if not file.resolve().is_relative_to(work_dir) or not file.is_file() or file.is_symlink():
            raise HTTPException(404, "产物文件不存在")
        return file, found["kind"]


def create_media_router(*, db_path, data_dir, model_settings_loader: Callable,
                        http_client_factory: Callable) -> APIRouter:
    manager = MediaJobManager(db_path, data_dir, model_settings_loader, http_client_factory)
    @asynccontextmanager
    async def lifespan(_app):
        await manager.start()
        try:
            yield
        finally:
            await manager.stop()

    router = APIRouter(prefix="/api/media", tags=["media"], lifespan=lifespan)
    router.media_manager = manager

    @router.get("/capabilities")
    async def capabilities():
        return await manager.capabilities()

    @router.post("/jobs", status_code=202)
    async def submit(payload: MediaJobInput):
        return await manager.submit(payload)

    @router.get("/jobs")
    async def jobs(document_id: str = Query(default="", max_length=160)):
        return {"items": manager.list(document_id)}

    @router.get("/jobs/{job_id}")
    async def detail(job_id: str):
        return manager.get(job_id)

    @router.post("/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        return await manager.cancel(job_id)

    @router.post("/jobs/{job_id}/retry", status_code=202)
    async def retry(job_id: str):
        return await manager.retry(job_id)

    @router.get("/jobs/{job_id}/files/{path:path}")
    async def files(job_id: str, path: str, download: bool = False):
        file, kind = manager.artifact_file(job_id, path)
        media_type = "text/html; charset=utf-8" if kind == "html" else (
            "text/plain; charset=utf-8" if kind == "text" else mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
        if kind == "html":
            headers["Content-Security-Policy"] = PREVIEW_CSP
        return FileResponse(file, media_type=media_type, filename=file.name,
                            content_disposition_type="attachment" if download else "inline", headers=headers)

    return router
