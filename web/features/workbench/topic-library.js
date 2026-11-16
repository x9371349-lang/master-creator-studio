import * as topics from './topic-library-state.js?v=topics-20261113';

export {topics};
export function mount(root,ctx,{getData,capture,changed,flush,compose,openDraft,openSession}){
  if(!document.querySelector('link[data-topic-library]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/web/features/workbench/topic-library.css?v=topics-20261113';link.dataset.topicLibrary='';document.head.append(link);}
  const esc=value=>ctx.esc(String(value ?? ''));
  const dialog=document.createElement('dialog');dialog.id='wbTopicLibraryDialog';dialog.className='tl-dialog';dialog.setAttribute('aria-labelledby','tlHeading');
  dialog.innerHTML=`<div class="tl-shell"><header class="tl-head"><div><span class="tl-eyebrow">从素材到创作</span><h2 id="tlHeading">选题库</h2><p>记下值得写的角度，带着依据进入下一篇创作。</p></div><button type="button" data-tl="close" class="tl-close" aria-label="关闭选题库">×</button></header>
  <div class="tl-toolbar"><div><button type="button" data-tl="new">＋ 新选题</button><button type="button" data-tl="capture">从当前稿件建选题</button></div><small id="tlCount"></small></div>
  <div class="tl-body"><aside class="tl-sidebar" aria-label="已保存选题"><div class="tl-filters"><input id="tlSearch" type="search" placeholder="搜索标题、角度或素材" aria-label="搜索选题"><select id="tlFilter" aria-label="选题阶段"><option value="active">进行中的选题</option><option value="all">全部选题</option>${Object.entries(topics.STATUS).map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select></div><div id="tlList" class="tl-list" aria-live="polite"></div></aside>
  <section class="tl-editor" aria-label="选题详情"><form id="tlForm"><div class="tl-editor-heading"><h3 id="tlEditorTitle">新选题</h3><span id="tlBadge"></span></div>
  <label for="tlTopicTitle">选题名称 <small>这篇内容要回答什么问题</small></label><input id="tlTopicTitle" name="title" maxlength="160" required placeholder="例如：如何判断定制柜报价是否合理？">
  <label for="tlAngle">写作切入角度</label><textarea id="tlAngle" name="angle" rows="2" maxlength="1000" placeholder="同一个主题，这一篇具体从哪里切入？"></textarea>
  <div class="tl-row"><div><label for="tlReader">目标读者</label><input id="tlReader" name="reader" maxlength="200" placeholder="准备装修、预算有限的家庭"></div><div><label for="tlPremise">想表达的核心观点</label><textarea id="tlPremise" name="premise" rows="2" maxlength="2000" placeholder="写下你自己的判断"></textarea></div></div>
  <label for="tlMaterial">素材与笔记</label><textarea id="tlMaterial" name="material" rows="5" maxlength="12000" placeholder="已有的真实案例、数据、观察或来源正文"></textarea>
  <label for="tlEvidenceGaps">发布前待核实 / 待补充</label><textarea id="tlEvidenceGaps" name="evidenceGaps" rows="2" maxlength="2000" placeholder="哪些结论缺依据？还要补什么资料？"></textarea>
  <label for="tlSourceURL">来源链接 <small>只作记录，不自动抓取</small></label><input id="tlSourceURL" type="url" maxlength="2000" placeholder="https://…"><p id="tlSourceNote" class="tl-note"></p>
  <div id="tlLinks" class="tl-links"></div><p id="tlError" role="alert" class="tl-error" hidden></p>
  <div class="tl-form-actions"><span id="tlStatus" role="status">填写后保存到本机</span><button type="submit" class="tl-save">保存选题</button></div></form></section></div>
  <footer class="tl-footer"><div><button type="button" data-tl="archive">归档</button><button type="button" data-tl="restore" hidden>恢复选题</button><button type="button" data-tl="export">导出 Markdown</button></div><button type="button" data-tl="compose" class="tl-compose">进入公众号创作 →</button></footer></div>`;
  document.body.append(dialog);
  const q=s=>dialog.querySelector(s),fields=['title','angle','reader','premise','material','evidenceGaps'];
  let editingId='',currentSource=null,posting=false,acting=false,opener=null,formDirty=false;const cache=new Map();
  const field=key=>q(`[name="${key}"]`);
  function values(){return Object.fromEntries(fields.map(key=>[key,field(key).value]));}
  function stash(){if(formDirty)cache.set(editingId || 'new',{...values(),sourceURL:q('#tlSourceURL').value,source:structuredClone(currentSource)});}
  function error(message=''){q('#tlError').textContent=message;q('#tlError').hidden=!message;}
  function list(){
    const data=getData(),rows=topics.listTopics(data,{query:q('#tlSearch').value,status:q('#tlFilter').value});
    q('#tlCount').textContent=`${rows.length} / ${topics.ensureLibrary(data).topics.length} 个选题`;
    q('#tlList').innerHTML=rows.length?rows.map(topic=>`<button type="button" data-tl-topic="${esc(topic.id)}" aria-pressed="${topic.id===editingId}"><span class="tl-card-top"><strong>${esc(topic.title)}</strong><small data-status="${esc(topic.status)}">${esc(topics.STATUS[topic.status] || '待整理')}</small></span><span class="tl-card-angle">${esc(topic.angle || '还没有记录写作角度')}</span><span class="tl-card-meta">${esc(topic.reader || '读者待明确')} · ${(topic.links?.draftIds || []).length} 篇关联稿件</span>${topic.evidenceGaps?'<span class="tl-card-gap">有待核实项</span>':''}</button>`).join(''):'<div class="tl-empty"><span aria-hidden="true">▤</span><strong>给下一篇留一个位置</strong><p>新建选题，或把当前稿件整理为素材。搜索不到时可切换阶段查看。</p></div>';
  }
  function links(){
    const data=getData(),topic=editingId && topics.getTopic(data,editingId),draftIds=topic?.links?.draftIds || [],sessionIds=topic?.links?.sessionIds || [];
    q('#tlLinks').innerHTML=[draftIds.length?`<strong>关联稿件</strong>${draftIds.map(id=>{const doc=data.drafts.find(d=>d.id===id);return `<button type="button" data-tl-open-draft="${esc(id)}" ${doc?'':'disabled'}>${esc(doc?.title || '稿件已移除')} ↗</button>`;}).join('')}`:'',sessionIds.length?`<strong>创作会话</strong>${sessionIds.map(id=>{const session=data.sessions.find(s=>s.id===id);return `<button type="button" data-tl-open-session="${esc(id)}" ${session?'':'disabled'}>${esc(session?.title || '会话已移除')} ↗</button>`;}).join('')}`:''].join('');
  }
  function buttons(){
    const topic=editingId && topics.getTopic(getData(),editingId),archived=topic?.status==='archived',busy=posting || acting;
    q('[data-tl="archive"]').hidden=Boolean(archived);q('[data-tl="archive"]').disabled=busy || !topic;
    q('[data-tl="restore"]').hidden=!archived;q('[data-tl="restore"]').disabled=busy;
    q('[data-tl="compose"]').disabled=busy || Boolean(archived);
    q('#tlBadge').textContent=topic?topics.STATUS[topic.status] || '待整理':'待保存';
    for(const input of dialog.querySelectorAll('input,textarea,select,button')){
      if(input.matches('#tlSourceURL'))input.disabled=busy || Boolean(editingId);
      else if(!input.matches('[data-tl="archive"],[data-tl="restore"],[data-tl="compose"]'))input.disabled=busy;
    }
  }
  function edit(id='',prefill=null){
    if(posting)return;stash();editingId=id;
    const topic=id?topics.getTopic(getData(),id):null,remembered=prefill || cache.get(id || 'new'),v=remembered || topic || {};
    formDirty=cache.has(id || 'new') || Boolean(prefill && fields.some(key=>prefill[key]));
    currentSource=structuredClone(remembered?.source ?? topic?.source ?? null);
    for(const key of fields)field(key).value=v[key] || '';
    q('#tlSourceURL').value=remembered?.sourceURL ?? currentSource?.url ?? '';
    q('#tlEditorTitle').textContent=topic?'选题详情':'新选题';q('#tlStatus').textContent=remembered?'本次输入尚未保存':topic?'已保存到本机':'填写后保存到本机';
    q('#tlSourceNote').textContent=currentSource?`来源快照：${currentSource.title || '提供的素材'}${currentSource.document_version?` · v${currentSource.document_version}`:''}。笔记可修改，来源快照单独保留。`:'首次保存时固定来源快照；后续编辑素材不会改变当时的记录。';
    error();list();links();buttons();q('.tl-editor').scrollTop=0;
  }
  async function saveTopic(){
    if(posting)throw new Error('正在保存选题，请稍候。');
    if(!q('#tlForm').reportValidity())throw new Error('请先检查选题名称和来源链接。');
    stash();const cacheKey=editingId || 'new';posting=true;buttons();error();q('#tlStatus').textContent='正在保存…';
    try{
      const data=getData(),input=values();let topic;
      if(editingId)topic=topics.updateTopic(data,editingId,input);
      else{topic=topics.createTopic(data,{...input,source:{...(currentSource || {}),title:currentSource?.title || input.title,url:q('#tlSourceURL').value,text:currentSource?.text ?? input.material}});editingId=topic.id;currentSource=structuredClone(topic.source);}
      changed();await flush();cache.delete(cacheKey);cache.delete(editingId);formDirty=false;q('#tlEditorTitle').textContent='选题详情';q('#tlStatus').textContent='已保存到本机';list();links();return topic;
    }catch(caught){q('#tlStatus').textContent='尚未保存，请重试';throw caught;}
    finally{posting=false;buttons();}
  }
  q('#tlForm').addEventListener('submit',event=>{event.preventDefault();void saveTopic().catch(caught=>error(caught.message));});
  dialog.addEventListener('input',event=>{
    if(event.target.id==='tlSearch')return list();if(event.target.closest('#tlForm')){formDirty=true;stash();q('#tlStatus').textContent='本次输入尚未保存';error();}
  });
  q('#tlFilter').addEventListener('change',list);
  dialog.addEventListener('click',event=>{let ownsAction=false;void (async()=>{
    const button=event.target.closest('button');if(!button || posting || acting)return;
    if(button.dataset.tlTopic)return edit(button.dataset.tlTopic);
    if(button.dataset.tlOpenDraft){dialog.close();return openDraft(button.dataset.tlOpenDraft);}
    if(button.dataset.tlOpenSession){dialog.close();return openSession(button.dataset.tlOpenSession);}
    const action=button.dataset.tl;
    if(['compose','archive','restore','export'].includes(action)){acting=true;ownsAction=true;buttons();}
    if(action==='close'){stash();dialog.close();}
    if(action==='new'){if(!editingId && formDirty)throw new Error('请先保存正在填写的选题，再新建下一条。');edit('',{title:'',angle:'',reader:'',premise:'',material:'',evidenceGaps:'',source:null,sourceURL:''});}
    if(action==='capture'){
      if(!editingId && formDirty)throw new Error('请先保存正在填写的选题，再从稿件创建下一条。');
      const doc=capture();if(!doc?.text?.trim())throw new Error('请先打开一篇有正文的稿件或引用来源。');
      if(Array.from(doc.text).length>12000)throw new Error('当前来源超过 12000 字，请先精简素材，或新建选题后粘贴需要的部分。');
      edit('',{title:doc.title || '新的写作选题',material:doc.text,sourceURL:topics.safeSourceURL(doc.url),source:{title:doc.title,text:doc.text,url:topics.safeSourceURL(doc.url),document_id:doc.id,document_version:doc.version}});
      q('#tlTopicTitle').focus();
    }
    if(action==='compose'){
      const topic=await saveTopic();const spec=topics.topicToScene(topic);
      if(topic.status==='candidate'){topics.setTopicStatus(getData(),topic.id,'selected');changed();await flush();}
      dialog.close();compose(spec);
    }
    if(action==='archive' || action==='restore'){
      if(!editingId)return;await saveTopic();topics.setTopicStatus(getData(),editingId,action==='archive'?'archived':'candidate');changed();await flush();cache.delete(editingId);
      if(action==='restore')q('#tlFilter').value='active';edit(editingId);q('#tlStatus').textContent=action==='archive'?'已归档，可恢复':'已恢复选题';
    }
    if(action==='export'){
      const topic=await saveTopic(),name=topic.title.replace(/[\\/:*?"<>|]/g,' ').slice(0,90) || '选题';
      if(ctx.download)await ctx.download(`${name}-选题.md`,topics.exportTopic(topic),'text/markdown;charset=utf-8');
    }
  })().catch(caught=>{error(caught.message);q('#tlStatus').textContent='本次操作未完成，请检查提示';}).finally(()=>{if(ownsAction){acting=false;buttons();}});});
  dialog.addEventListener('cancel',event=>{if(posting || acting)event.preventDefault();else stash();});
  dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus({preventScroll:true});});
  return {open(options={}){opener=document.activeElement;topics.ensureLibrary(getData());if(!dialog.open)dialog.showModal();edit(options.new?'':options.id || editingId,options.prefill || null);},
    refresh(){if(dialog.open){list();links();buttons();}},close(){if(!posting){stash();dialog.close();}},hasUnsaved(){return formDirty || cache.size>0;}};
}
