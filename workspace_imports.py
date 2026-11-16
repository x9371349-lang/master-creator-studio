"""Durable inbox for imports; the editor merges and saves without external revision bumps."""
import datetime
import hashlib
import json
import re
import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


class TextImport(BaseModel):
    transcript: str = Field(min_length=1, max_length=120_000)
    title: str = Field(default='采集口播', max_length=500)
    source: dict[str, Any] = Field(default_factory=dict)
    make_draft: bool = True


def init_imports(db_path):
    with sqlite3.connect(db_path) as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS workspace_imports (
            id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL, payload TEXT NOT NULL, acknowledged_at TEXT)''')


def enqueue_import(db_path, payload: TextImport):
    text = payload.transcript.strip()
    if not text:
        raise HTTPException(400, '口播文案为空')
    title = re.sub(r'[\\/:*?"<>|\x00-\x1f#@]+', ' ', payload.title).strip()[:80] or '采集口播'
    source = {key: str(payload.source[key])[:2000] for key in
              ('url', 'author', 'platform', 'job_id', 'content_id', 'item_id')
              if payload.source.get(key) is not None}
    for key in ('content_kind','extraction_state','captured_at'):
        if payload.source.get(key) is not None:source[key]=str(payload.source[key])[:120]
    if payload.source.get('source_confirmed') is True:source['source_confirmed']=True
    if source.get('url') and not re.match(r'^https?://', source['url'], re.I):
        source.pop('url')
    fingerprint = hashlib.sha256(json.dumps([title, text, source, payload.make_draft],
                                ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    import_id = uuid.uuid4().hex
    ref = {'id': 'ref-' + import_id, 'title': title, 'path': f'引用来源/{title}-{import_id[:6]}.md',
           'text': text, 'readOnly': True, 'source': source, 'createdAt': now, 'updatedAt': now}
    draft = None
    if payload.make_draft:
        draft = {'id': 'doc-' + import_id, 'title': title + '（原稿）',
                 'path': f'二创稿/{title}（原稿）-{import_id[:6]}.md', 'folderId': '二创稿', 'text': text,
                 'source': source, 'referenceIds': [ref['id']], 'updatedAt': now, 'version': 1,
                 'versions': [{'version': 1, 'text': text, 'kind': 'import', 'createdAt': now}]}
    item = {'id': import_id, 'created_at': now, 'ref': ref, 'draft': draft}
    with sqlite3.connect(db_path) as conn:
        conn.execute('INSERT OR IGNORE INTO workspace_imports (id,fingerprint,created_at,payload) VALUES (?,?,?,?)',
                     (import_id, fingerprint, now, json.dumps(item, ensure_ascii=False)))
        row = conn.execute('SELECT payload,acknowledged_at FROM workspace_imports WHERE fingerprint=?',
                           (fingerprint,)).fetchone()
    saved = json.loads(row[0])
    return {'success': True, 'pending': not bool(row[1]), 'import_id': saved['id'],
            'ref': saved['ref'], 'draft': saved['draft'],
            'message': f'已送入文案工作台《{title}》' if not row[1] else f'《{title}》已导入过，无需重复导入'}


def create_import_router(db_path):
    init_imports(db_path)
    router = APIRouter(prefix='/api/creatorhub')

    @router.post('/import-text')
    def import_text(payload: TextImport):
        return enqueue_import(db_path, payload)

    @router.get('/imports')
    def pending_imports():
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute('SELECT payload FROM workspace_imports WHERE acknowledged_at IS NULL ORDER BY created_at LIMIT 100').fetchall()
        return {'items': [json.loads(row[0]) for row in rows]}

    @router.post('/imports/{import_id}/ack')
    def acknowledge(import_id: str):
        with sqlite3.connect(db_path) as conn:
            row = conn.execute('SELECT payload FROM workspace_imports WHERE id=?', (import_id,)).fetchone()
            if not row:
                raise HTTPException(404, '导入记录不存在')
            item = json.loads(row[0])
            ws = conn.execute('SELECT data FROM workspace WHERE id=1').fetchone()
            state = json.loads(ws[0]) if ws else {}
            ref_saved = any(x.get('id') == item['ref']['id'] and x.get('text') == item['ref']['text'] for x in state.get('references', []))
            draft_saved = not item['draft'] or any(x.get('id') == item['draft']['id'] for x in state.get('drafts', []))
            if not ref_saved or not draft_saved:
                raise HTTPException(409, '请先保存导入的稿件，再确认导入')
            conn.execute('UPDATE workspace_imports SET acknowledged_at=? WHERE id=?',
                         (datetime.datetime.now(datetime.timezone.utc).isoformat(), import_id))
        return {'ok': True}

    return router
