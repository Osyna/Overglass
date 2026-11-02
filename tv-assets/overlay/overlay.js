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
                      'compare', 'sparkline', 'section', 'event', 'stat', 'status', 'meta', 'clock', 'grid', 'ticker', 'qr', 'svg'];
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
  var timelineTimer = null;
  var timelineKey = null;
  var timelineIndex = 0;
  var activePayload = null;
  var runtimeState = {dim: 1, compact: false, hidden: false};

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
  function checkSvg(source) {
    const fail = () => { throw new Error('SVG must be a safe inline geometry document of at most 8192 characters'); };
    if (typeof source !== 'string' || source.length > 8192 || /[^\x20-\x7e]|&|<!|<\?/.test(source)) fail();
    source = source.replace(/^ +| +$/g, '');
    const tags = ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'];
    const scalars = ['width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'stroke-width'];
    const scalar = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:%|px)?$/;
    const paint = /^(?:none|currentColor|transparent|black|white|red|green|blue|yellow|gray|grey|#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)$/;
    const stack = [];
    let rootSeen = false;
    let pos = 0;
    while (pos < source.length) {
      if (source[pos] === ' ') { pos += 1; continue; }
      const tag = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)([^<>]*?)(\/?)>/.exec(source.slice(pos));
      if (!tag || !tags.includes(tag[2])) fail();
      const name = tag[2];
      if (tag[1]) {
        if (tag[4] || !/^ *$/.test(tag[3]) || stack.pop() !== name) fail();
      } else {
        if (!stack.length) {
          if (rootSeen || name !== 'svg') fail();
          rootSeen = true;
        } else if (name === 'svg') fail();
        let attrs = tag[3];
        const seen = new Set();
        while (attrs && !/^ *$/.test(attrs)) {
          const attr = /^ +([A-Za-z][A-Za-z0-9-]*) *= *(["'])(.*?)\2/.exec(attrs);
          if (!attr || seen.has(attr[1])) fail();
          const key = attr[1], value = attr[3];
          seen.add(key);
          let valid = false;
          if (key === 'xmlns') valid = !stack.length && value === 'http://www.w3.org/2000/svg';
          else if (scalars.includes(key)) valid = scalar.test(value);
          else if (key === 'fill' || key === 'stroke') valid = paint.test(value);
          else if (['opacity', 'fill-opacity', 'stroke-opacity'].includes(key)) {
            valid = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value) && Number(value) >= 0 && Number(value) <= 1;
          } else if (key === 'viewBox' || key === 'points') valid = /^[-+0-9.eE, ]+$/.test(value);
          else if (key === 'd') valid = /^[MmZzLlHhVvCcSsQqTtAa0-9eE+., -]+$/.test(value);
          else if (key === 'transform') valid = /^(?: *(?:matrix|translate|scale|rotate|skewX|skewY)\( *[-+0-9.eE, ]+\) *)+$/.test(value);
          else if (key === 'fill-rule') valid = ['nonzero', 'evenodd'].includes(value);
          else if (key === 'stroke-linecap') valid = ['butt', 'round', 'square'].includes(value);
          else if (key === 'stroke-linejoin') valid = ['miter', 'round', 'bevel'].includes(value);
          if (!valid) fail();
          attrs = attrs.slice(attr[0].length);
        }
        if (!tag[4]) stack.push(name);
      }
      pos += tag[0].length;
    }
    if (!rootSeen || stack.length) fail();
    return source;
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
    if (kind === 'stack' || kind === 'row' || kind === 'grid') {
      var limit = kind === 'row' ? 10 : 20;
      if (kind === 'grid') {
        if (!Number.isInteger(node.columns) || node.columns < 1 || node.columns > 3) return null;
        out.columns = node.columns;
      }
      if (!Array.isArray(node.children) || node.children.length < 1 || node.children.length > limit) return null;
      out.gap = typeof node.gap === 'number' && node.gap >= 0 && node.gap <= 48 ? node.gap : undefined;
      out.align = oneOf(node.align, ['start', 'center', 'end']);
      out.children = [];
      for (var i = 0; i < node.children.length; i++) {
        var child = checkNode(node.children[i], depth + 1, counter);
        if (!child) return null;
        out.children.push(child);
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
    } else if (kind === 'ticker' || kind === 'qr') {
      if (typeof node.text !== 'string' || Array.from(node.text).length > 1000 || /[\u0000-\u001f\u007f]/.test(node.text)) return null;
      out.text = node.text.trim();
      if (!out.text) return null;
      if (kind === 'ticker') {
        if (node.speed !== undefined && (!Number.isInteger(node.speed) || node.speed < 10 || node.speed > 200)) return null;
        out.speed = node.speed;
        out.tone = oneOf(node.tone, TONES);
      } else {
        try { if (unescape(encodeURIComponent(out.text)).length > 2953) return null; } catch (error) { return null; }
        out.size = oneOf(node.size, IMAGE_SIZES);
      }
    } else if (kind === 'svg') {
      try { out.source = checkSvg(node.source); } catch (error) { return null; }
      out.size = oneOf(node.size, IMAGE_SIZES);
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
    clock.dataset.target = targetIso;
    clock.textContent = formatCountdown(new Date(targetIso).getTime() - Date.now());
  }

  function formatClock(now, format) {
    if (format === 'date') return now.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'});
    var out = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    return format === 'seconds' ? out + ':' + pad2(now.getSeconds()) : out;
  }

  function startClock(clock, format) {
    clock.dataset.format = format;
    clock.textContent = formatClock(new Date(), format);
  }

  function ensureLiveTimer() {
    if (liveTimers.length) return;
    liveTimers.push(setInterval(function () {
      var countdowns = stage.querySelectorAll('.w-countdown-clock');
      var clocks = stage.querySelectorAll('.w-clock-face');
      for (var i = 0; i < countdowns.length; i++) {
        countdowns[i].textContent = formatCountdown(new Date(countdowns[i].dataset.target).getTime() - Date.now());
      }
      for (var j = 0; j < clocks.length; j++) clocks[j].textContent = formatClock(new Date(), clocks[j].dataset.format);
    }, 1000));
  }

  function buildNode(node) {
    var e;
    switch (node.type) {
      case 'stack':
      case 'row':
      case 'grid':
        e = el('div', 'w-' + node.type);
        if (node.type === 'grid') e.style.gridTemplateColumns = 'repeat(' + node.columns + ', minmax(0, 1fr))';
        if (node.gap !== undefined) e.style.gap = node.gap + 'px';
        if (node.align) e.dataset.align = node.align;
        node.children.forEach(function (child) { e.appendChild(renderNode(child)); });
        return e;
      case 'ticker':
        e = el('div', 'w-ticker');
        e.dataset.tone = node.tone || 'info';
        e.dataset.speed = node.speed || 50;
        e.appendChild(span('w-ticker-text', node.text));
        return e;
      case 'qr':
        e = el('div', 'w-qr');
        e.dataset.size = node.size || 'm';
        e.setAttribute('role', 'img');
        e.setAttribute('aria-label', 'QR code: ' + node.text);
        try {
          var code = window.qrcode(0, 'L');
          code.addData(node.text, 'Byte');
          code.make();
          var count = code.getModuleCount();
          var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 ' + (count + 8) + ' ' + (count + 8));
          svg.setAttribute('shape-rendering', 'crispEdges');
          var white = document.createElementNS(svg.namespaceURI, 'rect');
          white.setAttribute('width', '100%');
          white.setAttribute('height', '100%');
          white.setAttribute('fill', '#ffffff');
          svg.appendChild(white);
          var path = document.createElementNS(svg.namespaceURI, 'path');
          var commands = [];
          for (var row = 0; row < count; row++) {
            for (var col = 0; col < count; col++) {
              if (code.isDark(row, col)) commands.push('M' + (col + 4) + ' ' + (row + 4) + 'h1v1h-1z');
            }
          }
          path.setAttribute('d', commands.join(''));
          path.setAttribute('fill', '#000000');
          svg.appendChild(path);
          e.appendChild(svg);
        } catch (error) {
          e.setAttribute('role', 'alert');
          e.textContent = 'QR encoding failed: ' + error.message;
        }
        return e;
      case 'svg':
        e = el('div', 'w-svg');
        e.dataset.size = node.size || 'm';
        var source = node.source.indexOf('xmlns=') >= 0 || /xmlns *=/.test(node.source) ? node.source :
          node.source.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        var graphic = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
        e.appendChild(document.importNode(graphic, true));
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
        e.addEventListener('error', function () { e.hidden = true; });
        e.addEventListener('load', function () { e.hidden = false; });
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

  function renderNode(node) {
    var element = buildNode(node);
    element._widget = node;
    return element;
  }

  function morph(old, fresh) {
    if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) {
      old.parentNode.replaceChild(fresh, old);
      return fresh;
    }
    if (old.nodeType === 3) {
      if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
      return old;
    }
    Array.prototype.slice.call(old.attributes).forEach(function (attribute) {
      // Focusability is local interaction state, not part of a widget's JSON fields.
      if (attribute.name !== 'tabindex' && !fresh.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
    });
    Array.prototype.slice.call(fresh.attributes).forEach(function (attribute) {
      if (old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
    });
    var count = Math.max(old.childNodes.length, fresh.childNodes.length);
    var next = Array.prototype.slice.call(fresh.childNodes);
    for (var i = 0; i < count; i++) {
      if (!next[i]) { while (old.childNodes.length > i) old.removeChild(old.lastChild); break; }
      if (!old.childNodes[i]) old.appendChild(next[i]);
      else morph(old.childNodes[i], next[i]);
    }
    return old;
  }

  function patchNode(element, node) {
    var previous = element._widget;
    if (previous && JSON.stringify(previous) === JSON.stringify(node)) return element;
    if (!previous || previous.type !== node.type) {
      var replacement = renderNode(node);
      element.parentNode.replaceChild(replacement, element);
      return replacement;
    }
    if (node.children) {
      element.style.gap = node.gap === undefined ? '' : node.gap + 'px';
      if (node.align) element.dataset.align = node.align;
      else delete element.dataset.align;
      if (node.type === 'grid') element.style.gridTemplateColumns = 'repeat(' + node.columns + ', minmax(0, 1fr))';
      node.children.forEach(function (child, index) {
        if (element.children[index]) patchNode(element.children[index], child);
        else element.appendChild(renderNode(child));
      });
      while (element.children.length > node.children.length) element.removeChild(element.lastChild);
    } else {
      morph(element, buildNode(node));
    }
    element._widget = node;
    return element;
  }

  function motion(card, direction) {
    var settings = card._animation || {};
    var kind = settings[direction] || 'none';
    var duration = settings.duration_ms === undefined ? 180 : settings.duration_ms;
    if (kind === 'none' || duration === 0) return 0;
    var base = window.getComputedStyle(card).transform;
    var from = {}, to = {};
    if (kind === 'fade' || kind === 'slide') { from.opacity = 0; to.opacity = 1; }
    if (kind === 'slide') { from.transform = (base === 'none' ? '' : base + ' ') + 'translateY(24px)'; to.transform = base; }
    if (kind === 'wipe') { from.clipPath = 'inset(0 100% 0 0)'; to.clipPath = 'inset(0 0% 0 0)'; }
    if (card._motion) card._motion.cancel();
    card._motion = card.animate(direction === 'enter' ? [from, to] : [to, from],
      {duration: duration, easing: 'ease', fill: direction === 'enter' ? 'backwards' : 'forwards'});
    return duration;
  }

  function retire(card) {
    card.classList.add('retiring');
    card.setAttribute('aria-hidden', 'true');
    var duration = motion(card, 'exit');
    setTimeout(function () { card.remove(); }, duration);
    return duration;
  }

  function fitTickers() {
    var tickers = stage.querySelectorAll('.w-ticker');
    for (var i = 0; i < tickers.length; i++) {
      var ticker = tickers[i], content = ticker.firstChild;
      var distance = ticker.clientWidth + content.offsetWidth;
      var signature = distance + ':' + ticker.dataset.speed + ':' + content.textContent;
      if (ticker._motionKey === signature) continue;
      ticker._motionKey = signature;
      content.style.setProperty('--ticker-start', ticker.clientWidth + 'px');
      content.style.setProperty('--ticker-end', -content.offsetWidth + 'px');
      content.style.animationDuration = (distance / Number(ticker.dataset.speed)) + 's';
    }
  }

  function runtime(values) {
    var layoutChanged = (runtimeState.hidden && values.hidden === false) ||
      (typeof values.compact === 'boolean' && values.compact !== runtimeState.compact);
    if (values.dim !== undefined && typeof values.dim === 'number' && values.dim >= 0.2 && values.dim <= 1) runtimeState.dim = values.dim;
    if (typeof values.compact === 'boolean') runtimeState.compact = values.compact;
    if (typeof values.hidden === 'boolean') runtimeState.hidden = values.hidden;
    stage.style.filter = runtimeState.dim === 1 ? '' : 'brightness(' + runtimeState.dim + ')';
    stage.dataset.compact = String(runtimeState.compact);
    stage.hidden = runtimeState.hidden;
    if (layoutChanged && !runtimeState.hidden) { fitPanels(); fitTickers(); }
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

  function updateCard(card, region, seconds) {
    card.dataset.pos = region.position;
    card.dataset.size = region.size;
    card.dataset.pinned = String(seconds === 0);
    card._animation = region.animation || {};
    card.style.setProperty('--offset-x', (region.offset ? region.offset.x : 0) + 'px');
    card.style.setProperty('--offset-y', (region.offset ? region.offset.y : 0) + 'px');
    card.style.top = '';
    card.style.bottom = '';
    patchNode(card.querySelector('.root').firstChild, region.tree);
    if (card._seconds !== seconds) {
      card._seconds = seconds;
      var bar = card.querySelector('.time span');
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(1)';
      void bar.offsetWidth;
      if (seconds) {
        bar.style.transition = 'transform ' + seconds + 's linear';
        bar.style.transform = 'scaleX(0)';
      }
    }
  }

  function makeCard(region, seconds) {
    var card = el('article', 'card show');
    var root = el('div', 'root');
    root.appendChild(renderNode(region.tree));
    card.appendChild(root);
    var time = el('div', 'time');
    time.appendChild(el('span'));
    card.appendChild(time);
    stage.appendChild(card);
    updateCard(card, region, seconds);
    motion(card, 'enter');
    return card;
  }

  // Keep the remote and pointer on the app underneath: no input region, no focus.
  function passThrough() {
    try { window.PalmSystem.setInputRegion([{x: 0, y: 0, width: 1, height: 1}]); } catch (e) {}
    try { window.PalmSystem.window.setFocus(false); } catch (e) {}
  }

  function cards() {
    return Array.prototype.slice.call(stage.querySelectorAll('.card:not(.retiring)'));
  }

  function close() {
    clearTimeout(hideTimer);
    clearTimeout(timelineTimer);
    clearTimeout(closeTimer);
    timelineKey = null;
    activePayload = null;
    var duration = 0;
    cards().forEach(function (card) { duration = Math.max(duration, retire(card)); });
    closeTimer = setTimeout(function () {
      clearLiveTimers();
      stage.textContent = '';
      try { window.close(); } catch (e) {}
    }, duration);
  }

  function optionsOf(raw) {
    var out = {};
    if (raw.offset !== undefined) {
      if (!raw.offset || typeof raw.offset !== 'object') return null;
      var x = raw.offset.x === undefined ? 0 : raw.offset.x;
      var y = raw.offset.y === undefined ? 0 : raw.offset.y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 1920 || Math.abs(y) > 1080) return null;
      out.offset = {x: x, y: y};
    }
    if (raw.animation !== undefined) {
      var animation = raw.animation;
      if (!animation || typeof animation !== 'object') return null;
      out.animation = {};
      for (var i = 0; i < 2; i++) {
        var key = ['enter', 'exit'][i];
        if (animation[key] !== undefined) {
          if (!oneOf(animation[key], ['none', 'fade', 'slide', 'wipe'])) return null;
          out.animation[key] = animation[key];
        }
      }
      if (animation.duration_ms !== undefined) {
        if (!Number.isInteger(animation.duration_ms) || animation.duration_ms < 0 || animation.duration_ms > 2000) return null;
        out.animation.duration_ms = animation.duration_ms;
      }
    }
    return out;
  }

  function regionsOf(p, counter) {
    counter = counter || {n: 0};
    var out = [];
    var entries = p.regions === undefined ? [p] : p.regions;
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_REGIONS || (p.regions !== undefined && p.root !== undefined)) return out;
    var seen = {};
    for (var i = 0; i < entries.length; i++) {
      var region = entries[i];
      if (!region || typeof region !== 'object') return [];
      var position = region.position === undefined && p.regions === undefined ? 'top-right' : oneOf(region.position, POSITIONS);
      var size = region.size === undefined ? 'm' : oneOf(region.size, SIZES);
      if (!position || !size || seen[position]) return [];
      var tree = checkNode(region.root, 0, counter);
      var options = optionsOf(region);
      if (!tree || !options) return [];
      seen[position] = true;
      out.push({position: position, size: size, tree: tree, animation: options.animation, offset: options.offset});
    }
    return out;
  }

  // Left/right panels start below a top bar and end above a bottom bar, like a broadcast sidebar.
  function fitPanels() {
    var top = stage.querySelector('.card:not(.retiring)[data-pos="top"]');
    var bottom = stage.querySelector('.card:not(.retiring)[data-pos="bottom"]');
    var inset = {top: top ? top.offsetHeight + 'px' : '', bottom: bottom ? bottom.offsetHeight + 'px' : ''};
    var edges = [];
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      var card = stage.querySelector('.card:not(.retiring)[data-pos="' + side + '"]');
      if (card) edges.push(side);
      if (card && (side === 'left' || side === 'right')) { card.style.top = inset.top; card.style.bottom = inset.bottom; }
    });
    stage.dataset.edges = edges.join(' ');
  }

  function renderFrame(p, seconds, replace) {
    var regions = regionsOf(p);
    if (!regions.length) return false;
    clearTimeout(closeTimer);
    applyTheme(checkTheme(p.theme));
    runtime(runtimeState);
    var existing = cards();
    if (replace) { existing.forEach(retire); existing = []; }
    regions.forEach(function (region, index) {
      if (existing[index]) updateCard(existing[index], region, seconds);
      else makeCard(region, seconds);
    });
    existing.slice(regions.length).forEach(retire);
    fitPanels();
    fitTickers();
    ensureLiveTimer();
    passThrough();
    return true;
  }

  function timelineFrame(replace) {
    var frame = activePayload.timeline[timelineIndex];
    var payload = Object.assign({}, frame.card);
    if (payload.theme === undefined) payload.theme = activePayload.theme;
    renderFrame(payload, frame.seconds, replace);
    timelineTimer = setTimeout(function () {
      timelineIndex += 1;
      if (timelineIndex >= activePayload.timeline.length) return close();
      timelineFrame(true);
    }, frame.seconds * 1000);
  }

  function render(p) {
    p = paramsOf(p);
    if (p.hide === true) return close();
    if (p.action === 'runtime') { runtime(p); return; }
    if (p.timeline !== undefined) {
      if (!Array.isArray(p.timeline) || p.timeline.length < 1 || p.timeline.length > 4 || p.root !== undefined || p.regions !== undefined) return;
      var counter = {n: 0};
      for (var i = 0; i < p.timeline.length; i++) {
        var frame = p.timeline[i];
        if (!frame || !Number.isInteger(frame.seconds) || frame.seconds < 1 || frame.seconds > 300 ||
            !frame.card || frame.card.timeline !== undefined || !regionsOf(frame.card, counter).length) return;
      }
      var key = JSON.stringify(p.timeline.map(function (frame) { return frame.seconds; }));
      var preserve = timelineKey === key && activePayload && activePayload.timeline;
      var preserveDeadline = preserve && activePayload.seconds === p.seconds;
      if (!preserveDeadline) {
        clearTimeout(hideTimer);
        if (Number.isInteger(p.seconds) && p.seconds > 0 && p.seconds <= 300) hideTimer = setTimeout(close, p.seconds * 1000);
      }
      activePayload = p;
      runtime({dim: p.dim === undefined && !preserve ? 1 : p.dim,
        compact: p.compact === undefined && !preserve ? false : p.compact, hidden: preserve ? undefined : false});
      if (preserve) {
        var current = p.timeline[timelineIndex];
        var payload = Object.assign({}, current.card);
        if (payload.theme === undefined) payload.theme = p.theme;
        renderFrame(payload, current.seconds, false);
      } else {
        clearTimeout(timelineTimer);
        timelineKey = key;
        timelineIndex = 0;
        timelineFrame(false);
      }
      return;
    }
    var seconds = Number.isInteger(p.seconds) && p.seconds >= 0 && p.seconds <= 300 ? p.seconds : 8;
    var preserveTimer = activePayload && !activePayload.timeline && activePayload.seconds === p.seconds && cards().length;
    if (!regionsOf(p).length) return;
    clearTimeout(timelineTimer);
    timelineKey = null;
    activePayload = p;
    runtime({dim: p.dim === undefined && !preserveTimer ? 1 : p.dim,
      compact: p.compact === undefined && !preserveTimer ? false : p.compact, hidden: preserveTimer ? undefined : false});
    renderFrame(p, seconds, false);
    if (!preserveTimer) {
      clearTimeout(hideTimer);
      if (seconds) hideTimer = setTimeout(close, seconds * 1000);
    }
  }

  // A real button press dismisses the card; Magic Remote pointer activity (key codes 1536 and up) does not.
  document.addEventListener('keydown', function (event) {
    if (event.keyCode < 1536 && cards().length) close();
  });
  document.addEventListener('webOSRelaunch', function (event) {
    render(paramsOf(event && event.detail ? event.detail : window.PalmSystem && window.PalmSystem.launchParams));
  }, true);
  window.webosFoundryOverlay = {render: render, close: close};
  if (document.fonts) document.fonts.ready.then(function () { fitPanels(); fitTickers(); });
  window.addEventListener('resize', function () { fitPanels(); fitTickers(); });
  render(paramsOf(window.PalmSystem ? window.PalmSystem.launchParams : {}));
}());
