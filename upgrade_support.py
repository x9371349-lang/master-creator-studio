"""Local candidate recovery and opt-in, measured draft length notices.

These helpers never read or save a workspace and never call a model. Length
requirements come only from the client's explicit length_request field, not
from source documents, assistant defaults, or earlier model responses.
"""
from datetime import datetime
import re
import unicodedata
import uuid


MAX_RECOVERY_CHARS = 100_000
_PROTOCOL = re.compile(r"<<<\s*(?:FILE|EDIT|OLD|NEW|END)\b", re.I)
_RANGE = re.compile(r"(?<![\d.])([0-9]{1,6})\s*(?:字\s*)?[-–—~～至到]\s*([0-9]{1,6})\s*字")
_TARGET = re.compile(r"(?<![\d.])(?P<approx>约|大约|大概)?\s*(?P<n>[0-9]{1,6})\s*字(?P<around>左右|上下)?")
_HEADING = re.compile(r"^[ \t]{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$")
_APPENDIX = re.compile(r"^(?:置顶评论|拍摄建议|拍摄备注|拍摄提示|发布说明|发布建议|制作备注|镜头建议|分镜建议|音效建议|修改说明|待核项|来源说明|诊断表|红队自查)(?:\s*[:：].*)?$")
_ARTICLE_SCENES = {"wechat", "xiaohongshu", "visual", "review"}


def make_recovered_draft(payload):
    """Create a new candidate from already confirmed plain manuscript text."""
    if not isinstance(payload, dict) or set(payload) - {"text", "title"}:
        raise ValueError("恢复请求只能包含已确认的正文 text 和可选标题 title")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("请先确认需要恢复的非空正文")
    if len(text) > MAX_RECOVERY_CHARS:
        raise ValueError("恢复正文不能超过 100000 字符")
    if _PROTOCOL.search(text):
        raise ValueError("请提取并确认纯正文后恢复，不要提交 FILE / EDIT 协议标记")
    if "\x00" in text:
        raise ValueError("恢复正文包含无效字符")
    supplied_title = payload.get("title", "")
    if not isinstance(supplied_title, str):
        raise ValueError("恢复标题必须是文字")
    title = unicodedata.normalize("NFC", supplied_title)
    title = "".join(char for char in title if not unicodedata.category(char).startswith("C"))
    title = re.sub(r"[/\\<>:\"|?*]", "-", title)
    title = re.sub(r"\s+", " ", title).strip(" ._-\t\r\n")
    title = re.sub(r"\.md$", "", title, flags=re.I).strip(" ._-")[:100] or "恢复正文"
    suffix = uuid.uuid4().hex
    # Titles are also unique: the legacy operation engine matches by title.
    title = f"{title}-{suffix[:12]}"
    folder = f"二创稿/手动恢复-{suffix}"
    now = datetime.now().isoformat()
    text = text.strip()
    return {
        "id": f"doc-{suffix}", "title": title, "folderId": folder,
        "path": f"{folder}/{title}.md", "text": text, "kind": "manual-recovery",
        "version": 1,
        "versions": [{"version": 1, "text": text, "kind": "manual-recovery", "createdAt": now}],
        "createdAt": now, "updatedAt": now,
    }


def explicit_length_requirement(request):
    """Parse one unambiguous range or numeric target; never invent a default."""
    if not isinstance(request, str) or len(request) > 2000:
        return None
    # Defense against accidentally passing a whole prompt instead of its target.
    request = re.split(r"【(?:只读来源|引用|当前文档)[^】]*】|以下\s*JSON\s*仅是只读来源", request, maxsplit=1)[0]
    request = re.sub(r"```.*?```", "", request, flags=re.S)
    ranges = list(_RANGE.finditer(request))
    targets = [match for match in _TARGET.finditer(request)
               if not any(start.start() <= match.start() < start.end() for start in ranges)]
    if len(ranges) + len(targets) != 1:
        return None
    if ranges:
        minimum, maximum = map(int, ranges[0].groups())
    else:
        match = targets[0]
        target = int(match["n"])
        approximate = bool(match["approx"] or match["around"])
        minimum = target * 9 // 10 if approximate else target
        maximum = (target * 11 + 9) // 10 if approximate else target
    if not 1 <= minimum <= maximum <= 100_000:
        return None
    return {"min": minimum, "max": maximum}


def length_count_mode(workflow=None):
    return "article" if (workflow or {}).get("scene_id") in _ARTICLE_SCENES else "spoken"


def manuscript_body(text, count_mode="spoken"):
    """Keep article headings; remove only explicitly labelled spoken appendices."""
    if count_mode == "article":
        return text
    lines, skipping_level = [], None
    for line in text.splitlines():
        heading = _HEADING.match(line)
        if heading:
            level = len(heading[1])
            # Ignore decorative emoji and Markdown bold around labels.
            label = heading[2].strip("* _")
            label = re.sub(r"^[^\w\u3400-\u9fff]+\s*", "", label)
            if _APPENDIX.fullmatch(label):
                skipping_level = level
                continue
            if skipping_level is not None and level <= skipping_level:
                skipping_level = None
        if skipping_level is None:
            lines.append(line)
    return "\n".join(lines)


def count_manuscript(text, count_mode="spoken"):
    # Python strings count Unicode code points, including punctuation, emoji,
    # and Markdown symbols. U+FEFF is treated as whitespace consistently.
    return sum(not char.isspace() and char != "\ufeff"
               for char in manuscript_body(text, count_mode))


def requested_length(payload, workflow=None):
    if payload.get("length_policy", payload.get("lengthPolicy")) != "draft":
        return None
    if workflow and workflow.get("stage") != "draft":
        return None
    return explicit_length_requirement(payload.get("length_request", payload.get("lengthRequest")))


def annotate_draft_lengths(applied, payload, workflow=None):
    """Attach a requirement to produced drafts and warn without rejecting them."""
    requirement = requested_length(payload, workflow)
    if not requirement:
        return []
    count_mode = length_count_mode(workflow)
    changed = {}
    for change in applied.get("changes", []):
        if change.get("status") == "applied" and isinstance(change.get("after"), str):
            # Several edits may touch one draft; evaluate its final content once.
            changed[change.get("draftId") or change.get("path")] = change
    warnings = []
    for index, draft in enumerate(applied.get("drafts", [])):
        key = draft.get("id") if draft.get("id") in changed else draft.get("path")
        if key not in changed:
            continue
        annotated = dict(draft, lengthRequirement=dict(requirement), lengthCountMode=count_mode)
        applied["drafts"][index] = annotated
        actual = count_manuscript(draft.get("text", ""), count_mode)
        if not requirement["min"] <= actual <= requirement["max"]:
            warnings.append({"draftId": draft.get("id"), "path": draft.get("path", ""),
                **requirement, "actual": actual,
                "message": f"正文实测 {actual} 字，目标 {requirement['min']}–{requirement['max']} 字；稿件已保留，可自行调整。"})
    return warnings
