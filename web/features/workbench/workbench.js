(function () {
  let root, ctx, state, diff, presentation, data, catalog, model, revision=0, loaded=false;
  let commerceAnalysis, trafficAnalysis, mediaProduction, importBridge, creativeScenes, sceneModule, topicLibrary, topicState, studioWorkflow, sourceIntake, sourceGuard, lastDraftClick=null;
  let mobileChatOpen=false,libraryCompact=null;
  let dirty=false, serial=0, saving=null, timer, conflict=false, pending=null, compacting=false, editMode, comparison, suggestion=null;
  let recovery=null,recovering=false,editSaving=false;const recoveryInputs=new Map();
  const q = selector => root.querySelector(selector);
  const esc = value => ctx.esc(String(value ?? ''));
  const allSkills = () => [...catalog.skills].sort((a,b) => (a.id===state.DEFAULT_SKILL?-1:b.id===state.DEFAULT_SKILL?1:0)).concat(data.skills);
  const session = () => data.sessions.find(item => item.id === data.ui.activeSessionId);
  const activeTab = () => data.ui.tabs.find(tab => tab.key === data.ui.activeTab);
  const documentFor = tab => tab?.kind === 'draft' ? data.drafts.find(d => d.id === tab.id) : tab?.kind === 'reference' ? data.references.find(r => r.id === tab.id) : null;
  const current = () => documentFor(activeTab());
  function syncMediaProductionButton() {
    const item=current(), button=q('[data-wb="media-production"]');
    if (button) button.disabled=!(activeTab()?.kind==='draft' && item && !item.readOnly && !q('#wbDraft').readOnly && q('#wbDraft').value.trim());
  }
  function captureMediaDocument() {
    const item=current();
    if (activeTab()?.kind!=='draft' || !item || item.readOnly || q('#wbDraft').readOnly) throw new Error('请先打开一篇可编辑稿件。');
    const text=q('#wbDraft').value;
    if (!text.trim()) throw new Error('稿件正文为空，请先写入内容。');
    const origin=item.source || item.metadata || {};
    return {document_id:item.id,document_version:item.version ?? 0,title:q('#wbTitle').value || item.title || '未命名稿件',text,
      source:origin && typeof origin==='object'?JSON.parse(JSON.stringify(origin)):{},captured_at:new Date().toISOString()};
  }
  const skillFor = id => allSkills().find(item => item.id === id);
  const chosenSkill = () => session()?.workflow && sceneModule?.sceneFor(session().workflow.scene_id)
    ? {id:'builtin:creative-scenes',name:sceneModule.sceneFor(session().workflow.scene_id).name,prompt:'',builtin:true}
    : skillFor(session().skillId) || skillFor(state.DEFAULT_SKILL) || catalog.skills[0];
  const fail = error => {
    q('#wbError').hidden = false;
    const msg = error.message || String(error);
    if (/409|另一窗口/.test(msg)) {
      q('#wbError').innerHTML = `<span>⚠️ ${esc(msg)}</span> <button type="button" onclick="location.reload()" style="margin-left:12px;padding:3px 12px;background:#059669;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">🔄 点击刷新同步最新版</button>`;
    } else {
      q('#wbError').textContent = msg;
    }
    if (root.hidden) ctx.showToast(msg, 'error');
  };
  function globalSaveStatus(text,error=false){const label=document.querySelector('#studioSaveLabel');if(label)label.textContent=text;document.querySelector('#studioConnection')?.classList.toggle('is-error',error);}
  const clearError = () => { q('#wbError').hidden=true; };
  const date = value => value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '';
  function initColumnResizing() {
    const layout=q('#wbLayout'), handles=[...layout.querySelectorAll('[data-wb-split]')];
    const minimum={left:190,center:360,chat:300}, clamp=(n,min,max) => Math.max(min,Math.min(max,n));
    let widths, drag;
    const available = () => layout.getBoundingClientRect().width-10;
    function apply(preference=data.ui.columnWidths) {
      if (window.innerWidth<=1120 || available()<=0) return;
      const space=available();
      const left=clamp(Number(preference?.left)||220,minimum.left,space-minimum.center-minimum.chat);
      const center=clamp(Number(preference?.center)||(space-left-(Number(preference?.chat)||360)),minimum.center,space-left-minimum.chat);
      widths={left,center,chat:space-left-center};
      layout.style.setProperty('--wb-left',`${left}px`);
      layout.style.setProperty('--wb-center',`${center}px`);
      handles.forEach(handle => {
        const first=handle.dataset.wbSplit==='left', value=first?left:center;
        handle.setAttribute('aria-valuemin',first?minimum.left:minimum.center);
        handle.setAttribute('aria-valuemax',Math.floor(first?left+center-minimum.center:space-left-minimum.chat));
        handle.setAttribute('aria-valuenow',Math.round(value));
      });
    }
    function move(which,delta,start) {
      if (which==='left') {
        const combined=start.left+start.center, left=clamp(start.left+delta,minimum.left,combined-minimum.center);
        apply({left,center:combined-left});
      } else apply({left:start.left,center:start.center+delta});
    }
    function finish(event) {
      if (!drag || (event.pointerId!==undefined && event.pointerId!==drag.id)) return;
      const previous=drag; drag=null;
      document.documentElement.classList.remove('wb-resizing'); previous.handle.classList.remove('is-dragging');
      if (event.type==='pointercancel') apply(previous.start);
      else { data.ui.columnWidths={left:widths.left,chat:widths.chat}; changed(); }
      if (previous.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id);
    }
    for (const handle of handles) {
      handle.addEventListener('pointerdown',event => {
        if (event.button!==0 || window.innerWidth<=1120) return;
        event.preventDefault(); apply();
        drag={id:event.pointerId,x:event.clientX,start:{...widths},handle};
        handle.setPointerCapture(event.pointerId); handle.classList.add('is-dragging');
        document.documentElement.classList.add('wb-resizing');
      });
      handle.addEventListener('pointermove',event => {
        if (drag?.id===event.pointerId) move(handle.dataset.wbSplit,event.clientX-drag.x,drag.start);
      });
      for (const name of ['pointerup','pointercancel','lostpointercapture']) handle.addEventListener(name,finish);
      handle.addEventListener('keydown',event => {
        if (!['ArrowLeft','ArrowRight'].includes(event.key) || window.innerWidth<=1120) return;
        event.preventDefault(); apply(); move(handle.dataset.wbSplit,(event.key==='ArrowRight'?1:-1)*(event.shiftKey?40:10),widths);
        data.ui.columnWidths={left:widths.left,chat:widths.chat}; changed();
      });
      handle.addEventListener('dblclick',() => { delete data.ui.columnWidths; apply(); changed(); });
    }
    new ResizeObserver(() => { if (!drag) apply();renderChatVisibility(); }).observe(layout);
    apply();
  }
  function changed() {
    dirty=true; serial++;globalSaveStatus('尚未保存');
    q('#wbSaveStatus').textContent='未保存'; q('#wbSkillSaveStatus').textContent='未保存';
    clearTimeout(timer); timer=setTimeout(() => void save().catch(fail),650);
  }
  async function save() {
    clearTimeout(timer);
    if (!loaded || !dirty) return;
    if (saving) { await saving; if (dirty) return save(); return; }
    if (conflict) throw new Error('另一个窗口已更新工作台。请导出备份后重新加载，避免覆盖内容。');
    const body=JSON.stringify({revision,data}), version=serial;
    q('#wbSaveStatus').textContent='正在保存…';globalSaveStatus('正在保存…');
    saving=ctx.api('/api/writing-workbench',{method:'PUT',body}).then(result => {
      revision=result.revision; if (serial===version) dirty=false;globalSaveStatus(dirty?'尚未保存':'已保存到本机');
      q('#wbSaveStatus').textContent=dirty?'未保存':'已保存到本机';
      q('#wbSkillSaveStatus').textContent=dirty?'未保存':'已保存到本机';
    }).catch(error => {
      if (/409|另一个窗口/.test(error.message)) conflict=true;
      q('#wbSaveStatus').textContent='保存失败';globalSaveStatus('保存失败',true); throw error;
    }).finally(() => { saving=null; });
    await saving; if (dirty) return save();
  }
  function download(text,name,type='text/markdown;charset=utf-8') {
    if (ctx.download) return ctx.download(name,text,type);
    const url=URL.createObjectURL(new Blob([text],{type})), anchor=document.createElement('a');
    anchor.href=url; anchor.download=name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  async function copy(text) {
    if (!text) return ctx.showToast('还没有可复制的内容','error');
    if (ctx.copy) return ctx.copy(text);
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const area=document.createElement('textarea'); area.value=text; area.style.cssText='position:fixed;opacity:0'; document.body.append(area); area.select();
      const ok=document.execCommand('copy'); area.remove(); if (!ok) throw new Error('复制失败，请选中文字后按 ⌘C');
    }
    ctx.showToast('已复制');
  }
  function trackOptions(selected='',defaults=false) {
    return `${defaults?'':'<option value="">跟随 skill</option>'}<option value="none">无底座</option>` + catalog.tracks.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  }
  const skillGuideRequests=new Map();
  async function ensureSkillGuide(id) {
    const item=skillFor(id);
    if (!item || !String(id).startsWith('host:') || item._guidanceState==='loaded') return item;
    if (skillGuideRequests.has(id)) return skillGuideRequests.get(id);
    item._guidanceState='loading';
    const request=Promise.resolve().then(async()=>{
      try {
        const result=await ctx.api('/api/skill-workflow/guide/'+encodeURIComponent(id));
        if (result?.skill?.id!==id || typeof result.skill.prompt!=='string') throw new Error('技能指导已变化，请刷新目录后重试。');
        item.prompt=result.skill.prompt;item._guidanceState='loaded';delete item._guidanceError;
        return item;
      } catch(error) {
        item._guidanceState='error';item._guidanceError=error.message || String(error);throw error;
      } finally {
        skillGuideRequests.delete(id);
        if(activeTab()?.kind==='skill' && activeTab()?.id===id)renderEditor();
      }
    });
    skillGuideRequests.set(id,request);return request;
  }
  function openTab(kind,id) {
    if (kind==='skill' && skillFor(id)?.protected) return;
    const key=`${kind}:${id}`;
    if (!data.ui.tabs.some(t => t.key===key)) data.ui.tabs.push({key,kind,id});
    data.ui.activeTab=key;
    if (kind==='draft') session().currentDocumentId=id;
    changed(); renderTree(); renderEditor();
    if(kind==='skill')void ensureSkillGuide(id).catch(fail);
  }
  function renderTree() {
    const row=(kind,item,label,extra='') => `<div ${kind==='draft'?`draggable="true" data-drag-draft="${esc(item.id)}"`:''} class="wb-tree-row ${data.ui.activeTab===`${kind}:${item.id}`?'active':''}"><button type="button" class="wb-tree-open" data-open-kind="${kind}" data-open-id="${esc(item.id)}" title="${esc(item.path || label)}${kind==='draft'?' · 双击重命名':''}">${esc(label)}${extra}</button>${kind==='draft'?`<button type="button" class="wb-draft-rename" data-rename-draft="${esc(item.id)}" title="重命名稿件" aria-label="重命名稿件：${esc(item.title)}"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m12.8 3.3 3.9 3.9M4 12.1 12.8 3.3a1.5 1.5 0 0 1 2.1 0l1.8 1.8a1.5 1.5 0 0 1 0 2.1L7.9 16H4z"/></svg></button>`:''}</div>`;
    const folders=new Set(['二创稿',...data.folders.map(f => f.path || `二创稿/${state.cleanName(f.name)}`),...data.drafts.map(d => d.folderId)]);
    for (const path of [...folders]) { const parts=path.split('/'); while (parts.length>1) { parts.pop(); folders.add(parts.join('/')); } }
    const folderTree=folder => {
      const items=data.drafts.filter(d => d.folderId===folder).map(d => row('draft',d,`▤ ${d.title}.md`)).join('');
      const children=[...folders].filter(path => path!==folder && path.slice(0,path.lastIndexOf('/'))===folder).sort().map(path => `<details class="wb-folder" data-folder-path="${esc(path)}" ${(data.ui.closedFolders || []).includes(path)?'':'open'}><summary data-drop-folder="${esc(path)}"><span class="wb-folder-name">${esc(path.split('/').at(-1))}</span><button type="button" data-rename-folder="${esc(path)}" title="重命名文件夹" aria-label="重命名文件夹：${esc(path.split('/').at(-1))}">✎</button><button type="button" data-delete-folder="${esc(path)}" title="删除文件夹">×</button></summary>${folderTree(path)}</details>`).join('');
      return folder==='二创稿'?`<div class="wb-root-drop" data-drop-folder="二创稿">${items || '<div class="wb-empty">未分类稿件</div>'}</div>${children}`:items+children || '<div class="wb-empty">空文件夹</div>';
    };
    q('#wbDocs').innerHTML=folderTree('二创稿');
    q('#wbDraftTree > summary').dataset.dropFolder='二创稿';
    q('#wbReferences').innerHTML=data.references.map(r => row('reference',r,`▤ ${r.title}.md`)).join('') || '<div class="wb-empty">添加对标文案或资料</div>';
    q('#wbSkills').innerHTML=allSkills().filter(s=>!s.protected).map(s => row('skill',s,`▤ ${s.name}`)).join('');
    q('#wbSessionItems').innerHTML=data.sessions.map(s => `<div class="wb-session-item ${s.id===session().id?'active':''}"><button type="button" data-session="${esc(s.id)}"><strong>${esc(s.title)}</strong><small>${esc(skillFor(s.skillId)?.name || 'AI 助手')} · ${date(s.createdAt)}</small></button><button type="button" class="wb-session-rename" data-rename-session="${esc(s.id)}" aria-label="重命名会话">✎</button><button type="button" class="wb-session-delete" data-delete-session="${esc(s.id)}" aria-label="删除会话">×</button></div>`).join('');
  }
  function moveDraft(draft,folder) {
    if(pending || compacting)throw new Error('请等待当前生成完成后再整理稿件。');
    const basename=draft.path.slice(draft.path.lastIndexOf('/')+1),path=`${folder}/${basename}`;
    if(data.drafts.some(d=>d.id!==draft.id && d.path===path))throw new Error('目标文件夹已有同名稿件，请先重命名。');
    draft.folderId=folder;draft.path=path;data.ui.closedFolders=(data.ui.closedFolders || []).filter(p=>folder!==p && !folder.startsWith(p+'/'));
    changed();renderTree();renderEditor();
  }
  function renderEditor() {
    data.ui.tabs=data.ui.tabs.filter(tab => tab.kind==='skill'?skillFor(tab.id) && !skillFor(tab.id).protected:documentFor(tab));
    if (!activeTab()) data.ui.activeTab=data.ui.tabs.at(-1)?.key || '';
    const tab=activeTab(), item=current(), skill=tab?.kind==='skill' && skillFor(tab.id);
    q('#wbTabs').innerHTML=data.ui.tabs.map(t => {
      const value=t.kind==='skill'?skillFor(t.id):documentFor(t);
      return `<div class="wb-tab ${t.key===tab?.key?'active':''}"><button type="button" data-open-kind="${t.kind}" data-open-id="${esc(t.id)}">${esc(value.name || `${value.title}.md`)}</button><button type="button" data-close-tab="${esc(t.key)}" aria-label="关闭文件">×</button></div>`;
    }).join('');
    q('#wbEmptyDraft').hidden=Boolean(tab); q('#wbSkillEditor').hidden=!skill; q('#wbEditorFields').hidden=!item;
    q('#wbQuickDraft').value=data.ui.quickDraft;
    q('[data-wb="quick-reference"]').disabled=!data.ui.quickDraft.trim();
    if (skill) {
      q('#wbSkillEditorTitle').textContent=skill.builtin?'内置 skill（只读）':'我的 skill';
      for (const [field,key] of [['Name','name'],['Description','description'],['Version','version'],['Prompt','prompt']]) {
        q(`#wbSkill${field}`).value=skill[key] || ''; q(`#wbSkill${field}`).readOnly=Boolean(skill.builtin);
      }
      q('#wbSkillTrack').innerHTML=trackOptions('',true); q('#wbSkillTrack').value=skill.defaultTrack || 'none'; q('#wbSkillTrack').disabled=Boolean(skill.builtin);
      q('#wbCopySkill').hidden=!skill.builtin; q('#wbSaveSkill').hidden=Boolean(skill.builtin); q('#wbDeleteSkill').hidden=Boolean(skill.builtin);
      q('#wbSkillSaveStatus').textContent=skill._guidanceState==='loading'?'正在读取技能指导…':skill._guidanceState==='error'?'技能指导未读取，请重新打开重试':String(skill.id).startsWith('host:')?(skill.availability?.execution==='requires_tool'?'本机技能 · 制作需交给 Codex 执行':'本机技能 · 只读'):skill.builtin?'内置 skill · 只读':dirty?'未保存':'已保存到本机';
    }
    if (item) {
      const readonly=tab.kind==='reference';
      q('#wbFolder').hidden=readonly; q('#wbFolder').innerHTML=[...new Set(['二创稿',...data.folders.map(f => f.path || `二创稿/${state.cleanName(f.name)}`),...data.drafts.map(d => d.folderId)])].map(path => `<option value="${esc(path)}">${esc(path)}</option>`).join(''); q('#wbFolder').value=item.folderId || '二创稿';
      q('#wbTitle').value=item.title; q('#wbTitle').readOnly=readonly;
      q('#wbDraft').value=item.text; q('#wbDraft').readOnly=readonly; q('#wbDraft').hidden=false; q('#wbDraftPreview').hidden=true; q('[data-wb="preview-draft"]').textContent='预览';
      q('#wbCount').textContent=state.countLabel(item.text,{article:item.lengthCountMode==='article'});
      q('#wbDocumentPath').textContent=item.path;
      for (const action of ['save','new-version','versions','previous-version']) q(`[data-wb="${action}"]`).hidden=readonly;
      q('#wbSaveStatus').textContent=readonly?'引用来源 · 只读':dirty?'未保存':'已保存到本机';
    }
    renderLengthHint(item);syncMediaProductionButton();renderSourceNotice(item,tab);
  }
  function renderSourceNotice(item,tab){
    const notice=q('#wbSourceNotice');if(!notice)return;
    const incomplete=Boolean(sourceGuard?.(item)),original=tab?.kind==='reference';
    const output=q('[data-wb="production-status"]');if(output)output.hidden=original;q('[data-wb="media-production"]').hidden=original;
    notice.hidden=!item || (!incomplete && !original);notice.classList.toggle('is-incomplete',incomplete);
    if(notice.hidden)return;
    notice.innerHTML=incomplete?'<p><strong>这份旧导入尚未确认是完整原文。</strong>它可能只是搜索摘要。先重新获取全文或粘贴完整正文，再开始二创。</p><button type="button" data-wb="repair-source">重新获取完整原文</button>':`<p><strong>第 2 步：查看原文</strong> · ${Array.from(item.text.replace(/\s/g,'')).length} 字 · 原文保留为只读。确认后会新建二创稿，不修改原文。</p><button type="button" data-wb="compose-source">基于原文二创 →</button><button type="button" data-wb="repair-source">更换原文</button>`;
  }
  function renderModels() {
    q('#wbModelLabel').textContent=model?.api_key_configured ? '密钥设置' : '填写密钥';
    q('#wbModelChip').textContent='密钥设置';
    q('#wbModelChip').title=model?.verified?'密钥已验证':'填写工作台密钥';
    q('#wbSearchMode option[value="provider"]').disabled=true;
    syncBusy();
  }
  function renderSession() {
    const s=session(), skill=chosenSkill();
    q('#wbSkillSelect').innerHTML=allSkills().map(k => `<option value="${esc(k.id)}">${esc(k.name)}${k.builtin?' · 内置':''}</option>`).join('');
    q('#wbSkillSelect').value=skill.id; q('#wbSkillPill').textContent=`✦ ${skill.name}`;
    q('#wbTrackSelect').innerHTML=trackOptions().replace('跟随 skill',skill.defaultTrack && skill.defaultTrack!=='none'?'跟随 skill':'无底座'); q('#wbTrackSelect').value=s.trackId;
    q('#wbSearchMode').value=s.searchMode; q('#wbThinking').value=s.thinking;
    q('#wbMessage').value=s.input;
    renderAttachments(); renderReferenceChips(); renderMessages(); renderContext();
  }
  function captureSceneSources() {
    const selected=new Set(session().referenceIds || []), item=current();
    if(item)selected.add(item.id);
    return [...data.references,...data.drafts].filter(doc=>selected.has(doc.id)).map(doc=>({
      id:doc.id,title:doc.id===item?.id?q('#wbTitle').value || doc.title:doc.title,
      text:doc.id===item?.id?q('#wbDraft').value:doc.text,version:doc.version || 0,
      source:doc.source || doc.metadata || {}
    })).filter(doc=>String(doc.text || '').trim());
  }
  async function startScene(spec) {
    if(pending || compacting)throw new Error('请先完成或停止当前生成。');
    await save();
    if(spec.topicId){const topic=topicState.getTopic(data,spec.topicId);if(!topic || topic.status==='archived')throw new Error('选题已变化，请在选题库恢复或重新选择。');}
    const created=sceneModule.createSceneSession(data,state,spec);
    if(spec.topicId){created.workflow.topic_id=spec.topicId;topicState.linkScene(data,spec.topicId,created.id);}
    mobileChatOpen=true;changed();renderTree();renderSession();renderChatVisibility();
    await save();
    void send().catch(error=>{if(created.workflow?.topic_id){topicState.markInterrupted(data,created.workflow.topic_id);changed();}fail(error);});
  }
  function captureTopicSource(){
    const doc=current();if(!doc)return null;const source=doc.source || doc.metadata || {};
    return {id:doc.id,title:q('#wbTitle').value || doc.title,text:q('#wbDraft').value,version:doc.version || 0,url:source.url || source.source_url || source.web_url || ''};
  }
  function renderReferenceChips() {
    const s=session();
    const items=[...data.references,...data.drafts].filter(r => s.referenceIds.includes(r.id));
    q('#wbReferenceChips').innerHTML=items.map(r => `<span class="wb-reference-chip">＠ ${esc(r.title)}<button type="button" data-remove-ref="${esc(r.id)}" aria-label="取消引用">×</button></span>`).join('');
  }
  function renderChatVisibility() {
    const compact=window.innerWidth<=1120,collapsed=compact?!mobileChatOpen:Boolean(data.ui.chatCollapsed);
    q('#wbLayout').classList.toggle('wb-chat-collapsed',collapsed);
    q('#wbLayout').classList.toggle('wb-chat-mobile-open',compact && !collapsed);
    q('.wb-chat').hidden=collapsed;
    q('[data-wb-split="center"]').hidden=collapsed;
    q('#wbExpandChat').hidden=!collapsed;
    q('#wbCollapseChat').setAttribute('aria-expanded',String(!collapsed));
    const library=q('#wbLibraryBrowser'),narrow=window.innerWidth<=600;
    if(library && libraryCompact!==narrow){library.open=!narrow;libraryCompact=narrow;}
  }
  function imageSource(item) { return typeof item==='string'?item:item.data; }
  function renderAttachments() {
    q('#wbAttachmentList').innerHTML=session().images.map((image,index) => `<div class="wb-attachment"><button type="button" data-preview-attachment="${index}" aria-label="预览图片"><img src="${esc(imageSource(image))}" alt="${esc(image.name || '附件图片')}" /></button><small>${esc(image.name || '图片')}</small><button type="button" data-remove-image="${index}" aria-label="移除图片">×</button></div>`).join('');
  }
  const markdown = text => presentation.markdown(text);
  const fileLabel = path => String(path || '').slice(String(path || '').lastIndexOf('/')+1).replace(/\.md$/,'');
  const measuredCount = (text,draft) => state.manuscriptCount(text,{article:draft?.lengthCountMode==='article'}).body;
  function renderLengthHint(draft) {
    const note=draft && presentation.lengthNote(draft.lengthRequirement,measuredCount(draft.text,draft));
    q('#wbLengthHint').hidden=!note;q('#wbLengthHint').textContent=note || '';
  }
  function changeCard(message,index) {
    const change=message.changes[index];
    return `<div class="wb-write-action"><code>${change.kind==='edit'?'Edit':'Write'}</code><span class="wb-write-title" title="${esc(change.path)}">${esc(fileLabel(change.path))}</span><span class="wb-write-added">+${change.added || 0}</span>${change.removed?`<span class="wb-write-removed">−${change.removed}</span>`:''}<small>v${change.version}</small><button type="button" data-compare-message="${esc(message.id)}" data-change-index="${index}">查看改动</button></div>`;
  }
  function assistantBody(message,streaming=false) {
    return presentation.replyParts(message,streaming).map((part, partIndex) => {
      if (part.type==='text') {
        if (!part.text.trim()) return '';
        if (typeof presentation?.readableReply === 'function') {
          return presentation.readableReply(part.text, {streaming, key: `${message.id || 'live'}-${partIndex}`});
        }
        return markdown(part.text);
      }
      if (part.type==='change') return changeCard(message,part.changeIndex);
      return `<div class="wb-write-action ${part.type==='pending'?'pending':'failed'}"><code>${part.kind==='edit'?'Edit':'Write'}</code><span class="wb-write-title" title="${esc(part.path)}">${esc(fileLabel(part.path))}</span><span class="wb-write-note">${part.type==='pending'?`接收候选内容… ${part.count} 字，完成后校验`:`未保存：${esc(part.reason)}`}</span>${part.type==='error' && part.complete && part.kind==='file' && message.id?`<button type="button" data-recover-message="${esc(message.id)}" data-operation-index="${part.operationIndex}">取回为新草稿</button>`:''}</div>`;
    }).join('');
  }
  function renderMessages(scroll=false) {
    const s=session();
    q('#wbMessages').innerHTML=(s.summary?`<details class="wb-search-results"><summary>早期对话摘要</summary><p>${esc(s.summary)}</p></details>`:'')+s.messages.map((m,messageIndex) => {
      const images=(m.images || []).map((image,index) => `<button type="button" data-preview-message="${esc(m.id)}" data-image-index="${index}" aria-label="预览图片"><img src="${esc(imageSource(image))}" alt="对话附件" /></button>`).join('');
      if (m.role==='user') {
        // Older sessions stored search evidence on the answer. Present it on
        // the associated question, as the original workbench does.
        const answer=s.messages[messageIndex+1];
        const results=presentation.searchResults(m.searchResults || (answer?.role==='assistant'?answer.searchResults:[]));
        const search=results.length?`<details class="wb-web"><summary>🔍 搜索了 ${results.length} 条</summary><div class="wb-web-list">${results.map(r => `<div class="wb-web-item"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="在浏览器打开：${esc(r.url)}">${esc(r.title || r.url)}</a><span>${esc(r.source || new URL(r.url).hostname)}</span></div>`).join('')}</div></details>`:'';
        const refs=(m.references || []).map(r => `<span class="wb-reference-chip">@${esc(r.title)}</span>`).join('');
        return `<article class="wb-message user"><div class="wb-user-bubble">${refs?`<div class="wb-message-references">${refs}</div>`:''}${esc(m.content)}${images?`<div class="wb-message-images">${images}</div>`:''}${search}</div>${m.interruptedReply?`<details class="wb-raw"><summary>连接中断前的回复（未写入稿件）</summary><pre>${esc(m.interruptedReply)}</pre></details>`:''}${m.error?`<div class="wb-message-error">${esc(m.error)}</div><button type="button" data-retry="${esc(m.id)}">重试</button>`:''}</article>`;
      }
      const body=assistantBody(m);
      const errors=(m.documentErrors || []).filter(e => !presentation.replyParts(m).some(part => part.type==='error' && part.path===e.path)).map(e => `<div class="wb-message-error">${esc(e.path || '')} ${esc(e.reason || e.message || e)}</div>`).join('');
      const warnings=(m.lengthWarnings || []).map(w=>`<p class="wb-length-warning">${esc(presentation.lengthNote(w,w.actual) || w.message || '')}</p>`).join('');
      const toolbar = `<div class="wb-msg-toolbar"><button type="button" class="wb-msg-btn" data-msg-copy="${esc(m.id)}" title="复制回复内容">📋 复制</button><button type="button" class="wb-msg-btn" data-msg-replace="${esc(m.id)}" title="将此内容替换为当前编辑稿的正文">📝 替换正文</button><button type="button" class="wb-msg-btn" data-msg-append="${esc(m.id)}" title="将此内容追加到当前编辑稿文末">➕ 追加文末</button><button type="button" class="wb-msg-btn" data-msg-new="${esc(m.id)}" title="将此内容创建为一份独立的新稿件">📄 另存新稿</button></div>`;
      return `<article class="wb-message assistant"><div class="wb-message-text">${body}</div>${warnings}${errors}${m.rawText && m.documentErrors?.length?`<details class="wb-raw"><summary>查看未应用的原始回复</summary><pre>${esc(m.rawText)}</pre></details>`:''}${toolbar}</article>`;
    }).join('');
    if (pending?.sessionId===s.id) q('#wbMessages').insertAdjacentHTML('beforeend',`<div class="wb-live-text wb-message-text">${assistantBody({content:pending.text,rawText:pending.text},true)}</div><div class="wb-thinking" role="status">${pending.stopping?'正在停止，保留已完成内容…':'正在思考，请稍候…'}</div>`);
    syncBusy(); if (scroll) q('#wbMessages').scrollTop=q('#wbMessages').scrollHeight;
  }
  function contextText() {
    const s=session(); return [s.summary,chosenSkill().prompt || '',...s.messages.map(m => m.rawText || m.content),...[...data.references,...data.drafts].filter(r => s.referenceIds.includes(r.id)).map(r => r.text),data.drafts.find(d => d.id===s.currentDocumentId)?.text || ''].join('');
  }
  function renderContext() {
    const s=session(), text=contextText();
    const percent=Math.min(100,Math.round(text.length/60000*100));
    q('#wbContext').textContent=`上下文 ${percent}%`;
    q('#wbContext').title=`约 ${text.length.toLocaleString()} / 60,000 字符；超过 80% 时会整理早期对话，保留最近两轮`;
    q('#wbCompact').disabled=Boolean(pending || compacting) || s.messages.filter(m => m.role==='user').length<3;
  }
  function syncBusy() {
    if (!loaded) return;
    q('#wbSend').disabled=Boolean(compacting || pending?.stopping) || !model?.api_key_configured || !model?.verified;
    q('#wbSend').textContent=pending?(pending.stopping?'正在停止…':'停止'):'发送';
    q('#wbSendHint').textContent=pending?'正在生成，可继续编辑稿件':compacting?'正在压缩早期对话…':!model?.api_key_configured || !model?.verified?'请先在设置中填写并验证密钥':'Enter 发送 · Shift + Enter 换行';
    creativeScenes?.render(session(),Boolean(pending || compacting));
  }
  const apiMessages = messages => messages.map((m,index) => {
    // Mentions are selected per turn. Keep their context in later turns too,
    // using the latest document text rather than leaving only a display chip.
    const references=index<messages.length-1 && m.role==='user'?(m.references || []).map(ref => [...data.references,...data.drafts].find(item => item.id===ref.id)).filter(Boolean):[];
    const content=(m.role==='assistant' && m.documentErrors?.length?presentation.failedReplyContext(m):(m.content || ''))+references.map(ref => `\n\n【引用 ${ref.path || ref.title}】\n${ref.text}`).join('');
    return {role:m.role,content,...(m.rawText?{rawText:m.rawText}:{}),...(m.images?.length?{images:m.images.map(imageSource)}:{})};
  });
  async function send(retryId='') {
    if (!loaded || pending || compacting) return;
    const s=session();
    const selectedDocs=[...data.references,...data.drafts].filter(doc=>s.referenceIds.includes(doc.id));if(s.includeDraft&&current())selectedDocs.push(current());
    if(selectedDocs.some(doc=>sourceGuard?.(doc) && (doc.text||'').trim().length < 30))throw new Error('引用的原稿内容为空或不足，请补充完整正文再开始二创。');
    if (!model?.api_key_configured || !model?.verified) {if(s.workflow?.topic_id){topicState.markInterrupted(data,s.workflow.topic_id);changed();}throw new Error('请先在设置中填写并验证密钥');}
    const last=s.messages.at(-1), skill=chosenSkill();
    if (retryId && (last?.id!==retryId || !last.error)) throw new Error('只能重试本会话最后一条失败的消息');
    if (!retryId && s.messages.filter(m => m.role==='user').length>=4 && contextText().length>48000) await compact();
    const content=retryId?last.content:s.input.trim();
    if (!content && !s.images.length && !retryId) return;
    if (!retryId && last?.role==='user') throw new Error('上一条请求尚未完成，请点击重试或新建会话');
    if(s.workflow?.topic_id)topicState.linkScene(data,s.workflow.topic_id,s.id);
    const selectedReferences=[...data.references,...data.drafts].filter(r => (retryId?(last.references || []).map(r => r.id):s.referenceIds).includes(r.id));
    const message=retryId?last:{id:state.uid(),role:'user',content,images:structuredClone(s.images),references:selectedReferences.map(r => ({id:r.id,title:r.title})),createdAt:new Date().toISOString()};
    if (!retryId) s.messages.push(message);
    delete message.error; s.input=''; s.images=[]; s.referenceIds=[]; closeSuggestions();
    if (s.title==='新会话') s.title=content.slice(0,18) || '图片写作';
    pending={sessionId:s.id,requestId:state.uid(),text:''}; clearError(); changed(); renderSession(); renderTree();
    try {
      await save();
      // Include references in the document inventory as read-only paths too.
      const drafts=[...data.drafts,...data.references.map(r => ({...r,type:'reference',readOnly:true}))];
      const lengthRequest=s.workflow?(/(?:^|\n)篇幅目标：([^\n]+)/.exec(s.workflow.brief || '')?.[1] || ''):content;
      const request={length_policy:'draft',length_request:lengthRequest,skill_id:skill.id,track_id:s.trackId,selected_skill:{id:skill.id,builtin:Boolean(skill.builtin)},current_document_id:s.currentDocumentId || '',drafts,references:selectedReferences.map(r => ({title:r.title,text:r.text})),messages:apiMessages(s.messages),search_mode:s.searchMode,thinking:s.thinking,context_summary:s.summary,
        ...(s.workflow?{workflow:{scene_id:s.workflow.scene_id,stage:s.workflow.stage}}:{})};
      const result=await streamChat({...request,request_id:pending.requestId});
      const answer=state.mergeReply(data,result,s.id,skill);
      if(s.workflow?.topic_id && answer.changes.length){
        try{for(const id of new Set(answer.changes.map(change=>change.draftId)))topicState.linkDraft(data,s.workflow.topic_id,id,{sessionId:s.id});}
        catch(error){ctx.showToast(`稿件已合入工作区，选题关联需检查：${error.message}`,'error');}
      }
      if(s.workflow?.topic_id && s.workflow.stage==='draft' && !answer.changes.length)topicState.markInterrupted(data,s.workflow.topic_id);
      if (result.searchError) {
        const count=presentation.searchResults(result.searchResults).length;
        ctx.showToast(count?`部分搜索未完成，本轮已使用获得的 ${count} 条资料`:result.searchError,'error');
      }
      if (session().id===s.id && answer.changes.length) openTab('draft',answer.changes.at(-1).draftId);
    } catch (error) { message.error=error.message; if (s.workflow?.topic_id)topicState.markInterrupted(data,s.workflow.topic_id);if (pending?.text) message.interruptedReply=pending.text; ctx.showToast(error.message || '生成失败','error'); }
    finally { pending=null; changed(); renderTree(); renderEditor(); if (session().id===s.id) renderMessages(true); renderContext(); await save();topicLibrary?.refresh(); }
  }
  async function streamChat(request) {
    const response=await fetch('/api/writing-workbench/chat/stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
    if (!response.ok) { const text=await response.text(); let detail=text; try { detail=JSON.parse(text).detail || text; } catch (_) {} throw new Error(typeof detail==='string'?detail:JSON.stringify(detail)); }
    const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='', result=null, lastRender=0, renderTimer;
    const renderLive=() => { clearTimeout(renderTimer); if (pending?.sessionId===session().id) { const live=q('.wb-live-text'); if (live) live.innerHTML=assistantBody({content:pending.text,rawText:pending.text},true); q('#wbMessages').scrollTop=q('#wbMessages').scrollHeight; } lastRender=Date.now(); };
    const accept=line => {
      if (!line.trim()) return;
      const event=JSON.parse(line);
      if (event.type==='error') throw new Error(event.detail || '生成失败');
      if (event.type==='delta') {
        pending.text+=event.text;
        if (Date.now()-lastRender>50) renderLive(); else { clearTimeout(renderTimer); renderTimer=setTimeout(renderLive,50); }
      }
      if (event.type==='done') { result=event.result; if (event.cancelled) ctx.showToast('已停止，完整稿件块已保留，未完成块不会写入'); }
      if (event.type==='search' && pending.sessionId===session().id && q('.wb-thinking')) q('.wb-thinking').textContent=event.error || `已获取 ${event.results?.length || 0} 条搜索结果，继续生成…`;
    };
    try {
      while (true) { const part=await reader.read(); buffer+=decoder.decode(part.value || new Uint8Array(),{stream:!part.done}); let split; while ((split=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,split); buffer=buffer.slice(split+1); accept(line); } if (part.done) break; }
      if (buffer.trim()) accept(buffer);
      if (!result) throw new Error('生成连接已中断，本次未覆盖稿件。可重试当前请求。');
      return result;
    } finally { clearTimeout(renderTimer); reader.releaseLock(); }
  }
  async function compact() {
    if (pending || compacting) return;
    const s=session();
    if (s.messages.filter(m => m.role==='user').length<3) return ctx.showToast('最近两轮会完整保留，目前无需压缩');
    compacting=true; syncBusy(); renderContext();
    try {
      await save();
      const result=await ctx.api('/api/writing-workbench/compact',{method:'POST',body:JSON.stringify({messages:apiMessages(s.messages),context_summary:s.summary})});
      if (result.compactedMessages) {
        s.archivedMessages ||= []; s.archivedMessages.push(...s.messages.splice(0,result.compactedMessages)); s.summary=result.summary; changed(); await save();
        ctx.showToast(`已压缩 ${result.compactedMessages} 条早期消息，保留最近两轮`);
      }
    } finally { compacting=false; renderSession(); }
  }
  function edit(mode) {
    editMode=mode; q('#wbDialogTitle').textContent=mode==='folder'?'新建文件夹':'添加引用来源';
    q('#wbEditName').value=''; q('#wbEditBody').value=''; q('#wbEditBodyWrap').hidden=mode==='folder'; q('#wbEditBody').required=mode!=='folder';
    q('#wbEditDialog').showModal();
  }
  function renderCompare(level=comparison.level) {
    comparison.level=level;
    const result=diff.segments(comparison.source,comparison.result,Number(level));
    const markup=segments => segments.map(s => s.matched?`<mark>${esc(s.text)}</mark>`:esc(s.text)).join('');
    q('#wbCompareSource').innerHTML=markup(result.segA); q('#wbCompareResult').innerHTML=markup(result.segB);
    q('#wbCompareReferenceText').innerHTML=markup(result.segB);
    const similarity=Number.isFinite(result.similarity)?result.similarity:100;
    q('#wbSimilarity').textContent=`重复度 ${similarity}%`; q('#wbSimilarity').classList.toggle('high',similarity>=70); q('#wbSimilarity').classList.toggle('medium',similarity>=40 && similarity<70);
    q('#wbParagraphHit').textContent=result.paragraphHit===null?'':'检测到整段重复';
    q('#wbSourceCount').textContent=`${comparison.source.length} 字`; q('#wbResultCount').textContent=`${(q('#wbCompareDialog').classList.contains('is-editing')?q('#wbCompareInput').value:comparison.result).length} 字`;
    q('#wbCompareDialog').querySelectorAll('[data-level]').forEach(button => button.classList.toggle('active',button.dataset.level===String(level)));
  }
  function openCompare(change,versionIndex=null) {
    comparison={source:change.before,result:change.after,draftId:change.draftId,expected:data.drafts.find(d => d.id===change.draftId)?.text,level:'1',versionIndex};
    q('#wbCompareInput').hidden=true; q('#wbCompareResult').hidden=false; q('#wbSaveCompare').hidden=true; q('#wbEditCompare').hidden=false; q('#wbDetectCompare').hidden=true;
    q('#wbCompareDialog').classList.remove('is-editing'); q('#wbCompareDialog').style.removeProperty('--wb-compare-edit-height');
    q('#wbCompareReference').hidden=true; q('#wbCompareDirty').hidden=true;
    renderCompare(); q('#wbCompareDialog').showModal();
  }
  function versions() {
    const d=current(); if (!d || activeTab().kind!=='draft') return;
    q('#wbVersionList').innerHTML=[...(d.versions || [])].reverse().map(v => `<div class="wb-version-row"><span>v${v.version} · ${state.count(v.text)} 字 <small>${date(v.createdAt)}</small></span><button type="button" data-version-view="${v.version}" data-version-draft="${esc(d.id)}">查看对比</button><button type="button" data-version-restore="${v.version}" data-version-draft="${esc(d.id)}">恢复为新版本</button></div>`).join('') || '<p class="wb-empty">手动编辑会自动保存。点击“存为新版本”保存第一个版本。</p>';
    q('#wbVersionsDialog').showModal();
  }
  async function addImages(files) {
    const target=session(); const accepted=[...files];
    if (target.images.length+accepted.length>6) throw new Error('每条消息最多添加 6 张图片');
    if (accepted.some(file => !['image/png','image/jpeg','image/webp'].includes(file.type))) throw new Error('请使用 PNG、JPEG 或 WebP 图片');
    if (accepted.some(file => file.size>60*1024*1024)) throw new Error('每张原图请控制在 60 MB 内');
    const images=await Promise.all(accepted.map(async file => {
      const bitmap=await createImageBitmap(file), scale=Math.min(1,1568/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height); bitmap.close();
      const type=file.type==='image/png'?'image/png':'image/jpeg';
      const content=canvas.toDataURL(type,.85);
      if (content.length*3/4>5*1024*1024) throw new Error('图片压缩后仍超过 5 MB，请缩小图片后再添加');
      return {name:file.name || '粘贴图片',data:content};
    }));
    target.images.push(...images); changed(); renderAttachments();
  }
  function previewImage(src) { q('#wbImagePreview').src=src; q('#wbImageDialog').showModal(); }
  function closeSuggestions() {
    suggestion=null; q('#wbSuggestions').hidden=true;
    q('#wbMessage').setAttribute('aria-expanded','false'); q('#wbMessage').removeAttribute('aria-activedescendant');
  }
  function highlightSuggestion(index) {
    if (!suggestion) return;
    const choices=[...q('#wbSuggestions').querySelectorAll('[data-suggest-id]')];
    suggestion.index=Math.max(0,Math.min(index,choices.length-1));
    choices.forEach((button,i) => {button.classList.toggle('active',i===suggestion.index);button.setAttribute('aria-selected',String(i===suggestion.index));});
    const selected=choices[suggestion.index];
    if (selected) {q('#wbMessage').setAttribute('aria-activedescendant',selected.id);selected.scrollIntoView({block:'nearest'});}
  }
  function suggestions() {
    const area=q('#wbMessage'), cursor=area.selectionStart, text=area.value.slice(0,cursor);
    const match=text.match(/(@|(?:^|\s)\/)([^\s@/]*)$/);
    if (!match) return closeSuggestions();
    const kind=match[1].includes('/')?'skill':'ref', marker=text.lastIndexOf(kind==='skill'?'/':'@');
    const items=(kind==='skill'?allSkills():[...data.drafts,...data.references]).filter(item => (item.name || item.title).toLocaleLowerCase().includes(match[2].toLocaleLowerCase()));
    suggestion={kind,start:marker,end:cursor,index:0};
    q('#wbSuggestions').innerHTML=items.map((item,i) => `<button type="button" role="option" aria-selected="${i===0}" id="wbSuggestion${i}" class="${i===0?'active':''}" data-suggest-kind="${kind}" data-suggest-id="${esc(item.id)}"><span>${esc(item.name || item.title)}</span><small>${esc(kind==='skill'?(item.builtin?'内置':'我的'):(item.path?.slice(0,item.path.lastIndexOf('/')) || '根目录'))}</small></button>`).join('') || `<div class="wb-suggestion-empty">没有匹配的${kind==='skill'?' skill':'稿件'}</div>`;
    q('#wbSuggestions').hidden=false; area.setAttribute('aria-expanded','true'); highlightSuggestion(0);
  }
  function selectSuggestion(button) {
    if (!suggestion || !button) return;
    const s=session(), {start,end}=suggestion;
    if (button.dataset.suggestKind==='skill') {s.skillId=button.dataset.suggestId;s.trackId='';}
    else if (!s.referenceIds.includes(button.dataset.suggestId)) s.referenceIds.push(button.dataset.suggestId);
    s.input=s.input.slice(0,start)+s.input.slice(end);
    changed(); closeSuggestions(); renderSession(); q('#wbMessage').focus(); q('#wbMessage').setSelectionRange(start,start);
  }
  async function removeDocument() {
    const tab=activeTab(), item=current(); if (!item) return;
    if (pending) throw new Error('正在生成，请结束后再删除稿件或来源');
    if (!await ctx.showConfirm({title:tab.kind==='reference'?'删除引用来源':'删除稿件',message:`删除“${item.title}”？会话记录会保留。`,danger:true})) return;
    const key=tab.kind==='reference'?'references':'drafts'; data[key]=data[key].filter(d => d.id!==item.id);
    for (const s of data.sessions) { s.referenceIds=s.referenceIds.filter(id => id!==item.id); if (s.currentDocumentId===item.id) s.currentDocumentId=''; }
    changed(); renderEditor(); renderTree(); renderReferenceChips();
  }
  function renameDraft(id){
    if(pending || compacting)throw new Error('请等待文案生成完成后再重命名，避免影响正在编辑的稿件');
    const draft=data.drafts.find(item=>item.id===id);if(!draft)return;
    lastDraftClick=null;editMode={mode:'rename-draft',id};clearError();
    q('#wbDialogTitle').textContent='重命名稿件';q('#wbEditName').value=draft.title;
    q('#wbEditBodyWrap').hidden=true;q('#wbEditBody').required=false;
    q('#wbEditName').setCustomValidity('');q('#wbEditDialog').showModal();q('#wbEditName').select();
  }
  function openRecovery(messageId,operationIndex) {
    if(pending || compacting)throw new Error('请等待当前生成完成后再取回草稿。');
    const message=session().messages.find(m=>m.id===messageId);
    if(!message)throw new Error('原始回复不存在，请重新打开对应会话。');
    const existing=data.drafts.find(d=>d.id===message.recoveredDrafts?.[operationIndex]);
    if(existing)return openTab('draft',existing.id);
    const candidate=presentation.recoverableFile(message,operationIndex);
    if(!candidate)throw new Error('只有完整且未保存的 FILE 候选稿可以取回；请查看原始回复。');
    const key=`${messageId}:${operationIndex}`,saved=recoveryInputs.get(key);
    recovery={key,messageId,sessionId:session().id,operationIndex,originalText:candidate.text,originalTitle:`${fileLabel(candidate.path)} · 取回`};
    q('#wbRecoveryTitle').value=saved?.title || recovery.originalTitle;
    q('#wbRecoveryText').value=saved?.text ?? candidate.text;q('#wbRecoveryError').hidden=true;
    q('#wbRecoveryDialog').showModal();q('#wbRecoveryTitle').focus();
  }
  function stashRecovery() {
    if(recovery){const input={title:q('#wbRecoveryTitle').value,text:q('#wbRecoveryText').value};if(input.title!==recovery.originalTitle || input.text!==recovery.originalText)recoveryInputs.set(recovery.key,input);else recoveryInputs.delete(recovery.key);}
  }
  async function saveRecovery(event) {
    event.preventDefault();if(!recovery || recovering)return;
    const saved=recovery;stashRecovery();q('#wbRecoveryError').hidden=true;
    try{
      if(pending || compacting)throw new Error('请等待当前生成完成后再保存取回稿。');
      recovering=true;q('#wbRecoverySave').disabled=true;q('#wbRecoverySave').textContent='正在保存…';
      q('#wbRecoveryTitle').disabled=true;q('#wbRecoveryText').disabled=true;
      const target=data.sessions.find(s=>s.id===saved.sessionId),message=target?.messages.find(m=>m.id===saved.messageId);
      if(!message)throw new Error('原始会话已变化，已保留本地候选内容。');
      let draft=data.drafts.find(d=>d.id===message.recoveredDrafts?.[saved.operationIndex]);
      const input={title:q('#wbRecoveryTitle').value,text:q('#wbRecoveryText').value};
      if(!draft || input.title!==saved.confirmedTitle || input.text!==saved.confirmedText){
        if(!draft)await save();
        // Validate each newly edited confirmation locally on the server before
        // committing it. Reuse the staged draft ID after a failed workspace PUT.
        const result=await ctx.api('/api/writing-workbench/recover-draft',{method:'POST',body:JSON.stringify(input)});
        const candidate=result.draft;if(!candidate?.id || !candidate.text)throw new Error('未收到取回稿，请重试。');
        if(draft){state.saveNewVersion(draft,candidate.text,'manual-recovery-edit');draft.title=candidate.title;draft.path=candidate.path;draft.folderId=candidate.folderId;}
        else{draft=candidate;data.drafts.push(draft);(message.recoveredDrafts ||= {})[saved.operationIndex]=draft.id;}
        saved.confirmedTitle=input.title;saved.confirmedText=input.text;changed();
      }
      if(target.workflow?.topic_id)topicState.linkDraft(data,target.workflow.topic_id,draft.id,{sessionId:target.id});
      openTab('draft',draft.id);await save();recoveryInputs.delete(saved.key);recovery=null;
      q('#wbRecoveryDialog').close();renderMessages();ctx.showToast('已另存为新草稿，原稿保留。');
    }catch(error){q('#wbRecoveryError').textContent=error.message;q('#wbRecoveryError').hidden=false;}
    finally{recovering=false;q('#wbRecoverySave').disabled=false;q('#wbRecoverySave').textContent='另存为新草稿';q('#wbRecoveryTitle').disabled=false;q('#wbRecoveryText').disabled=false;}
  }

  let currentHotPlatform = "全部";
  let cachedHotItems = [];
  async function loadHotTrendsList() {
    const listEl = q('#wbHotTrendsList');
    const tabsEl = q('#wbHotTabs');
    if (!listEl) return;
    listEl.innerHTML = '<div style="padding:30px;text-align:center;color:#666">正在载入实时热搜数据…</div>';
    try {
      const res = await ctx.api('/api/materials');
      cachedHotItems = res.items || [];
      const platforms = ["全部", ...(res.platforms || [])];
      if (tabsEl) {
        tabsEl.innerHTML = platforms.map(pf => `
          <button type="button" class="${pf === currentHotPlatform ? 'active' : ''}" data-hot-pf="${esc(pf)}" style="padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid #d1d5db;cursor:pointer;background:${pf === currentHotPlatform ? '#059669' : '#fff'};color:${pf === currentHotPlatform ? '#fff' : '#374151'};font-weight:${pf === currentHotPlatform ? '600' : 'normal'}">${esc(pf)}</button>
        `).join('');

        tabsEl.querySelectorAll('[data-hot-pf]').forEach(btn => {
          btn.onclick = () => {
            currentHotPlatform = btn.dataset.hotPf;
            loadHotTrendsList();
          };
        });
      }

      const searchInput = q('#wbHotSearch');
      if (searchInput) searchInput.oninput = () => renderFilteredHotList();
      renderFilteredHotList();
    } catch(e) {
      listEl.innerHTML = `<div style="padding:20px;color:red">读取实时热榜失败: ${esc(e.message)}</div>`;
    }
  }

  function renderFilteredHotList() {
    const listEl = q('#wbHotTrendsList');
    if (!listEl) return;
    const searchInput = q('#wbHotSearch');
    const qVal = ((searchInput && searchInput.value) || '').trim().toLowerCase();
    const filtered = cachedHotItems.filter(item => {
      const matchPf = currentHotPlatform === "全部" || item.platform === currentHotPlatform;
      const matchQ = !qVal || item.title.toLowerCase().includes(qVal);
      return matchPf && matchQ;
    });

    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:30px;text-align:center;color:#888">未找到匹配的热榜内容</div>';
      return;
    }

    const fmtNum = n => n ? (isNaN(n) ? n : (parseInt(n) >= 10000 ? (parseInt(n) / 10000).toFixed(1) + 'w' : n)) : '—';
    listEl.innerHTML = filtered.slice(0, 50).map(item => `
      <div style="padding:9px 12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <span style="font-size:11px;font-weight:bold;color:${item.rank <= 3 ? '#e11d48' : '#6b7280'};width:22px">#${item.rank}</span>
          <span style="font-size:10px;background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:4px;white-space:nowrap">${esc(item.platform)}</span>
          <div style="font-size:13px;font-weight:500;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1" title="${esc(item.title)}">
            ${esc(item.title)}
            ${item.url ? `<a href="${item.url}" target="_blank" style="color:#2563eb;text-decoration:none;margin-left:4px;font-size:11px" title="查看原网页">🔗</a>` : ''}
          </div>
          <span style="font-size:11px;color:#6b7280;font-family:monospace">${fmtNum(item.hot)}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="wb-green-button" style="white-space:nowrap;padding:4px 10px;font-size:11px;background:#059669;color:#fff;border-radius:6px;cursor:pointer" data-hot-draft="${esc(item.title)}" data-hot-pf="${esc(item.platform)}" data-hot-url="${esc(item.url || '')}">
            🚀 一键二创
          </button>
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-hot-draft]').forEach(btn => {
      btn.onclick = async () => {
        const title = btn.dataset.hotDraft;
        const pf = btn.dataset.hotPf;
        const url = btn.dataset.hotUrl;
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '创建中...';
        try {
          const impRes = await ctx.api('/api/materials/create-draft', {
            method: 'POST',
            body: JSON.stringify({ title: title, platform: pf, url: url })
          });
          await importBridge.pull();
          q('#wbHotTrendsDialog').close();
          if (impRes.draft?.id) openTab('draft', impRes.draft.id);
          ctx.showToast(`《${title}》已生成草稿并载入引用，开始二创！`);
        } catch(err) {
          ctx.showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = oldText;
        }
      };
    });
  }

  async function click(event) {
    if (!loaded) return;
    const button=event.target.closest('button'); if (!button) return;

    if (button.dataset.promptKey) {
      const PROMPTS = {
        rewrite: '请结合当前选中的原稿/引用素材，提炼最具争议或共鸣的核心切入点，写出一篇符合当前平台传播特性的爆款二创文章。要求开头黄金前3句抓住眼球，行文有节奏感，杜绝空话套话。',
        titles: '请为当前文稿拟定 10 个高转化爆款候选标题，分别覆盖：悬念式、痛点共鸣式、反常识冲突式、数字清单式和情绪宣泄式，并说明推荐理由。',
        spoken: '请将当前文稿浓缩为一段 60 秒（约 280~320 字）的高完播率短视频口播文案，包含黄金 3 秒抓人开头、痛点展开与互动金句。',
        xhs: '请将当前内容转为小红书爆款图文笔记结构，输出：3个爆款封面标题、5页图文核心字卡（每页一观点）、600字笔记正文以及热门互动标签。',
        humanize: '请深度润色当前稿件：删除机械排比、空洞过渡和翻译腔词汇（如“不可否认的是”、“总而言之”、“双刃剑”），保留真实故事、数据和论点，使语言生动自然、有作者个性。',
        review: '请对当前文稿进行全面风控合规审查：检测广告法违禁词、平台敏感词，指出夸大表述或事实依据不足之处，并给出安全的替换修改建议。'
      };
      const text = PROMPTS[button.dataset.promptKey];
      if (text) {
        const s = session();
        s.input = text;
        q('#wbMessage').value = text;
        q('#wbMessage').focus();
        syncBusy();
      }
      return;
    }

    if (button.dataset.msgCopy) {
      const m = session().messages.find(item => item.id === button.dataset.msgCopy);
      if (!m) return;
      const raw = (m.content || m.rawText || '').replace(/^[ \t]*<<<(?:FILE|EDIT)[^>]*>>>[\r\n]*/gm, '').replace(/^[ \t]*<<<END>>>[\r\n]*/gm, '').trim();
      navigator.clipboard.writeText(raw).then(() => ctx.showToast('已复制 AI 回复内容！')).catch(() => ctx.showToast('复制失败，请手动选择复制', 'error'));
      return;
    }

    if (button.dataset.msgReplace) {
      const m = session().messages.find(item => item.id === button.dataset.msgReplace);
      if (!m) return;
      const doc = current();
      if (!doc || doc.type === 'reference') { ctx.showToast('请先打开或新建一份可编辑的草稿！', 'error'); return; }
      const raw = (m.content || m.rawText || '').replace(/^[ \t]*<<<(?:FILE|EDIT)[^>]*>>>[\r\n]*/gm, '').replace(/^[ \t]*<<<END>>>[\r\n]*/gm, '').trim();
      if (!raw) return;
      doc.text = raw;
      doc.updatedAt = new Date().toISOString();
      doc.version = (doc.version || 1) + 1;
      (doc.versions || (doc.versions = [])).push({ version: doc.version, text: doc.text, kind: 'ai_replace', createdAt: doc.updatedAt });
      changed();
      renderEditor();
      save();
      ctx.showToast(`已将 AI 回复替换为《${doc.title}》正文（字数：${raw.length}）！`);
      return;
    }

    if (button.dataset.msgAppend) {
      const m = session().messages.find(item => item.id === button.dataset.msgAppend);
      if (!m) return;
      const doc = current();
      if (!doc || doc.type === 'reference') { ctx.showToast('请先打开或新建一份可编辑的草稿！', 'error'); return; }
      const raw = (m.content || m.rawText || '').replace(/^[ \t]*<<<(?:FILE|EDIT)[^>]*>>>[\r\n]*/gm, '').replace(/^[ \t]*<<<END>>>[\r\n]*/gm, '').trim();
      if (!raw) return;
      doc.text = (doc.text ? doc.text + '\n\n' : '') + raw;
      doc.updatedAt = new Date().toISOString();
      doc.version = (doc.version || 1) + 1;
      (doc.versions || (doc.versions = [])).push({ version: doc.version, text: doc.text, kind: 'ai_append', createdAt: doc.updatedAt });
      changed();
      renderEditor();
      save();
      ctx.showToast(`已追加内容到《${doc.title}》文末！`);
      return;
    }

    if (button.dataset.msgNew) {
      const m = session().messages.find(item => item.id === button.dataset.msgNew);
      if (!m) return;
      const raw = (m.content || m.rawText || '').replace(/^[ \t]*<<<(?:FILE|EDIT)[^>]*>>>[\r\n]*/gm, '').replace(/^[ \t]*<<<END>>>[\r\n]*/gm, '').trim();
      if (!raw) return;
      const firstLine = raw.split('\n')[0].replace(/^#+\s*/, '').trim();
      const title = firstLine.slice(0, 30) || 'AI 生成草稿';
      const d = state.makeDoc();
      d.title = title;
      d.text = raw;
      data.drafts.unshift(d);
      openTab('draft', d.id);
      changed();
      save();
      ctx.showToast(`已成功另存为新稿件《${title}》！`);
      return;
    }

    const a=button.dataset.wb, s=session();
    if (a==='settings') return ctx.openWorkbenchSettings?.();
    if(a==='topic-library')return topicLibrary.open();
    if(a==='production-status'){window.switchStudioTab('delivery');return;}
    if(a==='show-topics'){window.switchStudioTab('topics');return;}
    if(a==='close-dialog' && editSaving)return;
    if (a==='close-recovery') {if(!recovering){stashRecovery();q('#wbRecoveryDialog').close();}return;}
    if (a==='creative-scenes') {if(sourceGuard?.(current()))return sourceIntake.open({title:current().title.replace(/（原稿）$/,''),url:current().source?.url||'',summary:current().text,platform:current().source?.platform||'原文'});return creativeScenes.open();}
    if(a==='compose-source'){
      const original=current();
      if(!original)throw new Error('未选择有效原文。');
      const before=session();
      if(before.messages.length || before.referenceIds.length!==1 || before.referenceIds[0]!==original.id){
        const clean=state.makeSession();clean.title='二创 · '+original.title.replace(/（原稿）$/,'');clean.referenceIds=[original.id];
        const linkedDraft=data.drafts.find(d => (d.referenceIds||[]).includes(original.id));
        if(linkedDraft) clean.currentDocumentId=linkedDraft.id;
        data.sessions.unshift(clean);data.ui.activeSessionId=clean.id;changed();renderTree();renderSession();
      }
      return creativeScenes.open('wechat');
    }
    if (a==='compare-scene-source') {
      const source=data.references.find(ref=>(s.workflow?.sourceIds || []).includes(ref.id)),draft=data.drafts.find(item=>item.id===s.currentDocumentId);
      if(!source || !draft)throw new Error('本次来源快照或候选稿已被删除，请在左栏重新打开。');
      return openCompare({before:source.text,after:draft.text,draftId:draft.id});
    }
    if (a==='confirm-scene') {
      if(pending || compacting || !model?.api_key_configured || !model?.verified)throw new Error('请等待当前生成完成，并检查模型设置。');
      await save();sceneModule.confirmPlan(s);changed();renderSession();return send();
    }
    if (a==='media-production') return mediaProduction.open();
    if (a==='toggle-chat') {if(window.innerWidth<=1120)mobileChatOpen=!mobileChatOpen;else{data.ui.chatCollapsed=!data.ui.chatCollapsed;changed();}renderChatVisibility();return;}
    if (a==='traffic-analysis') return trafficAnalysis.open(current()?.text || q('#wbQuickDraft').value || '', current()?.title || '');
    if (a==='commerce-analysis') return commerceAnalysis.open(current()?.text || q('#wbQuickDraft').value || '', current()?.title || '');
    if (a==='save' || a==='save-skill') { await save(); return ctx.showToast('已保存'); }
    if (a==='backup') return download(JSON.stringify({format:'CopyWorkbench-v2',data},null,2),'文案工作台备份.json','application/json');
    if (a==='new') { const d=state.makeDoc(); data.drafts.unshift(d); return openTab('draft',d.id); }
    if (a==='folder' || a==='add-ref') return edit(a==='folder'?'folder':'reference');
    if (a==='import') return q('#wbFileInput').click();
    if (a==='export' && current()) return download(current().text,`${state.cleanName(current().title)}.md`);
    if (a==='goto-creatorhub') {
      window.open('http://127.0.0.1:8088/#publish', '_blank');
      return;
    }
    if (a==='goto-image-workbench') {
      const cur = current();
      const title = cur ? (cur.title || '') : '';
      const text = cur ? (cur.text || '') : '';
      window.switchStudioTab('image_workbench');
      try {
        const iframe = document.getElementById('imageWorkbenchStudioIframe');
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'SET_TOPIC',
            title: title,
            topic: title,
            text: text
          }, '*');
        }
      } catch(e) {}
      return;
    }
    if (a==='close-ch-dialog') {
      q('#wbCreatorHubDialog').close();
      return;
    }
    if (a==='close-hot-dialog') {
      q('#wbHotTrendsDialog').close();
      return;
    }
    if (a==='close-wanfeng-dialog') {
      const dlg = q('#wbWanfengDialog');
      if (dlg) dlg.close();
      return;
    }
    if (a==='wanfeng') {
      window.switchStudioTab('wanfeng');
      return;
    }
    if (a==='hot-trends') {
      window.switchStudioTab('radar');
      return;
    }
    if (a==='creatorhub-import') {
      window.switchStudioTab('creatorhub');
      return;
    }
    if(a==='extract-url')return sourceIntake.open();
    if(a==='quick-extract'){const match=q('#wbQuickDraft').value.match(/https?:\/\/[^\s]+/);return sourceIntake.open({url:match?.[0]||''});}
    if (a==='delete') return removeDocument();
    if (a==='copy-draft') return copy(current()?.text);
    if (a==='new-version' && activeTab()?.kind==='draft') { state.saveNewVersion(current()); changed(); await save(); return ctx.showToast(`已保存 v${current().version}`); }
    if (a==='versions') return versions();
    if (a==='previous-version') { const draft=current(), versions=draft?.versions || []; const previous=versions.at(-1)?.text===draft.text?versions.at(-2):versions.at(-1); if (!previous) return ctx.showToast('目前没有上一版，先保存一个版本'); return openCompare({before:previous.text,after:draft.text,draftId:draft.id}); }
    if (a==='preview-draft') { const preview=q('#wbDraftPreview'), area=q('#wbDraft'); preview.hidden=!preview.hidden; area.hidden=!preview.hidden; if (!preview.hidden) preview.innerHTML=markdown(current().text); button.textContent=preview.hidden?'预览':'编辑'; return; }
    if(a==='quick-reference'){const text=data.ui.quickDraft.trim();if(text)sourceIntake.open({manual_text:text,title:'我的原文'});return;}
    if (a==='new-skill') { const skill={id:`user:${state.uid()}`,name:'新 skill',description:'',version:'1.0',defaultTrack:'none',prompt:'',builtin:false}; data.skills.push(skill); return openTab('skill',skill.id); }
    if (a==='open-skill') return;
    if (a==='copy-skill') {
      const source=skillFor(activeTab()?.id); if (!source || source.protected) return;
      await ensureSkillGuide(source.id);
      const skill={...structuredClone(source),id:`user:${state.uid()}`,name:`${source.name}（我的）`,builtin:false}; data.skills.push(skill); return openTab('skill',skill.id);
    }
    if (a==='export-skill') {
      const skill=skillFor(activeTab()?.id); if (!skill || skill.protected) return;
      await ensureSkillGuide(skill.id);
      return download(`---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\nversion: ${JSON.stringify(skill.version)}\ndefaultTrack: ${JSON.stringify(skill.defaultTrack)}\n---\n\n${skill.prompt}`,`${state.cleanName(skill.name)}.md`);
    }
    if (a==='delete-skill') {
      const skill=skillFor(activeTab()?.id); if (!skill || skill.builtin) return;
      if (!await ctx.showConfirm({title:'删除 skill',message:`删除“${skill.name}”？已有稿件和会话会保留。`,danger:true})) return;
      data.skills=data.skills.filter(k => k.id!==skill.id); for (const item of data.sessions) if (item.skillId===skill.id) item.skillId=state.DEFAULT_SKILL;
      changed(); renderEditor(); renderTree(); renderSession(); return;
    }
    if (a==='new-session') { const item=state.makeSession(); data.sessions.unshift(item); data.ui.activeSessionId=item.id; changed(); renderTree(); return renderSession(); }
    if (a==='references') {
      if (suggestion?.kind==='ref' && !q('#wbSuggestions').hidden) {closeSuggestions();return;}
      const area=q('#wbMessage'), s=session(), cursor=area.selectionStart;
      if (s.input.slice(0,cursor).at(-1)!=='@') {s.input=s.input.slice(0,cursor)+'@'+s.input.slice(cursor);area.value=s.input;area.setSelectionRange(cursor+1,cursor+1);changed();}
      area.focus(); suggestions(); return;
    }
    if (a==='images') return q('#wbImageInput').click();
    if (a==='send') { if (pending) { pending.stopping=true; syncBusy(); try { await ctx.api(`/api/writing-workbench/chat/cancel/${pending.requestId}`,{method:'POST'}); } catch(error) { pending.stopping=false; syncBusy(); throw error; } return; } return send(); }
    if (a==='compact') return compact();
    const close={ 'close-dialog':'wbEditDialog','close-versions':'wbVersionsDialog','close-compare':'wbCompareDialog','close-image':'wbImageDialog' }[a];
    if (close) return q(`#${close}`).close();
    if (a==='edit-compare') {
      if (!data.drafts.some(d => d.id===comparison.draftId)) throw new Error('原稿件已删除，无法编辑');
      const dialog=q('#wbCompareDialog');
      dialog.style.setProperty('--wb-compare-edit-height',`${Math.max(480,dialog.getBoundingClientRect().height)}px`);dialog.classList.add('is-editing');
      q('#wbCompareReference').hidden=false; q('#wbCompareDirty').hidden=true;
      q('#wbCompareInput').value=comparison.result; q('#wbCompareInput').hidden=false; q('#wbCompareResult').hidden=true; q('#wbSaveCompare').hidden=true; q('#wbEditCompare').hidden=true; q('#wbDetectCompare').hidden=false;q('#wbDetectCompare').disabled=true;q('#wbCompareInput').focus(); return;
    }
    if (a==='detect-compare') { comparison.result=q('#wbCompareInput').value; renderCompare(); q('#wbCompareDialog').classList.remove('is-editing');q('#wbCompareReference').hidden=true;q('#wbCompareDirty').hidden=true; q('#wbCompareInput').hidden=true; q('#wbCompareResult').hidden=false; q('#wbEditCompare').hidden=false; q('#wbDetectCompare').hidden=true; q('#wbSaveCompare').hidden=comparison.result===comparison.expected; return; }
    if (a==='save-compare') {
      const draft=data.drafts.find(d => d.id===comparison.draftId); if (!draft) throw new Error('稿件已删除');
      if (draft.text!==comparison.expected) throw new Error('当前稿件已变化，请关闭对比后重新打开，避免覆盖编辑');
      state.saveNewVersion(draft,q('#wbCompareInput').value,'compare-edit'); comparison.result=draft.text; comparison.expected=draft.text; changed(); await save(); renderEditor();
      q('#wbCompareInput').hidden=true; q('#wbCompareResult').hidden=false; q('#wbSaveCompare').hidden=true; q('#wbEditCompare').hidden=false; q('#wbDetectCompare').hidden=true; renderCompare(); return ctx.showToast('改写已保存为新版本');
    }
    const d=button.dataset;
    if(d.recoverMessage)return openRecovery(d.recoverMessage,Number(d.operationIndex));
    if(d.renameDraft)return renameDraft(d.renameDraft);
    if (d.renameSession) { editMode={mode:'rename-session',id:d.renameSession}; q('#wbDialogTitle').textContent='重命名会话'; q('#wbEditName').value=data.sessions.find(item => item.id===d.renameSession).title; q('#wbEditBodyWrap').hidden=true; q('#wbEditBody').required=false; return q('#wbEditDialog').showModal(); }
    if (d.renameFolder) {if(pending || compacting)throw new Error('请等待当前生成完成后再整理稿件。');editMode={mode:'rename-folder',path:d.renameFolder}; q('#wbDialogTitle').textContent='重命名文件夹'; q('#wbEditName').value=d.renameFolder.split('/').at(-1); q('#wbEditBodyWrap').hidden=true; q('#wbEditBody').required=false;q('#wbEditError').hidden=true; return q('#wbEditDialog').showModal(); }
    if (d.deleteFolder) {
      if(pending || compacting)throw new Error('请等待当前生成完成后再整理稿件。');
      if (!await ctx.showConfirm({title:'删除文件夹',message:'删除文件夹后，其中稿件会移到“二创稿”根目录，内容和版本会保留。',okText:'删除文件夹'})) return;
      data.folders=data.folders.filter(f => { const path=f.path || `二创稿/${state.cleanName(f.name)}`; return path!==d.deleteFolder && !path.startsWith(d.deleteFolder+'/'); });
      for (const draft of data.drafts.filter(item => item.folderId===d.deleteFolder || item.folderId.startsWith(d.deleteFolder+'/'))) { draft.folderId='二创稿'; draft.path=`二创稿/${state.cleanName(draft.title)}.md`; }
      changed(); renderTree(); return renderEditor();
    }
    if (d.openKind) {
      if(d.openKind==='draft' && button.closest('#wbDocs') && event.detail>0){
        const now=Date.now(),again=lastDraftClick?.id===d.openId && now-lastDraftClick.time<450;
        lastDraftClick={id:d.openId,time:now};if(again)return renameDraft(d.openId);
      } else lastDraftClick=null;
      if(data.ui.activeTab===`${d.openKind}:${d.openId}`)return;
      return openTab(d.openKind,d.openId);
    }
    if (d.closeTab) { data.ui.tabs=data.ui.tabs.filter(t => t.key!==d.closeTab); changed(); renderTree(); return renderEditor(); }
    if (d.session) { data.ui.activeSessionId=d.session; if (session().currentDocumentId) openTab('draft',session().currentDocumentId); changed(); renderTree(); return renderSession(); }
    if (d.deleteSession) {
      if (pending?.sessionId===d.deleteSession || compacting) throw new Error('会话正在处理，请稍后再删除');
      if (!await ctx.showConfirm({title:'删除会话',message:'删除此会话？稿件与引用来源会保留。',danger:true})) return;
      data.sessions=data.sessions.filter(item => item.id!==d.deleteSession); if (!data.sessions.length) data.sessions.push(state.makeSession());
      if (!data.sessions.some(item => item.id===data.ui.activeSessionId)) data.ui.activeSessionId=data.sessions[0].id;
      changed(); renderTree(); return renderSession();
    }
    if (d.removeRef) { s.referenceIds=s.referenceIds.filter(id => id!==d.removeRef); changed(); renderReferenceChips(); return renderContext(); }
    if (d.removeImage!==undefined) { s.images.splice(Number(d.removeImage),1); changed(); return renderAttachments(); }
    if (d.previewAttachment!==undefined) return previewImage(imageSource(s.images[Number(d.previewAttachment)]));
    if (d.previewMessage) return previewImage(imageSource(s.messages.find(m => m.id===d.previewMessage).images[Number(d.imageIndex)]));
    if (d.copyMessage) return copy(s.messages.find(m => m.id===d.copyMessage)?.content);
    if (d.retry) return send(d.retry);
    if (d.compareMessage) return openCompare(s.messages.find(m => m.id===d.compareMessage).changes[Number(d.changeIndex)]);
    if (d.level) return renderCompare(d.level);
    if (d.versionView || d.versionRestore) {
      const draft=data.drafts.find(item => item.id===d.versionDraft), version=draft?.versions.find(v => String(v.version)===(d.versionView || d.versionRestore)); if (!version) return;
      if (d.versionView) return openCompare({before:version.text,after:draft.text,draftId:draft.id});
      if (!await ctx.showConfirm({title:'恢复版本',message:`将 v${version.version} 恢复为一个新版本？当前版本仍会保留。`,okText:'恢复'})) return;
      state.saveNewVersion(draft,version.text,'restore'); changed(); await save(); renderEditor(); return versions();
    }
    if (d.suggestId) return selectSuggestion(button);
  }
  function input(event) {
    if (!loaded) return;
    const element=event.target, s=session(), item=current(), key=element.id;
    if(key==='wbRecoveryText' || key==='wbRecoveryTitle'){stashRecovery();return;}
    if(key==='wbEditName')element.setCustomValidity('');
    if (key==='wbMessage') { s.input=element.value; changed(); suggestions(); return; }
    if (key==='wbQuickDraft') {
      data.ui.quickDraft=element.value;
      q('[data-wb="quick-reference"]').disabled=!element.value.trim();
      const hasUrl = /https?:\/\/[^\s]+/.test(element.value);
      const btn = q('#wbQuickExtractBtn');
      if (btn) btn.style.display = hasUrl ? 'inline-block' : 'none';
      changed(); return;
    }
    if (item && activeTab().kind==='draft' && (key==='wbTitle' || key==='wbDraft')) {
      if (key==='wbTitle') { const path=`${item.folderId}/${state.cleanName(element.value)}.md`; if (data.drafts.some(d => d.id!==item.id && d.path===path)) return fail(new Error('同一文件夹已有同名稿件，请使用其他名称')); item.title=element.value; item.path=path; renderTree(); q('#wbDocumentPath').textContent=item.path; }
      else { item.text=element.value; q('#wbCount').textContent=state.countLabel(item.text,{article:item.lengthCountMode==='article'}); }
      item.updatedAt=new Date().toISOString(); changed(); renderContext(); renderLengthHint(item);syncMediaProductionButton(); return;
    }
    const fields={wbSkillName:'name',wbSkillDescription:'description',wbSkillVersion:'version',wbSkillPrompt:'prompt'};
    if (fields[key] && activeTab()?.kind==='skill') { const skill=skillFor(activeTab().id); if (skill && !skill.builtin) { skill[fields[key]]=element.value; changed(); if (key==='wbSkillName') renderTree(); } }
    if (key==='wbCompareInput' && comparison) { const dirty=element.value!==comparison.result;q('#wbCompareDirty').hidden=!dirty;q('#wbDetectCompare').disabled=!dirty;q('#wbResultCount').textContent=`${element.value.length} 字`; }
  }
  async function change(event) {
    if (!loaded) return;
    const element=event.target, s=session(), key=element.id;
    const fields={wbSkillSelect:'skillId',wbTrackSelect:'trackId',wbSearchMode:'searchMode',wbThinking:'thinking'};
    if (fields[key]) { s[fields[key]]=element.value; if (key==='wbSkillSelect') { const before=skillFor(s.skillId); if (!s.trackId || s.trackId===before?.defaultTrack) s.trackId=''; } changed(); renderSession(); }
    if (key==='wbFolder' && activeTab()?.kind==='draft') {try{moveDraft(current(),element.value);}catch(error){renderEditor();throw error;}}
    if (key==='wbSkillTrack') { const skill=skillFor(activeTab()?.id); if (skill && !skill.builtin) { skill.defaultTrack=element.value; changed(); } }
    if (element.dataset.referenceId) { const id=element.dataset.referenceId; s.referenceIds=element.checked?[...new Set([...s.referenceIds,id])]:s.referenceIds.filter(value => value!==id); changed(); renderReferenceChips(); renderContext(); }
    if (key==='wbImageInput') { try { await addImages(element.files); } finally { element.value=''; } }
    if (key==='wbFileInput') {
      try {
        const files=[...element.files]; if (files.some(file => file.size>1024*1024)) throw new Error('每份文案文件请控制在 1 MB 内');
        const drafts=await Promise.all(files.map(async file => state.makeDoc(file.name.replace(/\.(txt|md|markdown)$/i,''),await file.text())));
        for (const draft of drafts) { data.drafts.push(draft); openTab('draft',draft.id); }
      } finally { element.value=''; }
    }
  }
  window.WorkbenchModules.register('workbench',{
    container:'#workbenchView',templateUrl:'/web/features/workbench/workbench.html?v=source-first-20261113',styleUrl:'/web/features/workbench/workbench.css?v=studio-loop-20261113',
    async mount(container,context) {
      root=container; ctx=context; q('#wbLayout').inert=true;
      window.selectWorkbenchSkill = function(targetSkill) {
        if (!targetSkill) return;
        const s = session();
        if (s) {
          s.skillId = targetSkill.id;
          changed();
          renderSession();
        }
      };
      const editError=document.createElement('p');editError.id='wbEditError';editError.hidden=true;editError.setAttribute('role','alert');q('#wbEditForm').insertBefore(editError,q('#wbEditForm .wb-dialog-footer'));
      root.addEventListener('toggle',event=>{const folder=event.target;if(!folder.matches?.('.wb-folder[data-folder-path]'))return;const closed=new Set(data?.ui.closedFolders || []),path=folder.dataset.folderPath;if(closed.has(path)===!folder.open)return;folder.open?closed.delete(path):closed.add(path);data.ui.closedFolders=[...closed];changed();},true);
      q('#wbRecoveryForm').addEventListener('submit',event=>void saveRecovery(event));
      q('#wbRecoveryDialog').addEventListener('cancel',event=>{if(recovering)event.preventDefault();else stashRecovery();});
      root.addEventListener('dragstart',event => { const row=event.target.closest('[data-drag-draft]'); if (row) {if(pending || compacting){event.preventDefault();return fail(new Error('请等待当前生成完成后再整理稿件。'));}event.dataTransfer.setData('application/x-copyworkbench-draft',row.dataset.dragDraft);} });
      root.addEventListener('dragover',event => { if (event.target.closest('[data-drop-folder]') && event.dataTransfer.types.includes('application/x-copyworkbench-draft')) event.preventDefault(); });
      root.addEventListener('drop',event => { const folder=event.target.closest('[data-drop-folder]'), id=event.dataTransfer.getData('application/x-copyworkbench-draft'); if (!folder || !id) return; event.preventDefault(); const draft=data.drafts.find(d => d.id===id); if (!draft) return;try{moveDraft(draft,folder.dataset.dropFolder);}catch(error){fail(error);} });
      root.addEventListener('click',event => void click(event).catch(fail)); root.addEventListener('input',input); root.addEventListener('change',event => void change(event).catch(fail));
      window.addEventListener('message', async event => {
        if (event.data?.type === 'WANFENG_IMPORT_SUCCESS' || event.data?.type === 'CREATORHUB_IMPORT_SUCCESS') {
          await importBridge?.pull();
          if (event.data.draftId) openTab('draft', event.data.draftId);
          window.switchStudioTab('workbench');
          ctx.showToast(`🌿 《${event.data.title || '对标文章'}》已无缝送入工坊，开始二创！`);
        }
      });
      q('#wbMessage').addEventListener('keydown',event => {
        if (event.isComposing) return;
        if (suggestion && !q('#wbSuggestions').hidden) {
          if (event.key==='Escape') {event.preventDefault();closeSuggestions();return;}
          if (['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault();highlightSuggestion(suggestion.index+(event.key==='ArrowDown'?1:-1));return;}
          if (event.key==='Enter') {event.preventDefault();selectSuggestion(q('#wbSuggestions').querySelector('[aria-selected="true"]'));return;}
        }
        if (event.key==='Enter' && !event.shiftKey) { event.preventDefault(); void send().catch(fail); }
      });
      q('#wbSuggestions').addEventListener('pointerdown',event => event.preventDefault());
      q('#wbSuggestions').addEventListener('pointermove',event => {const button=event.target.closest('[data-suggest-id]');if(button) highlightSuggestion([...q('#wbSuggestions').querySelectorAll('[data-suggest-id]')].indexOf(button));});
      root.addEventListener('pointerdown',event => {if (!event.target.closest('#wbComposer')) closeSuggestions();});
      q('#wbMessage').addEventListener('paste',event => {
        const images=[...event.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
        if (images.length) { event.preventDefault(); void addImages(images).catch(fail); }
      });
      const composer=q('#wbComposer');
      composer.addEventListener('dragover',event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); composer.classList.add('wb-drop-active'); } });
      composer.addEventListener('dragleave',() => composer.classList.remove('wb-drop-active'));
      composer.addEventListener('drop',event => { event.preventDefault(); composer.classList.remove('wb-drop-active'); void addImages(event.dataTransfer.files).catch(fail); });
      q('#wbEditDialog').addEventListener('cancel',event=>{if(editSaving)event.preventDefault();});
      q('#wbEditForm').addEventListener('submit',async event => {
        event.preventDefault();if(editSaving)return;q('#wbEditError').hidden=true;const name=q('#wbEditName').value.trim(), text=q('#wbEditBody').value.trim(); if (!name || (editMode!=='folder' && !['rename-draft','rename-folder','rename-session'].includes(editMode?.mode) && !text)) return;
        try{
        if(editMode?.mode==='rename-draft'){
          const draft=data.drafts.find(item=>item.id===editMode.id);if(!draft)return;
          if(pending || compacting){q('#wbEditName').setCustomValidity('请等待文案生成完成后再重命名');return q('#wbEditName').reportValidity();}
          const title=name.replace(/\.md$/i,'').trim(),path=`${draft.folderId}/${state.cleanName(title)}.md`;
          if(!title || data.drafts.some(item=>item.id!==draft.id && item.path===path)){
            q('#wbEditName').setCustomValidity(title?'同一文件夹已有同名稿件，请使用其他名称':'请输入稿件名称');return q('#wbEditName').reportValidity();
          }
          draft.title=title;draft.path=path;
        } else if (editMode?.mode==='rename-session') { const item=data.sessions.find(s => s.id===editMode.id); if (item) item.title=name; } else if (editMode?.mode==='rename-folder') {
          if(pending || compacting)throw new Error('请等待当前生成完成后再整理稿件。');
          const path=`${editMode.path.slice(0,editMode.path.lastIndexOf('/'))}/${state.cleanName(name)}`;
          const outside=old=>old!==editMode.path && !old.startsWith(editMode.path+'/');
          if([...data.folders.map(f=>f.path || `二创稿/${state.cleanName(f.name)}`),...data.drafts.map(d=>d.folderId)].some(old=>outside(old) && (old===path || old.startsWith(path+'/'))))throw new Error('已有同名文件夹，请换一个名称。');
          for (const folder of data.folders) { const old=folder.path || `二创稿/${state.cleanName(folder.name)}`; if (old===editMode.path || old.startsWith(editMode.path+'/')) { folder.path=path+old.slice(editMode.path.length); if (old===editMode.path) folder.name=name; } }
          for (const draft of data.drafts) if (draft.folderId===editMode.path || draft.folderId.startsWith(editMode.path+'/')) { draft.folderId=path+draft.folderId.slice(editMode.path.length); draft.path=path+draft.path.slice(editMode.path.length); }
          data.ui.closedFolders=(data.ui.closedFolders || []).map(old=>old===editMode.path || old.startsWith(editMode.path+'/')?path+old.slice(editMode.path.length):old);editMode.path=path;
        } else if (editMode==='folder') { const path=`二创稿/${state.cleanName(name)}`; if([...data.folders.map(f=>f.path || `二创稿/${state.cleanName(f.name)}`),...data.drafts.map(d=>d.folderId)].some(old=>old===path || old.startsWith(path+'/')))throw new Error('已有同名文件夹，请换一个名称。');data.folders.push({id:state.uid(),name,path});editMode={mode:'rename-folder',path}; }
        else if(editMode?.stagedReferenceId){const reference=data.references.find(ref=>ref.id===editMode.stagedReferenceId);if(!reference)throw new Error('引用来源已变化，请重新打开。');reference.title=state.cleanName(name);reference.text=text;reference.path=`引用来源/${reference.title}.md`;}
        else { const reference=state.makeReference(name,text); data.references.push(reference); session().referenceIds.push(reference.id);editMode={stagedReferenceId:reference.id};openTab('reference',reference.id); renderReferenceChips(); }
        changed();renderTree();renderEditor();editSaving=true;q('#wbEditForm [type=submit]').disabled=true;q('#wbEditForm [type=submit]').textContent='正在保存…';q('#wbEditName').disabled=true;q('#wbEditBody').disabled=true;await save();q('#wbEditDialog').close();
        }catch(error){q('#wbEditError').textContent=error.message;q('#wbEditError').hidden=false;}
        finally{editSaving=false;q('#wbEditForm [type=submit]').disabled=false;q('#wbEditForm [type=submit]').textContent='保存';q('#wbEditName').disabled=false;q('#wbEditBody').disabled=false;}
      });
      window.addEventListener('beforeunload',event => { if (dirty || pending || compacting || recoveryInputs.size || topicLibrary?.hasUnsaved() || studioWorkflow?.hasUnsaved() || sourceIntake?.hasUnsaved()) { event.preventDefault(); event.returnValue=''; } });
      try {
        const results=await Promise.all([import('/web/features/workbench/workbench-state.js?v=1.2.36-20261115'),import('/web/features/workbench/diff-algorithm-original.js?v=5'),ctx.api('/api/writing-workbench'),ctx.api('/api/writing-workbench/catalog'),ctx.api('/api/writing-workbench/model'),import('/web/features/workbench/workbench-presentation.js?v=1.2.36-20261115')]);
        [state,diff]=results; presentation=results[5]; const result=results[2]; catalog=results[3]; model=results[4]; revision=result.revision; data=state.normalizeState(result.data); loaded=true;
        if(data.ui.columnLayoutVersion!=='studio-loop-20261113'){delete data.ui.columnWidths;data.ui.chatCollapsed=false;data.ui.columnLayoutVersion='studio-loop-20261113';}
        if (JSON.stringify(result.data)!==JSON.stringify(data)) changed();
        for (const s of data.sessions) {
          const last=s.messages.at(-1); if (last?.role==='user' && !last.error) { last.error='上次生成已中断，点击重试继续。'; changed(); }
          if (s.currentDocumentId && !data.drafts.some(d => d.id===s.currentDocumentId)) s.currentDocumentId='';
        }
        const [analysisModule,mediaModule,importsModule,scenesModule,topicModule]=await Promise.all([import('/web/features/workbench/commerce-analysis.js?v=1.2.36-20261115'),import('/web/features/workbench/media-production.js?v=1'),import('/web/features/workbench/workspace-imports.js?v=1'),import('/web/features/workbench/creative-scenes.js?v=topics-20261113'),import('/web/features/workbench/topic-library.js?v=studio-loop-20261113')]);
        commerceAnalysis=analysisModule.mount(root,ctx);
        trafficAnalysis=analysisModule.mount(root,ctx,{kind:'traffic'});
        mediaProduction=mediaModule.mount(root,ctx,{capture:captureMediaDocument});
        sceneModule=scenesModule;
        creativeScenes=scenesModule.mount(root,ctx,{captureSources:captureSceneSources,start:startScene,isBusy:()=>Boolean(pending || compacting),isReady:()=>Boolean(model?.api_key_configured && model?.verified)});
        topicState=topicModule.topics;if(!data.topicLibrary){topicState.ensureLibrary(data);changed();}
        topicLibrary=topicModule.mount(root,ctx,{getData:()=>data,capture:captureTopicSource,changed,flush:save,
          compose:spec=>{window.switchStudioTab('workbench');creativeScenes.open(spec.sceneId,spec.values,{topicId:spec.topicId});},
          openDraft:id=>{window.switchStudioTab('workbench');openTab('draft',id);},openSession:id=>{window.switchStudioTab('workbench');const target=data.sessions.find(s=>s.id===id);if(!target)throw new Error('创作会话已移除。');data.ui.activeSessionId=id;changed();renderTree();renderSession();if(target.currentDocumentId)openTab('draft',target.currentDocumentId);}});
        const workflowModule=await import('/web/features/workbench/studio-workflow.js?v=source-first-20261113');
        const flowCss=document.createElement('link');flowCss.rel='stylesheet';flowCss.href='/web/features/workbench/studio-workflow.css?v=source-first-20261113';document.head.append(flowCss);
        const goDraft=id=>{if(!data.drafts.some(d=>d.id===id))throw new Error('稿件已移除，请重新选择。');window.switchStudioTab('workbench');openTab('draft',id);};
        const goSession=id=>{const s=data.sessions.find(s=>s.id===id);if(!s)throw new Error('会话已移除。');window.switchStudioTab('workbench');data.ui.activeSessionId=id;mobileChatOpen=true;data.ui.chatCollapsed=false;changed();renderTree();renderSession();renderChatVisibility();if(s.currentDocumentId)openTab('draft',s.currentDocumentId);};
        studioWorkflow=workflowModule.mount(document.querySelector('#studioFlowView'),ctx,{getData:()=>data,changed,flush:save,
          openDraft:goDraft,openSession:goSession,
          openReference:id=>{window.switchStudioTab('workbench');openTab('reference',id);},
          newDraft:()=>{window.switchStudioTab('workbench');const d=state.makeDoc();data.drafts.unshift(d);openTab('draft',d.id);q('#wbTitle').focus();},
          importFiles:()=>{window.switchStudioTab('workbench');q('#wbFileInput').click();},
          openScenes:()=>{window.switchStudioTab('workbench');creativeScenes.open();},openTopics:options=>topicLibrary.open(options),
          openMedia:id=>{goDraft(id);mediaProduction.open();},
          referenceTopic:id=>{const ref=data.references.find(r=>r.id===id);if(!ref)throw new Error('引用来源已移除。');if(topicLibrary.hasUnsaved())throw new Error('请先保存选题库中正在填写的内容。');if(Array.from(ref.text).length>12000)throw new Error('素材超过12000字，请在选题库粘贴需要的部分。');topicLibrary.open({new:true,prefill:{title:ref.title,material:ref.text,source:{title:ref.title,text:ref.text,document_id:ref.id,url:topicState.safeSourceURL(ref.source?.url || '')},sourceURL:topicState.safeSourceURL(ref.source?.url || '')}});},
          reviewWithAI:id=>{goDraft(id);mobileChatOpen=true;data.ui.chatCollapsed=false;renderChatVisibility();creativeScenes.open('review');}});
        const intakeModule=await import('/web/features/workbench/source-intake.js?v=article-body-20261114');sourceGuard=intakeModule.needsOriginalCheck;
        const intakeCss=document.createElement('link');intakeCss.rel='stylesheet';intakeCss.href='/web/features/workbench/source-intake.css?v=source-first-20261113';document.head.append(intakeCss);
        const sourceNotice=document.createElement('div');sourceNotice.id='wbSourceNotice';sourceNotice.className='wb-source-notice';sourceNotice.hidden=true;q('#wbLengthHint').after(sourceNotice);
        sourceIntake=intakeModule.mount(ctx,{isBusy:()=>Boolean(pending||compacting),importOriginal:async result=>{
          if(pending||compacting)throw new Error('请等待当前创作完成后再导入。');
          await importBridge.pull();
          const ref=data.references.find(item=>item.id===result.ref?.id);
          const draft=data.drafts.find(item=>item.id===result.draft?.id);
          if(!ref && !draft)throw new Error('原文尚未载入，请重试保存。');
          const targetTitle = (draft?.title || ref?.title || '新会话').replace(/（原稿）$/,'');
          const created=state.makeSession();
          created.title='二创 · '+targetTitle;
          if(ref) created.referenceIds=[ref.id];
          if(draft) created.currentDocumentId=draft.id;
          data.sessions.unshift(created);
          data.ui.activeSessionId=created.id;
          changed();
          await save();
          window.switchStudioTab('workbench');
          if(draft) {
            openTab('draft', draft.id);
          } else if(ref) {
            openTab('reference', ref.id);
          }
          renderSession();
        }});
        const productionButton=document.createElement('button');productionButton.type='button';productionButton.dataset.wb='production-status';productionButton.textContent='审稿与发布 →';q('.wb-editor-output').prepend(productionButton);
        importBridge=importsModule.createImportBridge({api:ctx.api,getData:()=>data,changed,flush:save,render:()=>{renderTree();renderReferenceChips();renderContext();studioWorkflow?.refresh();},showToast:ctx.showToast});
        renderTree(); renderEditor(); renderSession(); renderModels(); renderChatVisibility(); initColumnResizing(); q('#wbLayout').inert=false; q('#wbLayout').setAttribute('aria-busy','false');
        importBridge.start();
      } catch (error) { fail(new Error(`工作台加载失败，请重新加载页面。${error.message}`)); }
    },
    async prepareReload(){if(pending || compacting || recovering || editSaving || recoveryInputs.size || topicLibrary?.hasUnsaved() || studioWorkflow?.hasUnsaved() || sourceIntake?.hasUnsaved())return {ready:false,reason:'请先完成当前生成或保存正在填写的内容。'};await save();return {ready:!dirty};},
    showWorkspacePage(page,options) {studioWorkflow?.show(page,options);},
    previewSource(spec){sourceIntake?.open(spec);},
    startCreation(){sourceIntake?.open();},
    openDraft: async id => {
      if (!loaded) return;
      await importBridge?.pull();
      window.switchStudioTab('workbench');
      openTab('draft', id);
    },
    loadImportResult: async result => {
      if (!loaded) return;
      await importBridge?.pull();
      const draft = data.drafts.find(item => item.id === result.draft?.id || item.id === result.import_id || item.id === 'doc-' + result.import_id);
      const ref = data.references.find(item => item.id === result.ref?.id || item.id === 'ref-' + result.import_id);
      const targetTitle = (draft?.title || ref?.title || result.title || '新会话').replace(/（原稿）$/, '');
      const created = state.makeSession();
      created.title = '二创 · ' + targetTitle;
      if (ref) created.referenceIds = [ref.id];
      if (draft) created.currentDocumentId = draft.id;
      data.sessions.unshift(created);
      data.ui.activeSessionId = created.id;
      data.ui.chatCollapsed = false;
      mobileChatOpen = true;
      changed();
      await save();
      window.switchStudioTab('workbench');
      if (draft) openTab('draft', draft.id);
      else if (ref) openTab('reference', ref.id);
      renderSession();
      renderChatVisibility();
      const inputEl = q('#wbInput');
      if (inputEl) {
        inputEl.value = `@${draft?.title || targetTitle} 请对这篇原稿进行深度二创拆解：提炼核心矛盾、受众共鸣点与3个爆款创作方向。`;
        inputEl.dispatchEvent(new Event('input', {bubbles: true}));
      }
    },
    activate() { importBridge?.start(); if (loaded) void ctx.api('/api/writing-workbench/model').then(result => { model=result; renderModels(); }).catch(fail); },
    async deactivate() { importBridge?.stop(); mediaProduction?.close();topicLibrary?.close();sourceIntake?.close(); for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close(); try { await save(); } catch (error) { ctx.showToast(error.message,'error'); } },
    refresh() { if (loaded) void ctx.api('/api/writing-workbench/model').then(result => { model=result; renderModels(); }).catch(fail); }
  });
})();
