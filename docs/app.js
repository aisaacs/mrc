/* ============================================================
   Mister Claude — shared site interactions
   No dependencies. Progressive enhancement only.
   ============================================================ */
(function () {
  'use strict';

  /* ── Mobile nav toggle ── */
  function initNav() {
    var toggle = document.querySelector('.nav-toggle');
    var links = document.querySelector('.nav-links');
    if (!toggle || !links) return;
    toggle.addEventListener('click', function () {
      links.classList.toggle('open');
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  /* ── Scroll reveal ── */
  function initReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('visible'); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { obs.observe(el); });
  }

  /* ── Copy buttons on terminals ── */
  function initCopy() {
    document.querySelectorAll('.terminal').forEach(function (term) {
      var body = term.querySelector('.terminal-body');
      if (!body || term.dataset.nocopy === 'true') return;
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = 'copy';
      btn.addEventListener('click', function () {
        // Strip leading "$ " prompts so pasted commands are runnable.
        var text = body.innerText.replace(/^[\s]*\$ /gm, '').trim();
        var done = function () {
          btn.textContent = 'copied'; btn.classList.add('copied');
          setTimeout(function () { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else { fallback(); }
        function fallback() {
          var ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } catch (e) {}
          document.body.removeChild(ta);
        }
      });
      term.appendChild(btn);
    });
  }

  /* ── Yogurt quote rotator ── */
  var QUOTES = [
    ['Moichandising! Moichandising! Where the real money from the movie is made.', 'Yogurt'],
    ['May the Schwartz be with you.', 'Yogurt'],
    ['Use the Schwartz, coder!', 'Yogurt'],
    ['I am Yogurt. The one and only.', 'Yogurt'],
    ["God willing, we'll all meet again in Spaceballs 2: The Search for More Money.", 'Yogurt'],
    ['I hate yogurt. Even with strawberries.', 'Yogurt'],
    ['Ludicrous speed... GO!', 'Dark Helmet'],
    ["What's the matter, Colonel Sandurz? CHICKEN?", 'Dark Helmet'],
    ['We ain\'t found shit.', 'Sandurz'],
    ['She\'s gone from suck to blow!', 'Dark Helmet']
  ];
  function initQuotes() {
    var bq = document.querySelector('.quote blockquote');
    var ct = document.querySelector('.quote cite');
    if (!bq || !ct) return;
    var i = 0;
    function show(n) {
      bq.style.opacity = 0;
      setTimeout(function () {
        bq.textContent = '"' + QUOTES[n][0] + '"';
        ct.textContent = '— ' + QUOTES[n][1];
        bq.style.transition = 'opacity .5s'; bq.style.opacity = 1;
      }, 320);
    }
    // start from a deterministic-but-varied index based on page length
    i = (document.body.textContent.length) % QUOTES.length;
    show(i);
    setInterval(function () { i = (i + 1) % QUOTES.length; show(i); }, 6500);
  }

  /* ── Docs sidebar active-section highlight ── */
  function initDocsScrollSpy() {
    var sidebar = document.querySelector('.docs-sidebar');
    if (!sidebar || !('IntersectionObserver' in window)) return;
    var sections = document.querySelectorAll('.docs-content section[id]');
    if (!sections.length) return;
    var map = {};
    sidebar.querySelectorAll('a[href^="#"]').forEach(function (a) {
      map[a.getAttribute('href').slice(1)] = a;
    });
    var visible = new Set();
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id);
      });
      // highlight the topmost visible section
      var first = null;
      sections.forEach(function (s) { if (!first && visible.has(s.id)) first = s.id; });
      Object.keys(map).forEach(function (id) { map[id].classList.toggle('active', id === first); });
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
    sections.forEach(function (s) { obs.observe(s); });
  }

  /* ── Mark current page in nav ── */
  function initNavActive() {
    var path = location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      if (href === path || (path === 'index.html' && href === './') ||
          (href.indexOf('#') === -1 && href === path)) {
        a.classList.add('active');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initNav(); initNavActive(); initReveal(); initCopy(); initQuotes(); initDocsScrollSpy();
  });
})();
