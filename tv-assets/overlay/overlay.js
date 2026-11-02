'use strict';
// Draws one card from the launch params, over whatever is on screen. notify.js validates the params;
// shapes are re-checked here because any local app can launch this one.
(function () {
  var card = document.getElementById('card');
  var head = card.querySelector('.card-head');
  var title = document.getElementById('title');
  var body = document.getElementById('body');
  var lines = document.getElementById('lines');
  var media = document.getElementById('media');
  var time = document.getElementById('time');
  var KINDS = ['info', 'success', 'warning', 'alert'];
  var POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  var hideTimer = null;
  var closeTimer = null;

  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function paramsOf(raw) {
    var p = raw;
    try {
      if (typeof p === 'string') p = JSON.parse(p || '{}');
    } catch (e) {
      p = {};
    }
    if (p && typeof p.params === 'object') p = p.params;
    return p && typeof p === 'object' ? p : {};
  }

  // Keep the remote and pointer on the app underneath: no input region, no focus.
  function passThrough() {
    try { window.PalmSystem.setInputRegion([{x: 0, y: 0, width: 1, height: 1}]); } catch (e) {}
    try { window.PalmSystem.window.setFocus(false); } catch (e) {}
  }

  function close() {
    clearTimeout(hideTimer);
    card.classList.remove('show');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      card.hidden = true;
      try { window.close(); } catch (e) {}
    }, 200);
  }

  function render(p) {
    if (p.hide === true) return close();
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    title.textContent = text(p.title, 80);
    head.hidden = !title.textContent;
    body.textContent = text(p.body, 400);
    lines.textContent = '';
    (Array.isArray(p.lines) ? p.lines : []).slice(0, 10).forEach(function (line) {
      var item = document.createElement('li');
      item.textContent = text(line, 120);
      lines.appendChild(item);
    });
    media.textContent = '';
    var src = text(p.image, 500);
    if (/^https?:\/\//.test(src)) {
      var img = document.createElement('img');
      img.className = 'image';
      img.alt = '';
      img.addEventListener('error', function () { img.remove(); });
      img.src = src;
      media.appendChild(img);
    }
    card.dataset.kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : 'info';
    card.dataset.pos = POSITIONS.indexOf(p.position) >= 0 ? p.position : 'top-right';
    var seconds = typeof p.seconds === 'number' && p.seconds >= 0 && p.seconds <= 300 ? p.seconds : 8;
    card.dataset.pinned = String(seconds === 0);
    card.hidden = false;
    passThrough();
    time.style.transition = 'none';
    time.style.transform = 'scaleX(1)';
    void time.offsetWidth;
    requestAnimationFrame(function () { card.classList.add('show'); });
    if (seconds) {
      time.style.transition = 'transform ' + seconds + 's linear';
      time.style.transform = 'scaleX(0)';
      hideTimer = setTimeout(close, seconds * 1000);
    }
  }

  // A real button press dismisses the card; Magic Remote pointer activity (key codes 1536 and up) does not.
  document.addEventListener('keydown', function (event) {
    if (event.keyCode < 1536 && !card.hidden) close();
  });
  document.addEventListener('webOSRelaunch', function (event) {
    render(paramsOf(event && event.detail ? event.detail : window.PalmSystem && window.PalmSystem.launchParams));
  }, true);
  render(paramsOf(window.PalmSystem ? window.PalmSystem.launchParams : {}));
}());
