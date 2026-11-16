const FORMATS = {cards:'小红书图文',long:'文章长图',wechat:'公众号排版'};
const STATUS = {queued:'排队中',running:'制作中',completed:'已完成',failed:'制作失败',cancelled:'已取消'};
const ACTIVE = new Set(['queued','running']);
const PHASES = {queued:'等待开始',preparing:'准备稿件',planning:'整理内容',rewriting:'提炼改写',rendering:'生成图片',rendering_cards:'生成小红书图文',rendering_long:'生成文章长图',rendering_wechat:'生成公众号排版',checking:'检查排版',interrupted:'服务中断',packaging:'打包成品',completed:'制作完成',cancelled:'已取消'};

// Capture is provided by the editor. This module never mutates workspace documents.
export function mount(root,ctx,{capture}) {
  if (!document.querySelector('link[data-workbench-media]')) {
    const style=document.createElement('link');style.rel='stylesheet';style.href='/web/features/workbench/media-production.css?v=1';style.dataset.workbenchMedia='';document.head.append(style);
  }
  const esc=value=>ctx.esc(String(value ?? ''));
  const dialog=document.createElement('dialog');dialog.className='wb-media-dialog';dialog.setAttribute('aria-labelledby','wbMediaTitle');
  dialog.innerHTML=`<div class="mp-shell">
    <header class="mp-head"><div><span class="mp-eyebrow">文章制作</span><h2 id="wbMediaTitle">把稿件制作成品</h2><p>选择发布形式，生成可预览、可下载的内容。</p></div><button type="button" data-mp="close" class="mp-close" aria-label="关闭制作成品">×</button></header>
    <nav class="mp-mobile-tabs" aria-label="制作与成品"><button type="button" data-mp="panel-setup" aria-pressed="true">制作设置</button><button type="button" data-mp="panel-results" aria-pressed="false">成品记录</button></nav>
    <div class="mp-body"><section class="mp-setup" aria-label="制作设置"><form id="wbMediaForm">
      <div class="mp-snapshot"><span>本次稿件快照</span><strong id="wbMediaSnapshotTitle"></strong><small id="wbMediaSnapshotMeta"></small><p>包含打开时的未保存编辑。制作期间继续写作，不会改变已提交内容。</p><button type="button" data-mp="capture">更新为当前编辑稿</button></div>
      <fieldset class="mp-formats"><legend>制作形式 <small>可多选</small></legend>
        <label class="mp-format"><input type="checkbox" name="format" value="cards" checked><span><b>小红书图文</b><small>3:4 竖版 · 多张内容卡片</small></span><i class="mp-format-icon mp-format-cards" aria-hidden="true"></i></label>
        <label class="mp-format"><input type="checkbox" name="format" value="long"><span><b>文章长图</b><small>完整长图 · 便于分享收藏</small></span><i class="mp-format-icon mp-format-long" aria-hidden="true"></i></label>
        <label class="mp-format"><input type="checkbox" name="format" value="wechat"><span><b>公众号排版</b><small>HTML 预览 · 正文排版</small></span><i class="mp-format-icon mp-format-wechat" aria-hidden="true"></i></label>
      </fieldset>
      <fieldset class="mp-modes"><legend>内容处理</legend><label><input type="radio" name="mode" value="original" checked><span><b>原文排版</b><small>保留稿件文字，直接制作</small></span></label><label><input type="radio" name="mode" value="summary" disabled><span><b>提炼改写</b><small>由模型提炼结构并改写内容</small></span></label><p id="wbMediaModelHint" class="mp-note"></p></fieldset>
      <label class="mp-theme-label" for="wbMediaTheme">视觉主题</label><select id="wbMediaTheme" name="theme" disabled><option value="">正在读取主题…</option></select>
      <p id="wbMediaCapability" class="mp-capability" role="status">正在检查制作环境…</p><div id="wbMediaError" class="mp-error" role="alert" hidden></div>
      <button type="submit" class="mp-generate" disabled>开始制作</button><p class="mp-note">关闭窗口后，已提交的任务会继续在本机制作。</p>
    </form></section>
    <section class="mp-results" aria-label="成品与制作记录"><div class="mp-result-heading"><h3>制作记录</h3><button type="button" data-mp="refresh">刷新</button></div><div id="wbMediaJobs" class="mp-jobs" aria-label="当前稿件制作记录" aria-live="polite"><p class="mp-empty">正在读取制作记录…</p></div><div id="wbMediaOutput" class="mp-output"><div class="mp-placeholder"><span aria-hidden="true">▤</span><h3>成品会出现在这里</h3><p>选择左侧形式并开始制作，或打开一条历史记录。</p></div></div></section></div>
    <footer class="mp-footer"><span id="wbMediaFooter" role="status">制作结果与原稿分开保存</span><button type="button" data-mp="close">返回写作</button></footer></div>`;
  (root.querySelector('.wb-page') || root).append(dialog);
  const q=s=>dialog.querySelector(s);
  let snapshot=null,capabilities=null,jobs=[],selected=null,selectedArtifact='',timer=null,epoch=0,selectionSerial=0,previewSerial=0,posting=false,refreshing=false,opener=null,lastOutput='',textValue='',refreshErrors=0;
  const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
  const jobId=item=>String(item?.id || '');
  const phase=item=>PHASES[item?.phase] || (/[\u3400-\u9fff]/.test(String(item?.phase || ''))?item.phase:STATUS[item?.status]) || '等待更新';
  function showError(message='') {q('#wbMediaError').hidden=!message;q('#wbMediaError').textContent=message;}
  function safeURL(value) {
    if (!value) return '';
    try {const url=new URL(value,location.href);return url.origin===location.origin && url.pathname.startsWith('/api/media/')?url.pathname+url.search:'';} catch {return '';}
  }
  function cloneSnapshot(value) {
    if (!value?.document_id || !String(value.text || '').trim()) throw new Error('请先打开一篇有正文的可编辑稿件。');
    return JSON.parse(JSON.stringify({...value,title:String(value.title || '未命名稿件'),text:String(value.text),source:value.source || {}}));
  }
  function renderSnapshot() {
    q('#wbMediaSnapshotTitle').textContent=snapshot?.title || '';
    q('#wbMediaSnapshotMeta').textContent=snapshot?`${Array.from(snapshot.text.replace(/\s/g,'')).length.toLocaleString('zh-CN')} 字 · v${snapshot.document_version ?? 0} · ${date(snapshot.captured_at)}`:'';
  }
  function syncForm() {
    const summary=q('[name="mode"][value="summary"]');summary.disabled=!capabilities?.model_ready;
    if (summary.disabled && summary.checked) q('[name="mode"][value="original"]').checked=true;
    q('#wbMediaModelHint').textContent=capabilities && !capabilities.model_ready?'提炼改写需要先在工作台设置可用模型。':'';
    q('#wbMediaModelHint').hidden=!q('#wbMediaModelHint').textContent;
    const ready=Boolean(capabilities?.ready && q('#wbMediaTheme').value);
    q('#wbMediaTheme').disabled=!capabilities?.themes?.length || posting;
    q('.mp-generate').disabled=posting || !ready || !snapshot || !q('[name="format"]:checked');
    q('.mp-generate').textContent=posting?'正在提交…':'开始制作';
    q('[data-mp="capture"]').disabled=posting;
    q('#wbMediaCapability').textContent=capabilities?(ready?'本地制作已就绪':'制作环境暂未就绪，请稍后刷新。'):'正在检查制作环境…';
    q('#wbMediaCapability').dataset.ready=String(ready);
  }
  async function loadCapabilities(token) {
    const value=await ctx.api('/api/media/capabilities');if(token!==epoch)return;
    const previous=q('#wbMediaTheme').value;capabilities=value;
    q('#wbMediaTheme').replaceChildren();
    for (const theme of value.themes || []) q('#wbMediaTheme').add(new Option(theme.name || theme.id,theme.id));
    if (!(value.themes || []).length) q('#wbMediaTheme').add(new Option('暂无可用主题',''));
    else q('#wbMediaTheme').value=value.themes.some(t=>t.id===previous)?previous:value.themes.some(t=>t.id==='editorial')?'editorial':value.themes[0].id;
    syncForm();
  }
  function renderJobs() {
    const focused=document.activeElement?.closest('[data-mp="select-job"]')?.dataset.jobId;
    q('#wbMediaJobs').innerHTML=jobs.length?jobs.map(item=>`<button type="button" class="mp-job ${jobId(item)===jobId(selected)?'is-selected':''}" data-mp="select-job" data-job-id="${esc(item.id)}" aria-pressed="${jobId(item)===jobId(selected)}"><span><strong>${esc(item.title || '未命名稿件')}</strong><small>${esc(date(item.created_at))} · v${esc(item.document_version ?? 0)} · ${esc((item.formats || []).map(f=>FORMATS[f] || f).join(' / '))}</small></span><span class="mp-status" data-status="${esc(item.status)}">${esc(STATUS[item.status] || item.status)}</span></button>`).join(''):'<p class="mp-empty">这篇稿件还没有制作记录。</p>';
    if(focused) [...q('#wbMediaJobs').querySelectorAll('[data-job-id]')].find(button=>button.dataset.jobId===focused)?.focus({preventScroll:true});
  }
  function artifactLabel(artifact) {
    const path=String(artifact.path || artifact.name || ''),name=path.split('/').at(-1);
    const number=name?.match(/(?:card|page|full|img|fig)[-]?(\d+)/)?.[1] || '01';
    if(artifact.kind==='archive')return '完整成品包';
    if(path.includes('/cards/') && artifact.kind==='image')return name==='overview.jpg'?'小红书卡片总览':`小红书卡片 ${number}`;
    if(path.includes('/long/') && artifact.kind==='image')return `文章长图 ${number}`;
    if(name==='cover-2.35x1.png')return '公众号横版头图';
    if(name==='cover-1x1.png')return '公众号方形封面';
    return {'article.html':'公众号正文预览','article-body.html':'可粘贴的公众号正文','caption.md':'小红书发布文案','wechat.md':'公众号发布说明','rewrite.md':'提炼后的稿件','article.md':'制作源稿','snapshot.txt':'提交时的原稿','content.json':'图文内容结构','metadata.json':'稿件版本信息','qa.json':'排版检查记录','ledger.json':'原文校验记录','source.html':'排版源文件','covers.html':'封面排版文件','plan-warnings.json':'内容检查提示'}[name] || name || '成品文件';
  }
  function previewArtifact(a) {
    const name=String(a.path || a.name || '').split('/').at(-1);
    return safeURL(a.url) && !String(a.path || a.name || '').includes('/review/') && (a.kind==='image' || (a.kind==='html' && name==='article.html') ||
      (a.kind==='text' && ['caption.md','wechat.md','article.md','rewrite.md','snapshot.txt'].includes(name)));
  }
  function previewArtifacts(job) {
    const items=Array.isArray(job?.artifacts)?job.artifacts:[];
    const rank=a=>a.kind==='image' && /\/cards\/card-01\.png$/.test(a.path || a.name || '')?0:
      a.kind==='html'?1:a.kind==='image'?2:3;
    return items.filter(previewArtifact).sort((a,b)=>rank(a)-rank(b));
  }
  function mobilePanel(name) {
    dialog.dataset.mobilePanel=name==='results'?'results':'setup';
    dialog.querySelectorAll('.mp-mobile-tabs button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mp==='panel-'+dialog.dataset.mobilePanel)));
  }

  function renderOutput() {
    if(!selected) {lastOutput='';return;}
    const item=selected,artifacts=Array.isArray(item.artifacts)?item.artifacts:[],signature=JSON.stringify([item.id,item.status,item.phase,item.error,item.warnings,item.artifacts]);
    if(signature===lastOutput)return;lastOutput=signature;
    const visible=previewArtifacts(item);
    const archives=artifacts.filter(a=>a.kind==='archive' && safeURL(a.download_url || a.url));
    const previous=selectedArtifact;
    if(!visible.some((a,i)=>`${a.path || a.name || i}`===selectedArtifact)) selectedArtifact=visible.length?`${visible[0].path || visible[0].name || 0}`:'';
    const working=ACTIVE.has(item.status),failed=item.status==='failed',cancelled=item.status==='cancelled';
    q('#wbMediaOutput').innerHTML=`<div class="mp-selected-head"><div><span class="mp-status" data-status="${esc(item.status)}">${esc(STATUS[item.status] || item.status)}</span><h3>${esc(item.title || '未命名稿件')}</h3><p>${esc(item.mode==='summary'?'提炼改写':'原文排版')} · v${esc(item.document_version ?? 0)} · ${esc(date(item.created_at))}</p></div><div class="mp-job-actions">${working?'<button type="button" data-mp="cancel">取消任务</button>':''}${failed || cancelled?'<button type="button" data-mp="retry">重新制作</button>':''}${archives.map(a=>`<a class="mp-download" href="${esc(safeURL(a.download_url || a.url))}" download="${esc(artifactLabel(a))}">下载成品包</a>`).join('')}</div></div>
      ${working?`<div class="mp-progress" role="status"><span class="mp-spinner" aria-hidden="true"></span><div><strong>${esc(phase(item))}</strong><p>可以关闭窗口继续写作，稍后重新打开查看。</p></div></div>`:''}
      ${failed || cancelled?`<div class="mp-task-error" role="${failed?'alert':'status'}"><strong>${failed?'这次制作未完成':'任务已取消'}</strong><p>${esc(item.error || (cancelled?'任务已停止，原稿已保留。可以使用原快照重新制作。':'请稍后重试，或检查制作环境。原稿和快照已保留。'))}</p></div>`:''}
      ${(item.warnings || []).length?`<details class="mp-warnings"><summary>${item.warnings.length} 条制作提示</summary><ul>${item.warnings.map(w=>`<li>${esc(typeof w==='string'?w:w.message || JSON.stringify(w))}</li>`).join('')}</ul></details>`:''}
      ${visible.length?`<div class="mp-artifact-tabs" role="group" aria-label="选择成品预览">${visible.map((a,i)=>`<button type="button" data-mp="artifact" data-artifact="${i}" aria-pressed="${`${a.path || a.name || i}`===selectedArtifact}">${a.kind==='image'?`<img loading="lazy" src="${esc(safeURL(a.url))}" alt="">`:'<span class="mp-artifact-symbol" aria-hidden="true">'+(a.kind==='html'?'▤':'文')+'</span>'}<span>${esc(artifactLabel(a))}</span></button>`).join('')}</div><div class="mp-preview" id="wbMediaPreview" aria-live="polite"></div>`:!working && !failed && !cancelled?'<p class="mp-empty">这条记录暂时没有可预览的文件。</p>':''}
      ${artifacts.length?`<details class="mp-file-list"><summary>全部文件（${artifacts.length}）</summary>${artifacts.map(a=>{const url=safeURL(a.download_url || a.url);return `<div><span>${esc(artifactLabel(a))}</span>${url?`<a href="${esc(url)}" download="${esc(artifactLabel(a))}">下载</a>`:'<small>文件暂不可用</small>'}</div>`;}).join('')}</details>`:''}
      <p class="mp-snapshot-proof">此记录使用提交时的稿件快照${item.snapshot_sha256?` · 快照 ${esc(item.snapshot_sha256.slice(0,12))}`:''}，不随后续编辑改变。</p>`;
    if(visible.length)void renderPreview(visible.find((a,i)=>`${a.path || a.name || i}`===selectedArtifact) || visible[0]);
    if(previous!==selectedArtifact)textValue='';
    q('#wbMediaFooter').textContent=working?`${STATUS[item.status]} · ${phase(item)}`:`${STATUS[item.status] || '制作记录'} · 结果保存在本机`;
  }
  async function renderPreview(artifact) {
    const host=q('#wbMediaPreview');if(!host || !artifact)return;const token=++previewSerial,url=safeURL(artifact.url);textValue='';
    if(artifact.kind==='image') {host.innerHTML=`<div class="mp-text-tools"><span>${esc(artifactLabel(artifact))}</span><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看完整图片 ↗</a></div><div class="mp-image-preview"><img src="${esc(url)}" alt="${esc(artifactLabel(artifact))}"></div>`;return;}
    if(artifact.kind==='html') {host.innerHTML=`<iframe class="mp-html-preview" sandbox="" referrerpolicy="no-referrer" title="${esc(artifactLabel(artifact))}" src="${esc(url)}"></iframe><p class="mp-note">HTML 在独立预览区展示。</p>`;return;}
    host.innerHTML='<p class="mp-empty" role="status">正在读取文字文案…</p>';
    try {
      const response=await fetch(url,{credentials:'same-origin'});if(!response.ok)throw new Error(`文案读取失败（${response.status}），可尝试下载文件。`);
      const text=await response.text();if(token!==previewSerial || !dialog.open)return;textValue=text;
      host.innerHTML='<div class="mp-text-tools"><span>文字文案</span><button type="button" data-mp="copy-text">复制文案</button></div><pre class="mp-text-preview"></pre>';
      host.querySelector('pre').textContent=text.length>200000?text.slice(0,200000)+'\n\n预览较长，请下载文件查看完整内容。':text;
    } catch(error) {if(token===previewSerial && dialog.open)host.innerHTML=`<p class="mp-task-error" role="alert">${esc(error.message)}</p>`;}
  }
  function upsert(item) {jobs=[item,...jobs.filter(x=>jobId(x)!==jobId(item))];}
  async function selectJob(id,token=epoch) {
    const sequence=++selectionSerial,value=await ctx.api(`/api/media/jobs/${encodeURIComponent(id)}`);
    if(token!==epoch || sequence!==selectionSerial)return;
    if(jobId(selected)!==jobId(value))selectedArtifact='';selected=value;lastOutput='';renderJobs();renderOutput();
  }
  async function refresh(token=epoch,{capability=false}={}) {
    if(!snapshot || refreshing)return;
    refreshing=true;
    const identifier=String(snapshot.document_id);
    try {
      const results=await Promise.allSettled([ctx.api(`/api/media/jobs?document_id=${encodeURIComponent(identifier)}`),...(capability?[loadCapabilities(token)]:[])]);
      if(token!==epoch)return;
      if(results[0].status==='rejected')throw results[0].reason;
      jobs=results[0].value.items || [];refreshErrors=0;
      if(capability && results[1]?.status==='rejected') {capabilities=null;syncForm();throw results[1].reason;}
      renderJobs();
      if(selected && jobs.some(item=>jobId(item)===jobId(selected))) {
        const listed=jobs.find(item=>jobId(item)===jobId(selected));
        // The list endpoint may omit preview details; fetch the selected record.
        if(ACTIVE.has(selected.status) || listed.status!==selected.status) await selectJob(selected.id,token);
      } else if(jobs.length) await selectJob(jobs[0].id,token);
    } catch(error) {
      if(token===epoch) {refreshErrors++;showError(`读取制作记录失败：${error.message}。可点击刷新重试。`);}
    } finally {
      refreshing=false;
      if(token===epoch && dialog.open) {
        clearTimeout(timer);
        if(refreshErrors<3 && (jobs.some(item=>ACTIVE.has(item.status)) || ACTIVE.has(selected?.status)))timer=setTimeout(()=>void refresh(token),2400);
      }
    }
  }
  async function submit() {
    if(posting)return;
    const formats=[...dialog.querySelectorAll('[name="format"]:checked')].map(input=>input.value),mode=q('[name="mode"]:checked')?.value || 'original';
    if(!snapshot || !formats.length)throw new Error('请至少选择一种制作形式。');
    if(!capabilities?.ready || !q('#wbMediaTheme').value)throw new Error('制作环境尚未就绪，请先刷新。');
    if(mode==='summary' && !capabilities.model_ready)throw new Error('请先配置可用模型，再使用提炼改写。');
    const frozen=JSON.parse(JSON.stringify(snapshot)),token=epoch;
    posting=true;showError();syncForm();
    try {
      const value=await ctx.api('/api/media/jobs',{method:'POST',body:JSON.stringify({document_id:frozen.document_id,document_version:frozen.document_version,title:frozen.title,text:frozen.text,source:frozen.source,formats,theme:q('#wbMediaTheme').value,mode})});
      if(token!==epoch)return;
      upsert(value);selected=value;selectedArtifact='';lastOutput='';renderJobs();renderOutput();mobilePanel('results');
      clearTimeout(timer);if(dialog.open)timer=setTimeout(()=>void refresh(token),1800);
    } finally {posting=false;syncForm();}
  }
  dialog.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();void submit().catch(error=>showError(error.message));});
  dialog.addEventListener('change',()=>syncForm());
  dialog.addEventListener('click',event=>{
    event.stopPropagation();const button=event.target.closest('[data-mp]'),action=button?.dataset.mp;if(!action)return;
    void (async()=>{
      if(action==='close')return dialog.close();
      if(action==='panel-setup')return mobilePanel('setup');
      if(action==='panel-results')return mobilePanel('results');
      if(action==='capture') {
        if(posting)return;const value=cloneSnapshot(capture());
        const different=String(value.document_id)!==String(snapshot?.document_id);snapshot=value;renderSnapshot();showError();
        if(different) {selected=null;jobs=[];lastOutput='';q('#wbMediaOutput').innerHTML='<p class="mp-empty">选择一条制作记录查看成品。</p>';await refresh(epoch);}
        return syncForm();
      }
      if(action==='refresh') {showError();return refresh(epoch,{capability:true});}
      if(action==='select-job')return selectJob(button.dataset.jobId);
      if(action==='artifact') {
        const visible=previewArtifacts(selected),index=Number(button.dataset.artifact),artifact=visible[index];if(!artifact)return;
        selectedArtifact=`${artifact.path || artifact.name || index}`;
        dialog.querySelectorAll('[data-mp="artifact"]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));
        return renderPreview(artifact);
      }
      if(action==='copy-text') {if(textValue) {if(ctx.copy)await ctx.copy(textValue);else {await navigator.clipboard.writeText(textValue);ctx.showToast('文案已复制');}}return;}
      if(action==='cancel' || action==='retry') {
        if(!selected)return;const token=epoch,id=selected.id;button.disabled=true;showError();
        try {
          const value=await ctx.api(`/api/media/jobs/${encodeURIComponent(id)}/${action}`,{method:'POST',body:'{}'});if(token!==epoch)return;
          if(value?.id) {selected=value;upsert(value);lastOutput='';renderJobs();renderOutput();}
          else await selectJob(id,token);
          clearTimeout(timer);await refresh(token);
        } finally {if(button.isConnected)button.disabled=false;}
      }
    })().catch(error=>showError(error.message));
  });
  dialog.addEventListener('close',()=>{
    clearTimeout(timer);epoch++;selectionSerial++;previewSerial++;refreshing=false;
    q('#wbMediaPreview')?.querySelector('iframe')?.remove();lastOutput='';
    if(opener?.isConnected)opener.focus({preventScroll:true});
  });
  return {
    async open() {
      snapshot=cloneSnapshot(capture());opener=document.activeElement;renderSnapshot();showError();
      const previous=selected;
      if(previous && String(previous.document_id)!==String(snapshot.document_id)) {selected=null;jobs=[];lastOutput='';q('#wbMediaOutput').innerHTML='<p class="mp-empty">选择一条制作记录查看成品。</p>';}
      const token=++epoch;refreshing=false;mobilePanel(selected?'results':'setup');dialog.showModal();q('[data-mp="close"]').focus({preventScroll:true});syncForm();
      if(selected) {lastOutput='';renderOutput();}
      await refresh(token,{capability:true});
    },
    close() {if(dialog.open)dialog.close();}
  };
}
