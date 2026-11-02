'use strict';
// Draws one or more widget trees from the launch params, over whatever is on screen (ARCHITECTURE.md
// section 3a). notify.js already validated the shape; re-checked here because any local app on the TV
// could launch this one directly with luna-send, bypassing notify.js and the SSH dispatcher entirely.
// One overlay window can be visible at a time, so a broadcast-style layout (a top bar plus a side panel)
// is several regions -- several cards -- inside this one window.
(function () {
  var stage = document.getElementById('stage');
  var POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'top', 'bottom', 'left', 'right'];
  var SIZES = ['xs', 's', 'm', 'l', 'xl', 'full'];
  var TEXT_SIZES = ['xs', 's', 'm', 'l', 'xl'];
  var TEXT_WEIGHTS = ['normal', 'strong'];
  var TONES = ['info', 'success', 'warning', 'alert', 'accent'];
  var TEXT_COLORS = ['fg', 'fg-2'].concat(TONES);
  var LIST_STYLES = ['bullet', 'number', 'plain'];
  var WIDGET_TYPES = ['stack', 'row', 'text', 'image', 'badge', 'dot', 'progress', 'countdown', 'list', 'divider',
                      'compare', 'sparkline', 'section', 'event', 'stat', 'status', 'meta', 'clock'];
  var IMAGE_SHAPES = ['square', 'circle'];
  var IMAGE_SIZES = ['s', 'm', 'l'];
  var STATES = ['online', 'offline', 'degraded', 'unknown'];
  var CLOCK_FORMATS = ['time', 'seconds', 'date'];
  var FONTS = ['sans', 'condensed', 'mono'];
  var THEME_COLORS = ['accent', 'surface', 'text', 'muted', 'line'];
  var MAX_TREE_DEPTH = 5;
  var MAX_TREE_NODES = 80;
  var MAX_REGIONS = 4;
  // 24x24 stroke icons, the same vocabulary the web UI previews (web/app.js OVERLAY_ICONS).
  var ICONS = {
    ball: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5 3.5 2.6-1.3 4.1H9.8L8.5 10.6Z',
    bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7Z',
    chart: 'M4 20h16M7 16v-5M12 16V7M17 16v-9',
    trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4v4',
    pulse: 'M3 12h4l2-6 4 12 2-6h6',
    layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
    pin: 'M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10Zm0-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    card: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    swap: 'M7 4v12m0 0-3-3m3 3 3-3M17 20V8m0 0 3 3m-3-3-3 3',
    target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5h0m0 3v5',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 4a2 2 0 0 0 4 0',
    star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z',
    flag: 'M5 21V4m0 0h12l-3 4 3 4H5',
  };
  var hideTimer = null;
  var closeTimer = null;
  var liveTimers = [];

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

  function fraction(value) {
    return typeof value === 'number' && !isNaN(value) ? Math.max(0, Math.min(1, value)) : null;
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
      out.size = oneOf(node.size, IMAGE_SIZES);
    } else if (kind === 'badge') {
      out.text = text(node.text, 24);
      if (!out.text) return null;
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'dot') {
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'progress') {
      out.value = fraction(node.value);
      if (out.value === null) return null;
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
      if (Array.isArray(node.axis) && node.axis.length === 3) {
        out.axis = node.axis.map(function (label) { return text(label, 6); });
      }
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'section') {
      out.title = text(node.title, 40);
      if (!out.title) return null;
      out.icon = ICONS[node.icon] ? node.icon : undefined;
      out.action = text(node.action, 24) || undefined;
    } else if (kind === 'event') {
      out.time = text(node.time, 8);
      out.text = text(node.text, 120);
      if (!out.time || !out.text) return null;
      out.icon = ICONS[node.icon] ? node.icon : undefined;
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'stat') {
      out.label = text(node.label, 40);
      out.left = text(node.left, 16);
      out.right = text(node.right, 16);
      out.fraction = fraction(node.fraction);
      if (!out.label || !out.left || !out.right || out.fraction === null) return null;
      out.tone = oneOf(node.tone, TONES);
    } else if (kind === 'status') {
      out.label = text(node.label, 40);
      out.state = oneOf(node.state, STATES);
      if (!out.label || !out.state) return null;
      out.detail = text(node.detail, 24) || undefined;
    } else if (kind === 'meta') {
      if (!Array.isArray(node.items) || node.items.length < 1 || node.items.length > 4) return null;
      out.items = [];
      for (var m = 0; m < node.items.length; m++) {
        var item = node.items[m];
        if (!item || typeof item !== 'object') return null;
        var label = text(item.label, 24);
        var value = text(item.value, 40);
        if (!label || !value) return null;
        out.items.push({label: label, value: value, icon: ICONS[item.icon] ? item.icon : undefined});
      }
    } else if (kind === 'clock') {
      out.format = oneOf(node.format, CLOCK_FORMATS);
      out.label = text(node.label, 40) || undefined;
    } // divider has no fields
    return out;
  }

  function checkSegment(segment) {
    if (!segment || typeof segment !== 'object') return null;
    var label = text(segment.label, 24);
    var value = text(segment.value, 16);
    var share = fraction(segment.fraction);
    if (!label || !value || share === null) return null;
    return {label: label, value: value, fraction: share, tone: oneOf(segment.tone, TONES)};
  }

  function checkTheme(theme) {
    if (!theme || typeof theme !== 'object') return {};
    var out = {};
    for (var i = 0; i < THEME_COLORS.length; i++) {
      var key = THEME_COLORS[i];
      if (typeof theme[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(theme[key])) out[key] = theme[key];
    }
    if (typeof theme.opacity === 'number' && theme.opacity >= 0.2 && theme.opacity <= 1) out.opacity = theme.opacity;
    if (typeof theme.radius === 'number' && theme.radius >= 0 && theme.radius <= 32) out.radius = Math.round(theme.radius);
    if (typeof theme.scale === 'number' && theme.scale >= 0.75 && theme.scale <= 1.5) out.scale = theme.scale;
    out.font = oneOf(theme.font, FONTS);
    return out;
  }

  // --- rendering ---

  function el(tag, className) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  function span(className, content) {
    var e = el('span', className);
    e.textContent = content;
    return e;
  }

  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'w-icon');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function clearLiveTimers() {
    for (var i = 0; i < liveTimers.length; i++) clearInterval(liveTimers[i]);
    liveTimers = [];
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
    liveTimers.push(setInterval(tick, 1000));
  }

  function formatClock(now, format) {
    if (format === 'date') return now.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'});
    var out = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    return format === 'seconds' ? out + ':' + pad2(now.getSeconds()) : out;
  }

  function startClock(clock, format) {
    var tick = function () { clock.textContent = formatClock(new Date(), format); };
    tick();
    liveTimers.push(setInterval(tick, 1000));
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
        e.dataset.size = node.size || 'm';
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
        if (node.label) e.appendChild(span('w-progress-label', node.label));
        return e;
      }
      case 'countdown': {
        e = el('div', 'w-countdown');
        var clock = el('span', 'w-countdown-clock');
        e.appendChild(clock);
        if (node.label) e.appendChild(span('w-countdown-label', node.label));
        startCountdown(clock, node.target);
        return e;
      }
      case 'clock': {
        e = el('div', 'w-clock');
        var face = el('span', 'w-clock-face');
        e.appendChild(face);
        if (node.label) e.appendChild(span('w-clock-label', node.label));
        startClock(face, node.format || 'time');
        return e;
      }
      case 'compare': {
        e = el('div', 'w-compare');
        var labels = el('div', 'w-compare-labels');
        var bar = el('div', 'w-compare-bar');
        node.segments.forEach(function (segment) {
          var cell = el('div', 'w-compare-cell');
          cell.appendChild(span('w-compare-label', segment.label));
          var val = span('w-compare-value', segment.value);
          val.dataset.tone = segment.tone || '';
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
        if (node.axis) {
          var axis = el('div', 'w-sparkline-axis');
          node.axis.forEach(function (label) { axis.appendChild(span('', label)); });
          e.appendChild(axis);
        }
        var cols = el('div', 'w-sparkline-cols');
        node.points.forEach(function (point) {
          var col = el('span', 'w-sparkline-col');
          var fill = el('span', 'w-sparkline-fill');
          fill.dataset.sign = point < 0 ? 'neg' : 'pos';
          fill.style.height = (Math.abs(point) * 50) + '%';
          col.appendChild(fill);
          cols.appendChild(col);
        });
        e.appendChild(cols);
        return e;
      }
      case 'section':
        e = el('div', 'w-section');
        if (node.icon) e.appendChild(icon(node.icon));
        e.appendChild(span('w-section-title', node.title));
        if (node.action) e.appendChild(span('w-section-action', node.action));
        return e;
      case 'event': {
        e = el('div', 'w-event');
        e.dataset.tone = node.tone || 'info';
        e.appendChild(span('w-event-time', node.time));
        var mark = el('span', 'w-event-mark');
        if (node.icon) mark.appendChild(icon(node.icon));
        e.appendChild(mark);
        e.appendChild(span('w-event-text', node.text));
        return e;
      }
      case 'stat': {
        e = el('div', 'w-stat');
        e.dataset.tone = node.tone || 'accent';
        e.appendChild(span('w-stat-label', node.label));
        e.appendChild(span('w-stat-left', node.left));
        var statBar = el('span', 'w-stat-bar');
        var statFill = el('span', 'w-stat-fill');
        statFill.style.width = (node.fraction * 100) + '%';
        statBar.appendChild(statFill);
        e.appendChild(statBar);
        e.appendChild(span('w-stat-right', node.right));
        return e;
      }
      case 'status':
        e = el('div', 'w-status');
        e.dataset.state = node.state;
        e.appendChild(span('w-status-label', node.label));
        e.appendChild(span('w-status-state', node.state.charAt(0).toUpperCase() + node.state.slice(1)));
        if (node.detail) e.appendChild(span('w-status-detail', node.detail));
        return e;
      case 'meta':
        e = el('div', 'w-meta');
        node.items.forEach(function (item) {
          var cell = el('div', 'w-meta-cell');
          cell.appendChild(span('w-meta-label', item.label));
          var value = el('span', 'w-meta-value');
          value.textContent = item.value;
          if (item.icon) value.appendChild(icon(item.icon));
          cell.appendChild(value);
          e.appendChild(cell);
        });
        return e;
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

  function hexToRgb(hex) {
    return parseInt(hex.slice(1, 3), 16) + ' ' + parseInt(hex.slice(3, 5), 16) + ' ' + parseInt(hex.slice(5, 7), 16);
  }

  function applyTheme(theme) {
    var style = stage.style;
    style.cssText = '';
    var surfaceAlpha = theme.opacity !== undefined ? theme.opacity : 0.94;
    if (theme.surface || theme.opacity !== undefined) {
      style.setProperty('--surface', 'rgb(' + hexToRgb(theme.surface || '#191c22') + ' / ' + surfaceAlpha + ')');
    }
    if (theme.accent) style.setProperty('--accent', theme.accent);
    if (theme.text) style.setProperty('--fg', theme.text);
    if (theme.muted) style.setProperty('--fg-2', theme.muted);
    if (theme.line) style.setProperty('--line', theme.line);
    if (theme.radius !== undefined) style.setProperty('--radius', theme.radius + 'px');
    if (theme.scale !== undefined) style.setProperty('--scale', String(theme.scale));
    stage.dataset.font = theme.font || 'sans';
  }

  function makeCard(position, size, tree, seconds) {
    var card = el('article', 'card');
    card.dataset.pos = position;
    card.dataset.size = size;
    card.dataset.pinned = String(seconds === 0);
    var root = el('div', 'root');
    root.appendChild(renderNode(tree));
    card.appendChild(root);
    var time = el('div', 'time');
    var bar = el('span');
    time.appendChild(bar);
    card.appendChild(time);
    stage.appendChild(card);
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    requestAnimationFrame(function () { card.classList.add('show'); });
    if (seconds) {
      bar.style.transition = 'transform ' + seconds + 's linear';
      bar.style.transform = 'scaleX(0)';
    }
    return card;
  }

  // Keep the remote and pointer on the app underneath: no input region, no focus.
  function passThrough() {
    try { window.PalmSystem.setInputRegion([{x: 0, y: 0, width: 1, height: 1}]); } catch (e) {}
    try { window.PalmSystem.window.setFocus(false); } catch (e) {}
  }

  function cards() {
    return Array.prototype.slice.call(stage.querySelectorAll('.card'));
  }

  function close() {
    clearTimeout(hideTimer);
    cards().forEach(function (card) { card.classList.remove('show'); });
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      clearLiveTimers();
      stage.textContent = '';
      try { window.close(); } catch (e) {}
    }, 200);
  }

  function regionsOf(p) {
    var counter = {n: 0};
    var out = [];
    if (Array.isArray(p.regions)) {
      var seen = {};
      for (var i = 0; i < p.regions.length && i < MAX_REGIONS; i++) {
        var region = p.regions[i];
        if (!region || typeof region !== 'object') continue;
        var position = oneOf(region.position, POSITIONS);
        if (!position || seen[position]) continue;
        var tree = checkNode(region.root, 0, counter);
        if (!tree) continue;
        seen[position] = true;
        out.push({position: position, size: oneOf(region.size, SIZES) || 'm', tree: tree});
      }
    } else {
      var single = checkNode(p.root, 0, counter);
      if (single) out.push({position: oneOf(p.position, POSITIONS) || 'top-right', size: oneOf(p.size, SIZES) || 'm', tree: single});
    }
    return out;
  }

  // Left/right panels start below a top bar and end above a bottom bar, like a broadcast sidebar.
  function fitPanels() {
    var top = stage.querySelector('.card[data-pos="top"]');
    var bottom = stage.querySelector('.card[data-pos="bottom"]');
    var inset = {top: top ? top.offsetHeight + 'px' : '', bottom: bottom ? bottom.offsetHeight + 'px' : ''};
    ['left', 'right'].forEach(function (side) {
      var panel = stage.querySelector('.card[data-pos="' + side + '"]');
      if (panel) { panel.style.top = inset.top; panel.style.bottom = inset.bottom; }
    });
  }

  function render(p) {
    if (p.hide === true) return close();
    var regions = regionsOf(p);
    if (!regions.length) return; // malformed launch params from outside notify.js: draw nothing rather than guess
    clearTimeout(hideTimer);
    clearTimeout(closeTimer);
    clearLiveTimers();
    stage.textContent = '';
    applyTheme(checkTheme(p.theme));
    var seconds = typeof p.seconds === 'number' && p.seconds >= 0 && p.seconds <= 300 ? p.seconds : 8;
    regions.forEach(function (region) { makeCard(region.position, region.size, region.tree, seconds); });
    fitPanels();
    passThrough();
    if (seconds) hideTimer = setTimeout(close, seconds * 1000);
  }

  // A real button press dismisses the card; Magic Remote pointer activity (key codes 1536 and up) does not.
  document.addEventListener('keydown', function (event) {
    if (event.keyCode < 1536 && cards().length) close();
  });
  document.addEventListener('webOSRelaunch', function (event) {
    render(paramsOf(event && event.detail ? event.detail : window.PalmSystem && window.PalmSystem.launchParams));
  }, true);
  render(paramsOf(window.PalmSystem ? window.PalmSystem.launchParams : {}));
}());
