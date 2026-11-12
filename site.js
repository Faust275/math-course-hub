

/* ---------- window.WB_STORAGE: 纯前端零外部依赖 IndexedDB + LocalStorage 双模持久化引擎 ---------- */
window.WB_STORAGE = (function() {
  var DB_NAME = 'wb_course_notes_db';
  var DB_VERSION = 1;
  var STORE_NAME = 'user_annotations';
  var db = null;
  var mem = {};
  var raw = null;
  try { raw = window.localStorage; } catch(e) { raw = null; }

  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('wb_') === 0) {
        mem[k] = raw.getItem(k);
      }
    }
  } catch(e) {}

  if (window.indexedDB) {
    try {
      var req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function(e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = function(e) {
        db = e.target.result;
        try {
          var tx = db.transaction(STORE_NAME, 'readonly');
          var st = tx.objectStore(STORE_NAME);
          var cursorReq = st.openCursor();
          cursorReq.onsuccess = function(evt) {
            var cursor = evt.target.result;
            if (cursor) {
              if (cursor.value && cursor.value.key) {
                mem[cursor.value.key] = cursor.value.val;
              }
              cursor.continue();
            }
          };
        } catch(err) {}
      };
    } catch(err) {}
  }

  return {
    getItem: function(key) {
      if (key in mem) return mem[key];
      try { return raw ? raw.getItem(key) : null; } catch(e) { return null; }
    },
    setItem: function(key, val) {
      var s = String(val);
      mem[key] = s;
      try {
        if (raw) raw.setItem(key, s);
      } catch(quotaErr) {
        console.warn('[WB_STORAGE] LocalStorage 已满，正在通过 IndexedDB 持久化存储:', quotaErr);
      }
      if (db) {
        try {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          var st = tx.objectStore(STORE_NAME);
          st.put({ key: key, val: s, time: Date.now() });
        } catch(e) {}
      }
    },
    removeItem: function(key) {
      delete mem[key];
      try { if (raw) raw.removeItem(key); } catch(e) {}
      if (db) {
        try {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          var st = tx.objectStore(STORE_NAME);
          st.delete(key);
        } catch(e) {}
      }
    },
    exportAllNotes: function() {
      var out = { export_time: new Date().toISOString(), notes: {} };
      for (var k in mem) {
        if (k.indexOf('wb_hl_') === 0 || k.indexOf('wb_note_') === 0 || k.indexOf('wb_scroll_') === 0) {
          try { out.notes[k] = JSON.parse(mem[k]); } catch(e) { out.notes[k] = mem[k]; }
        }
      }
      return JSON.stringify(out, null, 2);
    }
  };
})();


/* 课程汇总站 · 共用逻辑。依赖 window.SITE (data/core.js)，节页另加载 data/lecture-*.js */
var SITE = window.SITE || {courses:[],lectures:[],docs:[],images:[],fullShards:{}};
var $ = function(s){return document.querySelector(s)};
var esc = function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
var lower = function(s){return String(s||'').toLowerCase()};
var cname = function(id){var c=SITE.courses.filter(function(x){return x.id===id})[0];return c?c.name:id};
var lname = function(id){var l=SITE.lectures.filter(function(x){return x.id===id})[0];return l?l.title:id};
var modes = {'原述':true,'补全':true,'推测':true};
var tab = 'timeline', seq = 0, fullLoaded = {}, fullBusy = false;

/* ---------- 检索：核心索引即时命中 + 按课摘要倒排按需补充 ---------- */
function grams(q){
  var s = lower(q).replace(/\s+/g,''), out = [];
  var toks = s.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) || [];
  toks.forEach(function(t){
    if(/^[a-z0-9_]+$/.test(t)){ out.push(t); if(t.length>3){for(var i=0;i<t.length-1;i++)out.push(t.substr(i,2))} }
    else { if(t.length===1) out.push(t); for(var j=0;j<t.length-1;j++) out.push(t.substr(j,2)); }
  });
  return out.filter(function(x,i,a){return a.indexOf(x)===i});
}
function ensureFull(cb){
  var keys = Object.keys(SITE.fullShards||{}).filter(function(k){return !fullLoaded[k]});
  if(!keys.length){ cb&&cb(); return; }
  var left = keys.length;
  keys.forEach(function(k){
    var s = document.createElement('script');
    s.src = SITE.fullShards[k];
    s.onload = s.onerror = function(){ fullLoaded[k]=true; if(--left===0){fullBusy=false;cb&&cb()} };
    document.head.appendChild(s);
  });
}
function docLine(d){
  return {t:d[0],c:d[1],l:d[2],time:d[3],title:d[4],snip:d[5],url:d[6],badge:d[7]||'原述'};
}
function collect(q, deep){
  var ql = lower(q), hit = {}, g = grams(q);
  /* 时间戳查询：01:14 / 01:14:30 这类，对 time 字段做精确/前缀匹配并加权（借鉴参考站的「搜时间戳」） */
  var ts = ql.match(/^(\d{1,2}:)?\d{1,2}:\d{1,2}$/);
  /* 例题查询：例3 / 例题3 / 证明2 这类，对例题条目加权 */
  var ex = ql.match(/^(例\s*\d+|证明\s*\d+|例题\s*\d+)/);
  SITE.docs.forEach(function(d,i){
    var o = docLine(d), score = 0;
    if(lower(o.title).indexOf(ql)>=0) score = 3;
    else if(lower(o.snip).indexOf(ql)>=0) score = 2;
    else if(lower(cname(o.c)).indexOf(ql)>=0 || lower(lname(o.l)).indexOf(ql)>=0) score = 1;
    if(ts){
      var t = (o.time||'').replace(/[—–-]/g,':');
      if(t.indexOf(ql)>=0) score = Math.max(score, 4);
    }
    if(ex && o.t==='ex'){
      if(('例 '+lower(o.title)).indexOf(ql)>=0 || lower(o.title).indexOf(ql)>=0) score = Math.max(score, 4);
    }
    if(score) hit[i]=score;
  });
  if(deep && window.SITE_FULL){
    Object.keys(window.SITE_FULL).forEach(function(k){
      var inv = window.SITE_FULL[k].inv || {};
      if(!g.length) return;
      /* 宽松倒排：命中过半查询片段即收录，避免短查询过严 */
      var cnt = {};
      g.forEach(function(t){ (inv[t]||[]).forEach(function(id){cnt[id]=(cnt[id]||0)+1}) });
      Object.keys(cnt).forEach(function(id){
        if(cnt[id] >= Math.max(1,Math.ceil(g.length*0.5))) hit[id]=Math.max(hit[id]||0,1);
      });
    });
  }
  return Object.keys(hit).map(function(id){return {i:+id,score:hit[id],o:docLine(SITE.docs[+id]||['','','','','','','',''])};})
    .filter(function(x){return x.o.t})
    .sort(function(a,b){return b.score-a.score || a.i-b.i});
}
function hl(s,q){
  s = esc(s); q = lower(q).trim();
  if(!q) return s;
  var i = lower(s).indexOf(esc(q));
  if(i<0) return s;
  return s.slice(0,i)+'<mark>'+s.slice(i,i+esc(q).length)+'</mark>'+s.slice(i+esc(q).length);
}
function showSearch(q){
  var p = $('#panel');
  if(!q){ p.style.display='none'; p.innerHTML=''; return; }
  var my = ++seq;
  var draw = function(deep,loading){
    if(my!==seq) return;
    var r = collect(q,deep), lim = r.slice(0,40);
    var h = '<h4><span>检索「'+esc(q)+'」 · '+r.length+' 条命中</span><span>'+
      (loading?'正在加载全文索引…':(deep?'含摘要全文':'结构索引'))+'</span></h4>';
    if(!lim.length) h += '<div class="empty">结构索引无命中，'+(loading?'正在查摘要全文…':'试试更短的关键词')+'</div>';
    lim.forEach(function(x){
      var o=x.o;
      h += '<a class="res" href="'+esc(o.url)+'"><div class="r1">'+hl(o.title,q)+
        ' <span class="tag '+(o.t==='img'?'blue':'')+'">'+esc({sec:'小节',ex:'例题',ch:'章',lec:'节',img:'图版',pre:'速览'}[o.t]||o.t)+'</span>'+
        (o.badge!=='原述'?'<span class="badge b-'+o.badge+'">'+o.badge+'</span>':'')+'</div>'+
        '<div class="r2"><span class="time">'+esc(o.time)+'</span> ｜ '+esc(cname(o.c))+' › '+esc(lname(o.l))+
        (o.snip?'<br>'+hl(o.snip.slice(0,90),q):'')+'</div></a>';
    });
    p.innerHTML=h; p.style.display='block';
  };
  draw(false,true);
  ensureFull(function(){ draw(true,false) });
}
/* 搜索框只在首页/课程页存在；作业页等也引了 site.js，取不到节点就跳过，
   否则 addEventListener 会抛异常，把后面的脚本一起弄死 */
var qEl = $('#q');
if(qEl){
  qEl.addEventListener('input',function(e){showSearch(e.target.value.trim())});
  qEl.addEventListener('focus',function(e){if(e.target.value.trim())showSearch(e.target.value.trim())});
  document.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();qEl.focus()}
    if(e.key==='Escape'){qEl.value='';var pp=$('#panel');if(pp)pp.style.display='none'}
  });
}
document.addEventListener('click',function(e){
  if(e.target.closest('#panel')||e.target.closest('#q')||e.target.closest('.searchbox'))return;
  var p=$('#panel'); if(p)p.style.display='none';
});

/* ---------- 页头 ---------- */
function crumb(){
  var h='<a href="index.html">首页</a>';
  if(PAGE.kind==='course') h+=' <span>›</span> <b>'+esc(cname(PAGE.id))+'</b>';
  if(PAGE.kind==='lecture'){
    var L=window.SITE_LECTURE||{};
    h+=' <span>›</span> <a href="course-'+esc(L.course||'')+'.html">'+esc(cname(L.course))+'</a>'+
       ' <span>›</span> <b>'+esc(L.title||'')+'</b>';
  }
  $('#crumb').innerHTML=h;
}

/* ---------- 首页：四门课并列 ---------- */
function home(){
  var ls=SITE.lectures, n=ls.length;
  var h='<h1>课程讲义汇总</h1><p class="sub">五门课并列：四门课堂讲义课 + 英语（教材精读与词表）。每门课点进去看节次，每节点进去直接阅读该节讲义全文（含全部公式与例题的完整推导）；顶部检索框可跨课搜索任意概念。</p>';
  h+='<div class="stats">'+
    '<div class="stat"><b>'+SITE.courses.length+'</b><span>门课程</span></div>'+
    '<div class="stat"><b>'+n+'</b><span>节已导入</span></div>'+
    '<div class="stat"><b>'+SITE.docs.length+'</b><span>可检索条目</span></div>'+
    '<div class="stat"><b>'+ls.reduce(function(a,l){return a+(l.examples||0)},0)+'</b><span>例题 / 证明</span></div>'+
    '<div class="stat"><b>'+SITE.images.length+'</b><span>图版 / 板书</span></div></div><div class="grid4">';
  SITE.courses.forEach(function(c){
    var mine=ls.filter(function(l){return l.course===c.id});
    var pct=c.expectNum?Math.min(100,Math.round(mine.length/c.expectNum*100)):0;
    h+='<div class="card" data-go="course-'+esc(c.id)+'.html">'+
      '<h3>'+esc(c.name)+'</h3><div class="cd">'+esc(c.desc)+'</div>'+
      '<div class="cnum">'+mine.length+' <small>/ 预计 '+esc(c.expect)+' 节</small></div>'+
      '<div class="bar"><i style="width:'+pct+'%"></i></div>'+
      '<span class="tag '+(mine.length?'ok':'wait')+'">'+(mine.length?'已导入 '+mine.length+' 节':'材料待导入')+'</span>'+
      '<span class="tag blue">'+esc(c.render)+'</span>'+
      (c.images?'<span class="tag">含图片讲义</span>':'')+
      '<div class="cd" style="margin-top:10px;font-size:11.5px">'+esc(c.materials)+'</div></div>';
  });
  h+='<div class="card" data-go="english.html">'
    +'<h3>英语</h3><div class="cd">Exploring the Frontier：课文精读 + 词表，逐句、逐词可回听</div>'
    +'<div class="cnum">8 <small>/ 4 个单元 × 2 篇</small></div>'
    +'<span class="tag ok">已导入 8 篇</span>'
    +'<span class="tag blue">音频 / 音标 / 释义</span>'
    +'<div class="cd" style="margin-top:10px;font-size:11.5px">课本配套音频 + 人工音标释义；拼写待照片核对</div></div>';
  h+='</div><div class="notice" style="margin-top:20px"><b>关于离线</b>：整个文件夹可直接双击 <code>index.html</code> 使用，不用装软件、不用联网、不用敲命令；检索索引是构建期生成好的本地文件，用普通脚本加载，因此不受浏览器本地文件限制。后续加课只要把材料放进 <code>content/</code> 再跑一次构建。</div>';
  return h;
}

/* ---------- 课程页 ---------- */

window.goToLecture = function(lid) {
  if (lid) location.href = 'lecture-' + lid + '.html?resume=1';
};
window.switchCourseTab = function(t) {
  window._courseTab = t;
  render();
};

function courseView(){
  var c=SITE.courses.filter(function(x){return x.id===PAGE.id})[0]||{};
  var mine=SITE.lectures.filter(function(l){return l.course===PAGE.id});
  var hw_mine=(SITE.homework||[]).filter(function(h){return h.course===PAGE.id});
  var tb_mine=(SITE.textbooks||[]).filter(function(b){return b.course===PAGE.id});

  var h='<h1>'+esc(c.name)+'</h1><p class="sub">'+esc(c.desc)+' · 预计 '+esc(c.expect)+' 节 · 已录入 '+tb_mine.length+' 本核心教材 · 已导入 '+mine.length+' 节讲义 · '+(hw_mine.length)+' 周作业 ｜ 渲染规则：'+esc(c.render)+'</p>';
  var lastRead = null;
  try { lastRead = JSON.parse((window.WB_STORAGE||localStorage).getItem('wb_last_read') || 'null'); } catch(e){}
  if (lastRead && lastRead.course === PAGE.id) {
    h += '<div class="last-read-card" data-lid="' + esc(lastRead.lid) + '" onclick="goToLecture(this.dataset.lid)">' +
         '<div class="lr-title">📖 <b>继续本课阅读</b>：' + esc(lastRead.title || '') + '</div>' +
         '<div class="lr-meta">已读 ' + (lastRead.progress || 0) + '% ｜ 点击直达 ➔</div>' +
         '</div>';
  }

  h+='<div class="notice"><b>本课材料形态</b>：'+esc(c.materials)+
     (c.images?'<br><b>图片</b>：讲义插图与板书照片会复制进站内 <code>assets/</code>，按时间戳挂到对应小节，并进入检索索引。':'')+
     '<br><b>字幕可信度</b>：'+esc(c.trust)+'</div>';

  var curTab = window._courseTab || (new URLSearchParams(location.search).get('tab')) || 'lectures';
  var hwObjective = hw_mine.some(function(x){ return !!x.objective; });
  var hwTabLabel = hwObjective ? ('📝 作业 (' + hw_mine.length + ' 次)')
                               : ('📝 每周作业 (' + hw_mine.length + ' 周)');
  h += '<div class="wb-course-tabs" style="display:flex;gap:10px;margin:20px 0 16px;border-bottom:2px solid var(--border);padding-bottom:12px;flex-wrap:wrap;">' +
       '<button class="btn ' + (curTab==='textbook'?'on':'ghost') + '" data-tab="textbook" onclick="switchCourseTab(this.dataset.tab)">📖 核心教材 (' + tb_mine.length + ' 本)</button>' +
       '<button class="btn ' + (curTab==='lectures'?'on':'ghost') + '" data-tab="lectures" onclick="switchCourseTab(this.dataset.tab)">📑 课堂讲义 (' + mine.length + ' 节)</button>' +
       '<button class="btn ' + (curTab==='homework'?'on':'ghost') + '" data-tab="homework" onclick="switchCourseTab(this.dataset.tab)">' + hwTabLabel + '</button>' +
       '</div>';

  if (curTab === 'textbook') {
    if (!tb_mine.length) {
      h += '<div class="placeholder">本学科核心教材正在整理录入中。</div>';
    } else {
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;margin-top:14px;">';
      tb_mine.forEach(function(b){
        h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:var(--shadow);">' +
             '<div>' +
             '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
             '<span class="tag ok" style="font-size:12px;">已文本化纯净阅读</span>' +
             '<span style="font-size:12px;color:var(--muted);">' + esc(b.edition) + '</span>' +
             '</div>' +
             '<h3 style="margin:0 0 6px;font-size:17px;font-weight:700;">' + esc(b.title) + '</h3>' +
             '<div style="font-size:13px;color:var(--accent);margin-bottom:10px;font-weight:500;">' + esc(b.author) + ' 著 ｜ ' + esc(b.publisher) + '</div>' +
             '<p style="font-size:13px;color:var(--text);line-height:1.6;margin-bottom:14px;">' + esc(b.desc) + '</p>' +
             '<div style="background:var(--surface2);border-radius:8px;padding:10px;margin-bottom:14px;max-height:160px;overflow-y:auto;font-size:12.5px;">' +
             '<b style="color:var(--muted);display:block;margin-bottom:6px;">章节目录 (' + b.chapter_count + ' 章)：</b>';
        b.chapters.forEach(function(ch){
          h += '<div style="margin-bottom:4px;"><a href="textbook-' + esc(b.id) + '-' + esc(ch.id) + '.html" style="color:var(--text);text-decoration:none;"><span style="color:var(--accent);font-weight:600;">第 ' + esc(ch.ch_num) + ' 章</span> ｜ ' + esc(ch.title) + '</a></div>';
        });
        h += '</div></div>' +
             '<div style="display:flex;gap:10px;">' +
             '<a class="btn on" style="flex:1;text-align:center;" href="' + esc(b.first_chapter) + '">📖 开始阅读第一章</a>' +
             '</div>' +
             '</div>';
      });
      h += '</div>';
    }
  } else if (curTab === 'homework') {
    if (!hw_mine.length) {
      h += '<div class="placeholder">这一门课的每周作业还在整理录入中。<br>后续把作业文件放进 <code>content/' + esc(c.id) + '/homework/</code> 后重新运行构建，作业列表与自测解析会自动在此展示。</div>';
    } else {
      hw_mine.forEach(function(hw){
        var isObj = !!hw.objective;
        var ln = isObj ? (esc(hw.seq_label || ('第 ' + hw.seq + ' 次作业')) + ' ｜ ' + esc(hw.title))
                       : ('第 ' + String(hw.week).padStart(2, '0') + ' 周作业 ｜ ' + esc(hw.title));
        var lm = isObj
          ? (esc(hw.coverage || '') + ' ｜ 共 ' + (hw.required_count||0) + ' 题 ｜ 判断/选择自测')
          : (esc(hw.coverage || '') + ' ｜ 题量：' + (hw.required_count||0) + ' 道必做 · ' + (hw.optional_count||0) + ' 道选做 ｜ 发布：' + esc(hw.publish_date || '—') + ' ｜ 截止：' + esc(hw.due_date || '—'));
        h += '<a class="lrow" href="homework-' + esc(hw.id) + '.html"><div class="lt"><div class="ln">' + ln +
             '</div><div class="lm">' + lm + '</div></div>' +
             '<span class="tag ok">' + (isObj ? '可自测' : '含自测解析') + '</span>' +
             '<span class="time">' + ((hw.required_count||0) + (hw.optional_count||0)) + ' 题</span></a>';
      });
    }
  } else {
    if (!mine.length) {
      h += '<div class="placeholder">这一门课还没有导入任何讲义。<br>请按照 <code>content/' + esc(c.id) + '/</code> 下的目录结构，放进 <code>full.html</code> / <code>handout.md</code> 后重新运行 <code>python build_site.py</code> 即可。</div>';
    } else {
      mine.forEach(function(l){
        h += '<a class="lrow" href="lecture-' + esc(l.id) + '.html"><div class="lt"><div class="ln">' + esc(l.title) +
             '</div><div class="lm">' + esc(l.session) + ' ｜ 授课 ' + esc(l.teacher||'—') + ' ｜ ' + esc(l.duration||'—') + ' ｜ ' +
             l.sections + ' 个小节 · ' + l.examples + ' 个例题 · ' + l.images + ' 张板书图</div></div>' +
             '<span class="tag ' + (l.status==='ready'?'ok':'warn') + '">' + esc(l.status) + '</span>' +
             '<span class="time">' + esc(l.date) + '</span></a>';
      });
    }
  }
  return h;
}

/* ---------- 节页 ---------- */
function leftTree(){
  var L=window.SITE_LECTURE||{}, h='<h4>全部课程</h4><div class="tree">';
  SITE.courses.forEach(function(c){
    h+='<div class="'+(c.id===L.course?'on':'muted')+'" data-go="course-'+esc(c.id)+'.html">'+esc(c.name);
    SITE.lectures.filter(function(l){return l.course===c.id}).forEach(function(l){
      h+='<div class="'+(l.id===L.id?'on':'muted')+'" data-go="lecture-'+esc(l.id)+'.html">'+esc(l.title)+'</div>';
    });
    h+='</div>';
  });
  return h+'</div>';
}
function rightToc(L){
  var h='<h4>节内目录</h4><div class="toc">';
  (L.chapters||[]).forEach(function(c,i){
    h+='<b>'+esc(c.title)+'</b>';
    (c.sections||[]).slice(0,4).forEach(function(s){h+='<a href="#c'+i+'">'+esc(s.title.slice(0,17))+'</a>'});
    if((c.sections||[]).length>4)h+='<a href="#c'+i+'" style="color:var(--accent)">… 其余 '+((c.sections||[]).length-4)+' 小节</a>';
  });
  h+='<b>附录</b>';
  (L.appendices||[]).forEach(function(a){h+='<a>'+esc(a.code)+' '+esc((a.title||'').slice(0,14))+'</a>'});
  h+='<b>来源与材料</b><a>原述 / 补全 / 推测 可过滤</a><a>图版与板书按时间戳挂载</a>';
  return h+'</div>';
}
function figBlock(L,sec){
  var imgs=(L.images||[]).filter(function(x){return !sec||x.sec===sec.time});
  if(!imgs.length)return '';
  var h='<details class="fig"><summary>图版 / 板书原图 · '+imgs.length+' 张（点开核对）</summary><div class="fb">';
  imgs.forEach(function(x){
    h+='<div style="max-width:46%"><img loading="lazy" src="'+esc(x.src)+'" alt="'+esc(x.caption)+'"><div class="sm">'+
       '<span class="time">'+esc(x.time)+'</span> '+esc(x.caption)+'</div><a href="'+esc(x.src)+'" target="_blank">查看原图 ↗</a></div>';
  });
  return h+'</div></details>';
}
function lectureView(){
  var L=window.SITE_LECTURE||{chapters:[],appendices:[],images:[]};
  var h='<h1>'+esc(cname(L.course))+' · '+esc(L.title)+'</h1><p class="sub">授课 '+esc(L.teacher||'—')+
    ' ｜ 时长 '+esc(L.duration||'—')+' ｜ '+(L.lines||0)+' 条字幕 ｜ '+(L.nchapters||0)+' 章 ｜ '+(L.sections||0)+' 小节 ｜ '+(L.examples||0)+' 例题</p>';
  h+='<div class="lay"><div class="pane">'+leftTree()+'</div><div>';
  h+='<div class="tools">'+
    '<button class="btn '+(tab==='timeline'?'on':'')+'" data-act="tab" data-v="timeline">时间轴视图</button>'+
    '<button class="btn '+(tab==='block'?'on':'')+'" data-act="tab" data-v="block">知识板块视图</button>'+
    '<span style="width:10px"></span>'+
    ['原述','补全','推测'].map(function(m){return '<button class="btn '+(modes[m]?'on':'')+'" data-act="mode" data-v="'+m+'">'+m+'</button>'}).join('')+
    '<a class="btn ghost" href="'+esc(L.full||'#')+'" target="_blank">打开完整讲义 ↗</a></div>';
  h+='<div class="notice">来源三态：无标记＝老师当堂讲的；<b>补全</b>＝整理者按标准数学补齐、不是板书；<b>推测</b>＝考点与复习优先级推断。关掉「补全」「推测」即可只看当堂内容。<br>'+
     '本节图版与板书照片按时间戳折叠挂在对应小节，默认收起；没有照片的小节不显示该区。</div>';
  if((L.prelude||[]).length){
    h+='<details class="chap" style="margin-bottom:14px"><summary><span>卷首速览 · '+L.prelude.length+
       ' 项</span><span class="time">讲义导读</span></summary><div class="items">';
    L.prelude.forEach(function(p){
      h+='<div class="item"><span class="txt"><b style="font-size:12.5px">'+esc(p.title)+
         '</b><span class="sm">'+esc(p.summary)+'</span></span></div>';
    });
    h+='</div></details>';
  }
  h+='<div class="chap" style="padding:11px 15px;margin-bottom:14px"><b style="font-size:12.5px">随堂材料</b><div class="mat">'+
     Object.keys(L.materials||{}).map(function(k){return '<span class="tag '+(L.materials[k]?'ok':'wait')+'">'+esc(k)+(L.materials[k]?' 已导入':' 待导入')+'</span>'}).join('')+
     '<span class="tag blue">'+(L.images||[]).length+' 张图版</span></div></div>';
  if(tab==='block'){
    h+='<div class="grid">';
    (L.chapters||[]).forEach(function(c){
      h+='<div class="card" data-act="jump" data-v="'+esc(c.idx)+'"><h3>'+esc(c.title)+'</h3>'+
        '<p class="cd">'+(c.sections||[]).length+' 小节 · '+(c.examples||[]).length+' 例题</p>'+
        '<span class="time">'+esc(c.time)+'</span></div>';
    });
    h+='</div><p class="sub" style="margin-top:14px">知识板块视图由讲义附录「按知识板块反查」结构化而来；点卡片跳回时间轴对应章。</p>';
  }else{
    (L.chapters||[]).forEach(function(c,i){
      var secs=(c.sections||[]).filter(function(s){return modes[s.badge||'原述']});
      var exs=(c.examples||[]).filter(function(e){return modes[e.badge||'原述']});
      h+='<details class="chap" id="c'+i+'" '+(i===0?'open':'')+'><summary><span>'+esc(c.title)+
        '</span><span class="time">'+esc(c.time)+' ｜ '+secs.length+' 小节 · '+exs.length+' 例题</span></summary><div class="items">';
      secs.forEach(function(s){
        h+='<div class="item"><span class="time">'+esc((s.time||'').slice(0,5))+'</span><span class="txt">'+esc(s.title)+
          '<span class="sm">'+esc(s.summary)+'</span>'+figBlock(L,s)+'</span>'+
          '<span class="badge b-'+(s.badge||'原述')+'">'+(s.badge||'原述')+'</span></div>';
      });
      if(exs.length){
        h+='<div style="margin:10px 0 4px;font-size:11.5px;color:var(--muted)">例题 / 证明</div>';
        exs.forEach(function(e){h+='<div class="item"><span class="time">'+esc((e.time||'').slice(0,5))+
          '</span><span class="txt">例 '+e.no+'　'+esc(e.title)+'</span><span class="badge">'+(e.badge||'原述')+'</span></div>'});
      }
      h+='</div></details>';
    });
  }
  h+='</div><div class="pane">'+rightToc(L)+'</div></div>';
  return h;
}

function markSubj(){
  var sn=document.getElementById('subjnav'); if(!sn) return;
  var cur = PAGE.kind==='course' ? PAGE.id
          : (PAGE.kind==='lecture' && window.SITE_LECTURE ? window.SITE_LECTURE.course : '');
  [].forEach.call(sn.children,function(a){
    a.classList.toggle('on', a.getAttribute('href')==='course-'+cur+'.html');
  });
}
function render(){
  crumb();
  $('#app').innerHTML = PAGE.kind==='home'?home():PAGE.kind==='course'?courseView():lectureView();
  markSubj();
}
/* 首页/课程页专用：作业页、英语页也引了 site.js，没有 #app 就整段跳过 */
var appEl = $('#app');
if(appEl){
appEl.addEventListener('click',function(e){
  var g=e.target.closest('[data-go]');
  if(g){location.href=g.dataset.go;return}
  var t=e.target.closest('[data-act]');
  if(!t)return;
  if(t.dataset.act==='tab')tab=t.dataset.v;
  if(t.dataset.act==='mode')modes[t.dataset.v]=!modes[t.dataset.v];
  if(t.dataset.act==='jump'){tab='timeline';render();var el=document.getElementById('c'+t.dataset.v);
    if(el){el.open=true;el.scrollIntoView({block:'start'})}return}
  render();
});
var brandEl = $('#brand');
if(brandEl) brandEl.addEventListener('click',function(){location.href='index.html'});
render();
}

var curTheme = (window.WB_STORAGE||localStorage).getItem('wb_theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function applySiteTheme(t) {
  if (window.wbSetTheme) window.wbSetTheme(t);   // 统一入口：同步 data-theme / 类名 / color-scheme
  document.documentElement.setAttribute('data-theme', t);
  if (t === 'dark') {
    document.documentElement.classList.add('wb-dark');
    document.documentElement.classList.remove('wb-light');
  } else {
    document.documentElement.classList.remove('wb-dark');
    document.documentElement.classList.add('wb-light');
  }
  (window.WB_STORAGE||localStorage).setItem('wb_theme', t);
  var btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = (t === 'dark' ? '☀️' : '🌙');
}
applySiteTheme(curTheme);
var tb = document.getElementById('theme-btn');
if (tb) tb.addEventListener('click', function(){
  curTheme = (document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  applySiteTheme(curTheme);
});

