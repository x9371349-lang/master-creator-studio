export function needsOriginalCheck(doc){
  if(!doc)return false;
  if(doc.source?.source_confirmed===true)return false;
  const text=String(doc.text||'').trim(),source=doc.source||{};
  if(text.length >= 60) return false;
  if(['body_extracted','transcribed','user_provided','wechat_10w','aihot','hot_topic'].includes(source.extraction_state)) return false;
  if(text.length < 30) return true;
  if(source.extraction_state === 'summary_only') return true;
  return false;
}

export function mount(ctx,actions){
  const esc=v=>ctx.esc(String(v??''));
  const dialog=document.createElement('dialog');dialog.id='sourceIntakeDialog';dialog.className='si-dialog';
  dialog.setAttribute('aria-labelledby','siHeading');
  dialog.innerHTML=`<header><div><small>用一篇真实原文开始</small><h2 id="siHeading">先看原稿，再进行二创</h2></div><button type="button" data-si="close" aria-label="关闭原文预览">×</button></header>
    <ol class="si-steps"><li data-si-step="1">1 选择来源</li><li data-si-step="2">2 确认原文</li><li data-si-step="3">3 开始二创</li></ol>
    <div class="si-body"><section class="si-input"><label for="siTitle">文章名称</label><input id="siTitle" maxlength="500" placeholder="给这份原文起个名字">
    <div class="si-mode"><button type="button" data-si-mode="link" aria-pressed="true">粘贴原文链接</button><button type="button" data-si-mode="paste" aria-pressed="false">直接粘贴全文</button></div>
    <div id="siLinkFields"><label for="siURL">公众号文章或网页链接</label><input id="siURL" type="url" placeholder="https://mp.weixin.qq.com/s/…"><p>支持微信“复制链接”、抖音、小红书、今日头条、微博及各类新闻资讯网页链接。</p></div>
    <div id="siPasteFields" hidden><label for="siManualText">完整原文</label><textarea id="siManualText" rows="9" placeholder="从你已打开的原文页面复制完整正文，粘贴到这里。"></textarea><label class="si-check"><input id="siManualConfirmed" type="checkbox" checked><span>我已粘贴完整正文，而不是搜索摘要。</span></label></div>
    <button type="button" data-si="preview" class="si-primary">获取原文并预览</button><details id="siSummary" hidden><summary>搜索摘要（不是原文）</summary><p></p></details>
    </section><section class="si-preview"><div class="si-preview-heading"><h3>原文预览</h3><span id="siCount">尚未获取</span></div><p id="siStatus" role="status">先填写链接，或直接粘贴全文。</p><textarea id="siText" aria-label="完整原文预览" readonly placeholder="成功读取后，完整正文会出现在这里。"></textarea><a id="siOriginalLink" target="_blank" rel="noopener noreferrer" hidden>在浏览器查看原文 ↗</a><p id="siError" role="alert" hidden></p></section></div>
    <footer><label class="si-check"><input id="siConfirmed" type="checkbox" disabled><span>我已查看上面的正文，确认这是要使用的完整原文。</span></label><button type="button" data-si="confirm" class="si-primary" disabled>确认原文，进入创作工坊 →</button></footer>`;
  document.body.append(dialog);
  const q=s=>dialog.querySelector(s);
  const safeURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
  let input={},mode='link',preview=null,busy=false,requestNumber=0;
  function sync(){
    q('[data-si="preview"]').disabled=busy;
    q('[data-si="confirm"]').disabled=busy||!preview||!q('#siConfirmed').checked;
    q('#siConfirmed').disabled=busy||!preview;
    q('[data-si="close"]').disabled=busy;
    for(const el of dialog.querySelectorAll('#siTitle,#siURL,#siManualText,#siManualConfirmed,[data-si-mode]'))el.disabled=busy;
    for(const el of dialog.querySelectorAll('[data-si-step]'))el.classList.toggle('active',Number(el.dataset.siStep)===(preview?2:1));
  }
  function error(message){q('#siError').textContent=message;q('#siError').hidden=!message;}
  function invalidate(){preview=null;q('#siConfirmed').checked=false;q('#siText').value='';q('#siCount').textContent='尚未获取';sync();}
  function setMode(next){mode=next;q('#siLinkFields').hidden=next!=='link';q('#siPasteFields').hidden=next!=='paste';for(const b of dialog.querySelectorAll('[data-si-mode]'))b.setAttribute('aria-pressed',String(b.dataset.siMode===next));q('[data-si="preview"]').textContent=next==='paste'?'预览粘贴的原文':'获取原文并预览';invalidate();error('');}
  async function getPreview(){
    if(busy)return;const run=++requestNumber;busy=true;preview=null;error('');q('#siConfirmed').checked=false;q('#siStatus').textContent='正在获取原文，暂不保存，也不进行二创…';sync();
    try{
      const response=await ctx.api('/api/source/preview',{method:'POST',body:JSON.stringify({title:q('#siTitle').value||input.title||'原文',url:q('#siURL').value,platform:input.platform||'网页原文',summary:input.summary||'',manual_text:mode==='paste'?q('#siManualText').value:'',manual_confirmed:mode==='paste'&&q('#siManualConfirmed').checked})});
      if(run!==requestNumber)return;
      preview=response.data;
      if(!preview?.text||!preview.preview_token)throw new Error('原文预览未准备好，请重试。');
      q('#siText').value=preview.text;q('#siTitle').value=preview.title||q('#siTitle').value;q('#siCount').textContent=`${Array.from(preview.text.replace(/\s/g,'')).length} 字`;
      q('#siStatus').textContent=mode==='paste'?'已载入你提供的正文。请核对完整性，再确认导入。':preview.source_resolution==='exact_title_search_refresh'?'已刷新搜狗临时链接并读取正文。请核对标题、来源链接和全文，再确认导入。':'已读取文章正文。请查看全文，确认后即可存为原文。';
      q('#siOriginalLink').hidden=!safeURL(preview.url);q('#siOriginalLink').href=safeURL(preview.url);
      q('#siConfirmed').checked=true;
    }catch(e){preview=null;q('#siText').value='';q('#siCount').textContent='未取得原文';q('#siStatus').textContent='还没有导入，也没有开始二创。';if(e.detail?.source_url&&safeURL(e.detail.source_url)){q('#siURL').value=e.detail.source_url;q('#siOriginalLink').href=safeURL(e.detail.source_url);q('#siOriginalLink').hidden=false;}error(e.message);}
    finally{busy=false;sync();}
  }
  async function confirm(){
    if(busy||!preview||!q('#siConfirmed').checked)return;
    if(actions.isBusy?.()){error('请先完成或停止当前创作，再保存原文。');return;}
    busy=true;error('');q('#siStatus').textContent='正在保存原文并进入创作…';sync();
    try{
      const result=await ctx.api('/api/materials/create-draft',{method:'POST',body:JSON.stringify({preview_token:preview.preview_token,source_confirmed:true})});
      await actions.importOriginal(result);dialog.close();ctx.showToast('原文已保存，已生成二创稿。开始二创！');
    }catch(e){error(e.message);q('#siStatus').textContent='保存尚未完成，内容保留在这里，可重试。';}
    finally{busy=false;sync();}
  }
  dialog.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.siMode&&!busy)setMode(b.dataset.siMode);if(b.dataset.si==='preview')void getPreview();if(b.dataset.si==='confirm')void confirm();if(b.dataset.si==='close'&&!busy)dialog.close();});
  dialog.addEventListener('input',event=>{if(event.target.id==='siConfirmed')return sync();if(event.target.closest('.si-input')){invalidate();error('');}});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  return {open(spec={}){if(busy){ctx.showToast('原文正在获取，请稍候。');return;}input=spec;setMode(spec.manual_text?'paste':'link');q('#siTitle').value=spec.title||'';q('#siURL').value=spec.url||'';q('#siManualText').value=spec.manual_text||'';q('#siManualConfirmed').checked=true;q('#siStatus').textContent='先获取并核对原文，再开始二创。';q('#siSummary').hidden=!spec.summary;q('#siSummary p').textContent=spec.summary||'';q('#siOriginalLink').hidden=!safeURL(spec.url);q('#siOriginalLink').href=safeURL(spec.url);if(!dialog.open)dialog.showModal();if(spec.url)void getPreview();},hasUnsaved:()=>busy||dialog.open&&Boolean(q('#siManualText').value.trim()),close(){if(!busy)dialog.close();}};
}
