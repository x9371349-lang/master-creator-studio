import json
import os
import re
import time
import asyncio
import urllib.request
from typing import Any, Optional
import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from workspace_imports import enqueue_import, TextImport

router = APIRouter(prefix="/api/radar", tags=["radar"])

_CACHE = {
    "aihot": None,
    "aihot_ts": 0,
}

CACHE_TTL = 300  # 5 minutes

# 项目根目录：本文件所在目录。所有可配置路径默认相对它解析。
_RADAR_ROOT = os.path.dirname(os.path.abspath(__file__))

def _radar_path(env_key: str, default_rel: str) -> str:
    """环境变量优先，缺省回退到项目相对路径，保证跨机器可启动。"""
    return os.environ.get(env_key) or os.path.join(_RADAR_ROOT, default_rel)

WECHAT_10W_FILE = _radar_path("WECHAT_10W_FILE", os.path.join("data", "radar", "wechat_10w_articles.json"))


def fetch_url(url: str, timeout: int = 12) -> str:
    headers = {
        "User-Agent": "aihot-skill/2.0.0 (+https://aihot.news/aihot-skill/)",
        "Accept": "*/*"
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def parse_aihot_hot(content: str) -> list[dict]:
    items = []
    pattern = re.compile(
        r'第\s*(\d+)\s*名：\[(.*?)\]\((.*?)\)\s*\n\s*信源：(.*?)\s*\n\s*(?:来龙去脉：(.*?))?(?=\n第|\n\n|\Z)',
        re.DOTALL
    )
    for m in pattern.finditer(content):
        rank, title, url, sources, story = m.groups()
        items.append({
            "rank": int(rank),
            "title": title.strip(),
            "url": url.strip(),
            "sources": sources.strip(),
            "story_url": (story or "").strip()
        })
    return items


def parse_aihot_daily(content: str) -> dict:
    title_m = re.search(r'#\s*(AIHOT\s*日报[^\n]*)', content)
    daily_title = title_m.group(1).strip() if title_m else "AIHOT 每日早报"
    
    sections = []
    parts = re.split(r'【(.*?)】', content)
    for i in range(1, len(parts), 2):
        sec_name = parts[i].strip()
        sec_body = parts[i+1] if i+1 < len(parts) else ""
        item_pattern = re.compile(r'(\d+)\.\s*\[(.*?)\]\((.*?)\)(?:\s*·\s*([^\n]+))?\n\s+([^\n]+)')
        for im in item_pattern.finditer(sec_body):
            idx, title, url, src, desc = im.groups()
            sections.append({
                "category": sec_name,
                "title": title.strip(),
                "url": url.strip(),
                "source": (src or "").strip(),
                "summary": desc.strip()
            })
    return {"title": daily_title, "items": sections}


AIHOT_CACHE_FILE = _radar_path("AIHOT_CACHE_FILE", os.path.join("data", "radar", "aihot_cache.json"))

@router.get("/aihot")
async def get_aihot(refresh: bool = Query(False)):
    now = time.time()
    if not refresh and _CACHE["aihot"] and (now - _CACHE["aihot_ts"] < CACHE_TTL):
        return {"ok": True, "cached": True, **_CACHE["aihot"]}

    disk_data = None
    if os.path.exists(AIHOT_CACHE_FILE):
        try:
            with open(AIHOT_CACHE_FILE, "r", encoding="utf-8") as f:
                disk_data = json.load(f)
        except Exception:
            pass

    if not refresh and disk_data and (now - disk_data.get("_ts", 0) < CACHE_TTL):
        _CACHE["aihot"] = disk_data
        _CACHE["aihot_ts"] = now
        return {"ok": True, "cached": True, **disk_data}

    async def fetch_async(client, url):
        try:
            resp = await client.get(url, timeout=5.0)
            return resp.text if resp.status_code == 200 else ""
        except Exception:
            return ""

    headers = {
        "User-Agent": "aihot-skill/2.0.0 (+https://aihot.news/aihot-skill/)",
        "Accept": "*/*"
    }

    try:
        async with httpx.AsyncClient(headers=headers, timeout=6.0, trust_env=True) as client:
            hot_raw, daily_raw = await asyncio.gather(
                fetch_async(client, "https://aihot.news/api/v1/agent/hot"),
                fetch_async(client, "https://aihot.news/api/v1/agent/daily")
            )
            hot_items = parse_aihot_hot(hot_raw) if hot_raw else (disk_data.get("hot", []) if disk_data else [])
            daily_data = parse_aihot_daily(daily_raw) if daily_raw else (disk_data.get("daily", {"title": "AIHOT 每日早报", "items": []}) if disk_data else {"title": "AIHOT 每日早报", "items": []})
    except Exception:
        hot_items = disk_data.get("hot", []) if disk_data else []
        daily_data = disk_data.get("daily", {"title": "AIHOT 每日早报", "items": []}) if disk_data else {"title": "AIHOT 每日早报", "items": []}

    res = {
        "hot": hot_items,
        "daily": daily_data,
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "_ts": now
    }
    _CACHE["aihot"] = res
    _CACHE["aihot_ts"] = now

    try:
        os.makedirs(os.path.dirname(AIHOT_CACHE_FILE), exist_ok=True)
        with open(AIHOT_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

    return {"ok": True, "cached": False, **res}


class AihotImportReq(BaseModel):
    title: str
    url: Optional[str] = ""
    summary: Optional[str] = ""
    sources: Optional[str] = ""
    story_url: Optional[str] = ""
    kind: Optional[str] = "aihot"


def create_radar_router(db_path: str):
    @router.post("/aihot/import")
    def import_aihot(req: AihotImportReq):
        # If there's a story URL, try to fetch detail text for background
        story_details = ""
        if req.story_url:
            try:
                story_details = fetch_url(req.story_url, timeout=8)
            except Exception:
                pass

        doc_parts = [
            f"# {req.title}",
            "",
            f"> 📡 数据来源: AIHOT 热点雷达",
            f"> 🔗 原文链接: {req.url}" if req.url else "",
            f"> 📰 报道信源: {req.sources}" if req.sources else "",
            "",
            "## 核心速览",
            req.summary or "暂无详细摘要，请结合信源与来龙去脉创作。",
            ""
        ]

        if story_details:
            doc_parts.extend([
                "---",
                "## 事件来龙去脉与报道梳理",
                story_details,
                ""
            ])

        doc_parts.extend([
            "---",
            "## 二创思路与选题切入点",
            "- **公众认知**: 这件事对行业、普通从业者或用户有什么直接冲击？",
            "- **深层博弈**: 背后各方利益或技术更迭的关键矛盾在哪里？",
            "- **观点输出**: 结合卡兹克风格/个人观点，给出独特的洞察与研判。",
            ""
        ])

        full_text = "\n".join(p for p in doc_parts if p)

        payload = TextImport(
            transcript=full_text,
            title=req.title,
            source={
                "url": req.url or req.story_url,
                "author": "AIHOT",
                "platform": "AIHOT 热点",
                "content_kind": "hot_topic",
                "source_confirmed": True,
                "extraction_state": "aihot"
            },
            make_draft=True
        )
        result = enqueue_import(db_path, payload)
        return {**result, "title": req.title}

    @router.get("/wechat10w")
    def get_wechat_10w(category: str = Query("")):
        if not os.path.exists(WECHAT_10W_FILE):
            return {"ok": False, "items": [], "categories": [], "error": "10w+ 数据文件未找到"}

        try:
            with open(WECHAT_10W_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            raw_articles = data.get("articles", [])
            categories = set()
            normalized = []
            for art in raw_articles:
                cat = art.get("type") or art.get("category") or "总排名"
                categories.add(cat)
                if category and category != "全部" and cat != category:
                    continue
                normalized.append({
                    "title": art.get("title", ""),
                    "account_name": art.get("userName", ""),
                    "account_id": art.get("accountId", ""),
                    "avatar": art.get("userHeadUrl", ""),
                    "cover": art.get("coverUrl", ""),
                    "clicks": art.get("clicksCount", "10w+"),
                    "likes": art.get("likeCount", "0"),
                    "shares": art.get("shareCount", "0"),
                    "comments": art.get("commentCount", "0"),
                    "summary": (art.get("summary") or art.get("content") or "")[:200],
                    "content": art.get("content") or "",
                    "url": art.get("oriUrl", ""),
                    "pub_time": art.get("publicTime", ""),
                    "category": cat
                })
            return {
                "ok": True,
                "categories": ["全部"] + sorted(list(categories)),
                "items": normalized,
                "total": len(normalized)
            }
        except Exception as e:
            return {"ok": False, "items": [], "categories": [], "error": str(e)}

    class Wechat10wImportReq(BaseModel):
        title: str
        url: Optional[str] = ""
        summary: Optional[str] = ""
        content: Optional[str] = ""
        account_name: Optional[str] = ""
        clicks: Optional[str] = "10w+"
        category: Optional[str] = ""

    @router.post("/wechat10w/import")
    def import_wechat_10w(req: Wechat10wImportReq):
        body_text = req.content if (req.content and len(req.content) > 50) else req.summary

        doc_parts = [
            f"# {req.title}",
            "",
            f"> 来源公众号: **{req.account_name}** · 阅读量: **{req.clicks}**",
            f"> 原文链接: {req.url}" if req.url else "",
            "",
            "## 原文核心内容",
            body_text or "（等待抓取完整正文或直接基于爆款选题重写）",
            "",
            "---",
            "## 10w+ 拆解与重构要点",
            "1. **爆款标题公式**: 拆解原标题吸引点击的心理钩子与悬念设置；",
            "2. **情绪与认同**: 原文引发受众共鸣的核心情绪（焦虑/好奇/获得感/愤慨）；",
            "3. **二创重构路线**: 保留核心论点，替换为自身案例或个人风格重写。",
            ""
        ]

        full_text = "\n".join(doc_parts)
        payload = TextImport(
            transcript=full_text,
            title=req.title,
            source={
                "url": req.url,
                "author": req.account_name,
                "platform": "微信10w+爆文",
                "content_kind": "wechat_10w",
                "source_confirmed": True,
                "extraction_state": "wechat_10w"
            },
            make_draft=True
        )
        result = enqueue_import(db_path, payload)
        return {**result, "title": req.title}

    return router
