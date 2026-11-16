import * as production from './studio-workflow-state.js?v=studio-loop-20261113';
import * as topics from './topic-library-state.js?v=topics-20261113';

// All records use the existing workspace revision/save mechanism. No publishing API.
export function mount(host,ctx,actions){
  const esc=value=>ctx.esc(String(value??''));
  const labels={draft:'待审稿',reviewed:'已审稿',ready:'待发布',published:'已记录发布'};
  const time=value=>value?new Date(value).toLocaleDateString('zh-CN',{month:'short',day:'numeric'}):'尚无记录';
  const count=text=>Array.from(String(text||'').replace(/\s/g,'')).length;
  const data=()=>actions.getData();
  const drafts=()=>[...data().drafts].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  let page='home',query='',filter='all',selected='',dialogKey='',applied=false,busy=false,formDirty=false,formSnapshot=null;
  const dialog=document.createElement('dialog');dialog.id='sfDialog';dialog.className='sf-dialog';dialog.setAttribute('aria-labelledby','sfDialogTitle');
  dialog.innerHTML='<form id="sfForm"><header><div><small id="sfDialogKicker"></small><h2 id="sfDialogTitle"></h2></div><button type="button" data-sf-close aria-label="关闭">×</button></header><div id="sfFields"></div><p id="sfError" role="alert" hidden></p><footer><span id="sfSaveStatus" role="status"></span><button type="submit" class="sf-primary" id="sfSubmit">保存到本机</button></footer></form>';
  document.body.append(dialog);
  const q=s=>dialog.querySelector(s),matches=item=>!query || [item.title,item.text,item.angle,item.material,item.reader].join('\n').toLowerCase().includes(query.toLowerCase());
  const button=(action,label,id='',cls='')=>`<button type="button" class="${cls}" data-sf="${action}" ${id?`data-id="${esc(id)}"`:''}>${label}</button>`;
  const empty=(title,text,action='',label='')=>`<div class="sf-empty"><span>✧</span><strong>${esc(title)}</strong><p>${esc(text)}</p>${action?button(action,esc(label),'','sf-primary'):''}</div>`;
  const badge=doc=>`<span class="sf-badge" data-stage="${production.stageFor(doc)}">${labels[production.stageFor(doc)]}</span>`;
  const docRow=(doc,extra='')=>`<article class="sf-doc-row"><button class="sf-document" type="button" data-sf="open-draft" data-id="${esc(doc.id)}"><span class="sf-file-icon">▤</span><span><strong>${esc(doc.title||'未命名稿件')}</strong><small>${count(doc.text)} 字 · ${esc(time(doc.updatedAt))}${doc.folderId?` · ${esc(doc.folderId)}`:''}</small></span></button>${badge(doc)}${production.stageFor(doc)==='published'&&!production.reviewPassed(doc)?'<small class="sf-recheck">审稿待重新核对</small>':''}<div class="sf-row-actions">${extra||button('open-draft','继续写作 ↗',doc.id)}</div></article>`;
  function heading(eyebrow,title,description,action=''){
    return `<header class="sf-heading"><div><small>${esc(eyebrow)}</small><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</header>`;
  }
  function home(){
    const docs=drafts(),last=docs.find(doc=>`draft:${doc.id}`===data().ui.activeTab)||docs[0];
    const candidates=topics.listTopics(data()).filter(topic=>['candidate','selected'].includes(topic.status));
    const interrupted=data().sessions.filter(session=>session.messages?.at(-1)?.role==='user'&&session.messages.at(-1).error);
    const pendingEdits=data().sessions.flatMap(session=>[session.messages?.at(-1)].filter(Boolean).flatMap(message=>Object.keys(message.recoveredDrafts||{}).length>=(message.documentErrors||[]).length?[]:(message.documentErrors||[]).map(error=>({session,error}))));
    const ready=docs.filter(doc=>production.stageFor(doc)==='ready');
    const needsFeedback=docs.filter(doc=>production.latestPublicationFor(doc)&&!production.feedbackFor(doc,production.latestPublicationFor(doc).id));
    const inbox=[...pendingEdits.slice(0,2).map(({session,error})=>({action:'open-session',id:session.id,title:'有改动尚未保存',note:error.reason||session.title,tag:'检查候选内容'})),
      ...interrupted.slice(0,2).map(session=>({action:'open-session',id:session.id,title:'继续上次中断的创作',note:session.title,tag:'打开会话'})),
      ...ready.slice(0,2).map(doc=>({action:'publication',id:doc.id,title:doc.title,note:'已完成当前稿件的审稿，可准备发布并记录结果。',tag:'待发布'})),
      ...needsFeedback.slice(0,2).map(doc=>({action:'feedback',id:doc.id,title:doc.title,note:'已有发布记录，补上表现与经验，留给下一篇。',tag:'待复盘'}))];
    return heading('今天的创作','让下一篇，在这里继续。','从一个选题开始，把创作、成品与反馈连起来。',button('source-start','从一篇原文开始','','sf-primary')+button('scenes','从空白开始'))+
      `<section class="sf-beginner"><div><div><h2>第一次使用？跟着这 5 步完成一篇内容</h2><p>先确认原文，再选择公众号、小红书或口播。原文保留，二创另存。</p></div>${button('source-start','开始第一篇 →','','sf-primary')}</div><ol><li>① 选素材<small>粘贴链接或完整正文</small></li><li>② 看原文<small>确认内容与字数</small></li><li>③ 选创作方式<small>文章、图文或口播</small></li><li>④ 确认方案<small>先看角度和大纲</small></li><li>⑤ 审稿与成品<small>核对后准备发布</small></li></ol></section><section class="sf-continue"><div class="sf-continue-main"><small>继续上次的工作</small><h2>${esc(last?.title||'你的下一篇作品')}</h2><p>${last?`${count(last.text)} 字 · ${esc(time(last.updatedAt))} · ${labels[production.stageFor(last)]}`:'写下一个想法，或先从灵感雷达收集素材。'}</p><div>${last?button('open-draft','继续编辑 →',last.id,'sf-primary'):button('new-draft','新建空白稿件','','sf-primary')}${button('topics','查看选题计划')}</div></div><div class="sf-cycle" aria-label="创作循环"><span>01 素材</span><span>02 选题</span><span>03 创作</span><span>04 审稿</span><span>05 发布</span><span>06 复盘 ↺</span><small>每一步，都为下一篇积累。</small></div></section>
      <div class="sf-home-grid"><section class="sf-section"><header><h2>需要你接着处理 <small>${inbox.length}</small></h2></header>${inbox.length?inbox.slice(0,5).map(item=>`<button class="sf-inbox" data-sf="${item.action}" data-id="${esc(item.id)}"><span class="sf-inbox-dot"></span><span><strong>${esc(item.title)}</strong><small>${esc(item.note)}</small></span><em>${esc(item.tag)} ↗</em></button>`).join(''):empty('没有积压，适合开始一篇','已完成的稿件可以在“成品与发布”中继续审稿、准备发布。','delivery','查看成品与发布')}</section>
      <section class="sf-section"><header><h2>下一篇写什么</h2>${button('topics','全部选题 ↗')}</header>${candidates.length?candidates.slice(0,4).map(topic=>`<button class="sf-topic-preview" data-sf="topic" data-id="${esc(topic.id)}"><small>${esc(topics.STATUS[topic.status])}${topic.evidenceGaps?' · 有待核实项':''}</small><strong>${esc(topic.title)}</strong><span>${esc(topic.angle||'补充一个具体的切入角度')}</span></button>`).join(''):empty('给下一个好想法留位置','保存角度、读者和依据，开始时就少一点犹豫。','new-topic','＋ 新建选题')}</section></div>
      <section class="sf-section sf-recent"><header><h2>最近编辑</h2>${button('library','全部稿件 ↗')}</header>${docs.length?docs.slice(0,4).map(doc=>docRow(doc)).join(''):empty('还没有稿件','空白写作、素材导入和创作场景都可以开始。')}</section>`;
  }
  function topicPage(){
    const stages=['candidate','selected','writing','drafted'],all=topics.listTopics(data(),{query,status:'active'});
    return heading('想法，变成下一篇','选题计划','在动笔前确定角度、读者和依据；创作中的状态由实际会话与稿件更新。',button('new-topic','＋ 新建选题','','sf-primary'))+
      `<div class="sf-page-toolbar"><span>${all.length} 个进行中的选题</span>${button('manage-topics','管理选题 / 归档')}</div><div class="sf-board">${stages.map(stage=>{const items=all.filter(t=>t.status===stage);return `<section class="sf-board-column"><h2><i data-topic-stage="${stage}"></i>${esc(topics.STATUS[stage])}<small>${items.length}</small></h2>${items.length?items.map(topic=>`<button class="sf-topic-card" data-sf="topic" data-id="${esc(topic.id)}"><strong>${esc(topic.title)}</strong><p>${esc(topic.angle||'尚未记录写作角度')}</p><small>${esc(topic.reader||'读者待明确')}</small>${topic.evidenceGaps?'<span class="sf-evidence">有待核实 / 待补充项</span>':''}<footer>${esc(time(topic.updatedAt))}<span>${topic.links?.draftIds?.length||0} 篇稿件 ↗</span></footer></button>`).join(''):'<p class="sf-board-empty">'+({candidate:'把零散想法放在这里',selected:'选定后，从详情进入创作',writing:'开始创作后自动关联会话',drafted:'候选稿实际保存后进入这里'}[stage])+'</p>'}</section>`;}).join('')}</div>`;
  }
  function library(){
    const docs=drafts().filter(matches),refs=data().references.filter(matches),ideas=topics.listTopics(data(),{query});
    return heading('你的内容资产','素材与稿件','统一查找正文、引用来源和选题。引用保留来源记录，稿件继续在编辑器中完成。',button('new-draft','＋ 新建稿件','','sf-primary'))+
      `<div class="sf-page-toolbar"><div class="sf-filters">${[['all','全部'],['drafts','稿件'],['references','引用素材'],['topics','选题']].map(([id,label])=>`<button data-sf-filter="${id}" aria-pressed="${filter===id}">${label}</button>`).join('')}</div><span>${query?`搜索：${esc(query)}`:'最近更新'}</span></div>
      ${(filter==='all'||filter==='drafts')?`<section class="sf-section"><header><h2>稿件 <small>${docs.length}</small></h2></header>${docs.length?docs.map(doc=>docRow(doc)).join(''):empty('没有匹配的稿件','尝试其他关键词，或开始一篇新稿。')}</section>`:''}
      ${(filter==='all'||filter==='references')?`<section class="sf-section"><header><h2>引用素材 <small>${refs.length}</small></h2>${button('import','导入文件')}</header>${refs.length?refs.map(ref=>`<article class="sf-doc-row"><button class="sf-document" data-sf="open-reference" data-id="${esc(ref.id)}"><span class="sf-file-icon">▧</span><span><strong>${esc(ref.title)}</strong><small>${count(ref.text)} 字 · 来源快照 · 只读</small></span></button><div class="sf-row-actions">${button('reference-topic','整理为选题',ref.id)}</div></article>`).join(''):empty('把依据留在这里','从稿件侧栏导入或提取来源，写作时可以直接引用。','editor','打开创作工坊')}</section>`:''}
      ${(filter==='all'||filter==='topics')?`<section class="sf-section"><header><h2>选题 <small>${ideas.length}</small></h2></header>${ideas.length?ideas.map(topic=>`<button class="sf-search-topic" data-sf="topic" data-id="${esc(topic.id)}"><strong>${esc(topic.title)}</strong><span>${esc(topic.angle||topics.STATUS[topic.status])}</span><small>打开选题 ↗</small></button>`).join(''):empty('还没有匹配的选题','新建选题，保存下次想写的角度。','new-topic','新建选题')}</section>`:''}`;
  }
  function delivery(){
    const docs=drafts().filter(doc=>String(doc.text||'').trim()),visible=docs.filter(doc=>filter==='all'||production.stageFor(doc)===filter);
    return heading('从稿件到成品','成品与发布','先完成当前稿件的审稿，再制作发布包。发布后在这里登记链接与时间。',button('editor','返回创作工坊'))+
      `<div class="sf-page-toolbar"><div class="sf-filters">${[['all','全部'],...Object.entries(labels)].map(([id,label])=>`<button data-sf-filter="${id}" aria-pressed="${filter===id}">${label} <small>${id==='all'?docs.length:docs.filter(d=>production.stageFor(d)===id).length}</small></button>`).join('')}</div><span>手动登记发布结果</span></div><section class="sf-section">${visible.length?visible.map(doc=>{const stage=production.stageFor(doc);return docRow(doc,button('review',stage==='draft'?'审稿清单':'查看审稿',doc.id)+(['reviewed','ready','published'].includes(stage)?button('package','制作成品',doc.id):'')+(stage==='reviewed'?button('ready','标记待发布',doc.id,'sf-primary'):stage==='ready'?button('publication','记录已发布',doc.id,'sf-primary'):stage==='published'?button('feedback','记录复盘',doc.id,'sf-primary')+(production.readyFor(doc)?button('publication','新增发布记录',doc.id):production.reviewPassed(doc)?button('ready','准备再次发布',doc.id):''):''));}).join(''):empty('这个阶段还没有稿件','写好正文后，在这里完成审稿与发布准备。','editor','打开创作工坊')}</section>`;
  }
  function insights(){
    const published=drafts().filter(doc=>production.latestPublicationFor(doc)),doc=published.find(d=>d.id===selected)||published[0];
    const publication=doc&&production.latestPublicationFor(doc),feedback=doc?.production?.feedback?.filter(record=>record.publicationId===publication.id)||[],last=doc&&production.feedbackFor(doc,publication.id);
    return heading('把经验，带回下一篇','数据复盘','记录平台表现与自己的判断，形成下一次选题的依据。这里的数据由你填写。',button('delivery','查看发布记录'))+
      (published.length?`<div class="sf-insights-grid"><aside class="sf-section sf-published-list"><header><h2>已记录发布</h2></header>${published.map(d=>`<button data-sf="select-feedback" data-id="${esc(d.id)}" aria-pressed="${d.id===doc.id}"><strong>${esc(d.title)}</strong><small>${esc(production.latestPublicationFor(d)?.channel)} · ${time(production.latestPublicationFor(d)?.publishedAt)}</small></button>`).join('')}</aside><section class="sf-section sf-insight-detail"><header><div><small>发布作品</small><h2>${esc(doc.title)}</h2></div>${button('feedback',last?'补充复盘':'记录首次复盘',doc.id,'sf-primary')}</header><p class="sf-note">${esc(publication.channel)} · ${esc(time(publication.publishedAt))} · <a href="${esc(publication.url)}" target="_blank" rel="noopener noreferrer">打开已登记链接 ↗</a></p>${last?`<div class="sf-metrics">${[['views','浏览 / 播放'],['likes','点赞'],['comments','评论'],['saves','收藏']].map(([key,label])=>`<div><strong>${last[key]===null||last[key]===undefined?'—':esc(last[key])}</strong><span>${label}</span></div>`).join('')}</div><div class="sf-feedback-note"><small>这次内容的表现</small><p>${esc(last.notes||'还没有记录表现观察。')}</p><small>下一篇怎么改</small><p>${esc(last.lesson||'还没有记录下一次的改进。')}</p></div><div class="sf-feedback-next"><div><strong>把复盘变成一个新选题</strong><p>保留这次作品与反馈的记录，带着改进开始下一篇。</p></div>${button('next-topic','生成下一选题 →',doc.id,'sf-primary')}</div><p class="sf-note">共 ${feedback.length} 次复盘记录 · 最近更新 ${esc(time(last.recordedAt))} · 数据为手动填写</p>`:empty('发布只是下一轮的起点','补充浏览、互动和你的观察，再把经验带回下一选题。','feedback','＋ 记录复盘').replace('data-sf="feedback"','data-sf="feedback" data-id="'+esc(doc.id)+'"')}</section></div>`:empty('先给第一篇作品留下发布记录','在“成品与发布”完成审稿、标记待发布，再填写实际发布链接。','delivery','前往成品与发布'));
  }
  function render(){
    if(!host)return;
    host.innerHTML=`<div class="sf-page sf-page-${page}">${({home,topics:topicPage,library,delivery,insights}[page]||home)()}</div>`;
  }
  function field(name,label,{type='text',value='',required=false,placeholder='',rows=3,maxlength=2000}={}){
    const id='sf-'+name;
    return `<label for="${id}">${label}</label>${type==='textarea'?`<textarea id="${id}" name="${name}" rows="${rows}" maxlength="${maxlength}" ${required?'required':''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>`:`<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''} ${type==='number'?'min="0" step="1"':'maxlength="'+maxlength+'"'} placeholder="${esc(placeholder)}">`}`;
  }
  function openForm(kind,id){
    const doc=production.getDraft(data(),id);if(!doc)throw new Error('稿件已移除，请重新选择。');
    const key=kind+':'+id;
    const currentSnapshot=JSON.stringify([doc.title,doc.text,production.latestPublicationFor(doc)?.id,production.feedbackFor(doc)?.id]);
    if(dialogKey!==key || formSnapshot!==currentSnapshot){
      formSnapshot=currentSnapshot;
      dialogKey=key;applied=false;formDirty=false;q('#sfError').hidden=true;q('#sfSaveStatus').textContent='保存到本机工作空间';q('#sfSubmit').textContent='保存到本机';
      q('#sfDialogKicker').textContent=doc.title;
      const review=production.reviewFor(doc);
      if(kind==='review'){
        q('#sfDialogTitle').textContent='审稿清单';
        q('#sfFields').innerHTML=`<p class="sf-note">确认当前稿件的标题与正文。编辑后需要重新核对；AI 审稿建议可以作为参考。</p><div class="sf-review-checks">${[['sourceChecked','已核对事实、数字与来源'],['titleChecked','已检查标题、表达与平台适配'],['rightsChecked','已检查素材使用权限与隐私']].map(([name,label])=>`<label><input type="checkbox" name="${name}" ${review?.[name]?'checked':''}><span>${label}</span></label>`).join('')}</div>${field('notes','审稿备注 / 待补充',{type:'textarea',value:review?.notes||'',placeholder:'还有哪些地方需要改？'})}<button type="button" data-sf="ai-review" data-id="${esc(id)}">用 AI 辅助审稿 ↗</button>`;
      }else if(kind==='publication'){
        q('#sfDialogTitle').textContent='记录已发布';
        q('#sfFields').innerHTML=`<p class="sf-note">填写你已完成的发布结果。此操作保存发布记录，不会代你发布到外部平台。</p>${field('channel','发布平台 / 账号',{required:true,placeholder:'例如：微信公众号 · 晚风拾响',maxlength:100})}${field('url','已发布内容链接',{type:'url',required:true,placeholder:'https://…'})}${field('publishedAt','发布时间',{type:'datetime-local',required:true,value:new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)})}<label class="sf-confirm"><input type="checkbox" name="confirmed" required><span>我确认内容已在上述平台发布，链接对应当前稿件。</span></label>`;
      }else if(kind==='feedback'){
        q('#sfDialogTitle').textContent='记录这篇作品的复盘';
        q('#sfFields').innerHTML=`<p class="sf-note">按你查看平台时的实际数据填写，未掌握的项目可以留空。每次补充都会保存一条新记录。</p><div class="sf-form-metrics">${[['views','浏览 / 播放'],['likes','点赞'],['comments','评论'],['saves','收藏']].map(([name,label])=>`<div>${field(name,label,{type:'number'})}</div>`).join('')}</div>${field('notes','观察到了什么',{type:'textarea',placeholder:'哪个角度引发互动？读者留下了什么问题？'})}${field('lesson','下一篇准备怎么改',{type:'textarea',required:true,placeholder:'留下具体的调整，例如：下一篇先给案例，再解释原因。'})}`;
      }else if(kind==='next-topic'){
        const latest=production.feedbackFor(doc);if(!latest)throw new Error('请先记录一次复盘。');
        q('#sfDialogTitle').textContent='把复盘带入下一选题';q('#sfSubmit').textContent='保存下一选题';
        q('#sfFields').innerHTML=`<p class="sf-note">本次改进：${esc(latest.lesson)}</p>${field('title','下一篇选题',{required:true,value:Array.from('继续探索：'+doc.title).slice(0,160).join(''),maxlength:160})}${field('angle','切入角度',{type:'textarea',value:Array.from(latest.lesson||'').slice(0,1000).join(''),maxlength:1000})}${field('reader','目标读者',{maxlength:200})}`;
      }
    }
    if(!dialog.open)dialog.showModal();
  }
  async function handle(action,id){
    if(action==='open-draft')return actions.openDraft(id);
    if(action==='open-reference')return actions.openReference(id);
    if(action==='open-session')return actions.openSession(id);
    if(action==='source-start')return ctx.previewSource?.({});
    if(action==='scenes')return actions.openScenes();
    if(action==='new-draft')return actions.newDraft();
    if(action==='editor')return window.switchStudioTab('workbench');
    if(['topics','library','delivery'].includes(action))return window.switchStudioTab(action);
    if(action==='new-topic')return actions.openTopics({new:true});
    if(action==='manage-topics')return actions.openTopics();
    if(action==='topic')return actions.openTopics({id});
    if(action==='import')return actions.importFiles();
    if(action==='reference-topic')return actions.referenceTopic(id);
    if(action==='package')return actions.openMedia(id);
    if(action==='ai-review'){dialog.close();return actions.reviewWithAI(id);}
    if(action==='select-feedback'){selected=id;return render();}
    if(action==='ready'){
      production.markReady(data(),id);actions.changed();await actions.flush();render();return ctx.showToast('已标记待发布，可以准备成品并登记实际发布结果。');
    }
    if(['review','publication','feedback','next-topic'].includes(action))return openForm(action,id);
  }
  host.addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b)return;
    if(b.dataset.sfFilter){filter=b.dataset.sfFilter;return render();}
    if(b.dataset.sf)void handle(b.dataset.sf,b.dataset.id).catch(error=>ctx.showToast(error.message,'error'));
  });
  dialog.addEventListener('click',event=>{
    if(event.target.closest('[data-sf-close]')&&!busy)dialog.close();
    const b=event.target.closest('[data-sf]');if(b)void handle(b.dataset.sf,b.dataset.id).catch(error=>ctx.showToast(error.message,'error'));
  });
  dialog.addEventListener('input',()=>{formDirty=true;q('#sfError').hidden=true;q('#sfSaveStatus').textContent='本次输入尚未保存';});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  q('#sfForm').addEventListener('submit',event=>{event.preventDefault();void(async()=>{
    if(busy)return;busy=true;q('#sfError').hidden=true;
    try{
      const [kind,...idParts]=dialogKey.split(':'),id=idParts.join(':');
      if(!applied){
        const doc=production.getDraft(data(),id),currentSnapshot=JSON.stringify([doc?.title,doc?.text,production.latestPublicationFor(doc)?.id,production.feedbackFor(doc)?.id]);
        if(currentSnapshot!==formSnapshot){throw new Error('稿件或发布记录已变化。请关闭后重新打开，核对当前内容。');}
        const form=new FormData(q('#sfForm')),value=Object.fromEntries(form.entries());
        if(kind==='review')production.saveReview(data(),id,{...value,sourceChecked:form.has('sourceChecked'),titleChecked:form.has('titleChecked'),rightsChecked:form.has('rightsChecked')});
        if(kind==='publication')production.recordPublication(data(),id,{...value,publishedAt:new Date(value.publishedAt).toISOString(),confirmed:form.has('confirmed')});
        if(kind==='feedback')production.saveFeedback(data(),id,value);
        if(kind==='next-topic')production.newTopicFromFeedback(data(),id,value);
        applied=true;actions.changed();
      }
      for(const input of dialog.querySelectorAll('input,textarea'))input.disabled=true;
      q('#sfSubmit').disabled=true;q('#sfSaveStatus').textContent='正在保存…';
      await actions.flush();formDirty=false;dialog.close();dialogKey='';render();ctx.showToast('已保存到本机');
      if(kind==='next-topic')window.switchStudioTab('topics');
    }catch(error){q('#sfError').textContent=error.message;q('#sfError').hidden=false;q('#sfSaveStatus').textContent=applied?'记录已保留在当前窗口，请重试保存':'尚未保存，请检查填写内容';if(applied)q('#sfSubmit').textContent='重试保存';}
    finally{busy=false;q('#sfSubmit').disabled=false;}
  })();});
  return {show(next,options={}){if(page!==next){filter='all';page=next;}query=String(options.query||'').trim();render();},refresh(){if(!host.hidden)render();},hasUnsaved:()=>formDirty||busy};
}
