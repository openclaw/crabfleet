export function css() {
  return `
:root{
  --ink:#0d0d0d;
  --text:#30313a;
  --muted:#6b7280;
  --subtle:#9ca3af;
  --bg:#f7f8fa;
  --paper:#ffffff;
  --paper-soft:#f9fafb;
  --accent:#e44861;
  --accent-soft:rgba(228,72,97,.1);
  --accent-strong:#c73b52;
  --blue:#0ea5e9;
  --green:#10b981;
  --amber:#f59e0b;
  --line:#e5e7eb;
  --line-soft:#eef0f3;
  --code-bg:#0f172a;
  --code-fg:#e6edf3;
  --code-inline-fg:#1c2128;
  --code-border:#1f2937;
  --pill-border:#dbe2eb;
  --shadow-card:0 4px 14px rgba(15,17,21,.08);
  --scrollbar:#cbd5e1;
  --hl-keyword:#7aa2ff;
  --hl-string:#9ece6a;
  --hl-number:#e0a96d;
  --hl-comment:#7c8597;
  --hl-flag:#c4a4ff;
  --hl-meta:#f08aa0;
  --hl-prompt:#64748b;
}
:root[data-theme="dark"]{
  --ink:#f2f2f5;
  --text:#c9c5cf;
  --muted:#918d98;
  --subtle:#5f5a66;
  --bg:#070a10;
  --paper:#100b0d;
  --paper-soft:#151016;
  --accent:#f05a70;
  --accent-soft:rgba(240,90,112,.16);
  --accent-strong:#ff8092;
  --blue:#3b82f6;
  --green:#34d399;
  --amber:#fbbf24;
  --line:#2a2630;
  --line-soft:#18131a;
  --code-bg:#06080d;
  --code-fg:#e6edf3;
  --code-inline-fg:#e6edf3;
  --code-border:#1c2030;
  --pill-border:#2a2f3c;
  --shadow-card:0 4px 18px rgba(0,0,0,.45);
  --scrollbar:#3a4154;
  --hl-keyword:#7aa2ff;
  --hl-string:#a6e3a1;
  --hl-number:#f0a868;
  --hl-comment:#6b7388;
  --hl-flag:#c4a4ff;
  --hl-meta:#ff8aa0;
  --hl-prompt:#7e8ba3;
}
:root{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:24px}
body{margin:0;background:radial-gradient(circle at 48% -8%,color-mix(in srgb,var(--accent) 12%,transparent),transparent 34rem),radial-gradient(circle at 86% 12%,color-mix(in srgb,var(--blue) 10%,transparent),transparent 30rem),var(--bg);color:var(--text);font-family:"Inter",ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.65;overflow-x:hidden;-webkit-font-smoothing:antialiased;font-feature-settings:"cv02","cv03","cv04","cv11";transition:background-color .18s,color .18s}
::selection{background:var(--accent);color:#fff}
a{color:var(--accent);text-decoration:none;transition:color .12s}
a:hover{text-decoration:underline;text-underline-offset:.2em}
.shell{display:grid;grid-template-columns:268px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 22px;background:color-mix(in srgb,var(--paper) 88%,transparent);border-right:1px solid var(--line);backdrop-filter:blur(18px);scrollbar-width:thin;scrollbar-color:var(--line) transparent;transition:background-color .18s,border-color .18s}
.sidebar::-webkit-scrollbar{width:6px}
.sidebar::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px}
.sidebar-head{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:11px;color:var(--ink);text-decoration:none;flex:1;min-width:0}
.brand:hover{text-decoration:none}
.brand .mark{flex:0 0 28px;width:28px;height:28px;border-radius:8px;display:block}
.brand strong{display:block;font-size:1.05rem;line-height:1.1;font-weight:600;letter-spacing:0;color:var(--ink)}
.brand small{display:block;color:var(--muted);font-size:.74rem;margin-top:3px;font-weight:400}
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:var(--paper-soft);color:var(--muted);cursor:pointer;padding:0;transition:border-color .15s,color .15s,background-color .15s,transform .12s}
.theme-toggle:hover{border-color:var(--ink);color:var(--ink)}
.theme-toggle:active{transform:scale(.94)}
.theme-toggle svg{width:16px;height:16px;display:block}
.theme-toggle .theme-icon-moon{display:block}
.theme-toggle .theme-icon-sun{display:none}
:root[data-theme="dark"] .theme-toggle .theme-icon-moon{display:none}
:root[data-theme="dark"] .theme-toggle .theme-icon-sun{display:block}
.search{display:block;margin:0 0 22px}
.search span{display:block;color:var(--muted);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0;margin-bottom:7px}
.search input{width:100%;border:1px solid var(--line);background:var(--paper-soft);border-radius:8px;padding:9px 12px;font:inherit;font-size:.9rem;color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s,background-color .18s}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
nav section{margin:0 0 18px}
nav h2{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0;margin:0 0 6px;font-weight:600}
.nav-link{display:block;color:var(--text);text-decoration:none;border-radius:6px;padding:5px 10px;margin:1px 0;font-size:.9rem;line-height:1.4;transition:background .12s,color .12s}
.nav-link:hover{background:var(--line-soft);color:var(--ink);text-decoration:none}
.nav-link.active{background:var(--accent-soft);color:var(--accent);font-weight:600}
main{min-width:0;padding:32px clamp(20px,4.5vw,56px) 80px;max-width:1180px;margin:0 auto;width:100%}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;border-bottom:1px solid var(--line);padding:8px 0 22px;margin-bottom:8px;flex-wrap:wrap}
.hero-text{min-width:0;flex:1 1 320px}
.eyebrow{margin:0 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0;font-size:.7rem}
.hero h1{font-size:2.25rem;line-height:1.1;letter-spacing:0;margin:0;font-weight:700;color:var(--ink)}
.hero-meta{display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap}
.repo,.edit,.btn-ghost{border:1px solid var(--line);color:var(--text);text-decoration:none;border-radius:7px;padding:6px 11px;font-weight:500;font-size:.83rem;background:var(--paper);transition:border-color .15s,color .15s,background .15s}
.repo:hover,.edit:hover,.btn-ghost:hover{border-color:var(--ink);color:var(--ink);text-decoration:none}
.edit{color:var(--muted)}
.home-hero{padding:14px 0 28px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.home-hero h1{font-size:3.25rem;line-height:1.04;letter-spacing:0;margin:0 0 .35em;font-weight:700;color:var(--ink)}
.home-hero .lede{font-size:1.18rem;line-height:1.55;color:var(--text);margin:0 0 1.2em;max-width:60ch}
.home-cta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 18px}
.home-cta .btn{display:inline-flex;align-items:center;gap:7px;border-radius:8px;padding:10px 16px;font-weight:600;font-size:.92rem;text-decoration:none;transition:background .15s,border-color .15s,color .15s,transform .12s}
.home-cta .btn-primary{background:var(--accent);color:#fff;border:1px solid var(--accent)}
.home-cta .btn-primary:hover{background:var(--accent-strong);border-color:var(--accent-strong);text-decoration:none}
.home-cta .btn-ghost{padding:10px 16px}
.home-install{display:flex;align-items:center;gap:12px;background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:10px 10px 10px 16px;font:500 .9rem/1.2 "JetBrains Mono","SF Mono",ui-monospace,monospace;max-width:38em;border:1px solid var(--code-border);box-shadow:0 18px 44px rgba(0,0,0,.18)}
.home-install .prompt{color:#64748b;user-select:none;flex:0 0 auto}
.home-install code{flex:1;background:transparent;border:0;color:var(--code-fg);font:inherit;padding:0;white-space:pre;overflow:hidden;text-overflow:ellipsis}
.home-install .copy{flex:0 0 auto;background:rgba(255,255,255,.08);color:var(--code-fg);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:5px 11px;font:500 .72rem/1 "Inter",sans-serif;cursor:pointer;transition:background .15s,border-color .15s}
.home-install .copy:hover{background:rgba(255,255,255,.16)}
.home-install .copy.copied{background:var(--accent);border-color:var(--accent)}
.home-services{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 18px}
.home-services span{display:inline-block;padding:3px 9px;border:1px solid var(--line);border-radius:999px;font-size:.78rem;color:var(--muted);background:var(--paper-soft)}
.doc-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:48px;margin-top:24px}
.doc-grid-home{margin-top:8px}
@media(min-width:1180px){.doc-grid{grid-template-columns:minmax(0,72ch) 200px;justify-content:start}.doc-grid-home{grid-template-columns:minmax(0,76ch);justify-content:start}}
.doc{min-width:0;max-width:72ch;overflow-wrap:break-word}
.doc-home{max-width:76ch}
.doc h1{font-size:2.6rem;line-height:1.08;letter-spacing:0;margin:0 0 .4em;font-weight:700;color:var(--ink)}
body:not(.home) .doc>h1:first-child{display:none}
.doc h2{font-size:1.45rem;line-height:1.2;margin:2em 0 .5em;font-weight:600;letter-spacing:0;color:var(--ink);position:relative}
.doc h3{font-size:1.1rem;margin:1.7em 0 .35em;position:relative;font-weight:600;color:var(--ink);letter-spacing:0}
.doc h4{font-size:.98rem;margin:1.4em 0 .25em;color:var(--ink);position:relative;font-weight:600}
.doc h2:first-child,.doc h3:first-child,.doc h4:first-child{margin-top:.2em}
.doc :is(h2,h3,h4) .anchor{position:absolute;left:-1.05em;top:0;color:var(--subtle);opacity:0;text-decoration:none;font-weight:400;padding-right:.3em;transition:opacity .12s,color .12s}
.doc :is(h2,h3,h4):hover .anchor{opacity:.7}
.doc :is(h2,h3,h4) .anchor:hover{opacity:1;color:var(--accent);text-decoration:none}
.doc p{margin:0 0 1.05em}
.doc ul,.doc ol{padding-left:1.3rem;margin:0 0 1.15em}
.doc li{margin:.25em 0}
.doc li>p{margin:0 0 .4em}
.doc strong{font-weight:600;color:var(--ink)}
.doc em{font-style:italic}
.doc code{font-family:"JetBrains Mono","SF Mono",ui-monospace,monospace;font-size:.84em;background:var(--line-soft);border:1px solid var(--line);border-radius:5px;padding:.08em .35em;color:var(--code-inline-fg)}
.doc pre{position:relative;overflow:auto;background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:14px 18px;margin:1.3em 0;font-size:.85em;line-height:1.6;scrollbar-width:thin;scrollbar-color:#334155 transparent;border:1px solid var(--code-border)}
.doc pre::-webkit-scrollbar{height:8px;width:8px}
.doc pre::-webkit-scrollbar-thumb{background:#334155;border-radius:8px}
.doc pre code{display:block;background:transparent;border:0;color:inherit;padding:0;font-size:1em;white-space:pre}
.doc pre .copy{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.06);color:var(--code-fg);border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:3px 9px;font:500 .7rem/1 "Inter",sans-serif;cursor:pointer;opacity:0;transition:opacity .15s,background .15s,border-color .15s}
.doc pre:hover .copy,.doc pre .copy:focus{opacity:1}
.doc pre .copy:hover{background:rgba(255,255,255,.12)}
.doc pre .copy.copied{background:var(--accent);border-color:var(--accent);opacity:1}
.doc pre .hl-c{color:var(--hl-comment);font-style:italic}
.doc pre .hl-s{color:var(--hl-string)}
.doc pre .hl-n{color:var(--hl-number)}
.doc pre .hl-k{color:var(--hl-keyword);font-weight:600}
.doc pre .hl-f{color:var(--hl-flag)}
.doc pre .hl-m{color:var(--hl-meta);font-weight:600}
.doc pre .hl-p{color:var(--hl-prompt);user-select:none}
.doc pre .hl-cmd{color:var(--hl-keyword);font-weight:600}
.doc blockquote{margin:1.4em 0;padding:10px 16px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 8px 8px 0;color:var(--text)}
.doc blockquote p:last-child{margin-bottom:0}
.doc table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:.92em}
.doc th,.doc td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}
.doc th{font-weight:600;color:var(--ink);background:var(--line-soft);border-bottom:1px solid var(--line)}
.doc hr{border:0;border-top:1px solid var(--line);margin:2.2em 0}
.toc{position:sticky;top:24px;align-self:start;font-size:.84rem;padding-left:14px;border-left:1px solid var(--line);max-height:calc(100vh - 48px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.toc::-webkit-scrollbar{width:5px}
.toc::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
.toc h2{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:0;margin:0 0 10px;font-weight:600}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:4px 0 4px 10px;line-height:1.35;border-left:2px solid transparent;margin-left:-12px;transition:color .12s,border-color .12s}
.toc a:hover{color:var(--ink);text-decoration:none}
.toc a.active{color:var(--accent);border-left-color:var(--accent);font-weight:500}
.toc-l3{padding-left:22px!important;font-size:.94em}
@media(max-width:1179px){.toc{display:none}}
.page-nav{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:48px;border-top:1px solid var(--line);padding-top:20px}
.page-nav>a{display:block;border:1px solid var(--line);background:var(--paper);border-radius:8px;padding:13px 16px;text-decoration:none;color:var(--text);transition:border-color .15s,transform .15s,box-shadow .15s,background-color .18s}
.page-nav>a:hover{border-color:var(--accent);text-decoration:none;color:var(--ink)}
.page-nav small{display:block;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:0;margin-bottom:5px;font-weight:600}
.page-nav span{display:block;font-weight:600;line-height:1.3;color:var(--ink)}
.page-nav-prev{text-align:left}
.page-nav-next{text-align:right;grid-column:2}
.page-nav-prev:only-child{grid-column:1}
.nav-toggle{display:none;position:fixed;top:14px;right:14px;top:calc(14px + env(safe-area-inset-top, 0px));right:calc(14px + env(safe-area-inset-right, 0px));z-index:20;width:40px;height:40px;border-radius:8px;background:var(--paper);border:1px solid var(--line);color:var(--ink);cursor:pointer;padding:10px 9px;flex-direction:column;align-items:stretch;justify-content:space-between;box-shadow:var(--shadow-card)}
.nav-toggle span{display:block;width:100%;height:2px;flex:0 0 2px;background:currentColor;border-radius:2px;transition:transform .2s,opacity .2s}
.nav-toggle[aria-expanded="true"] span:nth-child(1){transform:translateY(8px) rotate(45deg)}
.nav-toggle[aria-expanded="true"] span:nth-child(2){opacity:0}
.nav-toggle[aria-expanded="true"] span:nth-child(3){transform:translateY(-8px) rotate(-45deg)}
@media(max-width:900px){
  .shell{display:block}
  .sidebar{position:fixed;inset:0 30% 0 0;max-width:320px;height:100vh;z-index:15;transform:translateX(-100%);transition:transform .25s ease,background-color .18s,border-color .18s;box-shadow:0 18px 40px rgba(0,0,0,.18);background:var(--paper);pointer-events:none}
  .sidebar.open{transform:translateX(0);pointer-events:auto}
  .nav-toggle{display:flex}
  main{padding:64px 18px 56px}
  .hero{padding-top:6px}
  .hero h1{font-size:1.8rem}
  .home-hero h1{font-size:2.45rem}
  .doc h1{font-size:2.1rem}
  .hero-meta{width:100%;justify-content:flex-start}
  .home-hero{padding-top:8px}
  .doc{padding:0}
  .doc-grid{margin-top:18px;gap:24px}
  .doc :is(h2,h3,h4) .anchor{display:none}
}
@media(max-width:520px){
  main{padding:60px 14px 48px}
  .doc pre{margin-left:-14px;margin-right:-14px;border-radius:0;border-left:0;border-right:0}
  .home-install{flex-wrap:wrap}
}
:root{--ink:#202821;--text:#3e483e;--muted:#687267;--subtle:#737d71;--bg:#f5f3ec;--paper:#fffef9;--paper-soft:#efeee7;--accent:#b8442b;--accent-soft:#b8442b12;--accent-strong:#983520;--line:#d9ddd3;--line-soft:#eaece2;--code-bg:#19221d;--code-fg:#f3f2e9;--code-inline-fg:#202821;--code-border:#354238}
:root[data-theme="dark"]{--ink:#f3f2e9;--text:#c6cfc2;--muted:#a4b0a5;--subtle:#94a194;--bg:#141b18;--paper:#1c2520;--paper-soft:#242f28;--accent:#ed7255;--accent-soft:#ed72551a;--accent-strong:#f18b72;--line:#354238;--line-soft:#26342a;--code-bg:#111914;--code-fg:#f3f2e9;--code-inline-fg:#f3f2e9;--code-border:#354238}
body{background:var(--bg);font-family:"Trebuchet MS","Segoe UI",sans-serif;overflow-x:visible}
:is(a,button,input,summary):focus-visible{outline:3px solid var(--accent);outline-offset:4px}
.skip-link{position:fixed;top:-100px;left:16px;z-index:200;background:var(--paper);padding:12px 20px;border:1px solid var(--accent)}
.skip-link:focus{top:12px}
.brand strong{font-size:22px;letter-spacing:-.04em;font-weight:700}
.sidebar{background:var(--paper);backdrop-filter:none;padding-top:32px}
.sidebar .brand strong{font-size:20px}
.nav-link{padding-block:9px}
nav h2,.eyebrow{letter-spacing:.12em;font-family:ui-monospace,monospace;font-weight:500;font-size:10px}
.hero h1,.doc h1,.overview-heading h2{font-family:Georgia,"Times New Roman",serif;font-weight:400;letter-spacing:-.04em}
.hero h1{font-size:42px}
.doc h2{font-size:1.6rem;letter-spacing:-.035em;margin-top:2.2em}
.doc pre,.home-install{border-radius:10px;box-shadow:none}
.doc pre .copy,.home-install .copy{font-family:inherit;min-height:36px}
.theme-toggle{width:42px;height:42px}
.home .shell{display:block}
.home .sidebar,.home .nav-toggle{display:none}
.home main{max-width:1240px;padding:0 28px 72px}
.site-header{max-width:1240px;margin:0 auto;padding:24px 28px;display:flex;align-items:center;justify-content:space-between;gap:28px;border-bottom:1px solid var(--line)}
.site-header .brand{flex:0 1 auto}
.site-header .mark{width:34px;height:34px}
.site-header nav{display:flex;align-items:center;gap:26px}
.site-header nav>a{white-space:nowrap;color:var(--ink);font-size:13px;font-weight:600;display:inline-flex;align-items:center;min-height:44px}
.site-header nav .site-open{background:var(--ink);color:var(--paper);padding:0 17px;border-radius:7px;gap:20px}
.home-hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:62px;align-items:center;padding:92px 0 88px;margin:0;border:0}
.home-intro{min-width:0}
.home-hero .eyebrow{display:flex;gap:9px;align-items:center;color:var(--muted);font-size:10px;letter-spacing:.1em;margin-bottom:25px}
.status-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#4d9671;flex:none}
.home-hero h1{font:400 clamp(52px,5.6vw,76px)/1.02 Georgia,"Times New Roman",serif;letter-spacing:-.065em;margin:0 0 26px}
.home-hero h1 em{color:var(--accent);font-weight:400}
.home-hero .lede{font-size:17px;line-height:1.8;max-width:45ch;color:var(--muted);margin-bottom:28px}
.home-cta{gap:12px;margin-bottom:26px}
.home-cta .btn{min-height:48px;padding:11px 18px;border-radius:7px;gap:28px}
.home-cta .btn-primary{background:var(--accent);color:#fffdf7}
:root[data-theme="dark"] .home-cta .btn-primary{color:#192018}
.home-install{max-width:360px;padding:8px 8px 8px 16px;min-height:48px}
.home-install code{font-size:13px}
.home-caption{font-size:12px;color:var(--muted);margin-top:10px}
.desktop-preview{background:#1c2520;color:#f3f2e9;border:1px solid #354238;border-radius:16px;box-shadow:16px 24px 0 color-mix(in srgb,var(--accent) 9%,transparent);padding:22px;transform:rotate(2deg);position:relative}
.preview-top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #354238;padding-bottom:17px;gap:12px}
.preview-top>span:first-child{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.preview-top>span:last-child{font:8px ui-monospace,monospace;letter-spacing:.06em;color:#a4b0a5}
.preview-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:24px;font:28px Georgia,serif;letter-spacing:-.04em}
.preview-badge{font:10px ui-monospace,monospace;color:#9dd5b6;background:#76c79e13;border:1px solid #76c79e40;border-radius:30px;padding:6px 9px;letter-spacing:0}
.preview-count{padding:22px 0 16px;display:grid;gap:5px}
.preview-count strong{font-size:15px;font-weight:500}
.preview-count>span{font-size:11px;color:#a4b0a5}
.preview-session{display:flex;align-items:center;gap:12px;padding:15px 0;border-top:1px solid #354238}
.preview-avatar{width:32px;height:32px;display:grid;place-items:center;background:#28382d;border:1px solid #435247;border-radius:6px;font:11px ui-monospace,monospace;color:#a4b0a5}
.preview-session>div{display:grid;gap:4px}
.preview-session strong{font-size:12px;font-weight:500}
.preview-session div>span{font-size:10px;color:#a4b0a5}
.preview-session i{width:5px;height:5px;background:#76c79e;border-radius:50%;margin-left:auto}
.preview-note{background:#121a15;border:1px solid #354238;border-radius:8px;padding:14px;margin-top:6px;display:grid;gap:10px;font:10px/1.9 ui-monospace,monospace}
.preview-note>span{color:#a4b0a5;font-size:9px}
.preview-note p{margin:0;color:#c6cfc2;font:12px/1.7 "Trebuchet MS",sans-serif}
.preview-bottom{display:flex;align-items:center;gap:7px;padding-top:16px;color:#a4b0a5;font:8px ui-monospace,monospace;letter-spacing:.06em}
.home-principles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:34px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:36px 0 40px}
.home-principles article+article{border-left:1px solid var(--line);padding-left:34px}
.principle-number{color:var(--accent);font:10px ui-monospace,monospace;letter-spacing:.06em}
.home-principles h2{font:400 28px/1.2 Georgia,serif;color:var(--ink);letter-spacing:-.035em;margin:20px 0 16px}
.home-principles p{color:var(--muted);font-size:13px;line-height:1.8;max-width:36ch}
.home-principles a{display:inline-flex;align-items:center;min-height:44px;font-size:12px;font-weight:600}
.overview-heading{margin:68px 0 36px}
.overview-heading h2{font-size:42px;line-height:1.1;max-width:20ch;margin:14px 0}
.overview-heading>p:last-child{color:var(--muted);font-size:14px}
.home .doc-grid-home{grid-template-columns:minmax(0,76ch);margin-top:0}
.home .doc-home{max-width:76ch}.home .doc-home>h1:first-child{display:none}.home-platforms{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:24px;color:var(--muted);font:10px/1.8 ui-monospace,monospace;letter-spacing:.05em}
@media(max-width:1050px){.home-hero{gap:36px;padding-block:64px}.home-hero h1{font-size:60px}.desktop-preview{padding:18px}.site-header nav{gap:18px}}
@media(max-width:900px){body:not(.home) main{padding-top:80px}.home main{padding-inline:24px}.site-header{padding-inline:24px}.home-hero{grid-template-columns:minmax(0,1fr);gap:38px;padding-top:52px}.home-intro{max-width:600px}.home-hero h1{font-size:68px}.desktop-preview{width:min(480px,100%);justify-self:center;transform:rotate(1deg)}.home-principles{gap:22px}.home-principles article+article{padding-left:22px}.home-principles h2{font-size:24px}}
@media(max-width:600px){.home main{padding-inline:20px}.site-header{padding:18px 20px;gap:12px;flex-wrap:wrap}.site-header .brand{flex:1}.site-header nav{gap:12px;width:100%;justify-content:space-between}.site-header nav>a{font-size:12px}.site-header nav .site-open{padding-inline:12px;gap:10px}.site-header .theme-toggle{width:36px;height:44px;border:0;background:transparent}.home-hero{padding-block:42px 50px;gap:32px}.home-hero h1{font-size:52px}.home-hero .lede{font-size:15px}.home-hero .eyebrow{font-size:9px;letter-spacing:.06em}.home-cta .btn{font-size:12px;gap:15px;padding-inline:14px}.home-install{flex-wrap:nowrap;width:100%;min-width:0}.home-install code{font-size:12px}.home-install .copy{min-height:36px}.desktop-preview{box-shadow:7px 12px 0 color-mix(in srgb,var(--accent) 9%,transparent);padding:18px;transform:none}.preview-top>span:last-child{font-size:7px}.home-principles{grid-template-columns:1fr;gap:26px;padding-block:28px}.home-principles article+article{border-left:0;border-top:1px solid var(--line);padding:26px 0 0}.home-principles h2{font-size:30px;margin-block:14px}.home-principles p{max-width:44ch}.overview-heading{margin-top:44px}.overview-heading h2{font-size:36px}.hero h1{font-size:36px}.doc{font-size:15px}.doc pre .copy{opacity:1;position:static;display:block;margin:10px 0 0 auto}.doc table{display:block;overflow:auto}.nav-link{min-height:44px}.toc{display:none}}
@media(max-width:360px){.site-header nav{gap:8px}.site-header nav>a{font-size:11px}.site-header .theme-toggle{width:28px}.site-header nav .site-open{padding-inline:10px;gap:6px}.preview-heading{font-size:24px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation:none!important;transition:none!important}}

`;
}

export function js() {
  return `
const themeRoot=document.documentElement;
function applyTheme(mode){themeRoot.dataset.theme=mode;document.querySelectorAll('[data-theme-toggle]').forEach(b=>b.setAttribute('aria-pressed',mode==='dark'?'true':'false'))}
function storedTheme(){try{return localStorage.getItem('theme')}catch(e){return null}}
function persistTheme(mode){try{localStorage.setItem('theme',mode)}catch(e){}}
applyTheme(themeRoot.dataset.theme==='dark'?'dark':'light');
document.querySelectorAll('[data-theme-toggle]').forEach(btn=>{btn.addEventListener('click',()=>{const next=themeRoot.dataset.theme==='dark'?'light':'dark';applyTheme(next);persistTheme(next)})});
const systemDark=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)');
function onSystemChange(e){if(storedTheme())return;applyTheme(e.matches?'dark':'light')}
if(systemDark){if(systemDark.addEventListener)systemDark.addEventListener('change',onSystemChange);else if(systemDark.addListener)systemDark.addListener(onSystemChange)}
const sidebar=document.querySelector('.sidebar');
const toggle=document.querySelector('.nav-toggle');
const mobileNav=window.matchMedia('(max-width: 900px)');
const sidebarFocusable='a[href],button,input,select,textarea,[tabindex]';
function setSidebarFocusable(enabled){
  sidebar?.querySelectorAll(sidebarFocusable).forEach((el)=>{
    if(enabled){
      if(el.dataset.sidebarTabindex!==undefined){
        if(el.dataset.sidebarTabindex)el.setAttribute('tabindex',el.dataset.sidebarTabindex);
        else el.removeAttribute('tabindex');
        delete el.dataset.sidebarTabindex;
      }
    }else if(el.dataset.sidebarTabindex===undefined){
      el.dataset.sidebarTabindex=el.getAttribute('tabindex')??'';
      el.setAttribute('tabindex','-1');
    }
  });
}
function setSidebarOpen(open){
  if(!sidebar||!toggle)return;
  sidebar.classList.toggle('open',open);
  toggle.setAttribute('aria-expanded',open?'true':'false');
  if(mobileNav.matches){
    sidebar.inert=!open;
    if(open)sidebar.removeAttribute('aria-hidden');
    else sidebar.setAttribute('aria-hidden','true');
    setSidebarFocusable(open);
  }else{
    sidebar.inert=false;
    sidebar.removeAttribute('aria-hidden');
    setSidebarFocusable(true);
  }
}
setSidebarOpen(false);
toggle?.addEventListener('click',()=>setSidebarOpen(!sidebar?.classList.contains('open')));
document.addEventListener('click',(e)=>{if(!sidebar?.classList.contains('open'))return;if(sidebar.contains(e.target)||toggle?.contains(e.target))return;setSidebarOpen(false)});
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')setSidebarOpen(false)});
const syncSidebarForViewport=()=>setSidebarOpen(sidebar?.classList.contains('open')??false);
if(mobileNav.addEventListener)mobileNav.addEventListener('change',syncSidebarForViewport);
else mobileNav.addListener?.(syncSidebarForViewport);
const input=document.getElementById('doc-search');
input?.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();document.querySelectorAll('nav section').forEach(sec=>{let any=false;sec.querySelectorAll('.nav-link').forEach(a=>{const m=!q||a.textContent.toLowerCase().includes(q);a.style.display=m?'block':'none';if(m)any=true});sec.style.display=any?'block':'none'})});
function attachCopy(target,getText){const btn=document.createElement('button');btn.type='button';btn.className='copy';btn.textContent='Copy';btn.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(getText());btn.textContent='Copied';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1400)}catch{btn.textContent='Failed';setTimeout(()=>{btn.textContent='Copy'},1400)}});target.appendChild(btn)}
document.querySelectorAll('.doc pre').forEach(pre=>attachCopy(pre,()=>pre.querySelector('code')?.textContent??''));
document.querySelectorAll('.home-install').forEach(el=>attachCopy(el,()=>el.querySelector('code')?.textContent??''));
const tocLinks=document.querySelectorAll('.toc a');
if(tocLinks.length){const map=new Map();tocLinks.forEach(a=>{const id=a.getAttribute('href').slice(1);const el=document.getElementById(id);if(el)map.set(el,a)});const setActive=l=>{tocLinks.forEach(x=>x.classList.remove('active'));l.classList.add('active')};const obs=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);if(visible.length){const link=map.get(visible[0].target);if(link)setActive(link)}},{rootMargin:'-15% 0px -65% 0px',threshold:0});map.forEach((_,el)=>obs.observe(el))}
`;
}

export function preThemeScript() {
  return `(function(){var s;try{s=localStorage.getItem('theme')}catch(e){}var d=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=s||(d?'dark':'light')})();`;
}

export function themeToggleHtml() {
  return `<button class="theme-toggle" type="button" aria-label="Toggle dark mode" aria-pressed="false" data-theme-toggle>
    <svg class="theme-icon-moon" viewBox="0 0 20 20" aria-hidden="true"><path d="M14.6 12.1A6.5 6.5 0 0 1 7.4 2.7a6.5 6.5 0 1 0 7.2 9.4z" fill="currentColor"/></svg>
    <svg class="theme-icon-sun" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="10" y1="2" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18"/><line x1="2" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18" y2="10"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="14.4" y1="14.4" x2="15.8" y2="15.8"/><line x1="4.2" y1="15.8" x2="5.6" y2="14.4"/><line x1="14.4" y1="5.6" x2="15.8" y2="4.2"/></g></svg>
  </button>`;
}

// Canonical Crabfleet mark: a fleet of run-nodes on a dark app-icon tile, the
// center node lit coral to mark the live run. Shared by the SVG favicon and the
// PNG renderer (scripts/render-brand.mjs) so every surface uses one artwork.
export function brandMarkSvg({ glow = false } = {}) {
  const coords = [46, 105, 164];
  const nodes = [];
  for (const y of coords)
    for (const x of coords) {
      const live = x === 105 && y === 105;
      nodes.push(
        `<rect x="${x}" y="${y}" width="46" height="46" rx="13" fill="url(#${live ? "cf-live" : "cf-node"})"/>`,
      );
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Crabfleet">
  <defs>
    <linearGradient id="cf-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#15171d"/><stop offset="1" stop-color="#0c0e12"/></linearGradient>
    <linearGradient id="cf-node" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#525b6e"/><stop offset="1" stop-color="#3a4150"/></linearGradient>
    <linearGradient id="cf-live" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7184"/><stop offset="1" stop-color="#ef4f67"/></linearGradient>
    ${glow ? `<filter id="cf-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="14"/></filter>` : ""}
  </defs>
  <rect x="2" y="2" width="252" height="252" rx="58" fill="url(#cf-tile)" stroke="#262a34" stroke-width="2"/>
  ${glow ? `<rect x="105" y="105" width="46" height="46" rx="13" fill="#f05a70" filter="url(#cf-glow)" opacity="0.55"/>` : ""}
  ${nodes.join("\n  ")}
</svg>`;
}

export function faviconSvg() {
  return brandMarkSvg();
}
