import {paragraphDiff} from './analysis-diff.js';
const commerceStages=[['hook','抓人'],['topic','入题'],['develop','展开'],['amplify','放大'],['bridge','转书'],['product','塑品'],['cta','促单']];
const trafficStages=[['hook','黄金三秒（抓人）'],['tension','制造张力（设悬/铺垫）'],['develop','情绪推顶 / 价值交付（展开）'],['climax','高潮 / 反转（破局）'],['interaction','互动钩子（留痕）']];
const numbers=['①','②','③','④','⑤','⑥','⑦'];
function blockTitle(block,index,blocks){
  return `第 ${index+1} 段 · ${block.label}${blocks.slice(0,index).some(b=>b.stage===block.stage)?'（再次出现）':''}`;
}
function orderNote(blocks,stages,traffic=false){
  const rank=key=>stages.findIndex(s=>s[0]===key);
  const returns=blocks.flatMap((b,i)=>i>0 && rank(b.stage)>=0 && rank(blocks[i-1].stage)>rank(b.stage)?[`第 ${i+1} 段从「${blocks[i-1].label}」回到「${b.label}」`]:[]);
  return returns.length?`结构提示：${returns.join('；')}。${traffic?'环节可以交错，检查悬念、情绪与高潮之间是否衔接自然。':'可检查这些转折是否衔接自然，是否打断从介绍产品到下单的推进。'}`:'';
}
export function mount(root,ctx,{kind='commerce'}={}) {
  const traffic=kind==='traffic',stages=traffic?trafficStages:commerceStages;
  const title=traffic?'流量拆解与评分':'带货拆解与评分',reportTitle=traffic?'流量文案拆解':'带货文案拆解';
  const stageCount=traffic?'五':'七',endpoint=`/api/writing-workbench/${kind}-analysis`;
  const note=blocks=>orderNote(blocks,stages,traffic);
  const dialog=document.createElement('dialog');
  dialog.className=`ca-dialog${traffic?' ca-traffic':''}`;dialog.setAttribute('aria-label',title);dialog.dataset.dismissOutside='';
  dialog.innerHTML=`<div class="ca-shell">
    <header class="ca-head"><div><h2>${title}</h2><p>${traffic?'从开场、张力到情绪高点，看清文案的吸引力。':'看清一篇文案，如何从吸引注意走到成交。'}</p></div><div class="ca-window-actions"><small>点击窗口外可暂时收起</small><button type="button" data-ca="close" aria-label="收起${traffic?'流量':'带货'}拆解">×</button></div></header>
    <section class="ca-history-bar" aria-label="拆解历史"><div class="ca-history-heading"><strong>最近拆解 <span class="ca-history-count"></span></strong><span>点选查看原文与评分</span><div class="ca-history-navigation" hidden><button type="button" data-ca="history-prev" aria-label="查看较新的拆解" title="查看较新的拆解"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m12 5-5 5 5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" data-ca="history-next" aria-label="查看更早的拆解" title="查看更早的拆解"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m8 5 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div></div><div class="ca-history-list" role="group" aria-label="最近拆解记录"></div><label class="studio-sr-only" for="caHistory">最近拆解记录</label><select id="caHistory" aria-label="最近拆解记录" hidden><option value="">选择历史记录</option></select></section>
    <div class="ca-document-actions" hidden><div class="ca-document-state"><strong data-ca-edit-title>整篇文案</strong><span data-ca-edit-state role="status"></span></div><div class="ca-document-buttons"><button type="button" data-ca="parent" hidden>查看修改前评分</button><button type="button" data-ca="save-draft">保存为新稿</button><button type="button" class="ca-rescore" data-ca="rescore">重新评分</button></div></div>
    <div class="ca-body"><aside class="ca-input"><div class="ca-source-heading"><label for="caSource">待分析的文案</label><button type="button" data-ca="clear-source">清空</button></div><textarea id="caSource" placeholder="粘贴文案，或打开一篇稿件后从工作台进入。" maxlength="20000"></textarea>
    <div class="ca-input-meta"><span id="caCount">0 / 20000 字</span><span>原文保留，按建议修改可撤销</span></div>
    <div class="ca-run"><button type="button" class="studio-primary-button" data-ca="start">开始拆解</button></div>
    <p id="caStatus" class="ca-status" role="status"></p><div id="caError" class="ca-error" role="alert" hidden></div>
    <p class="ca-help">可收起窗口继续写稿，分析会自动保存在本机；请保持应用运行。</p>
    <details class="ca-rubric"><summary>评分标准 <span>${stageCount}个环节 · 满分 100</span></summary><p>${traffic?'抓人 25 · 张力 20 · 展开 25<br>高潮 20 · 互动 10':'抓人 15 · 入题 10 · 展开 20<br>放大 15 · 转书 15 · 塑品 15 · 促单 10'}</p><small>${traffic?'缺失环节计 0 分。仅评文案结构与表达，不代表实际完播率、停留时长或播放量。':'转书也包含转产品；缺失环节计 0 分。评分用于比较文案结构，不代表实际销量。'}</small></details></aside>
    <section class="ca-output" aria-label="文案拆解结果"><div class="ca-empty"><svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M17 9h24l7 7v39H17z" stroke="currentColor" stroke-width="1.5"/><path d="M24 24h17M24 32h17M24 40h10" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg><h3>${traffic?'让观众停下来，也愿意看下去':'让每一段，都有清晰的作用'}</h3><p>${stageCount}色标注原文，逐段点评，找出最值得先改的地方。</p><div class="ca-legend">${stages.map(([k,n],i)=>`<span class="ca-${k}">${numbers[i]} ${n}</span>`).join('')}</div></div></section></div></div>`;
  if(traffic)for(const el of dialog.querySelectorAll('[id],[for]'))for(const attr of ['id','for'])if(el.hasAttribute(attr))el.setAttribute(attr,el.getAttribute(attr).replace(/^ca/,'ta'));
  (root.querySelector('.studio-shell') || root).append(dialog);
  const q=s=>dialog.querySelector(traffic?s.replace(/#ca/g,'#ta'):s), esc=ctx.esc;
  function referenced(value,result){
    const count=result.blocks.reduce((total,b)=>total+(b.sentences?.length || 0),0);
    return esc(value).replace(/第(\d+(?:\s*[-–—~～至、和及]\s*\d+)*)句/g,(match,nums)=>`第${nums.replace(/\d+/g,n=>Number(n)>=1 && Number(n)<=count?`<button type="button" class="ca-reference" data-ca="sentence" data-number="${Number(n)}" aria-label="定位第${Number(n)}句" title="查看原文第${Number(n)}句">${n}</button>`:n)}句`);
  }
  function original(block){
    if(!block.sentences?.length)return esc(block.text.trim());
    return block.sentences.map(s=>`<span class="ca-sentence${/\n\s*\n/.test(s.text)?' ca-paragraph-end':''}" data-ca-sentence="${s.number}" tabindex="-1"><span class="ca-sentence-number">第${s.number}句</span><span class="ca-sentence-text">${esc(s.text.trim())}</span></span>`).join('');
  }
  let selected=null,timer=null,clock=null,observedAt=0,request=0,starting=false,lastSeed='',editing=false,activeBlock=-1,editClock=null,editPoll=null,editStarted=0,editPhase='',editReceived=0,editProgressToken=0,sourceDraft=null,openGeneration=0,opening=false;
  function count(){q('#caCount').textContent=`${q('#caSource').value.length} / 20000 字`;}
  function error(message=''){q('#caError').hidden=!message;q('#caError').textContent=message;}
  function busy(value){q('[data-ca=start]').disabled=Boolean(value || opening);q('[data-ca=start]').textContent=value?'拆解中…':'开始拆解';q('[data-ca="clear-source"]').disabled=Boolean(value || editing || opening);}
  let historyItems=[];
  function updateHistoryNavigation(){
    const list=q('.ca-history-list'),max=list.scrollWidth-list.clientWidth;
    q('.ca-history-navigation').hidden=max<=1;
    q('[data-ca="history-prev"]').disabled=list.scrollLeft<=1;
    q('[data-ca="history-next"]').disabled=list.scrollLeft>=max-1;
  }
  q('.ca-history-list').addEventListener('scroll',updateHistoryNavigation,{passive:true});
  new ResizeObserver(updateHistoryNavigation).observe(q('.ca-history-list'));
  function revealHistorySelection(){
    const card=Array.from(q('.ca-history-list').children).find(node=>node.dataset.id===selected?.id);
    card?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function historyStatus(item){return {running:'分析中',completed:'已完成',failed:'未完成'}[item.status] || '未知状态';}
  function historyDate(value){const timestamp=Date.parse(value);return Number.isFinite(timestamp)?new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(timestamp):'时间未知';}
  function renderHistory(){
    const cards=document.createDocumentFragment();
    for(const item of historyItems){
      const date=historyDate(item.created),status=historyStatus(item),score=Number.isInteger(item.score)?item.score:null;
      const button=document.createElement('button');button.type='button';button.className='ca-history-card';button.dataset.ca='history';button.dataset.id=item.id;button.disabled=Boolean(editing||opening);button.setAttribute('aria-pressed',String(item.id===selected?.id));button.title=item.title || '未命名文案';
      button.setAttribute('aria-label',`${item.title}，${date}，${status}${score===null?'':`，${score} 分`}`);
      const copy=document.createElement('span');copy.className='ca-history-copy';
      const title=document.createElement('strong');title.className='ca-history-title';title.textContent=item.title || '未命名文案';
      const meta=document.createElement('span');meta.className='ca-history-meta';meta.textContent=`${date} · ${status}`;copy.append(title,meta);
      const points=document.createElement('span');points.className='ca-history-points';
      const total=document.createElement('strong');total.textContent=score===null?'—':String(score);
      const suffix=document.createElement('span');suffix.textContent=score===null?(item.status==='completed'?'未评分':'/100'):'/100';points.append(total,suffix);
      if(item.comparison && Number.isInteger(item.comparison.parent_score)){
        const comparison=document.createElement('small');comparison.className='ca-history-comparison';comparison.textContent=`原评 ${item.comparison.parent_score} 分`;points.append(comparison);
      }
      button.append(copy,points);cards.append(button);
    }
    if(!historyItems.length){const empty=document.createElement('p');empty.className='ca-history-empty';empty.textContent='完成一次拆解后，会在这里保留记录和得分。';cards.append(empty);}
    const list=q('.ca-history-list'),offset=list.scrollLeft,focusedId=document.activeElement?.closest('.ca-history-card')?.dataset.id;
    list.replaceChildren(cards);list.scrollLeft=offset;
    q('.ca-history-count').textContent=historyItems.length?`${historyItems.length} 条`:'';
    if(focusedId)Array.from(list.children).find(node=>node.dataset.id===focusedId)?.focus({preventScroll:true});
    requestAnimationFrame(updateHistoryNavigation);
  }
  async function history(){
    const data=await ctx.api(endpoint);
    const select=q('#caHistory');select.replaceChildren(new Option('选择历史记录',''));
    historyItems=data.items;
    for(const item of historyItems){const score=Number.isInteger(item.score)?` · ${item.score}/100`:'';select.add(new Option(`${historyDate(item.created)} ${item.title} · ${historyStatus(item)}${score}`,item.id));}
    select.value=selected?.id || '';renderHistory();
    return data.items;
  }
  function duration(seconds){const n=Math.max(0,Math.floor(seconds));return n>=60?`${Math.floor(n/60)}分${n%60}秒`:`${n}秒`;}
  function progress(){
    if(selected?.status!=='running')return;
    const seconds=(selected.elapsed_seconds ?? 0)+Math.floor((Date.now()-observedAt)/1000);
    const message=selected.phase || (selected.received_chars>0?'正在生成点评':'等待模型响应');
    q('#caStatus').textContent=`${message} · 已用时 ${duration(seconds)}`;
    const elapsed=q('[data-ca-elapsed]'),detail=q('[data-ca-progress]'),help=q('[data-ca-wait-help]');
    if(elapsed)elapsed.textContent=duration(seconds);
    if(detail)detail.textContent=selected.phase || (selected.received_chars>0?`模型正在返回拆解 · 已收到 ${selected.received_chars.toLocaleString('zh-CN')} 字符`:'已提交文章，等待模型开始返回');
    if(help)help.textContent=seconds>=60 && !selected.received_chars?'模型尚未返回内容。可以切换页面，稍后回来查看。':'可以关闭此弹窗继续写作，分析会继续并自动保存；请保持应用运行。';
  }
  function render(item){
    selected=item;observedAt=Date.now();clearInterval(clock);clock=null;busy(item.status==='running');error(item.status==='failed'?item.error:'');
    historyItems=historyItems.map(row=>row.id===item.id?{...row,score:item.result?.score??null,status:item.status,comparison:item.comparison}:row);renderHistory();
    q('#caHistory').value=item.id;renderEdits(false);
    if(item.status==='running'){
      if(!q('[data-ca-elapsed]'))q('.ca-output').innerHTML=`<div class="ca-working" role="status"><span class="ca-spinner" aria-hidden="true"></span><h3>${traffic?'正在分析流量结构':'正在拆解成交链路'}</h3><div class="ca-elapsed"><span>已用时</span><strong data-ca-elapsed>0秒</strong></div><p data-ca-progress></p><small data-ca-wait-help></small></div>`;
      progress();clock=setInterval(progress,1000);return;
    }
    q('#caStatus').textContent=item.status==='completed'?`已完成${item.elapsed_seconds==null?'':` · 用时 ${duration(item.elapsed_seconds)}`}`:'分析未完成，可修改原文后重试。';
    if(!item.result){q('.ca-output').innerHTML='<div class="ca-working"><h3>这次分析未完成</h3><p>原文已保留，请重试分析。</p></div>';return;}
    const r=item.result;
    q('.ca-output').innerHTML=`<div class="ca-result-head"><div><span class="ca-result-type">${traffic?'流量结构评分':r.is_commerce?'带货结构评分':'非带货文章'}</span><h3>${traffic?'从吸引注意，到留下共鸣':r.is_commerce?'从停留，到成交':'先看内容，再谈转化'}</h3></div><div class="ca-score">${r.score===null?'<strong>—</strong>':`<strong>${r.score}</strong><span>/ 100</span>`}</div></div>
    ${item.comparison?`<div class="ca-score-comparison"><span>修改前 <strong>${item.comparison.parent_score ?? '—'}</strong></span><span>本次整篇评分 <strong>${r.score ?? '—'}</strong></span>${typeof r.score==='number' && typeof item.comparison.parent_score==='number'?`<span class="ca-score-change">${r.score>item.comparison.parent_score?'+':''}${r.score-item.comparison.parent_score} 分</span>`:''}<small>基于当前全文重新分析</small></div>`:''}
    <p class="ca-verdict">${referenced(r.verdict,r)}</p><p class="ca-summary">${referenced(r.summary,r)}</p>
    <div class="ca-result-tools"><div class="ca-legend">${stages.map(([k,n],i)=>`<span class="ca-${k}">${numbers[i]} ${n}</span>`).join('')}</div><div class="ca-result-actions"><button type="button" data-ca="copy-all">一键复制</button><button type="button" data-ca="export">导出拆解</button></div></div>
    <p class="ca-copy-status" data-ca-copy-status role="status" hidden></p>
    <p class="ca-order-help">句子从全文第 1 句连续编号，点击点评中的句子编号可定位原文。同一环节可能再次出现，分数按环节计一次。</p>
    ${note(r.blocks)?`<p class="ca-order-note">${esc(note(r.blocks))}</p>`:''}
    <div class="ca-column-head" aria-hidden="true"><span>文案原文</span><span>环节点评</span></div>
    <div class="ca-annotated">${r.blocks.map((b,blockIndex)=>{const review=r.reviews.find(x=>x.stage===b.stage);return `<section class="ca-block ca-${b.stage}" aria-label="${esc(blockTitle(b,blockIndex,r.blocks))}"><div class="ca-passage"><header><h4>${esc(blockTitle(b,blockIndex,r.blocks))}</h4></header><div class="ca-original">${original(b)}</div></div><div class="ca-review-column">${review?`<details class="ca-comment" open><summary><span>环节点评 <span class="ca-review-score">${review.score} / ${review.max_score} 分</span></span><button type="button" class="ca-copy" data-ca="copy-review" data-block="${blockIndex}" title="复制这一环节的点评" aria-label="复制${esc(b.label)}点评">复制</button></summary><div class="ca-review-body"><p><b>亮点</b><span>${referenced(review.strength,r)}</span></p><p><b>问题</b><span>${referenced(review.issue,r)}</span></p><p><b>建议</b><span>${referenced(review.suggestion,r)}<span class="ca-paragraph-actions"><button type="button" class="ca-revise" data-ca="revise" data-block="${blockIndex}">按建议修改</button><button type="button" class="ca-undo" data-ca="undo" data-block="${blockIndex}" aria-label="撤销第${blockIndex+1}段的上次修改">撤销</button></span><span class="ca-revision-progress" data-ca-revision-progress="${blockIndex}" role="status" hidden><progress aria-label="本段修改进度"></progress><span data-ca-revision-detail></span></span></span></p></div></details>`:`<p class="ca-no-review">此段为其他文字，不计入${stageCount}环节评分。</p>`}</div></section>`;}).join('')}</div>
    ${r.reviews.some(x=>!x.present)?`<section class="ca-missing"><h4>缺失的环节</h4>${r.reviews.filter(x=>!x.present).map(x=>`<p><strong>${esc(x.label)} · 0 / ${x.max_score}</strong><span>${referenced(x.issue,r)}</span><span>建议：${referenced(x.suggestion,r)}</span></p>`).join('')}</section>`:''}
    <section class="ca-priorities"><h4>优先改这几处</h4><ol>${r.priorities.map(p=>`<li>${referenced(p,r)}</li>`).join('')}</ol></section>`;
    renderEdits();
  }
  function comparison(before,after){
    const diff=paragraphDiff(before.text,after);
    const side=kind=>diff.parts.filter(part=>part.kind!==-kind).map(part=>part.kind===kind?`<${kind===1?'ins':'del'}>${esc(part.text)}</${kind===1?'ins':'del'}>`:esc(part.text)).join('');
    return `<div class="ca-diff"><div class="ca-diff-heading"><strong class="ca-edit-label">修改对比</strong><span>新增 ${diff.added} 字 · 删除 ${diff.removed} 字</span></div><div class="ca-diff-columns"><section><h5>修改前 <small>红色标出删改</small></h5><div class="ca-diff-text ca-diff-before">${side(-1)}</div></section><section><h5>修改后 <small>绿色标出新增</small></h5><div class="ca-diff-text ca-diff-after">${side(1)}</div></section></div></div><details class="ca-before"><summary>查看带句号编号的原文</summary>${original(before)}</details>`;
  }
  function renderEditProgress(){
    const seconds=duration((Date.now()-editStarted)/1000);
    for(const node of dialog.querySelectorAll('[data-ca-revision-progress]')){
      node.hidden=editing!=='revise' || Number(node.dataset.caRevisionProgress)!==activeBlock;
      if(!node.hidden)node.querySelector('[data-ca-revision-detail]').textContent=`${editPhase} · 已用时 ${seconds}${editReceived?` · 已收到 ${editReceived.toLocaleString('zh-CN')} 字符`:''}`;
    }
    if(editing==='revise')q('[data-ca-edit-state]').textContent=`正在修改第 ${activeBlock+1} 段 · ${editPhase} · ${seconds}`;
  }
  function beginEditProgress(identifier){
    editStarted=Date.now();editPhase='准备调用模型';editReceived=0;
    const token=++editProgressToken;
    editClock=setInterval(renderEditProgress,500);
    async function poll(){
      try{
        const value=await ctx.api(`${endpoint}/${identifier}/revision-progress`);
        if(token!==editProgressToken)return;
        if(value.status==='running' && value.block_index===activeBlock){editPhase=value.phase;editReceived=value.received_chars;renderEditProgress();}
      }catch(_){ /* The original edit request still owns success/failure. */ }
      if(token===editProgressToken)editPoll=setTimeout(poll,1000);
    }
    editPoll=setTimeout(poll,250);
  }
  function endEditProgress(){
    editProgressToken++;clearInterval(editClock);clearTimeout(editPoll);editClock=null;editPoll=null;
  }
  function renderEdits(updateParagraphs=true){
    const current=selected?.editing,ready=selected?.status==='completed' && current;
    const changes=ready?current.blocks.filter((text,i)=>text!==selected.result.blocks[i].text).length:0;
    const manual=ready && q('#caSource').value!==current.text;
    q('.ca-document-actions').hidden=!selected;
    const save=q('[data-ca="save-draft"]'),rescore=q('[data-ca="rescore"]'),parent=q('[data-ca="parent"]');
    save.disabled=Boolean(editing || opening || !ready || !changes && !selected?.comparison || manual);
    rescore.disabled=Boolean(editing || opening || !ready || manual || !changes);
    rescore.textContent=editing==='rescore' || selected?.status==='running' && selected?.comparison?'重新评分中…':'重新评分';
    parent.hidden=!selected?.comparison;parent.disabled=Boolean(editing || opening);
    q('[data-ca-edit-title]').textContent=changes?`已修改 ${changes} 段`:selected?.comparison?'修改后全文':'整篇文案';
    q('[data-ca-edit-state]').textContent=editing==='rescore'?'正在提交修改后的完整文案…':editing==='undo'?`正在撤销第 ${activeBlock+1} 段…`:editing?`正在修改第 ${activeBlock+1} 段…`:manual?'左侧文案已手动编辑，请先开始拆解':selected?.status==='running'?'正在分析全文，完成后显示最新总分':selected?.status==='failed'?'评分未完成，文案与修改前记录已保留':changes?'修改已保存，点击重新评分查看最新总分':selected?.comparison?'已完成整篇重新评分，可继续修改':'按段修改后，可对整篇文案重新评分';
    for(const button of dialog.querySelectorAll('[data-ca="revise"],[data-ca="undo"]')){
      const index=Number(button.dataset.block),undo=button.dataset.ca==='undo';
      button.disabled=Boolean(editing || opening || manual || !ready || undo && !current.undo_blocks?.includes(index));
      button.textContent=editing && index===activeBlock && editing===(undo?'undo':'revise')?(undo?'撤销中…':'修改中…'):(undo?'撤销':'按建议修改');
    }
    q('#caSource').readOnly=Boolean(editing || opening);
    q('#caHistory').disabled=Boolean(editing || opening);
    for(const button of q('.ca-history-list').querySelectorAll('[data-ca="history"]'))button.disabled=Boolean(editing || opening);
    q('[data-ca="clear-source"]').disabled=Boolean(editing || opening || starting || selected?.status==='running');
    q('[data-ca="start"]').disabled=Boolean(editing || opening || starting || selected?.status==='running');
    renderEditProgress();
    if(!ready || !updateParagraphs)return;
    dialog.querySelectorAll('.ca-block').forEach((section,i)=>{
      const target=section.querySelector('.ca-original'),before=selected.result.blocks[i];
      target.innerHTML=current.blocks[i]===before.text?original(before):comparison(before,current.blocks[i]);
    });
  }
  async function editParagraph(blockIndex,undo=false){
    if(editing || !selected?.result)return;
    const item=selected,state=item.editing || {revision:0,text:item.source};
    if(q('#caSource').value!==state.text)throw new Error('左侧文章已手动修改，请先重新拆解再按建议修改，避免覆盖你的编辑');
    const token=request,scroll=q('.ca-output').scrollTop;
    editing=undo?'undo':'revise';activeBlock=blockIndex;if(!undo)beginEditProgress(item.id);error();renderEdits();
    try{
      const updated=await ctx.api(`${endpoint}/${item.id}/${undo?'undo':'revise'}`,{method:'POST',body:JSON.stringify({revision:state.revision,text:state.text,block_index:blockIndex})});
      if(token!==request && selected?.id!==item.id)return;
      q('#caSource').value=updated.editing.text;count();render(updated);q('.ca-output').scrollTop=scroll;
    }finally{endEditProgress();editing=false;activeBlock=-1;renderEdits();}
  }
  async function rescore(){
    if(editing || !selected?.editing)return;
    const item=selected,state=item.editing;
    if(q('#caSource').value!==state.text)throw new Error('左侧文章已手动修改，请先开始拆解，避免遗漏手动编辑');
    const token=++request;clearTimeout(timer);editing='rescore';error();renderEdits();
    try{
      const updated=await ctx.api(`${endpoint}/${item.id}/rescore`,{method:'POST',body:JSON.stringify({revision:state.revision,text:state.text})});
      if(token!==request)return;
      q('#caSource').value=updated.source;q('#caSource').scrollTop=0;count();render(updated);q('.ca-output').scrollTop=0;
      q('.ca-body').scrollTop=0;
      await history();revealHistorySelection();if(updated.status==='running')timer=setTimeout(()=>void watch(updated.id,token),1800);
    }finally{editing=false;renderEdits();}
  }
  async function watch(identifier,token){
    try{
      const item=await ctx.api(`${endpoint}/${identifier}`);
      if(token!==request)return;
      render(item);
      if(item.status==='running')timer=setTimeout(()=>void watch(identifier,token),1800);
      else await history();
    }catch(e){if(token===request){clearInterval(clock);error(e.message);busy(false);q('#caStatus').textContent='结果暂时读取失败，重新打开窗口可继续读取。';}}
  }
  async function select(identifier){
    clearTimeout(timer);const token=++request;
    const focusedHistoryId=document.activeElement?.closest('.ca-history-card')?.dataset.id;
    const wasOpening=opening;opening=true;renderEdits(false);
    try{
      const item=await ctx.api(`${endpoint}/${identifier}`);
      if(token!==request)return;
      q('#caSource').value=item.editing?.text || item.source;count();render(item);revealHistorySelection();
      if(item.status==='running')timer=setTimeout(()=>void watch(identifier,token),1800);
    }finally{if(token===request){opening=wasOpening;renderEdits(false);if(focusedHistoryId&&!opening)Array.from(q('.ca-history-list').children).find(node=>node.dataset.id===focusedHistoryId)?.focus({preventScroll:true});}}
  }
  function markdown(){
    const r=selected?.result;if(!r)return '';
    return `# ${reportTitle}\n\n${r.score===null?'非带货文章':`综合评分：${r.score} / 100`}${selected.editing?.text!==selected.source?'（修改前评分，需重新评分）':''}${selected.comparison?`\n修改前评分：${selected.comparison.parent_score ?? '—'} / 100`:''}\n\n${r.verdict}\n\n${r.summary}\n\n按原文顺序拆分，同一环节可能再次出现；分数按环节计一次。\n\n${note(r.blocks)}\n\n`+r.blocks.map((b,i)=>{const v=r.reviews.find(x=>x.stage===b.stage);return `## ${blockTitle(b,i,r.blocks)}${v?`（环节得分 ${v.score}/${v.max_score}）`:''}\n\n${b.sentences?.length?b.sentences.map(s=>`第${s.number}句  ${s.text.trim()}`).join('\n\n'):b.text.trim()}\n\n${v?`亮点：${v.strength}\n\n问题：${v.issue}\n\n建议：${v.suggestion}\n\n`:''}`;}).join('')+r.reviews.filter(x=>!x.present).map(v=>`## ${v.label}（缺失，0/${v.max_score}）\n\n${v.issue}\n\n建议：${v.suggestion}\n\n`).join('')+`## 优先修改\n\n${r.priorities.map((x,i)=>`${i+1}. ${x}`).join('\n\n')}`;
  }
  dialog.addEventListener('click',async event=>{
    const button=event.target.closest('[data-ca]'),action=button?.dataset.ca;if(!action)return;
    if(action.startsWith('copy-'))event.preventDefault();
    try{
      if(action==='close'){dialog.close();return;}
      if(action==='history-prev'||action==='history-next'){
        const list=q('.ca-history-list');list.scrollBy({left:(action==='history-prev'?-1:1)*Math.max(270,list.clientWidth*.85),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});return;
      }
      if(action==='clear-source'){
        if(editing||selected?.status==='running')return;
        q('#caSource').value='';q('#caSource').dispatchEvent(new Event('input'));q('#caSource').focus();return;
      }
      if(action==='sentence'){
        const target=q(`[data-ca-sentence="${Number(button.dataset.number)}"]`);if(!target)return;
        const before=target.closest('.ca-before');if(before)before.open=true;
        q('.ca-sentence.is-highlighted')?.classList.remove('is-highlighted');
        target.classList.add('is-highlighted');target.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});target.focus({preventScroll:true});return;
      }
      if(action==='revise')return await editParagraph(Number(button.dataset.block));
      if(action==='undo')return await editParagraph(Number(button.dataset.block),true);
      if(action==='rescore')return await rescore();
      if(action==='parent'){if(!editing && selected?.comparison)await select(selected.comparison.parent_id);return;}
      if(action==='save-draft'){
        if(editing || !selected?.editing)return;
        button.disabled=true;
        try{await ctx.saveAnalysisDraft(selected.title || reportTitle,selected.editing.text);ctx.showToast('已保存为新稿，原稿保留');}
        finally{button.disabled=false;}
        return;
      }
      if(action==='history'){if(!editing&&!opening&&button.dataset.id)await select(button.dataset.id);return;}
      if(action==='copy-all' || action==='copy-review'){
        let text=markdown();
        if(action==='copy-review'){
          const block=selected?.result?.blocks[Number(button.dataset.block)];
          const review=selected?.result?.reviews.find(item=>item.stage===block?.stage);
          if(!review)return;
          text=`${blockTitle(block,Number(button.dataset.block),selected.result.blocks)}（环节得分 ${review.score}/${review.max_score}）\n\n亮点：${review.strength}\n\n问题：${review.issue}\n\n建议：${review.suggestion}`;
        }
        if(!text)return;
        const feedback=q('[data-ca-copy-status]');
        feedback.hidden=false;feedback.textContent='正在复制…';button.disabled=true;
        try{
          if(ctx.copy)await ctx.copy(text);
          else{
            try{await navigator.clipboard.writeText(text);}
            catch(_){
              const area=document.createElement('textarea');area.value=text;area.style.cssText='position:fixed;opacity:0';dialog.append(area);area.focus();area.select();
              let copied=false;try{copied=document.execCommand('copy');}finally{area.remove();button.focus();}
              if(!copied)throw new Error('复制失败，请选中文字后按 ⌘C 复制');
            }
          }
          feedback.textContent=`已复制${action==='copy-all'?'完整拆解':'本段点评'}（${Array.from(text).length.toLocaleString('zh-CN')} 字），可直接粘贴。`;
        }catch(e){
          feedback.textContent='复制未完成，请重试；也可点击“导出拆解”保存。';
          throw e;
        }finally{
          button.disabled=false;
        }
        const label=button.textContent;button.textContent='已复制';
        setTimeout(()=>{if(button.isConnected)button.textContent=label;},1600);return;
      }
      if(action==='export'){
        if(ctx.download){await ctx.download((selected.title || reportTitle)+'-拆解.md',markdown(),'text/markdown;charset=utf-8');return;}
        const blob=new Blob([markdown()],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
        a.href=url;a.download=(selected.title || reportTitle)+'-拆解.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
      }
      if(action==='start'){
        if(starting || selected?.status==='running')return;
        const text=q('#caSource').value;if(!text.trim()){error('请先粘贴一篇文章');q('#caSource').focus();return;}
        starting=true;busy(true);error();clearTimeout(timer);const token=++request;
        q('#caStatus').textContent='正在提交分析…';
        try{
          const item=await ctx.api(endpoint,{method:'POST',body:JSON.stringify({text,title:text.trim().split('\n')[0].slice(0,28)})});
          if(token!==request)return;
          render(item);await history();revealHistorySelection();if(item.status==='running')timer=setTimeout(()=>void watch(item.id,token),1800);
        }finally{starting=false;if(selected?.status!=='running')busy(false);}
      }
    }catch(e){error(e.message);if(action==='start')q('#caStatus').textContent='分析未能提交，请检查提示后重试。';}
  });
  q('#caSource').addEventListener('input',()=>{count();renderEdits();if(selected?.result)q('#caStatus').textContent='原文已修改，右侧为上次分析；点击「开始拆解」分析当前文章。';});
  q('#caHistory').addEventListener('change',()=>{if(q('#caHistory').value)void select(q('#caHistory').value).catch(e=>error(e.message));});
  dialog.addEventListener('close',()=>{const text=q('#caSource').value;sourceDraft={text,id:selected?.id||'',seed:lastSeed,manual:!selected||text!==(selected.editing?.text||selected.source)};clearTimeout(timer);clearInterval(clock);request++;openGeneration++;opening=false;});
  return {async open(seed='',title=''){
    const generation=++openGeneration,remembered=sourceDraft;sourceDraft=null;
    const newSeed=Boolean(seed && seed!==lastSeed && selected?.status!=='running');
    if(newSeed){q('#caSource').value=seed;lastSeed=seed;count();if(selected?.result)q('#caStatus').textContent='已载入当前稿件，右侧为上次分析。';}
    opening=true;dialog.showModal();dialog.setAttribute('aria-busy','true');renderEdits(false);
    try{
      const items=await history();
      if(!dialog.open || generation!==openGeneration)return;
      const active=items.find(x=>x.status==='running');
      if(active)await select(active.id);
      else if(selected)await select(selected.id);
      else if(!q('#caSource').value && items.length)await select(items[0].id);
      if(!dialog.open || generation!==openGeneration)return;
      // Hiding is not discarding. A newly selected manuscript still takes priority.
      const restore=newSeed&&!active?seed:remembered?.manual&&remembered.id===(selected?.id||'')&&remembered.seed===lastSeed?remembered.text:null;
      if(restore!==null){q('#caSource').value=restore;q('#caSource').dispatchEvent(new Event('input'));}
    }catch(e){if(generation===openGeneration)error(e.message);}
    finally{if(generation===openGeneration){opening=false;dialog.setAttribute('aria-busy','false');renderEdits(false);}}
  }};
}
