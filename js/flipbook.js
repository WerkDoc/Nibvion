// ================= PDF → Interaktives 3D-Flipbook (eigenständige .html) =================
// Seiten werden lokal über pdf.js als JPEG gerendert und zusammen mit einem kleinen Betrachter
// (CSS + JS, keine externen Dateien) in EINE .html-Datei gepackt. Der Empfänger öffnet sie im
// Browser: Doppelseiten wie ein Magazin (quer/PC) bzw. Einzelseite (Handy hochkant), 3D-Umblättern
// mit Biegung und Schatten, Zoom, optional dezenter Blättersound (Web Audio, synthetisiert).
import { icon } from './icons.js';
import { sheet, toast, busy, haptic, esc } from './ui.js';
import { loadPdf, closePdf } from './pdfcore.js';
import { db } from './db.js';
import { shareBytes } from './editor.js';

const QUALITY = {
  std: { label: 'Standard', sub: 'Kleine Datei, ideal zum Verschicken', px: 1300, q: 0.8 },
  hi: { label: 'Hoch', sub: 'Gestochen scharf zum Zoomen, größere Datei', px: 2200, q: 0.88 },
};

export function flipbookSheet(d) {
  if (!d) return;
  let qual = 'std', sound = true;
  sheet({
    title: 'Als 3D-Flipbook exportieren',
    html: `<p style="color:var(--text2);margin:0 2px 12px;font-size:14px;line-height:1.45">„${esc(d.name)}“ wird zu <b style="color:var(--text)">einer einzigen .html-Datei</b>. Der Empfänger öffnet sie im Browser (Handy oder PC) und blättert wie in einem echten Magazin – ohne App, ohne Internet.</p>
      <div class="lbl" style="margin-top:0">Qualität</div>
      <div class="menu" data-q>${Object.entries(QUALITY).map(([k, o]) => `<button class="row ${k === qual ? 'sel' : ''}" data-v="${k}"><span class="row-main"><span class="row-title">${o.label}</span><span class="row-sub" style="display:block">${o.sub}</span></span><span class="radio"></span></button>`).join('')}</div>
      <div class="row" style="padding:14px 2px 4px;border:0"><div class="row-main"><div class="row-title">Blättersound</div><div class="row-sub">Dezentes Papierrascheln (im Flipbook abschaltbar)</div></div><div class="seg" data-snd><button class="on" data-v="1">An</button><button data-v="0">Aus</button></div></div>
      <p style="color:var(--text3);font-size:12.5px;margin:6px 2px 0">Geschätzte Größe: <span data-est>…</span></p>
      <div class="btn-row"><button class="btn primary" data-go>${icon('book')} Flipbook erstellen</button></div>`,
    onMount(el, api) {
      const est = () => { const per = qual === 'hi' ? 520 : 190; el.querySelector('[data-est]').textContent = `ca. ${Math.max(1, Math.round((d.pages || 1) * per / 1024 * 10) / 10).toString().replace('.', ',')} MB (${d.pages || 1} Seiten)`; };
      el.querySelectorAll('[data-q] [data-v]').forEach(b => b.onclick = () => { qual = b.dataset.v; haptic(); el.querySelectorAll('[data-q] .row').forEach(x => x.classList.toggle('sel', x === b)); est(); });
      el.querySelectorAll('[data-snd] button').forEach(b => b.onclick = () => { sound = b.dataset.v === '1'; el.querySelectorAll('[data-snd] button').forEach(x => x.classList.toggle('on', x === b)); });
      est();
      el.querySelector('[data-go]').onclick = async () => { api.close(); await exportFlipbook(d, qual, sound); };
    },
  });
}

async function exportFlipbook(d, qual, sound) {
  const Q = QUALITY[qual];
  busy(true, 'Flipbook wird vorbereitet …', { scan: d.thumb });
  let pdf;
  try {
    const f = await db.get('files', d.id);
    pdf = await loadPdf(f.data);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      busy(true, `Seite ${i} von ${pdf.numPages} wird gerendert …`);
      const p = await pdf.getPage(i), v = p.getViewport({ scale: 1 });
      const s = Q.px / Math.max(v.width, v.height), vp = p.getViewport({ scale: s });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: g, viewport: vp }).promise;
      pages.push({ w: c.width, h: c.height, d: c.toDataURL('image/jpeg', Q.q).split(',')[1] });
      c.width = c.height = 0;
    }
    busy(true, 'Flipbook wird verpackt …');
    const title = d.name.replace(/\.pdf$/i, '');
    const html = buildHtml(title, pages, sound);
    const bytes = new TextEncoder().encode(html);
    busy(false);
    await shareBytes(bytes, title + ' (Flipbook).html', 'text/html');
    toast('Flipbook erstellt');
  } catch (e) { console.error(e); busy(false); toast('Flipbook konnte nicht erstellt werden', true); }
  finally { if (pdf) closePdf(pdf); }
}

// ---------------------------------------------------------------------------------
// Eigenständige HTML-Datei
// ---------------------------------------------------------------------------------
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function buildHtml(title, pages, sound = true) {
  const data = JSON.stringify({ title, sound, pages }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="generator" content="Nibvion"><title>${escHtml(title)}</title>
<style>${VIEWER_CSS}</style></head>
<body><div id="app">
  <header id="top"><div class="ttl">${escHtml(title)}</div><div id="cnt"></div></header>
  <main id="stage"><div id="zoom"><div id="book"></div></div><div id="load"><i></i><span>Wird geladen …</span></div></main>
  <footer id="bar">
    <button id="prev" aria-label="Zurück"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <input id="slider" type="range" min="0" value="0" aria-label="Seite">
    <button id="next" aria-label="Weiter"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    <span class="sep"></span>
    <button id="zm" aria-label="Zoom"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M11 8v6M8 11h6"/></svg></button>
    <button id="snd" aria-label="Ton"><svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="w" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/><path class="x" d="M16 9.5l5 5M21 9.5l-5 5"/></svg></button>
    <button id="fs" aria-label="Vollbild"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
  </footer>
  <div id="brand">Erstellt mit Nibvion</div>
</div>
<script type="application/json" id="data">${data}</script>
<script>${VIEWER_JS}</script>
</body></html>`;
}

const VIEWER_CSS = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;background:#1b1d22;color:#eceef2;font:15px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overscroll-behavior:none}
#app{position:fixed;inset:0;display:flex;flex-direction:column;background:radial-gradient(ellipse at 50% 40%,#2b2f38 0%,#17181c 75%)}
#top{display:flex;align-items:center;gap:12px;padding:calc(env(safe-area-inset-top) + 12px) 18px 8px;transition:opacity .3s,transform .3s}
.ttl{flex:1;min-width:0;font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cnt{flex:none;padding:6px 12px;border-radius:14px;background:rgba(255,255,255,.08);font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
#stage{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;cursor:grab}
#zoom{position:relative;transform-origin:0 0;will-change:transform;transition:transform .35s cubic-bezier(.2,.8,.2,1)}
#zoom.drag{transition:none}
#book{position:relative;perspective:2600px;perspective-origin:50% 50%}
.pg{position:absolute;top:0;background:#fff no-repeat;background-size:100% 100%;box-shadow:0 18px 50px rgba(0,0,0,.45)}
.pg.l{border-radius:4px 0 0 4px}.pg.r{border-radius:0 4px 4px 0}
.pg.l::after,.pg.r::after{content:"";position:absolute;top:0;bottom:0;width:34px;pointer-events:none}
.pg.l::after{right:0;background:linear-gradient(270deg,rgba(0,0,0,.22),rgba(0,0,0,0))}
.pg.r::after{left:0;background:linear-gradient(90deg,rgba(0,0,0,.2),rgba(0,0,0,0))}
.single .pg.r::after{width:14px}
.pg.empty{visibility:hidden}
#leaf{position:absolute;top:0;width:0;height:100%;transform-style:preserve-3d;-webkit-transform-style:preserve-3d;pointer-events:none;z-index:3}
.st{position:absolute;top:0;transform-origin:0 50%;transform-style:preserve-3d;-webkit-transform-style:preserve-3d;will-change:transform}
.fc{position:absolute;inset:0;overflow:hidden;background:#fff no-repeat;-webkit-backface-visibility:hidden;backface-visibility:hidden}
.fc.bk{transform:rotateY(180deg)}
.fc.paper{background:#f4f1ea}
.fc i{position:absolute;inset:0;background:#000;opacity:0;will-change:opacity;pointer-events:none}
.cast{position:absolute;top:0;bottom:0;width:80px;z-index:2;pointer-events:none;opacity:0;will-change:transform,opacity}
.cast.r{transform-origin:0 50%;background:linear-gradient(90deg,rgba(0,0,0,.45),rgba(0,0,0,.12) 40%,rgba(0,0,0,0))}
.cast.l{transform-origin:100% 50%;background:linear-gradient(270deg,rgba(0,0,0,.45),rgba(0,0,0,.12) 40%,rgba(0,0,0,0))}
#bar{display:flex;align-items:center;gap:8px;padding:8px 14px calc(env(safe-area-inset-bottom) + 12px);max-width:720px;width:100%;margin:0 auto;transition:opacity .3s,transform .3s}
#bar button{flex:none;width:42px;height:42px;border-radius:21px;display:grid;place-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);color:#fff;cursor:pointer;transition:transform .2s,background .2s}
#bar button:active{transform:scale(.88)}#bar button:disabled{opacity:.3}
#bar button.on{background:linear-gradient(135deg,#ff6a5b,#ffa15a);border-color:transparent}
#bar svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
#snd .x{display:none}#snd.off .x{display:inline}#snd.off .w{display:none}
.sep{flex:none;width:1px;height:26px;background:rgba(255,255,255,.12);margin:0 2px}
#slider{flex:1;min-width:60px;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:rgba(255,255,255,.15);outline:none}
#slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#ff6a5b,#ffa15a);box-shadow:0 2px 8px rgba(0,0,0,.4)}
#slider::-moz-range-thumb{width:20px;height:20px;border:0;border-radius:50%;background:#ff7a5b}
#brand{position:fixed;right:12px;bottom:calc(env(safe-area-inset-bottom) + 64px);font-size:10.5px;color:rgba(255,255,255,.25);pointer-events:none}
#load{position:absolute;display:flex;flex-direction:column;align-items:center;gap:12px;color:rgba(255,255,255,.6);font-size:13px}
#load i{width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top-color:#ff6a5b;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.uioff #top{opacity:0;transform:translateY(-12px);pointer-events:none}.uioff #bar{opacity:0;transform:translateY(12px);pointer-events:none}
.zoomed #stage{cursor:move}
@media (prefers-reduced-motion:reduce){#zoom,#top,#bar{transition:none}}
`;

// Betrachter-Logik (läuft beim Empfänger, ohne Abhängigkeiten)
const VIEWER_JS = String.raw`(function(){
"use strict";
var D=JSON.parse(document.getElementById('data').textContent);
var RM=matchMedia('(prefers-reduced-motion: reduce)').matches;
var N=D.pages.length,urls=[],$=function(id){return document.getElementById(id)};
var book=$('book'),stage=$('stage'),zoomEl=$('zoom');
// Bilder als Blob-URLs (Strings werden nicht 16× pro Blatt kopiert)
D.pages.forEach(function(p,i){var b=atob(p.d),a=new Uint8Array(b.length);for(var k=0;k<b.length;k++)a[k]=b.charCodeAt(k);urls[i]=URL.createObjectURL(new Blob([a],{type:'image/jpeg'}));p.d=null;});
$('load').remove();

var S={dbl:false,s:0,P:{w:0,h:0},A:0,v:0,dir:0,raf:0,leaf:null,zoom:1,tx:0,ty:0,sound:!!D.sound,ui:true};
var STRIPS=14,BEND=44;
var L,R,leafHost,castL,castR;

// ---------- Aufteilung: einzeln oder Doppelseite ----------
function spreads(){return S.dbl?Math.floor(N/2)+1:N}
function slots(s){if(!S.dbl)return{l:-1,r:s};return{l:s===0?-1:2*s-1,r:2*s<N?2*s:-1}}
function bg(el,i){if(i<0||i>=N){el.classList.add('empty');el.style.backgroundImage='';return}el.classList.remove('empty');el.style.backgroundImage='url('+urls[i]+')'}

function layout(){
  var W=stage.clientWidth-24,H=stage.clientHeight-16,p0=D.pages[0],ar=p0.w/p0.h;
  var wasDbl=S.dbl,first=wasDbl?slots(S.s).r:S.s;
  S.dbl=N>1&&W>H*1.05&&W>=640;
  var cols=S.dbl?2:1,pw=Math.min(W/cols,H*ar),ph=pw/ar;
  S.P={w:Math.floor(pw),h:Math.floor(ph)};
  book.style.width=(S.P.w*cols)+'px';book.style.height=S.P.h+'px';
  book.className=S.dbl?'dbl':'single';
  book.innerHTML='';
  L=document.createElement('div');L.className='pg l';R=document.createElement('div');R.className='pg r';
  castL=document.createElement('div');castL.className='cast l';castR=document.createElement('div');castR.className='cast r';
  leafHost=document.createElement('div');leafHost.id='leaf';
  [L,R].forEach(function(e){e.style.width=S.P.w+'px';e.style.height=S.P.h+'px'});
  L.style.left='0';R.style.left=(S.dbl?S.P.w:0)+'px';
  if(!S.dbl)L.style.display='none';
  leafHost.style.left=(S.dbl?S.P.w:0)+'px';
  book.appendChild(L);book.appendChild(R);book.appendChild(castL);book.appendChild(castR);book.appendChild(leafHost);
  if(first<0)first=0;
  S.s=S.dbl?Math.ceil(first/2):first;
  if(wasDbl&&!S.dbl)S.s=Math.max(0,first);
  setZoom(1);show();
}
function show(){var o=slots(S.s);bg(L,o.l);bg(R,o.r);count()}
function count(){var o=slots(S.s),a=o.l>=0?o.l+1:o.r+1,b=o.r>=0?o.r+1:o.l+1;$('cnt').textContent=(a===b?a:a+'–'+b)+' / '+N;var sl=$('slider');sl.max=spreads()-1;sl.value=S.s;$('prev').disabled=S.s<=0;$('next').disabled=S.s>=spreads()-1}

// ---------- Blatt bauen ----------
function face(i,x0,cls){var f=document.createElement('div');f.className='fc'+(cls?' '+cls:'');
  if(i>=0&&i<N){f.style.backgroundImage='url('+urls[i]+')';f.style.backgroundSize=S.P.w+'px '+S.P.h+'px';f.style.backgroundPosition=(-x0)+'px 0'}
  else if(cls==='bk')f.classList.add('paper');
  f.appendChild(document.createElement('i'));return f}
function build(front,back){
  leafHost.innerHTML='';var n=RM?1:STRIPS,sw=S.P.w/n,par=leafHost,list=[];
  for(var k=0;k<n;k++){var st=document.createElement('div');st.className='st';
    st.style.width=(sw+(k<n-1?1.5:0))+'px';st.style.height=S.P.h+'px';st.style.left=(k?sw:0)+'px';
    var fr=face(front,k*sw),bk=face(S.dbl?back:-2,S.P.w-(k+1)*sw,'bk');
    if(!S.dbl){bk.className='fc bk paper';bk.style.backgroundImage='';}
    st.appendChild(fr);st.appendChild(bk);par.appendChild(st);par=st;
    list.push({el:st,fd:fr.firstChild,bd:bk.firstChild});}
  S.leaf={s:list,sw:sw};
}
function apply(){
  var lf=S.leaf;if(!lf)return;var n=lf.s.length,p=S.A/180,bend=n>1?Math.sin(p*Math.PI)*BEND:0,d=n>1?bend/(n-1):0,r0=S.A-bend/2,edge=0;
  for(var k=0;k<n;k++){var s=lf.s[k],a=(r0+k*d)*Math.PI/180,c=Math.cos(a),sn=Math.abs(Math.sin(a));
    s.el.style.transform='rotateY('+(-(k?d:r0)).toFixed(3)+'deg)';
    s.fd.style.opacity=(c>0?.32*Math.pow(sn,1.4):0).toFixed(3);
    s.bd.style.opacity=(c<0?.26*Math.pow(sn,1.4):0).toFixed(3);
    edge+=lf.sw*c;}
  var sp=S.dbl?S.P.w:0,si=Math.sin(S.A*Math.PI/180);
  if(edge>0){castR.style.opacity=(.85*Math.min(1,si*1.6)).toFixed(3);castR.style.transform='translate3d('+(sp+edge).toFixed(1)+'px,0,0) scaleX('+(.35+si*1.2).toFixed(3)+')';castL.style.opacity=0}
  else{castR.style.opacity=0;if(S.dbl){castL.style.opacity=(.85*Math.min(1,si*1.6)).toFixed(3);castL.style.transform='translate3d('+(sp+edge-80).toFixed(1)+'px,0,0) scaleX('+(.35+si*1.2).toFixed(3)+')'}}
}
function clearLeaf(){leafHost.innerHTML='';S.leaf=null;castL.style.opacity=0;castR.style.opacity=0}

// ---------- Blättern ----------
function can(d){return d>0?S.s<spreads()-1:S.s>0}
function begin(d){
  S.dir=d;S.v=0;var a=slots(S.s);
  if(d>0){var b=slots(S.s+1);build(a.r,b.l);bg(R,b.r);S.A=0}
  else{var b2=slots(S.s-1);build(b2.r,a.l);bg(L,b2.l);S.A=180}
  apply();
}
function animateTo(t,done){
  cancelAnimationFrame(S.raf);var last=performance.now(),K=150,C=2*Math.sqrt(K)*.92;
  function step(now){var dt=Math.min(.032,(now-last)/1000);last=now;S.v+=(K*(t-S.A)-C*S.v)*dt;S.A+=S.v*dt;
    if(S.A>180){S.A=180;S.v=Math.min(0,S.v)*-.15}if(S.A<0){S.A=0;S.v=Math.max(0,S.v)*-.15}apply();
    if(Math.abs(t-S.A)<.25&&Math.abs(S.v)<8){S.A=t;apply();S.raf=0;done();return}S.raf=requestAnimationFrame(step)}
  S.raf=requestAnimationFrame(step);
}
function finish(commit){
  var d=S.dir,t=d>0?(commit?180:0):(commit?0:180);
  if(commit)rustle();
  animateTo(t,function(){if(commit)S.s+=d;show();requestAnimationFrame(clearLeaf);S.dir=0});
}
function go(d){
  if(S.raf||drag||!can(d))return;
  if(RM){S.s+=d;show();return}
  begin(d);S.v=d>0?260:-260;finish(true);
}
$('prev').onclick=function(){go(-1)};$('next').onclick=function(){go(1)};
$('slider').oninput=function(){if(S.raf)return;S.s=+this.value;show()};

// ---------- Blättersound (Web Audio, synthetisiert) ----------
var ac=null,noise=null;
function rustle(){
  if(!S.sound)return;
  try{
    if(!ac){var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;ac=new AC();
      noise=ac.createBuffer(1,ac.sampleRate*.5,ac.sampleRate);var ch=noise.getChannelData(0),b=0;
      for(var i=0;i<ch.length;i++){var w=Math.random()*2-1;b=.88*b+.12*w;ch[i]=b*(.6+.4*Math.random())}}
    if(ac.state==='suspended')ac.resume();
    var t=ac.currentTime,src=ac.createBufferSource();src.buffer=noise;src.playbackRate.value=.9+Math.random()*.25;
    var bp=ac.createBiquadFilter();bp.type='bandpass';bp.Q.value=.7;bp.frequency.setValueAtTime(3200,t);bp.frequency.exponentialRampToValueAtTime(900,t+.32);
    var hp=ac.createBiquadFilter();hp.type='highpass';hp.frequency.value=380;
    var g=ac.createGain();g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.16,t+.03);g.gain.setValueAtTime(.12,t+.12);g.gain.exponentialRampToValueAtTime(.001,t+.38);
    src.connect(bp);bp.connect(hp);hp.connect(g);g.connect(ac.destination);src.start(t);src.stop(t+.42);
  }catch(e){}
}
function sndUi(){$('snd').classList.toggle('off',!S.sound)}
$('snd').onclick=function(){S.sound=!S.sound;sndUi();if(S.sound)rustle()};sndUi();

// ---------- Zoom ----------
function setZoom(z,cx,cy){
  var r=stage.getBoundingClientRect(),bw=book.offsetWidth,bh=book.offsetHeight;
  var ox=(r.width-bw)/2,oy=(r.height-bh)/2;
  if(cx==null){cx=r.width/2;cy=r.height/2}
  var bx=(cx-ox-S.tx)/S.zoom,by=(cy-oy-S.ty)/S.zoom;
  S.zoom=z;S.tx=z===1?0:cx-ox-bx*z;S.ty=z===1?0:cy-oy-by*z;clampPan();
  document.body.classList.toggle('zoomed',z>1);$('zm').classList.toggle('on',z>1);
}
function clampPan(){
  var r=stage.getBoundingClientRect(),bw=book.offsetWidth*S.zoom,bh=book.offsetHeight*S.zoom,ox=(r.width-book.offsetWidth)/2,oy=(r.height-book.offsetHeight)/2;
  if(S.zoom>1){var minx=r.width-bw-ox-20,maxx=-ox+20,miny=r.height-bh-oy-20,maxy=-oy+20;
    if(bw<r.width)S.tx=(r.width-bw)/2-ox;else S.tx=Math.min(maxx,Math.max(minx,S.tx));
    if(bh<r.height)S.ty=(r.height-bh)/2-oy;else S.ty=Math.min(maxy,Math.max(miny,S.ty));}
  zoomEl.style.transform='translate3d('+S.tx+'px,'+S.ty+'px,0) scale('+S.zoom+')';
}
$('zm').onclick=function(){setZoom(S.zoom>=2.5?1:S.zoom<1.5?1.75:2.5)};

// ---------- Gesten ----------
var drag=null,lastTap=0,pts={};
stage.addEventListener('pointerdown',function(e){
  pts[e.pointerId]={x:e.clientX,y:e.clientY};
  var ids=Object.keys(pts);
  if(ids.length===2){if(drag&&drag.d&&drag.d!=='x'&&S.leaf)finish(false);var a=pts[ids[0]],b=pts[ids[1]];drag={pinch:true,d:Math.hypot(a.x-b.x,a.y-b.y),z:S.zoom};return}
  if(S.raf)return;
  drag={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now(),lt:performance.now(),d:0,moved:false,tx:S.tx,ty:S.ty};
  try{stage.setPointerCapture(e.pointerId)}catch(_){}
});
stage.addEventListener('pointermove',function(e){
  if(pts[e.pointerId])pts[e.pointerId]={x:e.clientX,y:e.clientY};
  var g=drag;if(!g)return;
  if(g.pinch){var ids=Object.keys(pts);if(ids.length<2)return;var a=pts[ids[0]],b=pts[ids[1]],r=stage.getBoundingClientRect();
    var z=Math.max(1,Math.min(4,g.z*Math.hypot(a.x-b.x,a.y-b.y)/g.d));zoomEl.classList.add('drag');setZoom(z,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top);return}
  if(e.pointerId!==g.id)return;
  var dx=e.clientX-g.x,dy=e.clientY-g.y;
  if(S.zoom>1){if(Math.hypot(dx,dy)>6)g.moved=true;zoomEl.classList.add('drag');S.tx=g.tx+dx;S.ty=g.ty+dy;clampPan();return}
  if(!g.d){if(Math.abs(dx)<8||Math.abs(dx)<Math.abs(dy)*1.1){if(Math.hypot(dx,dy)>10)g.moved=true;return}
    g.moved=true;var d=dx<0?1:-1;if(!can(d)){g.d='x';return}g.d=d;if(!RM)begin(d)}
  if(g.d==='x'||RM)return;
  var W=S.P.w,edge=g.d>0?W+dx*(S.dbl?.75:1.3):-W+dx*(S.dbl?.75:2.1);
  var nA=Math.acos(Math.max(-1,Math.min(1,edge/W)))*180/Math.PI,now=performance.now(),dt=Math.max(1,now-g.lt)/1000;
  S.v=S.v*.6+((nA-S.A)/dt)*.4;g.lt=now;S.A=nA;apply();
});
function up(e){
  delete pts[e.pointerId];
  var g=drag;if(!g)return;
  if(g.pinch){if(Object.keys(pts).length===0){drag=null;zoomEl.classList.remove('drag');if(S.zoom<1.08)setZoom(1)}return}
  if(e.pointerId!==g.id)return;drag=null;zoomEl.classList.remove('drag');
  if(!g.d||S.zoom>1){
    if(!g.moved&&performance.now()-g.t<350){
      var now=Date.now(),r=stage.getBoundingClientRect();
      if(now-lastTap<300){lastTap=0;setZoom(S.zoom>1?1:2,e.clientX-r.left,e.clientY-r.top);return}
      lastTap=now;var x=(e.clientX-r.left)/r.width;
      setTimeout(function(){if(lastTap!==now||S.zoom>1)return;if(x>.75)go(1);else if(x<.25)go(-1);else{S.ui=!S.ui;document.body.classList.toggle('uioff',!S.ui)}},260);
    }
    return;
  }
  if(g.d==='x')return;
  if(RM){S.s+=g.d;show();return}
  var fl=Math.abs(S.v)>240,c=g.d>0?(fl?S.v>0:S.A>70):(fl?S.v<0:S.A<110);
  finish(e.type==='pointercancel'?false:c);
}
stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' ')go(1);else if(e.key==='ArrowLeft'||e.key==='PageUp')go(-1);else if(e.key==='+')setZoom(Math.min(4,S.zoom+.5));else if(e.key==='-')setZoom(Math.max(1,S.zoom-.5))});
$('fs').onclick=function(){var el=document.documentElement;if(document.fullscreenElement||document.webkitFullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen).call(document)}else if(el.requestFullscreen)el.requestFullscreen().catch(function(){});else if(el.webkitRequestFullscreen)el.webkitRequestFullscreen()};
if(!(document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen))$('fs').style.display='none';
var rz;addEventListener('resize',function(){clearTimeout(rz);rz=setTimeout(function(){if(!S.raf)layout()},150)});
layout();
})();`;
