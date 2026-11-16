import DiffMatchPatch from './diff-match-patch.js';

// Encode Unicode code points as individual tokens so emoji cannot be split
// across markup. Decode before rendering; no original text is normalized.
export function paragraphDiff(before,after){
  const tokens=new Map(),characters=[''];
  const encode=text=>Array.from(text,char=>{
    if(!tokens.has(char)){
      const index=characters.length;
      tokens.set(char,String.fromCharCode(index<0xd800?index:index+0x800));
      characters.push(char);
    }
    return tokens.get(char);
  }).join('');
  const decode=text=>Array.from(text,char=>{
    const code=char.charCodeAt(0);
    return characters[code<0xe000?code:code-0x800];
  }).join('');
  const a=encode(before),b=encode(after),engine=new DiffMatchPatch();
  engine.Diff_Timeout=.2;
  const parts=engine.diff_main(a,b,false).map(([kind,text])=>({kind,text:decode(text)}));
  return {parts,added:parts.filter(p=>p.kind===1).reduce((n,p)=>n+Array.from(p.text).length,0),
    removed:parts.filter(p=>p.kind===-1).reduce((n,p)=>n+Array.from(p.text).length,0)};
}
