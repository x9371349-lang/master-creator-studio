"""Media lifecycle tests use temporary SQLite, fake renderers and local ASGI."""
import asyncio
import hashlib
import json
from pathlib import Path
import signal
import sqlite3
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

from fastapi import FastAPI
import httpx
from pydantic import ValidationError
import pytest

from media_jobs import MediaJobInput, MediaJobManager, PREVIEW_CSP, create_media_router


def payload(**overrides):
    return MediaJobInput.model_validate({
        'document_id': 'doc-1', 'document_version': 3, 'title': '测试稿件',
        'text': '# 文章\n\n保留原文内容。普通链接 https://example.test 可以保留。',
        'source': {'author': '作者', 'url': 'https://example.test/source', 'api_key': 'DROP-THIS'},
        **overrides,
    })


def manager(tmp_path, **kwargs):
    return MediaJobManager(tmp_path/'workbench.sqlite3', tmp_path, lambda: {'api_key': 'MODEL-SECRET', 'model': 'test'},
                           lambda timeout=60: httpx.AsyncClient(timeout=timeout), **kwargs)


async def ready():
    return {'ready': True, 'model_ready': True, 'themes': [{'id': 'editorial', 'name': '编辑杂志'}]}


async def await_status(mgr, job_id, states=('completed', 'failed', 'cancelled')):
    for _ in range(200):
        job = mgr.get(job_id)
        if job['status'] in states:
            return job
        await asyncio.sleep(.005)
    raise AssertionError('job did not settle: '+str(mgr.get(job_id)))


def install_renderer(mgr, *, delay=.001, fail=False):
    calls = []
    async def render(job_id, args, work_dir):
        calls.append(args)
        await asyncio.sleep(delay)
        if fail:
            raise ValueError('测试排版失败')
        if args[0] == 'export.mjs':
            (work_dir/'rewrite.md').write_text('# 改写稿\n\n总结内容。')
            assets=work_dir/'rewrite-assets';assets.mkdir(exist_ok=True)
            (assets/'fig-1.png').write_bytes(b'FIGURE')
            return
        out=Path(args[args.index('--out')+1])/'editorial';out.mkdir(parents=True,exist_ok=True)
        (out/'page-01.png').write_bytes(b'PNG')
        (out/'article.html').write_text('<!doctype html><p>排版产物</p>')
        (out/'qa.json').write_text(json.dumps({'issues': [{'level':'warn','msg':'测试提示'}]}))
        # Neither arbitrary files nor process logs may enter downloads.
        (work_dir/'render.log').write_text('never publish process logs')
        (work_dir/'private-secret.txt').write_text('MODEL-SECRET')
    mgr._run_command=render
    mgr.capabilities=ready
    return calls


def test_validation_rejects_media_paths_and_invalid_controls():
    for overrides in [
        {'text':'![图片](https://example.test/a.png)'},
        {'text':'![引用图片][image]\n\n[image]: file:///etc/passwd'},
        {'text':'<img src="file:///etc/passwd">'},
        {'text':'<svg>payload</svg>'},
        {'text':'---\nhero: /tmp/photo.png\n---\n文章'},
        {'formats':[]}, {'formats':['cards','cards']}, {'formats':['video']},
        {'theme':'../../private'}, {'source':{'url':'file:///etc/passwd'}}, {'source':{'url':'https://user:secret@example.test'}},
        {'text':'x'*120_001}, {'document_version':True}, {'unexpected':'field'},
    ]:
        with pytest.raises(ValidationError): payload(**overrides)
    assert payload().source == {'author':'作者','url':'https://example.test/source'}
    assert payload().mode == 'original'


def test_original_job_is_snapshot_based_and_archives_only_manifest(tmp_path):
    async def run():
        mgr=manager(tmp_path); calls=install_renderer(mgr)
        try:
            original=payload(formats=['cards','long','wechat'])
            queued=await mgr.submit(original)
            assert queued['status']=='queued'
            job=await await_status(mgr,queued['id'])
            assert job['status']=='completed', job
            assert job['artifacts'][0]['kind']=='image'
            assert job['snapshot_sha256']==hashlib.sha256(original.text.encode()).hexdigest()
            assert len(calls)==3 and [args[args.index('--layout')+1] for args in calls]==['card','long','wechat']
            assert calls[0][-2:]==['--ratio','3:4']
            root=mgr.jobs_dir/job['id'];article=(root/'article.md').read_text()
            assert article.endswith(original.text) and 'url: "https://example.test/source"' in article
            assert job['warnings']==['测试提示']
            assert len(mgr.list('doc-1'))==1 and mgr.list('different')==[]
            with zipfile.ZipFile(root/'results.zip') as archive:
                names=archive.namelist()
                assert 'article.md' in names and 'metadata.json' in names
                assert any(name.endswith('/qa.json') for name in names)
                assert 'render.log' not in names and 'private-secret.txt' not in names
                assert all('MODEL-SECRET' not in archive.read(name).decode(errors='ignore') for name in names)
            assert not any('api_key' in value for value in (root/'metadata.json').read_text().splitlines())
            assert all(item['url'].startswith('/api/media/jobs/'+job['id']+'/files/') for item in job['artifacts'])
            # This subsystem may share a DB file but never creates/edits workspace.
            with sqlite3.connect(mgr.db_path) as conn:
                assert conn.execute("SELECT name FROM sqlite_master WHERE name='workspace'").fetchone() is None
        finally: await mgr.stop()
    asyncio.run(run())


def test_summary_plans_once_and_exports_wechat_article(tmp_path):
    async def run():
        mgr=manager(tmp_path);calls=install_renderer(mgr);plans=[]
        async def plan(raw, job, work_dir):
            plans.append((raw,job))
            (work_dir/'content.json').write_text('{}')
            (work_dir/'plan-warnings.json').write_text(json.dumps(['文案提示']))
        mgr._create_plan=plan
        try:
            queued=await mgr.submit(payload(mode='summary',formats=['cards','wechat']))
            job=await await_status(mgr,queued['id'])
            assert job['status']=='completed',job
            assert len(plans)==1
            assert [args[0] for args in calls]==['render.mjs','export.mjs','render.mjs']
            assert calls[0][1].endswith('/content.json')
            assert calls[2][1].endswith('/rewrite.md')
            assert '文案提示' in job['warnings']
        finally: await mgr.stop()
    asyncio.run(run())


def test_queued_cancel_does_not_execute_and_worker_is_serial(tmp_path):
    async def run():
        mgr=manager(tmp_path);mgr.capabilities=ready
        entered=asyncio.Event();release=asyncio.Event();seen=[];active=0;peak=0
        async def render(job):
            nonlocal active,peak
            active+=1;peak=max(peak,active);seen.append(job['id']);entered.set()
            try: await release.wait()
            finally: active-=1
            mgr._update(job['id'],only_running=True,status='completed',phase='completed')
        mgr._run_job=render
        try:
            first=await mgr.submit(payload());await entered.wait()
            second=await mgr.submit(payload(title='第二个'))
            cancelled=await mgr.cancel(second['id'])
            assert cancelled['status']=='cancelled'
            release.set();assert (await await_status(mgr,first['id']))['status']=='completed'
            await asyncio.sleep(.01)
            assert seen==[first['id']] and peak==1
        finally: await mgr.stop()
    asyncio.run(run())


def test_running_cancel_then_retry_creates_new_id_with_same_snapshot(tmp_path):
    async def run():
        mgr=manager(tmp_path);mgr.capabilities=ready;entered=asyncio.Event();stopped=asyncio.Event()
        async def render(job):
            entered.set()
            try: await asyncio.Event().wait()
            finally: stopped.set()
        mgr._run_job=render
        try:
            first=await mgr.submit(payload());await entered.wait()
            assert (await mgr.cancel(first['id']))['status']=='cancelled'
            await asyncio.wait_for(stopped.wait(),1)
            retry=await mgr.retry(first['id'])
            assert retry['id']!=first['id'] and retry['snapshot_sha256']==first['snapshot_sha256']
            assert retry['document_version']==3
            assert mgr.get(first['id'])['status']=='cancelled'
            await mgr.cancel(retry['id'])
        finally: await mgr.stop()
    asyncio.run(run())


def test_restart_marks_pending_work_interrupted_without_replay(tmp_path):
    async def run():
        mgr=manager(tmp_path);mgr.capabilities=ready
        first=await mgr.submit(payload())
        # Yield has not reached worker yet. Simulate a process crash by stopping
        # the worker before it can claim the persistent queued row.
        await mgr.stop()
        reopened=manager(tmp_path);calls=install_renderer(reopened)
        try:
            await reopened.start()
            job=reopened.get(first['id'])
            assert job['status']=='failed' and job['phase']=='interrupted'
            assert '重试' in job['error'] and not calls
            retried=await reopened.retry(first['id'])
            assert (await await_status(reopened,retried['id']))['status']=='completed'
        finally: await reopened.stop()
    asyncio.run(run())


def test_render_failure_and_timeout_are_not_success(tmp_path):
    async def run():
        mgr=manager(tmp_path,job_timeout=.02);install_renderer(mgr,fail=True)
        try:
            first=await mgr.submit(payload())
            failed=await await_status(mgr,first['id'])
            assert failed['status']=='failed' and '测试排版失败' in failed['error'] and failed['artifacts']==[]
            async def stuck(_job): await asyncio.Event().wait()
            mgr._run_job=stuck
            second=await mgr.submit(payload())
            failed=await await_status(mgr,second['id'])
            assert failed['status']=='failed' and '超时' in failed['error'] and not failed['artifacts']
        finally: await mgr.stop()
    asyncio.run(run())


def test_files_are_manifest_bound_and_html_sandboxed(tmp_path):
    async def run():
        router=create_media_router(db_path=tmp_path/'test.db',data_dir=tmp_path,
                                  model_settings_loader=lambda:{},http_client_factory=httpx.AsyncClient)
        mgr=router.media_manager;install_renderer(mgr)
        app=FastAPI();app.include_router(router)
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://local') as client:
                response=await client.post('/api/media/jobs',json=payload().model_dump())
                assert response.status_code==202
                job=await await_status(mgr,response.json()['id'])
                image=next(item for item in job['artifacts'] if item['kind']=='image')
                html=next(item for item in job['artifacts'] if item['kind']=='html')
                preview=await client.get(html['url'])
                assert preview.status_code==200 and preview.headers['content-security-policy']==PREVIEW_CSP
                assert "script-src 'none'" in preview.headers['content-security-policy']
                assert preview.headers['content-disposition'].startswith('inline;')
                download=await client.get(image['download_url'])
                assert download.headers['content-disposition'].startswith('attachment;')
                for relative in ['render.log','private-secret.txt','../test.db','/etc/passwd','outputs/../../test.db','bad\\path']:
                    with pytest.raises(Exception) as error: mgr.artifact_file(job['id'],relative)
                    assert getattr(error.value,'status_code',None)==404
                # A later symlink replacement cannot escape the job directory.
                path=mgr.jobs_dir/job['id']/image['path'];path.unlink();path.symlink_to(mgr.db_path)
                assert (await client.get(image['url'])).status_code==404
                listed=(await client.get('/api/media/jobs?document_id=doc-1')).json()
                assert len(listed['items'])==1
                assert (await client.get('/api/media/jobs/not-a-job')).status_code==404
        finally: await mgr.stop()
    asyncio.run(run())


def test_subprocess_cancel_kills_owned_group_and_inherits_cache(tmp_path):
    async def run():
        mgr=manager(tmp_path);work=tmp_path/'job';work.mkdir()
        done=asyncio.Event();created=asyncio.Event();signals=[];invocation={}
        class Process:
            pid=97531;returncode=None
            async def communicate(self):
                await done.wait();return b'',None
            async def wait(self):
                await done.wait();self.returncode=-15;return self.returncode
        process=Process()
        async def spawn(*args,**kwargs):
            invocation.update(args=args,**kwargs);created.set();return process
        def killpg(pid,sig):
            signals.append((pid,sig));done.set()
        with patch('media_jobs.asyncio.create_subprocess_exec',spawn),patch('media_jobs.os.killpg',killpg),patch.object(mgr,'_node_path',return_value='/fake/node'):
            task=asyncio.create_task(mgr._run_command('job',['render.mjs','article.md'],work))
            await created.wait();task.cancel();await asyncio.gather(task,return_exceptions=True)
        assert invocation['start_new_session'] is True
        assert invocation['env']['ARTICLE2MEDIA_CACHE']==str(tmp_path/'media-engine-cache')
        assert signals and all(pid==97531 for pid,_ in signals)
        assert signals[0][1]==signal.SIGTERM and mgr._process is None
    asyncio.run(run())


def test_capabilities_do_not_expose_credentials(tmp_path):
    async def run():
        mgr=manager(tmp_path)
        mgr._detect_runtime=lambda:{'ready':True,'node':{'available':True,'version':'v22.1.0'},'chrome':{'available':True,'name':'Chrome'},'themes':[],'engine_version':'abc123'}
        data=await mgr.capabilities()
        assert data['model_ready'] is True
        assert 'MODEL-SECRET' not in json.dumps(data) and 'api_key' not in json.dumps(data)
    asyncio.run(run())


def test_existing_frontmatter_is_normalized_with_exact_raw_snapshot(tmp_path):
    mgr=manager(tmp_path)
    raw='---\ntitle: "旧标题"\nauthor: "原作者"\nurl: "https://example.test/original"\n---\n\n# 正文\n\n不改变这段文字。'
    values=payload(text=raw,source={}).model_dump()
    job={'id':'snapshot-test','title':'当前稿件标题','document_id':'doc-1','document_version':3,
         'snapshot_sha256':hashlib.sha256(raw.encode()).hexdigest(),'mode':'original','theme':'editorial',
         'formats':['cards'],'created_at':'2026-11-12T00:00:00Z'}
    work=mgr.jobs_dir/'snapshot-test';mgr._write_snapshot(work,values,job)
    article=(work/'article.md').read_text()
    assert article.count('\n---\n')==1 and 'title: "当前稿件标题"' in article
    assert 'author: "原作者"' in article and 'url: "https://example.test/original"' in article
    assert article.endswith('# 正文\n\n不改变这段文字。')
    assert (work/'snapshot.txt').read_text()==raw
    assert hashlib.sha256((work/'snapshot.txt').read_bytes()).hexdigest()==job['snapshot_sha256']


def test_included_router_lifespan_starts_and_stops_worker(tmp_path):
    async def run():
        router=create_media_router(db_path=tmp_path/'test.db',data_dir=tmp_path,
                                  model_settings_loader=lambda:{},http_client_factory=httpx.AsyncClient)
        app=FastAPI();app.include_router(router)
        mgr=router.media_manager
        assert mgr._worker is None
        async with app.router.lifespan_context(app):
            assert mgr._worker is not None and not mgr._worker.done()
        assert mgr._worker is None
    asyncio.run(run())


def test_cli_timeout_cleans_up_process_group(tmp_path):
    async def run():
        mgr=manager(tmp_path,command_timeout=.001);work=tmp_path/'job';work.mkdir()
        done=asyncio.Event();signals=[]
        class Process:
            pid=97532;returncode=None
            async def communicate(self):
                await done.wait();return b'',None
            async def wait(self):
                await done.wait();self.returncode=-15;return self.returncode
        process=Process()
        async def spawn(*_args,**_kwargs): return process
        def killpg(pid,sig): signals.append((pid,sig));done.set()
        with patch('media_jobs.asyncio.create_subprocess_exec',spawn),patch('media_jobs.os.killpg',killpg),patch.object(mgr,'_node_path',return_value='/fake/node'):
            with pytest.raises(ValueError,match='时间限制'):
                await mgr._run_command('job',['render.mjs','article.md'],work)
        assert signals and signals[0][1]==signal.SIGTERM and mgr._process is None
    asyncio.run(run())


def test_summary_qa_array_error_is_rejected_even_when_cli_exits_success(tmp_path):
    async def run():
        mgr=manager(tmp_path);install_renderer(mgr)
        async def plan(_payload,_job,work): (work/'content.json').write_text('{}')
        mgr._create_plan=plan
        original_render=mgr._run_command
        async def bad_qa(job_id,args,work):
            await original_render(job_id,args,work)
            out=Path(args[args.index('--out')+1])/'editorial'
            (out/'qa.json').write_text(json.dumps([{'issues':[{'level':'error','msg':'卡片文字溢出'}]}]))
        mgr._run_command=bad_qa
        try:
            job=await mgr.submit(payload(mode='summary'))
            result=await await_status(mgr,job['id'])
            assert result['status']=='failed' and '卡片文字溢出' in result['error']
            assert result['artifacts']==[]
        finally: await mgr.stop()
    asyncio.run(run())


def test_each_requested_format_must_produce_images(tmp_path):
    async def run():
        mgr=manager(tmp_path);install_renderer(mgr)
        original_render=mgr._run_command
        async def empty_long(job_id,args,work):
            if '--layout' in args and args[args.index('--layout')+1]=='long': return
            await original_render(job_id,args,work)
        mgr._run_command=empty_long
        try:
            job=await mgr.submit(payload(formats=['cards','long']))
            result=await await_status(mgr,job['id'])
            assert result['status']=='failed' and '长图' in result['error']
            assert result['artifacts']==[]
        finally: await mgr.stop()
    asyncio.run(run())


def test_finder_node_lookup_accepts_explicit_runtime_path(tmp_path):
    from media_jobs import find_node
    executable=tmp_path/'node';executable.write_text('#!/bin/sh\n');executable.chmod(0o755)
    with patch.dict('media_jobs.os.environ',{'ARTICLE2MEDIA_NODE':str(executable)}),patch('media_jobs.shutil.which',return_value=None):
        assert find_node()==str(executable)
