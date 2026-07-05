/* Liquid Flow — shared light/dark theme toggle.
   Injects a bold floating button (lower-right) + dark-mode color overrides.
   Include once per page:  <script src="theme-toggle.js" defer></script>            */
(function () {
  var KEY = 'lf-theme';
  var root = document.documentElement;

  // Apply saved (or system) preference as early as possible to limit flash.
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (!saved) {
    saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', saved);

  // ---- dark-mode variable overrides (match the shared palette across pages) ----
  var css = ''
    + ':root[data-theme="dark"]{'
    +   'color-scheme:dark;'
    +   '--cloud:#0B1120;--white:#131C30;'
    +   '--ink:#EAF0FB;--ink-2:#9AAAC7;'
    +   '--line:#243352;--line-2:#1B2840;--mist:#1C3056;'
    +   '--flow:#3D74FF;--flow-2:#6B97FF;'
    +   '--field:#243352;'
    +   '--tint:#16284A;--tint-bd:#26467E;--tint-tx:#8FBEF5;'
    +   '--green:#1D9E75;--green-bg:#10301F;--green-tx:#5FD7A6;'
    +   '--ok:#1D9E75;--ok-bg:#10301F;--ok-tx:#5FD7A6;'
    +   '--veil:#8E7Cff;--veil-bg:#1E1A40;'
    +   '--bad:#E24B4A;--bad-bg:#3A1A1A;--bad-tx:#FF8E8C;'
    +   '--warn:#BA7517;--warn-bg:#3A2A12;--warn-tx:#F0C277;'
    + '}'
    + ':root[data-theme="dark"] body{background:var(--cloud);color:var(--ink);}'
    + ':root[data-theme="dark"] img:not([src*=".svg"]){filter:brightness(.92);}'
    // Home/landing header keeps its light frosted bar in dark mode — darken its text so it stays readable.
    + ':root[data-theme="dark"] header .navlinks a{color:#33415E;}'
    + ':root[data-theme="dark"] header .navlinks a:hover{color:#0A1B3D;}'
    + ':root[data-theme="dark"] header .brand .wm{color:#0A1B3D;}'
    + ':root[data-theme="dark"] header .nav-cta .btn-ghost{color:#33415E;background:transparent;border:none;}'
    // "How the gate works" panel uses background:var(--ink) which flips light in dark mode —
    // make it a translucent frosted panel and darken its writeup so it reads clearly.
    + ':root[data-theme="dark"] .how{background:rgba(255,255,255,0.66);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(10,27,61,0.10);}'
    + ':root[data-theme="dark"] .how h2.sec-title{color:#0A1B3D;}'
    + ':root[data-theme="dark"] .how .sec-tag{color:#1E5BFF;}'
    + ':root[data-theme="dark"] .how .step h4{color:#0A1B3D;}'
    + ':root[data-theme="dark"] .how .step p{color:#33415E;}'
    + ':root[data-theme="dark"] .how .step .num{color:#1E5BFF;border-color:rgba(30,91,255,0.45);}'
    // ---- flip hardcoded white surfaces (tabs/chips/cards/inputs) in dark mode ----
    + ':root[data-theme="dark"] .chip,'
    +   ':root[data-theme="dark"] .opt,'
    +   ':root[data-theme="dark"] .gate-card,'
    +   ':root[data-theme="dark"] .feat,'
    +   ':root[data-theme="dark"] .sec-item,'
    +   ':root[data-theme="dark"] .linkrow,'
    +   ':root[data-theme="dark"] .btn-ghost,'
    +   ':root[data-theme="dark"] .copy,'
    +   ':root[data-theme="dark"] .input,'
    +   ':root[data-theme="dark"] .textarea,'
    +   ':root[data-theme="dark"] input:not([type=checkbox]):not([type=radio]):not([type=range]),'
    +   ':root[data-theme="dark"] textarea,'
    +   ':root[data-theme="dark"] select{'
    +   'background:var(--white);color:var(--ink);border-color:var(--line);}'
    + ':root[data-theme="dark"] .anychip{background:#16284A;border-color:#26467E;color:#8FBEF5;}'
    + ':root[data-theme="dark"] .chip[aria-pressed="true"]{background:var(--flow);color:#fff;border-color:var(--flow);}'
    + ':root[data-theme="dark"] input::placeholder,:root[data-theme="dark"] textarea::placeholder{color:#6B7C9C;}'
    // ---- the floating button ----
    + '#lf-theme-fab{position:fixed;right:22px;bottom:22px;z-index:99999;width:58px;height:58px;'
    +   'border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;'
    +   'background:linear-gradient(145deg,#1E5BFF,#0A1B3D);color:#fff;'
    +   'box-shadow:0 10px 28px -8px rgba(30,91,255,.65),0 2px 6px rgba(10,27,61,.4);'
    +   'transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s,background .3s;'
    +   '-webkit-tap-highlight-color:transparent;outline:none;}'
    + '#lf-theme-fab::after{content:"";position:absolute;inset:-4px;border-radius:50%;'
    +   'border:2px solid rgba(91,141,255,.5);opacity:.0;transition:opacity .3s;}'
    + '#lf-theme-fab:hover{transform:translateY(-4px) scale(1.06);'
    +   'box-shadow:0 18px 38px -10px rgba(30,91,255,.8),0 4px 10px rgba(10,27,61,.5);}'
    + '#lf-theme-fab:hover::after{opacity:1;animation:lf-fab-pulse 1.6s ease-out infinite;}'
    + '#lf-theme-fab:active{transform:translateY(-1px) scale(1.0);}'
    + ':root[data-theme="dark"] #lf-theme-fab{background:linear-gradient(145deg,#FFB23D,#FF7A29);'
    +   'box-shadow:0 10px 28px -8px rgba(255,150,40,.6),0 2px 6px rgba(0,0,0,.45);}'
    + ':root[data-theme="dark"] #lf-theme-fab:hover{box-shadow:0 18px 40px -10px rgba(255,150,40,.85);}'
    + '#lf-theme-fab svg{width:26px;height:26px;display:none;}'
    + ':root[data-theme="light"] #lf-theme-fab .lf-moon{display:block;}'
    + ':root[data-theme="dark"]  #lf-theme-fab .lf-sun{display:block;}'
    + '@keyframes lf-fab-pulse{0%{transform:scale(1);opacity:.7}100%{transform:scale(1.25);opacity:0}}'
    + '@media(max-width:600px){#lf-theme-fab{width:50px;height:50px;right:16px;bottom:16px;}#lf-theme-fab svg{width:23px;height:23px;}}';

  function injectStyle() {
    var s = document.createElement('style');
    s.id = 'lf-theme-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectButton() {
    if (document.getElementById('lf-theme-fab')) return;
    var b = document.createElement('button');
    b.id = 'lf-theme-fab';
    b.type = 'button';
    b.setAttribute('aria-label', 'Toggle light and dark mode');
    b.title = 'Toggle theme';
    b.innerHTML =
      // moon (shown in light mode → click for dark)
      '<svg class="lf-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
      // sun (shown in dark mode → click for light)
      + '<svg class="lf-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2 12h2.5M19.5 12H22M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>';
    b.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
    });
    document.body.appendChild(b);
  }

  if (document.head) injectStyle();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { if (!document.getElementById('lf-theme-style')) injectStyle(); injectButton(); });
  } else {
    if (!document.getElementById('lf-theme-style')) injectStyle();
    injectButton();
  }
})();
