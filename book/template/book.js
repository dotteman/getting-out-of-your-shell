(function(){
  /* ---------- bash highlighter (single-pass alternation, escape-safe) ---------- */
  var KW = ['if','then','else','elif','fi','for','while','until','do','done','case','esac',
            'function','return','local','in','select','time','coproc'];
  var CMDS = ['ls','cd','pwd','cat','less','more','head','tail','grep','egrep','sed','awk','find',
    'cp','mv','rm','mkdir','rmdir','touch','ln','chmod','chown','chgrp','sudo','su','echo','printf',
    'sort','uniq','cut','tr','wc','tee','xargs','which','whereis','type','file','stat','du','df',
    'ps','top','htop','kill','killall','pkill','pgrep','jobs','fg','bg','nohup','sleep','wait',
    'export','alias','unalias','source','history','env','set','unset','read','test','man','apropos',
    'tar','gzip','gunzip','zip','unzip','curl','wget','ssh','scp','rsync','ping','ip','ifconfig',
    'systemctl','journalctl','crontab','date','whoami','id','uname','df','mount','umount','diff',
    'basename','dirname','realpath','readlink','seq','yes','true','false','exit','trap','shift',
    'getopts','declare','mapfile','printenv','watch','tree','column','jq','nl','split','shuf','tac',
    'chsh','passwd','groups','umask','open','apt','yum','dnf','brew','git','python3','bash','sh'];
  var re = new RegExp([
    '^\\$ ',                                   // 1 prompt
    '#[^\\n]*',                                // 2 comment
    "'[^'\\n]*'",                              // 3 single-quoted
    '"(?:[^"\\\\\\n]|\\\\.)*"',                // 4 double-quoted
    '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$[0-9?#@*!$]', // 5 variable
    '(?:^|[\\s|(])--?[A-Za-z][A-Za-z0-9-]*',   // 6 option
    '\\b(?:' + KW.join('|') + ')\\b',          // 7 keyword
    '\\b(?:' + CMDS.join('|') + ')\\b'         // 8 command
  ].join('|'), 'gm');

  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function highlight(text){
    return esc(text).replace(re, function(m){
      if (m === '$ ')                        return '<span class="prompt">$ </span>';
      if (m.charAt(0) === '#')               return '<span class="com">'+m+'</span>';
      if (m.charAt(0) === "'" || m.charAt(0)==='"') return '<span class="str">'+m+'</span>';
      if (m.charAt(0) === '$')               return '<span class="var">'+m+'</span>';
      if (/^[\s|(]/.test(m))                 return m.charAt(0)+'<span class="opt">'+m.slice(1)+'</span>';
      if (m.charAt(0) === '-')               return '<span class="opt">'+m+'</span>';
      if (KW.indexOf(m) > -1)                return '<span class="kw">'+m+'</span>';
      return '<span class="cmd">'+m+'</span>';
    });
  }

  var blocks = document.querySelectorAll('pre > code');
  for (var i=0;i<blocks.length;i++){
    var c = blocks[i];
    var raw = c.textContent;
    if (!c.classList.contains('plain')) c.innerHTML = highlight(raw);
    var btn = document.createElement('button');
    btn.className = 'copy'; btn.type='button'; btn.textContent = 'copy';
    (function(btn, raw){
      btn.addEventListener('click', function(){
        var t = raw.split('\n').filter(function(l){return l.indexOf('$ ')===0 || !/^\s*(#|$)/.test(l) || true;})
                   .map(function(l){return l.replace(/^\$ /,'');}).join('\n');
        try{
          if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t); }
          else {
            var ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta);
            ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
          }
          btn.textContent='copied'; setTimeout(function(){btn.textContent='copy';},1200);
        }catch(e){ btn.textContent='select manually'; setTimeout(function(){btn.textContent='copy';},1500); }
      });
    })(btn, raw);
    c.parentNode.appendChild(btn);
  }

  /* ---------- build TOC from headings ---------- */
  var toc = document.getElementById('toc');
  var heads = document.querySelectorAll('main h2, main h3');
  var links = [];
  for (var j=0;j<heads.length;j++){
    var h = heads[j];
    if (!h.id){
      h.id = (h.textContent||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50) || ('s'+j);
    }
    var a = document.createElement('a');
    a.href = '#' + h.id;
    a.className = h.tagName === 'H2' ? 'lvl2' : 'lvl3';
    var num = h.querySelector('.chapnum');
    a.textContent = num ? (num.textContent.replace(/\s+/g,' ').trim() + ' — ' + h.textContent.replace(num.textContent,'').trim())
                        : h.textContent.trim();
    toc.appendChild(a);
    links.push({a:a, h:h});
  }

  /* ---------- scroll spy ---------- */
  var ticking = false;
  function spy(){
    var pos = window.scrollY + 90, cur = null;
    for (var k=0;k<links.length;k++){ if (links[k].h.offsetTop <= pos) cur = links[k]; }
    for (var m=0;m<links.length;m++) links[m].a.classList.remove('active');
    if (cur){
      cur.a.classList.add('active');
      var sb = document.getElementById('sidebar');
      var top = cur.a.offsetTop;
      if (top < sb.scrollTop || top > sb.scrollTop + sb.clientHeight - 60) sb.scrollTop = top - sb.clientHeight/2;
    }
    ticking = false;
  }
  window.addEventListener('scroll', function(){ if(!ticking){ ticking = true; requestAnimationFrame(spy);} });
  spy();

  /* ---------- mobile nav ---------- */
  var mb = document.getElementById('menubtn');
  mb.addEventListener('click', function(){ document.body.classList.toggle('nav-open'); });
  toc.addEventListener('click', function(e){ if(e.target.tagName==='A') document.body.classList.remove('nav-open'); });
})();
