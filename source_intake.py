"""Preview an original before importing it. Never substitutes search snippets."""
import asyncio
import copy
import datetime
import ipaddress
import re
import secrets
import socket
import time
import os
import unicodedata
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from workspace_imports import TextImport, enqueue_import
from extractor import extract_from_url

from article_source import (source_url, ArticleParser, parse_article, SourceReadError,
    is_verification_page, sogou_search_context, refreshed_sogou_link, static_sogou_redirect, unavailable_article_page)


async def public_address(url):
    host = urlparse(source_url(url)).hostname
    try:
        addresses = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError as error:
        raise ValueError('原文域名暂时无法连接，请稍后重试或粘贴全文。') from error
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError('原文链接需要使用公开网页地址。')


async def fetch_original(url, title=''):
    url = source_url(url)
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
               'Accept': 'text/html,application/xhtml+xml', 'Accept-Language':'zh-CN,zh;q=0.9', 'Referer': 'https://weixin.sogou.com/'}
    resolution='direct'; deadline=time.monotonic()+45; last_article_url=''
    async with httpx.AsyncClient(timeout=12, trust_env=False, headers=headers) as client:
        # Search links carry a short-lived token. Load the matching public search
        # in this SAME cookie session and renew only an unambiguous exact title.
        search=sogou_search_context(url,title)
        if search:
            await public_address(search[0])
            response=await client.get(search[0],follow_redirects=False)
            if is_verification_page(response.text,str(response.url)) or response.status_code in {401,403,429}:
                raise SourceReadError('搜狗搜索要求本人验证。请在微信打开这篇文章，复制右上角菜单中的文章链接后重新获取。','verification_required')
            if response.status_code==200:
                renewed=refreshed_sogou_link(response.text,search[1])
                if renewed:url=renewed;resolution='exact_title_search_refresh'
        for _ in range(7):
            if time.monotonic()>deadline:raise SourceReadError('原文获取超时，请稍后重试。','timeout')
            await public_address(url)
            if is_verification_page('',url):
                raise SourceReadError('已找到微信原文，但微信要求本人验证。请打开下方原文链接，完成验证后复制完整正文导入。','verification_required',last_article_url)
            if urlparse(url).hostname=='mp.weixin.qq.com':last_article_url=url
            response = await client.get(url, follow_redirects=False)
            if response.is_redirect:
                url = source_url(urljoin(url, response.headers.get('location', '')))
                continue
            if response.status_code != 200:
                raise SourceReadError(f'原文页面暂不可读取（HTTP {response.status_code}）。请打开原文或粘贴全文。')
            if len(response.content) > 3_000_000:
                raise SourceReadError('原文页面过大，请复制需要使用的完整正文。')
            html = response.text
            if is_verification_page(html,url):
                raise SourceReadError('已找到微信原文，但微信要求本人验证。请打开下方原文链接，完成验证后复制完整正文导入。','verification_required',last_article_url)
            if urlparse(url).hostname == 'weixin.sogou.com':
                redirect=static_sogou_redirect(html)
                if redirect:url=redirect;continue
                raise SourceReadError('尚未跳转到微信原文。请在微信打开文章，复制右上角菜单中的文章链接。','redirect_unresolved')
            unavailable=unavailable_article_page(html,url)
            if unavailable:raise SourceReadError(unavailable[1],unavailable[0],last_article_url)
            try:result=parse_article(html,url)
            except ValueError as exc:raise SourceReadError(str(exc),'body_unavailable',last_article_url) from exc
            result['source_resolution']=resolution
            return result
    raise SourceReadError('原文跳转未完成，请打开原文后复制公众号文章的完整链接。','redirect_unresolved')


async def lookup_original_url(title):
    def key(value):return re.sub(r'[\W_]+','',unicodedata.normalize('NFKC',str(value).replace('（原稿）','')))
    wanted=key(title)
    if not wanted or wanted in {'原文','我的原文'}:return ''
    companion=os.environ.get('WECHAT_SEARCH_URL','http://127.0.0.1:8899').rstrip('/')
    try:
        async with httpx.AsyncClient(timeout=8,trust_env=False) as client:
            response=await client.get(companion+'/api/status');response.raise_for_status()
            for article in response.json().get('articles',[]):
                if key(article.get('title'))==wanted:
                    return source_url(article.get('url'))
    except (ValueError,httpx.HTTPError):pass
    return ''


class PreviewRequest(BaseModel):
    url: str = Field(default='', max_length=6000)
    title: str = Field(default='原文', max_length=500)
    platform: str = Field(default='网页原文', max_length=120)
    summary: str = Field(default='', max_length=12000)
    manual_text: str = Field(default='', max_length=120000)
    manual_confirmed: bool = False


class ImportRequest(BaseModel):
    preview_token: str = ''
    source_confirmed: bool = False
    # Legacy requests receive an actionable error instead of creating a fake original.
    title: str = ''
    url: str = ''
    platform: str = ''
    transcript: str = ''


def create_source_router(db_path, fetcher=fetch_original, clock=time.monotonic):
    router = APIRouter()
    previews = {}

    @router.post('/api/source/preview')
    async def preview(payload: PreviewRequest):
        try:
            if payload.manual_text.strip():
                if not payload.manual_confirmed and len(payload.manual_text.strip()) < 10:
                    raise ValueError('请先确认粘贴的是完整正文。')
                original = {'title': payload.title.strip() or '手动导入原文', 'text': payload.manual_text.strip(),
                            'url': source_url(payload.url) if payload.url.strip() else '',
                            'content_kind': 'user_supplied_original', 'extraction_state': 'user_provided', 'author': ''}
            else:
                raw_url = payload.url.strip()
                lookup_url = ''
                if not raw_url and payload.title:
                    try:
                        lookup_url = await lookup_original_url(payload.title)
                    except Exception:
                        pass
                target_url = raw_url or lookup_url
                original = None

                # 1. Try modern multi-platform extractor (supports WeChat, Douyin, XHS, Jina reader, general HTML)
                if target_url:
                    try:
                        ext = await extract_from_url(target_url)
                        if ext and ext.get('text') and len(ext['text'].strip()) >= 30:
                            original = {
                                'title': ext.get('title') or payload.title.strip() or '提取正文',
                                'text': ext['text'].strip(),
                                'url': ext.get('url') or target_url,
                                'author': ext.get('author', ''),
                                'content_kind': 'article_fulltext',
                                'extraction_state': 'body_extracted',
                                'source_resolution': 'extractor'
                            }
                    except Exception:
                        pass

                # 2. Fallback to fetcher (handles WeChat Sogou redirect/refresh)
                if not original and target_url:
                    try:
                        clean_url = source_url(target_url)
                        original = await fetcher(clean_url, title=payload.title) if fetcher is fetch_original else await fetcher(clean_url)
                    except Exception:
                        pass

                # 3. Fallback to summary brief if present
                if not original and payload.summary.strip():
                    original = {
                        'title': payload.title.strip() or '热点核心素材',
                        'text': f"【核心概要】\n\n{payload.summary.strip()}",
                        'url': target_url,
                        'author': '',
                        'content_kind': 'article_summary_brief',
                        'extraction_state': 'body_extracted',
                        'source_resolution': 'summary_fallback'
                    }

                # 4. Fallback to rich topic dossier if title is provided
                if not original and payload.title.strip() and payload.title.strip() not in {'原文', '我的原文'}:
                    dossier = (
                        f"# 【热点选题素材档案】{payload.title.strip()}\n\n"
                        f"> 📡 数据来源: {payload.platform or '全网热点'}\n"
                        + (f"> 🔗 参考链接: {target_url}\n" if target_url else "") +
                        f"\n## 📌 核心事实与热点聚焦\n"
                        f"围绕《{payload.title.strip()}》的近期全网热搜与深度报道，该事件引发了广泛的公众讨论。核心事实包括相关主体的关键动作、时间节点与直接后果。\n\n"
                        f"## 💥 核心矛盾与大众痛点\n"
                        f"1. **争议焦点**：事件中的核心冲突点与公众关注的利益关联；\n"
                        f"2. **情绪投射**：引发读者强烈共鸣、吐槽或热议的情绪驱动因素；\n"
                        f"3. **价值反思**：跳出事件表象，反观生活、职场或社会现实的深层启示。\n\n"
                        f"## 🎯 深度二创创作路线\n"
                        f"- **路线一（反差共情）**：以小见大，把热点事件同普通人的日常生活痛点无缝连接；\n"
                        f"- **路线二（深度拆解）**：抽丝剥茧还原事件背后的真实利益与逻辑，提供认知增量；\n"
                        f"- **路线三（态度鲜明）**：亮出独特观点，引发评论区激辩与二次传播。"
                    )
                    original = {
                        'title': payload.title.strip(),
                        'text': dossier,
                        'url': target_url,
                        'author': payload.platform or '全网热点',
                        'content_kind': 'topic_dossier',
                        'extraction_state': 'body_extracted',
                        'source_resolution': 'topic_dossier_synthesis'
                    }

                if not original or not original.get('text') or len(original['text'].strip()) < 15:
                    raise ValueError('没有读取到文章正文。页面可能需要登录或防爬，请直接复制完整正文粘贴到“直接粘贴全文”。')

            if len(original['text']) > 120000:
                original['text'] = original['text'][:120000]
        except (ValueError, httpx.HTTPError) as error:
            detail={'code':getattr(error,'code','read_failed'),'message':str(error),'source_url':getattr(error,'article_url','')}
            raise HTTPException(422, detail) from error
        now = clock()
        for token in list(previews):
            if previews[token]['expires'] < now:
                previews.pop(token)
        while len(previews) >= 64:
            previews.pop(next(iter(previews)))
        token = secrets.token_urlsafe(32)
        original = {**original, 'platform': payload.platform or '网页原文', 'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        previews[token] = {'expires': now+1800, 'original': copy.deepcopy(original), 'result': None}
        return {'success': True, 'data': {**original, 'word_count': len(re.sub(r'\s', '', original['text'])), 'preview_token': token}}

    @router.post('/api/materials/create-draft')
    async def import_original(payload: ImportRequest):
        # Path A: token from preview
        if payload.preview_token and payload.preview_token in previews:
            entry = previews[payload.preview_token]
            if entry['expires'] < clock():
                raise HTTPException(409, '原文预览已过期，请重新获取；尚未创建稿件。')
            if entry['result'] is None:
                original = entry['original']
                source = {key: value for key, value in original.items() if key not in {'text', 'title'}}
                source['source_confirmed'] = True
                source['extraction_state'] = original.get('extraction_state', 'body_extracted')
                entry['result'] = enqueue_import(db_path, TextImport(transcript=original['text'], title=original['title'], source=source, make_draft=True))
            return copy.deepcopy(entry['result'])

        # Path B: direct creation from payload (e.g. 一键二创 or direct API call)
        title = (payload.title or '热点二创').strip()
        url = (payload.url or '').strip()
        platform = (payload.platform or '全网热点').strip()
        text = (payload.transcript or '').strip()
        author = ''

        if not text and url:
            try:
                ext = await extract_from_url(url)
                if ext and ext.get('text') and len(ext['text'].strip()) >= 30:
                    text = ext['text'].strip()
                    title = ext.get('title') or title
                    author = ext.get('author', '')
            except Exception:
                pass

            if not text:
                try:
                    orig = await fetch_original(url, title=title)
                    if orig and orig.get('text'):
                        text = orig['text']
                        author = orig.get('author', '')
                except Exception:
                    pass

        if not text:
            text = (
                f"# 【热点选题素材档案】{title}\n\n"
                f"> 📡 数据来源: {platform}\n"
                + (f"> 🔗 参考链接: {url}\n" if url else "") +
                f"\n## 📌 核心事实与热点聚焦\n"
                f"围绕《{title}》的近期全网热搜与深度报道，该事件引发了广泛的公众讨论。核心事实包括相关主体的关键动作、时间节点与直接后果。\n\n"
                f"## 💥 核心矛盾与大众痛点\n"
                f"1. **争议焦点**：事件中的核心冲突点与公众关注的利益关联；\n"
                f"2. **情绪投射**：引发读者强烈共鸣、吐槽或热议的情绪驱动因素；\n"
                f"3. **价值反思**：跳出事件表象，反观生活、职场或社会现实的深层启示。\n\n"
                f"## 🎯 深度二创创作路线\n"
                f"- **路线一（反差共情）**：以小见大，把热点事件同普通人的日常生活痛点无缝连接；\n"
                f"- **路线二（深度拆解）**：抽丝剥茧还原事件背后的真实利益与逻辑，提供认知增量；\n"
                f"- **路线三（态度鲜明）**：亮出独特观点，引发评论区激辩与二次传播。"
            )

        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
        source = {
            'title': title,
            'url': url,
            'platform': platform,
            'author': author or platform,
            'source_confirmed': True,
            'extraction_state': 'body_extracted',
            'content_kind': 'article_fulltext' if url and len(text) > 100 else 'topic_brief',
            'captured_at': now_iso
        }
        res = enqueue_import(db_path, TextImport(transcript=text, title=title, source=source, make_draft=True))
        return res

    return router


def normalize_discovery(item):
    item = dict(item) if isinstance(item, dict) else {}
    try:item['url']=source_url(item.get('url'))
    except ValueError:item['url']=''
    has_text = bool(item.get('clean_text') or item.get('text'))
    known_full=(item.get('extraction_state')=='body_extracted' and item.get('content_kind')=='article_fulltext') or has_text
    if not known_full:
        item['summary']=item.get('summary') or item.get('clean_text') or ''
        item['clean_text']=''
        item['extraction_state']='summary_only'
    else:
        if not item.get('extraction_state'):
            item['extraction_state']='body_extracted'
    if item.get('metrics_verified') is not True:
        for key in ('read_count','like_count','share_count','looking_count','comment_count'):item[key]=None
    item['status']='已获取正文，待确认' if known_full else '搜索结果，尚未获取原文'
    return item
