var _ut=0,_ui=null;
function fu(s){var d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sc=s%60;return d>0?d+'d '+h+'h':h>0?h+'h '+m+'m':m>0?m+'m '+sc+'s':sc+'s';}
function ft(iso){return new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function fd(ms){return ms<1000?ms+'ms':(ms/1000).toFixed(1)+'s';}

function drawChart(h){
  var c=document.getElementById('hchart'),ctx=c.getContext('2d');
  var dpr=window.devicePixelRatio||1,W=c.offsetWidth,H=c.offsetHeight||130;
  c.width=W*dpr;c.height=H*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,W,H);
  var n=h.length||24,gap=3,bw=Math.max(2,(W-gap*(n-1))/n),mx=Math.max.apply(null,h.concat([1])),now=new Date().getHours();
  h.forEach(function(v,i){
    var x=i*(bw+gap),bh=Math.max(3,(v/mx)*(H-20)),y=H-bh-16,cur=i===now;
    var g=ctx.createLinearGradient(0,y,0,y+bh);
    g.addColorStop(0,cur?'rgba(107,124,156,1)':'rgba(107,124,156,.55)');
    g.addColorStop(1,cur?'rgba(107,124,156,.3)':'rgba(107,124,156,.08)');
    ctx.fillStyle=g;ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(x,y,bw,bh,2);else ctx.rect(x,y,bw,bh);
    ctx.fill();
    if(v>0&&bh>16){ctx.fillStyle=cur?'#f0f0f5':'rgba(160,160,176,.75)';ctx.font='9px JetBrains Mono,monospace';ctx.textAlign='center';ctx.fillText(v,x+bw/2,y-2);}
  });
  ctx.fillStyle='rgba(90,90,106,.7)';ctx.font='9px JetBrains Mono,monospace';ctx.textAlign='center';
  for(var i=0;i<n;i+=6){ctx.fillText(String(i).padStart(2,'0')+'h',i*(bw+gap)+bw/2,H-2);}
}

function renderTicks(logs){
  var row=document.getElementById('ticks');row.innerHTML='';
  for(var i=0;i<30;i++){
    var e=logs&&logs[i],ok=!e||e.status==='ok';
    var t=document.createElement('div');
    t.className='uptime-bar'+(ok?'':' error');
    t.setAttribute('data-label',ok?'OK':'Error');
    row.appendChild(t);
  }
}

function calcAvg(logs){
  var r=(logs||[]).slice(0,20).filter(function(l){return l.status==='ok';});
  if(!r.length)return '—';
  return fd(Math.round(r.reduce(function(a,b){return a+b.duration_ms;},0)/r.length));
}

function renderLog(logs){
  var tb=document.getElementById('log-body');
  if(!logs||!logs.length){tb.innerHTML='<tr><td colspan="5" class="empty"><div class="empty-icon">∅</div>No requests yet</td></tr>';return;}
  tb.innerHTML=logs.map(function(e){
    var ok=e.status==='ok',cached=e.cached;
    var badge='<span class="badge '+(ok?'badge-ok':'badge-err')+'">'+(ok?'OK':'ERR')+'</span>'+(cached?' <span class="badge badge-cache">⚡</span>':'');
    var title=(e.title||'').length>38?(e.title||'').slice(0,38)+'…':(e.title||'—');
    return '<tr><td class="log-time">'+ft(e.iso)+'</td><td class="log-id"><a href="/proxy?q='+encodeURIComponent(e.video_id||'')+'">'+e.video_id+'</a></td><td class="log-title" title="'+(e.title||'')+'">'+title+'</td><td>'+badge+'</td><td class="log-dur">'+fd(e.duration_ms)+'</td></tr>';
  }).join('');
}

function renderCache(entries){
  var el=document.getElementById('cache-list'),cnt=document.getElementById('cache-count');
  cnt.textContent=entries.length;
  if(!entries.length){el.innerHTML='<div class="empty"><div class="empty-icon">◎</div>No cached entries</div>';return;}
  el.innerHTML=entries.map(function(e){
    return '<div class="cache-row"><span class="cache-id">'+e.id+'</span><span class="cache-title">'+(e.title||'—')+'</span><span class="cache-ttl">'+e.ttl_remaining_min+'m left</span><button class="btn btn-danger btn-xs" onclick="evict(\''+e.id+'\')">×</button></div>';
  }).join('');
}

async function clearCache(){
  if(!confirm('Clear all cached links?'))return;
  await fetch('/api/cache',{method:'DELETE'});
  render();
}

async function evict(id){
  await fetch('/api/cache/'+id,{method:'DELETE'});
  render();
}

async function render(){
  var data,cache;
  try{var r=await fetch('/stats');data=await r.json();}catch{return;}
  try{var r2=await fetch('/api/cache');cache=await r2.json();}catch{cache={entries:[]};}
  _ut=data.uptime_seconds;
  document.getElementById('s-total').textContent=(data.total_requests||0).toLocaleString();
  document.getElementById('s-rate').textContent=(data.success_rate??'—')+'%';
  document.getElementById('s-errors').textContent=(data.total_errors||0)+' errors';
  document.getElementById('s-avg').textContent=calcAvg(data.logs);
  document.getElementById('s-cache').textContent=data.cache_entries||0;
  document.getElementById('log-meta').textContent=(data.logs||[]).length+' entries';
  drawChart(data.hourly||Array(24).fill(0));
  renderTicks(data.logs);
  renderLog(data.logs);
  renderCache(cache.entries||[]);
  if(_ui)clearInterval(_ui);
  _ui=setInterval(function(){_ut++;document.getElementById('s-uptime').textContent='up '+fu(_ut);},1000);
  document.getElementById('s-uptime').textContent='up '+fu(_ut);
}

render();
setInterval(render,15000);
window.addEventListener('resize',function(){fetch('/stats').then(function(r){return r.json();}).then(function(d){if(d)drawChart(d.hourly||Array(24).fill(0));});});

// ── yt-dlp update ──────────────────────────────────────────────────────────
async function updateYtDlp() {
  const btn = document.getElementById('ytdlp-update-btn');
  const log = document.getElementById('ytdlp-update-log');
  btn.disabled = true;
  btn.textContent = 'updating…';
  log.textContent = '';
  log.style.display = 'block';

  try {
    const res  = await fetch('/api/update-ytdlp', { method: 'POST' });
    const data = await res.json();
    log.textContent = data.output || data.error || 'done';
    log.style.color = data.ok ? 'var(--ok)' : 'var(--err)';
    btn.textContent = data.ok ? '✓ updated' : '✗ failed';
  } catch(e) {
    log.textContent = e.message;
    log.style.color = 'var(--err)';
    btn.textContent = '✗ failed';
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'Update yt-dlp'; }, 3000);
  }
}