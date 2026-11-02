'use strict';
// Draws a widget tree from the launch params, over whatever is on screen (ARCHITECTURE.md section 3a).
// notify.js already validated the shape; re-checked here because any local app on the TV could launch
// this one directly with luna-send, bypassing notify.js and the SSH dispatcher entirely.
(function () {
  var card = document.getElementById('card');
  var root = document.getElementById('root');
  var time = document.getElementById('time');
  var POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
  var SIZES = ['xs', 's', 'm', 'l', 'xl', 'full'];
  var TEXT_SIZES = ['xs', 's', 'm', 'l', 'xl'];
  var TEXT_WEIGHTS = ['normal', 'strong'];
  var TEXT_COLORS = ['fg', 'fg-2', 'info', 'success', 'warning', 'alert'];
  var TONES = ['info', 'success', 'warning', 'alert'];
  var LIST_STYLES = ['bullet', 'number', 'plain'];
  var WIDGET_TYPES = ['stack', 'row', 'text', 'image', 'badge', 'dot', 'progress', 'countdown', 'list', 'divider',
                      'compare', 'sparkline'];
  var IMAGE_SHAPES = ['square', 'circle'];
  var MAX_TREE_DEPTH = 5;
  var MAX_TREE_NODES = 60;
  var hideTimer = null;
  var closeTimer = null;
  var countdownTimers = [];

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

  // --- defence-in-depth widget tree validator: same rules as notify.js's tree(), independently applied ---

  function oneOf(value, choices) {
    return choices.indexOf(value) >= 0 ? value : undefined;
  }

  function checkNode(node, depth, counter) {
    counter.n += 1;
    if (counter.n > MAX_TREE_NODES || depth > MAX_TREE_DEPTH) return null;
    if (!node || typeof node !== 'object') return null;
    var kind = WIDGET_TYPES.indexOf(node.type) >= 0 ? node.type : null;
    if (!kind) return null;
    var out = {type: kind};
    if (kind === 'stack' || kind === 'row') {
      var limit = kind === 'stack' ? 20 : 10;
      if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > limit) return null;
      out.gap = typeof node.gap === 'number' && node.gap >= 0 && node.gap <= 48 ? node.gap : undefined;
      out.align = oneOf(node.align, ['start', 'center', 'end']);
      out.children = [];
      for (var i = 0; i < node.children.length; i++) {
        var child = checkNode(node.children[i], depth + 1, counter);
        if (child) out.children.push(child);
      }
      if (!out.children.length) return null;
    } else if (kind === 'text') {
      out.text = text(node.text, 400);
      if (!out.text) return null;
      out.size = oneOf(node.size, TEXT_SIZES);
      out.weight = oneOf(node.weight, TEXT_WEIGHTS);
      out.color = oneOf(node.color, TEXT_COLORS);
    } else if (kind === 'image') {
      var src = text(node.src, 500);
      if (!/^https?:\/\//.test(src)) return null;
      out.src = src;
      out.shape = oneOf(node.shape, IMAGE_SHAPES);
    } else if (kind === 'badge') {
      out.text = text(node.text, 24);
      if (!out.text) return null;
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'dot') {
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'progress') {
      if (typeof node.value !== 'number' || isNaN(node.value)) return null;
      out.value = Math.max(0, Math.min(1, node.value));
      out.label = text(node.label, 40) || undefined;
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'countdown') {
      if (typeof node.target !== 'string' || isNaN(Date.parse(node.target))) return null;
      out.target = node.target;
      out.label = text(node.label, 40) || undefined;
    } else if (kind === 'list') {
      if (!Array.isArray(node.items) || node.items.length < 1 || node.items.length > 10) return null;
      out.items = node.items.map(function (item) { return text(item, 120); }).filter(Boolean);
      if (!out.items.length) return null;
      out.style = oneOf(node.style, LIST_STYLES);
    } else if (kind === 'compare') {
      if (!Array.isArray(node.segments) || node.segments.length < 2 || node.segments.length > 4) return null;
      out.segments = [];
      for (var s = 0; s < node.segments.length; s++) {
        var seg = checkSegment(node.segments[s]);
        if (!seg) return null;
        out.segments.push(seg);
      }
    } else if (kind === 'sparkline') {
      if (!Array.isArray(node.points) || node.points.length < 3 || node.points.length > 24) return null;
      out.points = [];
      for (var p = 0; p < node.points.length; p++) {
        var point = node.points[p];
        if (typeof point !== 'number' || isNaN(point) || point < -1 || point > 1) return null;
        out.points.push(point);
      }
      out.tone = oneOf(node.tone, TONES);
    } // divider has no fields
    return out;
  }

  function checkSegment(segment) {
    if (!segment || typeof segment !== 'object') return null;
    var label = text(segment.label, 24);
    var value = text(segment.value, 16);
    if (!label || !value || typeof segment.fraction !== 'number' || isNaN(segment.fraction)) return null;
    return {label: label, value: value, fraction: Math.max(0, Math.min(1, segment.fraction)), tone: oneOf(segment.tone, TONES)};
  }

  // --- rendering ---

  function el(tag, className) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  function clearCountdowns() {
    for (var i = 0; i < countdownTimers.length; i++) clearInterval(countdownTimers[i]);
    countdownTimers = [];
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return '0:00';
    var totalSeconds = Math.floor(ms / 1000);
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    if (days > 0) return days + 'd ' + pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
    if (hours > 0) return hours + ':' + pad2(minutes) + ':' + pad2(seconds);
    return minutes + ':' + pad2(seconds);
  }

  function startCountdown(clock, targetIso) {
    var target = new Date(targetIso).getTime();
    var tick = function () { clock.textContent = formatCountdown(target - Date.now()); };
    tick();
    countdownTimers.push(setInterval(tick, 1000));
  }

  function renderNode(node) {
    var e;
    switch (node.type) {
      case 'stack':
      case 'row':
        e = el('div', node.type === 'stack' ? 'w-stack' : 'w-row');
        if (node.gap !== undefined) e.style.gap = node.gap + 'px';
        if (node.align) e.dataset.align = node.align;
        node.children.forEach(function (child) { e.appendChild(renderNode(child)); });
        return e;
      case 'text':
        e = el('p', 'w-text');
        e.textContent = node.text;
        e.dataset.size = node.size || 'm';
        e.dataset.weight = node.weight || 'normal';
        e.dataset.color = node.color || 'fg';
        return e;
      case 'image':
        e = el('img', 'w-image');
        e.alt = '';
        e.addEventListener('error', function () { e.remove(); });
        e.dataset.shape = node.shape || 'square';
        e.src = node.src;
        return e;
      case 'badge':
        e = el('span', 'w-badge');
        e.textContent = node.text;
        e.dataset.tone = node.tone || 'info';
        return e;
      case 'dot':
        e = el('span', 'w-dot');
        e.dataset.tone = node.tone || 'info';
        return e;
      case 'progress': {
        e = el('div', 'w-progress');
        e.dataset.tone = node.tone || 'info';
        var track = el('div', 'w-progress-track');
        var fill = el('div', 'w-progress-fill');
        fill.style.width = (node.value * 100) + '%';
        track.appendChild(fill);
        e.appendChild(track);
        if (node.label) {
          var plabel = el('span', 'w-progress-label');
          plabel.textContent = node.label;
          e.appendChild(plabel);
        }
        return e;
      }
      case 'countdown': {
        e = el('div', 'w-countdown');
        var clock = el('span', 'w-countdown-clock');
        e.appendChild(clock);
        if (node.label) {
          var clabel = el('span', 'w-countdown-label');
          clabel.textContent = node.label;
          e.appendChild(clabel);
        }
        startCountdown(clock, node.target);
        return e;
      }
      case 'compare': {
        e = el('div', 'w-compare');
        var labels = el('div', 'w-compare-labels');
        var bar = el('div', 'w-compare-bar');
        node.segments.forEach(function (segment) {
          var cell = el('div', 'w-compare-cell');
          var lab = el('span', 'w-compare-label');
          lab.textContent = segment.label;
          var val = el('span', 'w-compare-value');
          val.textContent = segment.value;
          val.dataset.tone = segment.tone || '';
          cell.appendChild(lab);
          cell.appendChild(val);
          labels.appendChild(cell);
          var seg = el('span', 'w-compare-seg');
          seg.style.width = (segment.fraction * 100) + '%';
          seg.dataset.tone = segment.tone || 'neutral';
          bar.appendChild(seg);
        });
        e.appendChild(labels);
        e.appendChild(bar);
        return e;
      }
      case 'sparkline': {
        e = el('div', 'w-sparkline');
        e.dataset.tone = node.tone || 'info';
        node.points.forEach(function (point) {
          var col = el('span', 'w-sparkline-col');
          var fill = el('span', 'w-sparkline-fill');
          fill.dataset.sign = point < 0 ? 'neg' : 'pos';
          fill.style.height = (Math.abs(point) * 50) + '%';
          col.appendChild(fill);
          e.appendChild(col);
        });
        return e;
      }
      case 'list':
        e = el('ul', 'w-list');
        e.dataset.style = node.style || 'bullet';
        node.items.forEach(function (item) {
          var li = document.createElement('li');
          li.textContent = item;
          e.appendChild(li);
        });
        return e;
      case 'divider':
      default:
        return el('hr', 'w-divider');
    }
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
      clearCountdowns();
      root.textContent = '';
      try { window.close(); } catch (e) {}
    }, 200);
  }

  function render(p) {
    if (p.hide === true) return close();
    var tree = checkNode(p.root, 0, {n: 0});
    if (!tree) return; // malformed launch params from outside notify.js: draw nothing rather than guess
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    clearCountdowns();
    card.dataset.pos = oneOf(p.position, POSITIONS) || 'top-right';
    card.dataset.size = oneOf(p.size, SIZES) || 'm';
    root.textContent = '';
    root.appendChild(renderNode(tree));
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
