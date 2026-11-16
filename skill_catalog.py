"""Read-only discovery of installed skill documents.

Discovery is not execution: a present document or command never means a
workflow, network connection, account, or publishing permission was verified.
Only SKILL.md files are read. References, scripts, credentials and user data
are not opened by this module.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
from typing import Iterable


STAGES = ("read", "topic", "write", "review", "visual", "media", "publish", "feedback", "general")
MAX_DOCUMENT_BYTES = 256_000
MAX_READ_CHARS = 20_000
MAX_SKILLS = 1_000
MAX_DIRECTORIES = 4_000
MAX_DEPTH = 12
MAX_ISSUES = 300
_SKIP_DIRS = {".git", ".svn", "__pycache__", "node_modules", ".venv", "venv", ".cache"}
_COMMANDS = {
    "agent-reach", "bsk", "cloudl", "clasp", "codex", "curl", "docker", "ffmpeg", "ffprobe",
    "gh", "git", "hyperframes", "manim", "mcporter", "node", "npm", "npx", "opencli",
    "pandoc", "python", "python3", "say", "swift", "tesseract", "uci", "uv", "uvx", "wewrite", "xcrun", "yt-dlp",
}
_STAGE_TERMS = {
    "read": ("intake", "fetch", "download", "extract", "transcript", "research", "search", "scrape", "热榜", "抓取", "采集", "检索", "读取", "转录", "搜榜", "扫榜", "素材研究"),
    "topic": ("topic", "title", "hook", "选题", "标题", "钩子"),
    "write": ("writer", "writing", "rewrite", "story", "写作", "创作", "改写", "二创", "文案", "小说", "编剧", "续写", "成稿"),
    "review": ("review", "check", "diagnos", "审稿", "检查", "质检", "校验", "诊断", "去ai味", "去 ai 味", "去ai痕迹"),
    "visual": ("image", "illustrat", "cover", "poster", "photo", "pose", "visual", "封面", "配图", "插图", "图像", "图片", "海报", "画风", "视觉", "图型", "漫画", "手绘"),
    "media": ("video", "audio", "tts", "hyperframes", "motion", "animation", "subtitle", "caption", "render", "剪辑", "视频", "动画", "配音", "分镜", "字幕", "口播"),
    "publish": ("publish", "md2wechat", "发布", "上传", "草稿箱", "排版"),
    "feedback": ("stats", "analytics", "feedback", "复盘", "数据分析", "数据回流", "反馈", "自学习", "写作偏好"),
}


def default_roots() -> tuple[Path, ...]:
    """Known installation roots; no directory is inferred from a document."""
    home = Path.home()
    return (
        home / ".codex/skills",
        home / ".agents/skills",
        home / ".gemini/config/skills",
        home / "wewrite/skills",
        home / ".gemini/antigravity/scratch/cloudownloader/skills",
        home / "Desktop/codex/universal-content-intake",
        home / ".gemini/antigravity/scratch/pose-reference",
        home / ".gemini/antigravity/scratch/yajutang-antigravity/skills/yajutang-pinterest-publisher",
        home / ".gemini/antigravity/scratch/chatgpt-pool/fpbrowser2api/skills/chatgpt-image-gen",
        Path(__file__).resolve().parent / "vendor/article2media/skills",
    )


def _inside(path: Path, roots: Iterable[Path]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def _id(path: Path) -> str:
    return "host:" + hashlib.sha256(os.fsencode(str(path))).hexdigest()[:24]


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            return str(json.loads(value))
        except ValueError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def _metadata(text: str, fallback: str) -> tuple[str, str, str]:
    """Parse only useful top-level scalar YAML fields, without YAML objects."""
    lines = text.lstrip("\ufeff").splitlines()
    values: dict[str, str] = {}
    if lines and lines[0].strip() == "---":
        end = next((n for n in range(1, len(lines)) if lines[n].strip() == "---"), len(lines))
        i = 1
        while i < end:
            match = re.match(r"^([A-Za-z][\w-]*):\s*(.*)$", lines[i])
            if not match:
                i += 1
                continue
            key, value = match.groups()
            i += 1
            if value in {"|", ">", "|-", ">-", "|+", ">+"} or not value:
                pieces = []
                while i < end and (not lines[i].strip() or lines[i][0].isspace()):
                    pieces.append(lines[i].strip())
                    i += 1
                value = " ".join(piece for piece in pieces if piece)
            values[key] = _unquote(value)
    heading = next((line.lstrip("# ").strip() for line in lines if re.match(r"^#\s+\S", line)), "")
    name = (values.get("name") or fallback or heading or "未命名技能").strip()
    description = (values.get("description") or heading or name).strip()
    return name[:240], description[:1_600], values.get("allowed-tools", "")


def _stages(name: str, description: str) -> list[str]:
    text = (name + " " + description).lower()
    found = [stage for stage, terms in _STAGE_TERMS.items() if any(term in text for term in terms)]
    return found or ["general"]


def _availability(text: str, allowed_tools: str, accessible: bool) -> tuple[str, dict]:
    # Keep dependency observations small. Do not retain command arguments,
    # inline configuration, shell snippets, or executable paths from documents.
    sample = text[:32_000]
    mentioned = []
    for command in sorted(_COMMANDS):
        if re.search(r"(?<![\w-])" + re.escape(command) + r"(?=\s|`|$)", sample):
            mentioned.append({"name": command, "present": shutil.which(command) is not None})
    tool_backed = bool(allowed_tools or mentioned or re.search(
        r"image_gen|imagegen|image[- ]generation|mcp[_:.]|browser|浏览器|图像生成|图片生成|生成图片|生成图像|publish(?:ing)?|上传到|发布到|草稿箱|scripts/[^\s`]+\.(?:py|js|mjs|sh)\b", sample, re.I))
    mode = "requires_tool" if tool_backed else "prompt_only"
    workflow = bool(re.search(r"workflow|pipeline|orchestrat|统一.*入口|总控|全流程|主流程", sample[:8_000], re.I))
    return ("workflow" if workflow else "tool" if tool_backed else "prompt"), {
        "document_accessible": accessible,
        "execution": mode,
        "runtime_verified": False,
        "runtime_state": "not_checked" if tool_backed else "document_only",
        "commands": mentioned,
        "note": "仅发现技能文档及本机命令，尚未验证运行、账号、外部连接或操作权限。" if tool_backed else "可按需读取指令；本目录不执行技能，也不授予对外操作权限。",
    }


def _roots(values: Iterable[os.PathLike | str] | None) -> tuple[list[Path], list[dict]]:
    roots, issues, seen = [], [], set()
    if isinstance(values, (str, os.PathLike)):
        values = (values,)
    for supplied in default_roots() if values is None else values:
        p = Path(supplied).expanduser()
        try:
            canonical = p.resolve(strict=True)
            if not canonical.is_dir():
                raise NotADirectoryError()
        except (OSError, RuntimeError):
            issues.append({"code": "root_unavailable", "path": str(p), "message": "技能目录不存在或不可读取。"})
            continue
        if canonical not in seen:
            roots.append(canonical)
            seen.add(canonical)
    return roots, issues


def _read_document(path: Path, roots: list[Path], max_bytes: int = MAX_DOCUMENT_BYTES) -> tuple[str, int]:
    canonical = path.resolve(strict=True)
    if not _inside(canonical, roots):
        raise ValueError("技能路径超出已登记目录。")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(canonical, flags)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("技能文档不是普通文件。")
        data = source.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("技能文档超过读取大小限制。")
    if b"\x00" in data:
        raise ValueError("技能文档编码不受支持。")
    return data.decode("utf-8-sig"), info.st_size


def _unavailable_metadata(path: Path, roots: list[Path]) -> dict | None:
    """Bounded, non-executable metadata for a document that cannot be loaded.

    This record is deliberately outside ``skills``. A router must never load a
    truncated rule set as a usable instruction or treat the prefix as a prompt.
    """
    try:
        canonical = path.resolve(strict=True)
        if not _inside(canonical, roots):
            return None
        fd = os.open(canonical, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                return None
            prefix = source.read(8_192)
    except (OSError, RuntimeError):
        return None
    metadata = "" if b"\x00" in prefix else prefix.decode("utf-8-sig", errors="replace")
    name, description, tools = _metadata(metadata, path.parent.name)
    kind, availability = _availability(metadata, tools, False)
    availability.update(document_state="unavailable", runtime_state="unavailable", note="仅记录目录元数据，文档未完整加载，不能作为执行指令。")
    return {"id": _id(canonical), "name": name, "description": description,
            "path": str(canonical), "stages": _stages(name, description), "kind": kind,
            "bytes": info.st_size, "availability": availability}


def discover_skills(roots: Iterable[os.PathLike | str] | None = None) -> dict:
    """Discover current documents without importing or executing any skill.

    Symlinks are followed only into a registered root. Canonical directories
    and documents are visited once, so aliases and cycles cannot multiply the
    catalog. Same-name skills at distinct real locations remain separate.
    """
    allowed, issues = _roots(roots)
    result, unavailable, seen_dirs, seen_files = [], [], set(), set()
    duplicate_paths = 0
    limited = False

    def issue(code: str, path: Path, message: str) -> None:
        if len(issues) < MAX_ISSUES:
            issues.append({"code": code, "path": str(path), "message": message})

    stack = [(root, 0) for root in reversed(allowed)]
    while stack:
        directory, depth = stack.pop()
        if len(seen_dirs) >= MAX_DIRECTORIES or len(result) >= MAX_SKILLS:
            limited = True
            break
        try:
            real_dir = directory.resolve(strict=True)
        except (OSError, RuntimeError):
            issue("unreadable_path", directory, "目录或符号链接当前不可访问。")
            continue
        if not _inside(real_dir, allowed):
            issue("outside_root", directory, "符号链接指向未登记的目录，未读取。")
            continue
        if real_dir in seen_dirs:
            duplicate_paths += 1
            continue
        seen_dirs.add(real_dir)
        try:
            entries = sorted(os.scandir(directory), key=lambda e: e.name.casefold())
        except OSError:
            issue("unreadable_path", directory, "技能目录不可读取。")
            continue
        children = []
        for entry in entries:
            candidate = Path(entry.path)
            if entry.name == "SKILL.md":
                try:
                    real_file = candidate.resolve(strict=True)
                    if not _inside(real_file, allowed):
                        issue("outside_root", candidate, "技能链接超出已登记目录，未读取。")
                        continue
                    if real_file in seen_files:
                        duplicate_paths += 1
                        continue
                    seen_files.add(real_file)
                    body, size = _read_document(real_file, allowed)
                except (OSError, UnicodeError, RuntimeError, ValueError) as exc:
                    issue("document_unavailable", candidate, "技能文档无法安全读取或超过大小限制。")
                    record = _unavailable_metadata(candidate, allowed)
                    if record is not None:
                        unavailable.append(record)
                    continue
                name, description, tools = _metadata(body, candidate.parent.name)
                kind, availability = _availability(body, tools, True)
                item = {
                    "id": _id(real_file), "name": name, "description": description,
                    "path": str(real_file), "stages": _stages(name, description),
                    "kind": kind, "availability": availability,
                    "source_root": str(next(root for root in allowed if _inside(real_file, [root]))),
                    "bytes": size,
                }
                result.append(item)
                if len(result) >= MAX_SKILLS:
                    limited = bool(stack or children)
                    break
            elif entry.name not in _SKIP_DIRS and (not entry.name.startswith(".") or entry.name == ".system"):
                try:
                    # is_dir follows a symlink, but no content is read until its
                    # resolved destination passes the registered-root check.
                    if entry.is_dir():
                        if depth >= MAX_DEPTH:
                            limited = True
                            issue("depth_limit", candidate, "超过目录扫描深度，未继续读取。")
                        else:
                            children.append((candidate, depth + 1))
                    elif entry.is_symlink() and not entry.is_file():
                        issue("unreadable_path", candidate, "符号链接已失效。")
                except OSError:
                    issue("unreadable_path", candidate, "技能路径不可读取。")
        stack.extend(reversed(children))

    result.sort(key=lambda item: (item["name"].casefold(), item["path"]))
    by_name: dict[str, list[str]] = {}
    for item in result:
        by_name.setdefault(item["name"].casefold(), []).append(item["id"])
    for item in result:
        peers = by_name[item["name"].casefold()]
        if len(peers) > 1:
            item["same_name_ids"] = [value for value in peers if value != item["id"]]
    return {
        "skills": result, "unavailable": unavailable,
        "counts": {"total": len(result), "by_stage": {stage: sum(stage in item["stages"] for item in result) for stage in STAGES},
                   "prompt_only": sum(item["availability"]["execution"] == "prompt_only" for item in result),
                   "requires_tool": sum(item["availability"]["execution"] == "requires_tool" for item in result),
                   "duplicate_paths_skipped": duplicate_paths, "unavailable": len(unavailable),
                   "discovered_documents": len(result) + len(unavailable), "issues": len(issues)},
        "issues": issues, "roots": [str(root) for root in allowed], "scan_limited": limited,
    }


def read_skill(skill_id: str, roots: Iterable[os.PathLike | str] | None = None, max_chars: int = MAX_READ_CHARS) -> str:
    """Read one currently discovered ID. Never accepts a caller-supplied path.

    Oversized instructions are rejected rather than truncated: truncating a
    document could remove its constraints or permission requirements.
    """
    if not isinstance(skill_id, str) or not re.fullmatch(r"host:[a-f0-9]{24}", skill_id):
        raise ValueError("技能 ID 无效。请从当前技能目录选择。")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or not 1 <= max_chars <= MAX_READ_CHARS:
        raise ValueError("技能读取预算需在 1 到 20000 字符之间。")
    supplied = None if roots is None else tuple(roots)
    catalog = discover_skills(supplied)
    item = next((item for item in catalog["skills"] if item["id"] == skill_id), None)
    if item is None:
        raise ValueError("技能当前不可用，请刷新技能目录。")
    allowed, _ = _roots(supplied)
    try:
        body, _ = _read_document(Path(item["path"]), allowed)
    except (OSError, UnicodeError, RuntimeError, ValueError) as exc:
        raise ValueError("技能文档当前无法安全读取。") from exc
    if len(body) > max_chars:
        raise ValueError("完整技能指令超过本次读取预算，未截断加载。")
    return body
