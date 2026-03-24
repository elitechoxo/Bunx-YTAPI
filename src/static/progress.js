var _filter='all',_jobs=[],_iv=null;
function fd(ms){return ms<1000?ms+'ms':(ms/1000).toFixed(1)+'s';}
function ft(ms){var s=Math.floor(ms/1000),m=Math.floor(s/60),sc=s%60;return m>0?m+'m '+sc+'s':sc+'s';}
function setF(f,btn){
  _filter=f;document.querySelectorAll('.f-btn').forEach(function(b){b.classList.remove('active');});btn.classList.add('active');renderList(_jobs);
}
async function deleteJob(id){
  if(!confirm('Delete job + file for '+id+'?'))return;
  await fetch('/api/jobs/'+id,{method:'DELETE'}).catch(function(){});render();
}
async function clearDone(){
  var done=_jobs.filter(function(j){return j.status==='ready'||j.status==='error';});
  if(!done.length)return;
  await Promise.all(done.map(function(j){return fetch('/api/jobs/'+j.id,{method:'DELETE'}).catch(function(){});}));render();
}
function jobHTML(j){
  var ip=j.status==='processing',ir=j.status==='ready',ie=j.status==='error';
  var badge=ip?'<span class="badge badge-proc"><span class="spinner"></span> processing</span>':ir?'<span class="badge badge-ok">ready</span>':'<span class="badge badge-err">error</span>';
  var actions='';
  if(ir&&j.file_url)actions+='<a href="'+j.file_url+'" class="btn btn-secondary btn-xs">⬇</a>';
  actions+='<button class="btn btn-danger btn-xs" onclick="deleteJob(\''+j.id+'\')">✕</button>';
  var meta='<span>'+badge+'</span><span class="t-dim">'+j.id+'</span><span class="t-dim">'+ft(j.elapsed||0)+'</span>';
  if(ie&&j.error)meta+='<span class="t-err" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+j.error+'">'+j.error+'</span>';
  if(ir&&j.file_url)meta+='<a href="'+j.file_url+'" class="t-ok" style="font-size:.7rem;text-decoration:none;font-family:var(--fm);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block" title="'+j.file_url+'">'+j.file_url+'</a>';
  var bar=ip?'<div class="progress-bar"><div class="progress-fill"></div></div>':'';
  return '<div class="job-card '+j.status+' fade-in"><div style="min-width:0"><div class="job-title">'+(j.title||j.id)+'</div><div class="job-meta">'+meta+'</div>'+bar+'</div><div class="job-actions">'+actions+'</div></div>';
}
function renderList(jobs){
  var list=document.getElementById('job-list');
  var f=_filter==='all'?jobs:jobs.filter(function(j){return j.status===_filter;});
  if(!f.length){list.innerHTML='<div class="empty"><div class="empty-icon">∅</div>'+(jobs.length?'No '+_filter+' jobs':'No jobs yet')+'</div>';return;}
  list.innerHTML=f.map(jobHTML).join('');
}
function updateCounts(jobs){
  var proc=jobs.filter(function(j){return j.status==='processing';}).length;
  var ready=jobs.filter(function(j){return j.status==='ready';}).length;
  var err=jobs.filter(function(j){return j.status==='error';}).length;
  document.getElementById('j-total').textContent=jobs.length;
  document.getElementById('j-proc').textContent=proc;
  document.getElementById('j-ready').textContent=ready;
  document.getElementById('j-err').textContent=err;
  document.getElementById('fc-all').textContent=jobs.length;
  document.getElementById('fc-proc').textContent=proc;
  document.getElementById('fc-ready').textContent=ready;
  document.getElementById('fc-err').textContent=err;
}
async function render(){
  try{var r=await fetch('/api/jobs');_jobs=await r.json();}catch{return;}
  updateCounts(_jobs);renderList(_jobs);
  var hasProc=_jobs.some(function(j){return j.status==='processing';});
  if(hasProc&&!_iv){_iv=setInterval(render,3000);}else if(!hasProc&&_iv){clearInterval(_iv);_iv=null;}
}
render();setInterval(render,10000);
