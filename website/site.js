(function () {
  'use strict';

  var header = document.getElementById('head');
  if (header) {
    function setStuck() {
      header.dataset.stuck = window.scrollY > 12 ? '1' : '0';
    }
    setStuck();
    window.addEventListener('scroll', setStuck, { passive: true });
  }

  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('site-menu');
  if (!toggle || !menu) return;

  function closeMenu() {
    menu.dataset.open = 'false';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation');
  }

  toggle.addEventListener('click', function () {
    var opening = menu.dataset.open !== 'true';
    menu.dataset.open = opening ? 'true' : 'false';
    toggle.setAttribute('aria-expanded', opening ? 'true' : 'false');
    toggle.setAttribute('aria-label', opening ? 'Close navigation' : 'Open navigation');
  });

  menu.addEventListener('click', function (event) {
    if (event.target.closest('a')) closeMenu();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && menu.dataset.open === 'true') {
      closeMenu();
      toggle.focus();
    }
  });

  window.matchMedia('(min-width: 861px)').addEventListener('change', function (event) {
    if (event.matches) closeMenu();
  });
}());
