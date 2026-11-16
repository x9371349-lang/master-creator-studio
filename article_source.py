"""Shared article body and Sogou redirect parsing. Never executes page scripts."""
import re
import unicodedata
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse, parse_qs, urlencode


def source_url(value):
    text = str(value or '').strip()
    if not text.startswith(('http://', 'https://', '/link?')):
        links = re.findall(r'https?://[^\s<>\"\']+', text)
        if len(links) == 1:
            text = links[0].rstrip('，。；）】》')
    if text.startswith('/link?'):
        text = urljoin('https://weixin.sogou.com', text)
    parsed = urlparse(text)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('请填写完整的原文链接，或粘贴完整正文。')
    if parsed.port not in {None, 80, 443}:
        raise ValueError('原文链接需要使用公开网页地址。')
    return text


class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.capture = None
        self.body = []
        self.title = []
        self.title_depth = None
        self.meta = {}
        self.body_found = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            self.meta[attrs.get('property', attrs.get('name', ''))] = attrs.get('content', '')
        if tag in {'meta', 'br', 'img', 'hr', 'input', 'link', 'source', 'wbr'}:
            if self.capture is not None and tag in {'br', 'hr'}:
                self.body.append('\n')
            return
        self.stack.append(tag)
        if attrs.get('id') == 'js_content' or tag == 'article':
            if self.capture is None:
                self.capture = len(self.stack)
                self.body_found = True
        if attrs.get('id') == 'activity-name' or tag == 'title':
            self.title_depth = len(self.stack)
        if self.capture is not None and tag in {'p', 'div', 'section', 'li', 'h1', 'h2', 'h3'}:
            self.body.append('\n')

    def handle_endtag(self, tag):
        if tag not in self.stack:
            return
        depth = len(self.stack) - self.stack[::-1].index(tag)
        if self.capture is not None and depth >= self.capture and tag in {'p', 'div', 'section', 'li', 'h1', 'h2', 'h3'}:
            self.body.append('\n')
        if depth == self.capture:
            self.capture = None
        if depth == self.title_depth:
            self.title_depth = None
        self.stack = self.stack[:depth-1]

    def handle_data(self, text):
        if any(tag in {'script', 'style', 'noscript', 'svg'} for tag in self.stack):
            return
        if self.capture is not None:
            self.body.append(text)
        if self.title_depth is not None:
            self.title.append(text)


def parse_article(html, url):
    parser = ArticleParser()
    parser.feed(html)
    text = '\n\n'.join(line.strip() for line in ''.join(parser.body).splitlines() if line.strip())
    if not parser.body_found or not text:
        raise ValueError('没有读取到文章正文。页面可能需要验证、链接已过期，或这只是搜索结果页；请打开原文，复制完整正文。')
    if re.search(r'请完成安全验证|环境异常.*验证|验证码中间页|访问过于频繁|完成验证后继续', text):
        raise ValueError('原文页面需要本人完成平台验证。请打开原文处理后重试，或复制完整正文。')
    if len(re.sub(r'\s', '', text)) < 300 and re.search(r'(?:\.{3,}|…+)\s*$', text):
        raise ValueError('读取到的内容带有摘要省略标记，尚不能确认是完整原文。请复制全文后导入。')
    title = parser.meta.get('og:title') or ''.join(parser.title).strip() or '网页原文'
    return {'title': title, 'text': text, 'url': url,
            'author': parser.meta.get('og:article:author', ''),
            'content_kind': 'article_fulltext', 'extraction_state': 'body_extracted'}


class SourceReadError(ValueError):
    def __init__(self, message, code='body_unavailable', article_url=''):
        super().__init__(message)
        self.code = code
        self.article_url = article_url


def title_key(value):
    return re.sub(r'[\W_]+', '', unicodedata.normalize('NFKC', str(value or '').replace('（原稿）','')))


def is_verification_page(html, url):
    path = urlparse(url).path.lower()
    if any(marker in path for marker in ('/antispider', 'appmsgcaptcha', '/captcha', '/verify')):
        return True
    if re.search(r'id\s*=\s*[\"\']js_content[\"\']', html, re.I):
        return False
    title = re.search(r'<title[^>]*>(.*?)</title>', html, re.S | re.I)
    title = unescape(re.sub('<[^>]*>', '', title.group(1))) if title else ''
    return any(marker in title for marker in ('验证码', '安全验证', '环境异常')) or bool(re.search(r'请完成安全验证|完成验证后继续|访问过于频繁', html[:10000]))


class SearchLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_h3=False; self.href=None; self.parts=[]; self.links=[]
    def handle_starttag(self, tag, attrs):
        if tag=='h3': self.in_h3=True
        if tag=='a' and self.in_h3:
            self.href=dict(attrs).get('href');self.parts=[]
    def handle_data(self, data):
        if self.href is not None:self.parts.append(data)
    def handle_endtag(self, tag):
        if tag=='a' and self.href is not None:
            self.links.append((''.join(self.parts),self.href));self.href=None
        if tag=='h3':self.in_h3=False


def sogou_search_context(url, expected_title=''):
    if urlparse(url).hostname!='weixin.sogou.com':return None
    query=parse_qs(urlparse(url).query).get('query',[''])[0]
    title=expected_title if title_key(expected_title) not in {'', '原文', '我的原文', '网页原文'} else query
    query=query or title
    if not query:return None
    return ('https://weixin.sogou.com/weixin?'+urlencode({'type':2,'query':query,'ie':'utf8'}), title)


def refreshed_sogou_link(html, expected_title):
    parser=SearchLinks();parser.feed(html);key=title_key(expected_title)
    matches={urljoin('https://weixin.sogou.com',href) for title,href in parser.links if key and title_key(title)==key}
    matches={url for url in matches if urlparse(url).hostname=='weixin.sogou.com' and urlparse(url).path=='/link'}
    return next(iter(matches)) if len(matches)==1 else ''


def static_sogou_redirect(html):
    # Accept only an explicit string assignment/concatenation to the variable
    # used by location.replace. Expressions/calls are never evaluated.
    if not re.search(r'(?:window\.)?location',html):return ''
    literal = r"(?:'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
    pattern = re.compile(r'(?<![\w$.])(?:var\s+|let\s+|const\s+)?url\s*(\+?=)\s*('+literal+r')\s*;' )
    value=''
    def decode(raw):
        def escape(match):
            token=match.group(1)
            if token.startswith(('x','u')):return chr(int(token[1:],16))
            return {'n':'\n','r':'\r','t':'\t'}.get(token,token)
        return re.sub(r'\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\\/\"\'nrt])',escape,raw[1:-1])
    for op,raw in pattern.findall(html):
        piece=decode(raw);value=piece if op=='=' else value+piece
    # URLs in script strings are not HTML text: unescape would turn
    # &timestamp into ×tamp by decoding the legacy &times entity.
    value=value.replace("&amp;","&")
    try:
        normalized=source_url(value)
        if urlparse(normalized).hostname=='mp.weixin.qq.com':return normalized
    except ValueError:pass
    direct=re.search(r'(?:window\.)?location\.(?:href|replace)\s*(?:=|\()\s*[\"\'](https?[^\"\']+)[\"\']',html)
    if direct:
        try:
            normalized=source_url(direct.group(1).replace('&amp;','&'))
            if urlparse(normalized).hostname=='mp.weixin.qq.com':return normalized
        except ValueError:pass
    return ''


def unavailable_article_page(html, url):
    if urlparse(url).hostname!='mp.weixin.qq.com' or re.search(r'id\s*=\s*[\"\']js_content[\"\']',html,re.I):return None
    text=re.sub(r'<(script|style)[^>]*>.*?</\1>','',html,flags=re.S|re.I)
    text=unescape(re.sub('<[^>]+>',' ',text))
    if '参数错误' in text or '链接已过期' in text:
        return ('expired_article_link','已找到微信地址，但该地址返回“参数错误”或已过期。请在微信内打开这篇文章，从右上角菜单复制最新文章链接后重新获取。')
    if any(x in text for x in ('该内容已被发布者删除','此内容因违规无法查看','此内容已被发布者删除')):
        return ('article_unavailable','微信原文已删除或不可查看，尚未取得正文。请更换可正常打开的原文链接。')
    return None
