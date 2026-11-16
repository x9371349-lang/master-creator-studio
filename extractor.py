import re
import os
import json
from html import unescape
from typing import Tuple, Dict, Any, Optional
from urllib.parse import urlparse, parse_qs, unquote
import httpx

from article_source import ArticleParser

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9"
}

MOBILE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40 NetType/WIFI Language/zh_CN",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9"
}

def clean_html_text(html_fragment: str) -> str:
    if not html_fragment:
        return ""
    text = re.sub(r'<(script|style|noscript|svg)[^>]*>.*?</\1>', '', html_fragment, flags=re.S | re.I)
    text = re.sub(r'<br\s*/?>', '\n', text, flags=re.I)
    text = re.sub(r'</(p|div|h[1-6]|li|tr|section)>', '\n\n', text, flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    text = unescape(text)
    lines = [line.strip() for line in text.split('\n')]
    cleaned = []
    for line in lines:
        if line:
            cleaned.append(line)
    return '\n\n'.join(cleaned)

def extract_json_body(html_text: str, min_len: int = 40) -> str:
    patterns = [
        r'"content"\s*:\s*"((?:[^"\\]|\\.){100,})"',
        r'"article_content"\s*:\s*"((?:[^"\\]|\\.){100,})"',
        r'"htmlContent"\s*:\s*"((?:[^"\\]|\\.){100,})"',
        r'"body"\s*:\s*"((?:[^"\\]|\\.){100,})"',
        r'"desc"\s*:\s*"((?:[^"\\]|\\.){60,})"',
    ]
    best = ""
    for pat in patterns:
        for mm in re.finditer(pat, html_text):
            try:
                s = json.loads('"' + mm.group(1) + '"')
                cleaned = clean_html_text(s)
                if len(cleaned) > len(best):
                    best = cleaned
            except Exception:
                continue
    return best if len(best) >= min_len else ""

def parse_with_article_parser(html: str) -> Dict[str, str]:
    try:
        parser = ArticleParser()
        parser.feed(html)
        text = '\n\n'.join(line.strip() for line in ''.join(parser.body).splitlines() if line.strip())
        title = parser.meta.get('og:title') or ''.join(parser.title).strip() or ''
        author = parser.meta.get('og:article:author') or parser.meta.get('author') or ''
        return {'title': title, 'text': text, 'author': author}
    except Exception:
        return {'title': '', 'text': '', 'author': ''}

async def extract_wechat(url: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    # 1. Direct fetch with mobile headers
    try:
        resp = await client.get(url, headers=MOBILE_HEADERS, follow_redirects=True, timeout=10.0)
        if resp.status_code == 200:
            html = resp.text
            parsed = parse_with_article_parser(html)
            if parsed['text'] and len(parsed['text']) >= 50:
                return {
                    "title": parsed['title'] or "微信公众号文章",
                    "author": parsed['author'],
                    "text": parsed['text'],
                    "source": "微信公众号",
                    "url": str(resp.url)
                }
    except Exception:
        pass

    # 2. Fallback to Jina Reader
    jina_url = f"https://r.jina.ai/{url}"
    try:
        jresp = await client.get(jina_url, timeout=12.0)
        if jresp.status_code == 200 and len(jresp.text.strip()) > 60:
            content = jresp.text.strip()
            title_m = re.search(r'^Title:\s*(.+)$', content, re.M)
            title = title_m.group(1).strip() if title_m else "微信公众号文章"
            return {
                "title": title,
                "author": "",
                "text": content,
                "source": "微信公众号",
                "url": url
            }
    except Exception:
        pass

    raise ValueError("未能直接读取该微信文章正文（微信页面可能包含安全验证）。请直接复制文章完整正文后粘贴导入。")

async def extract_douyin(url: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    resp = await client.get(url, headers=MOBILE_HEADERS, follow_redirects=True, timeout=10.0)
    html = resp.text
    
    title_m = re.search(r'<title>(.*?)</title>', html, re.S)
    title = unescape(title_m.group(1).strip()) if title_m else "抖音视频"
    title = re.sub(r' - 抖音.*$', '', title).strip()
    
    desc_m = re.search(r'<meta name="description" content="(.*?)"', html) or re.search(r'<meta property="og:description" content="(.*?)"', html)
    desc = unescape(desc_m.group(1).strip()) if desc_m else ""
    
    text = desc if (desc and desc != title) else title
    return {
        "title": title[:40] if title else "抖音文案",
        "author": "",
        "text": text,
        "source": "抖音",
        "url": str(resp.url)
    }

async def extract_xiaohongshu(url: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    xhs_headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
    resp = await client.get(url, headers=xhs_headers, follow_redirects=True, timeout=10.0)
    html = resp.text
    
    title_m = re.search(r'<meta name="og:title" content="(.*?)"', html) or re.search(r'<title>(.*?)</title>', html)
    title = unescape(title_m.group(1).strip()) if title_m else "小红书笔记"
    title = re.sub(r' - 小红书.*$', '', title).strip()
    
    desc_m = re.search(r'<meta name="description" content="(.*?)"', html) or re.search(r'<meta name="og:description" content="(.*?)"', html)
    desc = unescape(desc_m.group(1).strip()) if desc_m else ""
    
    state_m = re.search(r'window\.__INITIAL_STATE__\s*=\s*({.*?});?</script>', html, re.S)
    if state_m:
        try:
            state_data = json.loads(state_m.group(1))
            note = state_data.get("note", {}).get("noteDetailMap", {})
            if note:
                first_note = list(note.values())[0].get("note", {})
                title = first_note.get("title") or title
                desc = first_note.get("desc") or desc
        except Exception:
            pass
            
    full_text = f"{title}\n\n{desc}".strip() if desc and desc != title else title
    return {
        "title": title,
        "author": "",
        "text": full_text,
        "source": "小红书",
        "url": str(resp.url)
    }

async def extract_bilibili(url: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=10.0)
    html = resp.text
    title_m = re.search(r'<title[^>]*>(.*?)</title>', html, re.S)
    title = unescape(title_m.group(1).strip()) if title_m else "B站视频"
    title = re.sub(r'_哔哩哔哩_bilibili.*$', '', title).strip()
    
    desc_m = re.search(r'<meta name="description" content="(.*?)"', html)
    desc = unescape(desc_m.group(1).strip()) if desc_m else ""
    
    return {
        "title": title,
        "author": "",
        "text": f"【视频简介】\n{desc}\n\n【视频标题】\n{title}" if desc else title,
        "source": "哔哩哔哩",
        "url": str(resp.url)
    }

async def extract_toutiao(url: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    # Check if this is a trending topic URL (e.g. toutiao.com/trending/...)
    parsed_url = urlparse(url)
    qs = parse_qs(parsed_url.query)
    title_from_param = ""
    if "title" in qs:
        title_from_param = unquote(qs["title"][0])
    elif "log_pb" in qs:
        try:
            log_data = json.loads(unquote(qs["log_pb"][0]))
            title_from_param = log_data.get("title", "")
        except Exception:
            pass

    if "/trending/" in parsed_url.path or "topic_id" in qs:
        topic_title = title_from_param or "头条热点"
        dossier = (
            f"# 【头条热搜话题档案】{topic_title}\n\n"
            f"> 📡 数据来源: 今日头条实时热点榜\n"
            f"> 🔗 话题链接: {url}\n\n"
            f"## 📌 核心事实与热点聚焦\n"
            f"围绕《{topic_title}》的实时讨论正在今日头条及全网持续升温。该话题汇聚了广大网友、媒体报道及各方当事人的最新回应。\n\n"
            f"## 💥 核心矛盾与大众痛点\n"
            f"1. **争议焦点**：事件中的核心冲突点与公众关注的利益关联；\n"
            f"2. **情绪投射**：引发读者强烈共鸣、吐槽或热议的情绪驱动因素；\n"
            f"3. **价值反思**：跳出事件表象，反观生活、职场或社会现实的深层启示。\n\n"
            f"## 🎯 深度二创创作路线\n"
            f"- **路线一（反差共情）**：以小见大，把热点事件同普通人的日常生活痛点无缝连接；\n"
            f"- **路线二（深度拆解）**：抽丝剥茧还原事件背后的真实利益与逻辑，提供认知增量；\n"
            f"- **路线三（态度鲜明）**：亮出独特观点，引发评论区激辩与二次传播。"
        )
        return {
            "title": topic_title,
            "author": "今日头条热点",
            "text": dossier,
            "source": "今日头条",
            "url": url
        }

    # For article pages
    resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=10.0)
    html = resp.text
    json_body = extract_json_body(html)
    if json_body:
        title_m = re.search(r'<title>(.*?)</title>', html, re.S)
        title = unescape(title_m.group(1).strip()) if title_m else (title_from_param or "头条文章")
        title = re.sub(r' - 今日头条.*$', '', title).strip()
        return {
            "title": title,
            "author": "",
            "text": json_body,
            "source": "今日头条",
            "url": str(resp.url)
        }

    return await extract_general(url, client)

async def extract_general(url: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    # 1. Try Jina reader first for high-quality clean markdown
    jina_url = f"https://r.jina.ai/{url}"
    try:
        resp = await client.get(jina_url, timeout=12.0)
        if resp.status_code == 200 and len(resp.text.strip()) > 50:
            content = resp.text.strip()
            title_m = re.search(r'^Title:\s*(.+)$', content, re.M)
            title = title_m.group(1).strip() if title_m else "网页提取文案"
            return {
                "title": title,
                "author": "",
                "text": content,
                "source": "网页提取",
                "url": url
            }
    except Exception:
        pass

    # 2. Direct fetch with ArticleParser and JSON body fallback
    resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=10.0)
    html = resp.text
    
    parsed = parse_with_article_parser(html)
    if parsed['text'] and len(parsed['text']) >= 50:
        return {
            "title": parsed['title'] or "网页文章",
            "author": parsed['author'],
            "text": parsed['text'],
            "source": "网页提取",
            "url": str(resp.url)
        }

    json_body = extract_json_body(html)
    if json_body:
        title_m = re.search(r'<title>(.*?)</title>', html, re.S)
        title = unescape(title_m.group(1).strip()) if title_m else "网页文章"
        return {
            "title": title,
            "author": "",
            "text": json_body,
            "source": "网页提取",
            "url": str(resp.url)
        }

    title_m = re.search(r'<title>(.*?)</title>', html, re.S)
    title = unescape(title_m.group(1).strip()) if title_m else "网页文章"
    body = clean_html_text(html)
    return {
        "title": title,
        "author": "",
        "text": body,
        "source": "网页提取",
        "url": url
    }

async def extract_from_url(url: str) -> Dict[str, Any]:
    url = url.strip()
    url_m = re.search(r'https?://[^\s<>"]+', url)
    if url_m:
        url = url_m.group(0)
    else:
        raise ValueError("未检测到有效的网址链接")
        
    proxy = os.environ.get("https_proxy") or os.environ.get("http_proxy")
    async with httpx.AsyncClient(timeout=15.0, proxy=proxy, trust_env=True) as client:
        if "mp.weixin.qq.com" in url:
            return await extract_wechat(url, client)
        elif "douyin.com" in url or "iesdouyin.com" in url:
            return await extract_douyin(url, client)
        elif "xiaohongshu.com" in url or "xhslink.com" in url:
            return await extract_xiaohongshu(url, client)
        elif "toutiao.com" in url:
            return await extract_toutiao(url, client)
        elif "bilibili.com" in url or "b23.tv" in url:
            return await extract_bilibili(url, client)
        else:
            return await extract_general(url, client)
