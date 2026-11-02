/* Evaluate this async function in the actual overlay page (check-visual.mjs runs it). */
(async function () {
  var api = window.webosFoundryOverlay;
  function assert(condition, message) { if (!condition) throw new Error(message); }
  var originalTimeout = window.setTimeout, originalClear = window.clearTimeout, originalClose = window.close;
  var timers = new Map(), next = 1, closed = 0, checks = 0;
  window.setTimeout = function (callback, milliseconds) { var id = next++; timers.set(id, {callback: callback, ms: milliseconds}); return id; };
  window.clearTimeout = function (id) { timers.delete(id); };
  window.close = function () { closed++; };
  function run(id) { var job = timers.get(id); assert(job, 'Expected scheduled lifecycle timer'); timers.delete(id); job.callback(); }
  function byDelay(ms) { return Array.from(timers.entries()).find(function (entry) { return entry[1].ms === ms; }); }
  function show(card) { api.render(card); checks++; }
  try {
    var initial = {seconds: 20, animation: {enter: 'fade', exit: 'wipe', duration_ms: 50}, offset: {x: 12, y: -8},
      root: {type: 'grid', columns: 2, gap: 16, children: [
        {type: 'text', text: 'One', color: 'accent'},
        {type: 'clock', format: 'seconds', label: 'Now'},
        {type: 'progress', value: 0.25, label: 'Quarter'},
        {type: 'ticker', text: 'Real scrolling text', speed: 40}
      ]}};
    show(initial);
    var card = document.querySelector('.card:not(.retiring)'), text = document.querySelector('.w-text');
    var clock = document.querySelector('.w-clock-face'), progress = document.querySelector('.w-progress');
    var ticker = document.querySelector('.w-ticker-text'), enter = card._motion;
    var expiry = byDelay(20000)[0];
    text.tabIndex = 0; text.focus();
    var updated = JSON.parse(JSON.stringify(initial));
    updated.root.children[0] = {type: 'text', text: 'Two'};
    updated.root.children[2] = {type: 'progress', value: 0.75};
    delete updated.offset;
    show(updated);
    assert(card === document.querySelector('.card:not(.retiring)'), 'Value refresh retains card identity');
    assert(text === document.querySelector('.w-text') && text.textContent === 'Two', 'Value refresh patches text in place');
    assert(clock === document.querySelector('.w-clock-face'), 'Unchanged clock identity and ticker survive refresh');
    assert(ticker === document.querySelector('.w-ticker-text'), 'Unchanged ticker identity survives refresh');
    assert(progress === document.querySelector('.w-progress') && !progress.querySelector('.w-progress-label'), 'Removed optional labels are cleared');
    assert(document.querySelector('.w-text').dataset.color === 'fg', 'Removed optional styling is cleared');
    assert(card.style.getPropertyValue('--offset-x') === '0px', 'Removed offset resets');
    assert(card._motion === enter && timers.has(expiry), 'Value refresh restarts neither enter animation nor expiry');
    assert(document.activeElement === text, 'Refresh preserves focus');
    updated.root.children[2] = {type: 'badge', text: 'Changed'};
    show(updated);
    assert(!document.querySelector('.w-progress') && document.querySelector('.w-badge'), 'Type changes replace affected widget');
    assert(clock === document.querySelector('.w-clock-face'), 'Type changes retain siblings');
    show({action: 'runtime', dim: 0.4, compact: true, hidden: true});
    assert(document.getElementById('stage').hidden && document.getElementById('stage').dataset.compact === 'true', 'Runtime hide and compact apply');
    assert(timers.has(expiry) && card === document.querySelector('.card:not(.retiring)'), 'Runtime does not reset lifecycle');
    show({action: 'runtime', dim: 1, compact: false, hidden: false});
    assert(!document.getElementById('stage').hidden && document.getElementById('stage').style.filter === '', 'Runtime state clears explicitly');
    var frames = [{seconds: 1, card: {root: {type: 'text', text: 'Frame one'}}},
      {seconds: 2, card: {root: {type: 'text', text: 'Frame two'}}}];
    show({timeline: frames});
    var advance = byDelay(1000)[0];
    show({action: 'runtime', compact: true});
    assert(timers.has(advance), 'Runtime retains timeline timer');
    run(advance);
    assert(document.querySelector('.card:not(.retiring) .w-text').textContent === 'Frame two', 'Timeline advances in same overlay lifetime');
    var final = byDelay(2000)[0];
    show({seconds: 0, root: {type: 'qr', text: 'https://webosfoundry.dev', size: 's'}});
    assert(!timers.has(final), 'Replacing timeline cancels future frames');
    assert(document.querySelector('.w-qr svg path').getAttribute('d').length > 100, 'QR uses actual encoded modules');
    show({seconds: 0, root: {type: 'svg', source: '<svg viewBox="0 0 24 24"><path d="M0 0L24 24" stroke="#fff"/></svg>'}});
    assert(document.querySelector('.w-svg svg').namespaceURI === 'http://www.w3.org/2000/svg', 'Inline SVG gets SVG namespace');
    var safe = document.querySelector('.w-svg');
    show({seconds: 0, root: {type: 'svg', source: '<svg onload="alert(1)"/>'}});
    assert(document.querySelector('.w-svg') === safe && !document.querySelector('[onload]'), 'Unsafe SVG is rejected before DOM mutation');
    show({timeline: frames});
    var pending = byDelay(1000)[0];
    show({hide: true});
    assert(!timers.has(pending), 'Hide cancels timeline');
    Array.from(timers.entries()).forEach(function (entry) { run(entry[0]); });
    assert(!document.querySelector('.card') && closed > 0, 'Hide finishes cleanup and closes app');
    show({timeline: frames, seconds: 1});
    run(byDelay(1000)[0]);
    assert(!document.querySelector('.card:not(.retiring)'), 'Explicit overall deadline closes timeline before later frames');
    return {checks: checks, passed: true};
  } finally {
    api.close();
    Array.from(timers.keys()).forEach(function (id) { if (timers.has(id)) run(id); });
    window.setTimeout = originalTimeout; window.clearTimeout = originalClear; window.close = originalClose;
  }
}())
