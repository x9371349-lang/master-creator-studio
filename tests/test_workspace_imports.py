import json
import sqlite3
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workspace_imports import create_import_router


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.mark.anyio
async def test_inbox_preserves_revision_and_edits_until_editor_saves(tmp_path):
    db = tmp_path/'test.db'
    state = {'drafts':[{'id':'existing','text':'正在编辑的原文'}], 'references':[]}
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE workspace (id INTEGER PRIMARY KEY,revision INTEGER,data TEXT)')
        conn.execute('INSERT INTO workspace VALUES(1,7,?)',(json.dumps(state),))
    app=FastAPI();app.include_router(create_import_router(db))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        payload={'title':'采集来源','transcript':'口播正文','source':{'url':'https://example.test/a','author':'作者','platform':'douyin'}}
        result=(await client.post('/api/creatorhub/import-text',json=payload)).json()
        duplicate=(await client.post('/api/creatorhub/import-text',json=payload)).json()
        assert duplicate['import_id']==result['import_id']
        with sqlite3.connect(db) as conn:
            revision,raw=conn.execute('SELECT revision,data FROM workspace').fetchone()
        assert revision==7 and json.loads(raw)==state
        items=(await client.get('/api/creatorhub/imports')).json()['items']
        assert len(items)==1 and items[0]['ref']['source']['author']=='作者'
        ack=f"/api/creatorhub/imports/{result['import_id']}/ack"
        assert (await client.post(ack)).status_code==409
        state['references'].append(result['ref']);state['drafts'].append(result['draft'])
        state['drafts'][0]['text']='用户的新编辑'
        with sqlite3.connect(db) as conn:
            conn.execute('UPDATE workspace SET revision=8,data=?',(json.dumps(state),))
        assert (await client.post(ack)).status_code==200
        assert (await client.get('/api/creatorhub/imports')).json()['items']==[]
        assert (await client.post('/api/creatorhub/import-text',json=payload)).json()['pending'] is False
        assert (await client.post('/api/creatorhub/import-text',json={'transcript':'  '})).status_code==400
        assert (await client.post('/api/creatorhub/import-text',json={'transcript':'new','source':{'url':'file:///etc/passwd'}})).json()['ref']['source']=={}
