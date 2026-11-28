// The remote view of one OMS session. Everything the model or a tool wrote is put on the page as text, never as markup.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Private browsing: the device pairs again next time.
      }
    },
  };

  // This device's own secret. It is made here, never shown, and only works once the terminal has allowed it.
  let secret = store.get('oms-client');
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    secret = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    store.set('oms-client', secret);
  }
  const call = (path, body, signal) =>
    fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + secret,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });

  const log = $('log');
  const rows = new Map();
  let me = { role: 'guest', name: '' };
  let status = { busy: false, model: '', yolo: false };
  let online = false;

  // ---------------------------------------------------------------- the conversation

  /** `code` and **bold** inside one line. */
  function inline(parent, text) {
    for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!part) continue;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
        parent.append(el('code', '', part.slice(1, -1)));
      else if (part.length > 4 && part.startsWith('**') && part.endsWith('**'))
        parent.append(el('strong', '', part.slice(2, -2)));
      else parent.append(part);
    }
  }
  /** The small part of Markdown replies use: code fences, headings, lists, paragraphs. */
  function prose(parent, text) {
    const parts = text.split(/```[^\n]*\n?/);
    parts.forEach((part, index) => {
      if (index % 2) {
        const pre = el('pre');
        pre.append(el('code', '', part.replace(/\n$/, '')));
        parent.append(pre);
        return;
      }
      for (const block of part.split(/\n{2,}/)) {
        const lines = block.split('\n').filter((line) => line.trim());
        if (!lines.length) continue;
        const bullet = /^\s*(?:[-*]|\d+[.)])\s+/;
        if (lines.every((line) => bullet.test(line))) {
          const list = el(/^\s*\d/.test(lines[0]) ? 'ol' : 'ul');
          for (const line of lines) inline(list.appendChild(el('li')), line.replace(bullet, ''));
          parent.append(list);
          continue;
        }
        const heading = lines.length === 1 && /^#{1,6}\s+(.*)$/.exec(lines[0]);
        const node = el(heading ? 'h3' : 'p');
        if (heading) inline(node, heading[1]);
        else
          lines.forEach((line, at) => {
            if (at) node.append(el('br'));
            inline(node, line);
          });
        parent.append(node);
      }
    });
  }

  function draw(entry) {
    if (entry.kind === 'user') return el('div', 'user', entry.text);
    if (entry.kind === 'assistant') {
      const node = el('div', 'assistant' + (entry.streaming ? ' streaming' : ''));
      prose(node, entry.text);
      if (entry.ending) node.append(el('p', 'ending', entry.ending));
      return node;
    }
    if (entry.kind === 'tool') {
      const node = el('details', 'tool ' + entry.state);
      const summary = node.appendChild(el('summary'));
      summary.append(
        el('b', '', entry.title),
        el('span', 'target', entry.target),
        el('span', 'summary', entry.summary),
      );
      if (entry.output) node.append(el('pre', '', entry.output));
      return node;
    }
    const node = el('div', 'note');
    if (entry.label) node.append(el('b', '', entry.label));
    node.append(entry.text);
    return node;
  }
  function put(entry) {
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const next = draw(entry);
    const old = rows.get(entry.key);
    // An opened tool row stays open while its output grows.
    if (old && old.tagName === 'DETAILS' && old.open) next.open = true;
    if (old) old.replaceWith(next);
    else log.append(next);
    rows.set(entry.key, next);
    if (atEnd) log.scrollTop = log.scrollHeight;
  }
  function reset(entries) {
    log.replaceChildren();
    rows.clear();
    for (const entry of entries) put(entry);
    log.scrollTop = log.scrollHeight;
  }

  // ---------------------------------------------------------------- status, people, approvals

  function showStatus() {
    document.body.classList.toggle('busy', online && status.busy);
    $('sub').textContent = !online
      ? 'Reconnecting…'
      : [status.busy ? 'Working…' : 'Ready', status.model, status.yolo ? 'YOLO' : ''].filter(Boolean).join(' · ');
    $('stop').hidden = !(online && status.busy && me.role === 'owner');
    $('send').disabled = !online || status.busy;
    const asked = online && me.role === 'owner' ? status.approval : undefined;
    $('approval').hidden = !asked;
    if (asked) {
      $('approval').dataset.id = String(asked.id);
      $('approval-title').textContent = asked.title;
      $('approval-reasons').textContent = asked.reasons.join(' · ');
      $('approval-command').textContent = asked.command;
      $('approval-session').hidden = !asked.session;
    }
    if (online && status.waiting) flash('Waiting for the host to approve a command.');
  }
  function showPeople(people) {
    $('people').replaceChildren(
      ...people.map((person) => {
        const item = el('li', person.live ? 'live' : '');
        item.append(el('span', '', person.name));
        item.title = person.name + (person.live ? ' · here now' : ' · away');
        return item;
      }),
    );
  }
  let flashTimer;
  function flash(text) {
    $('flash').textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ($('flash').textContent = ''), 4000);
  }
  async function post(path, body) {
    try {
      const response = await call(path, body);
      if (response.ok) return true;
      const problem = await response.json().catch(() => ({}));
      flash(typeof problem.error === 'string' ? problem.error : 'That did not work.');
    } catch {
      flash('The session is not reachable right now.');
    }
    return false;
  }

  // ---------------------------------------------------------------- pairing

  const GATES = {
    pair: ['Pair this device', 'Type the code that /remote shows in the terminal.'],
    name: ['Join this session', 'Say who you are, so the host knows who is asking.'],
    wrong: ['That code did not match', 'Codes change after each use. Type the one /remote shows now.'],
    wait: ['Allow it in the terminal', 'OMS is asking there whether this device may connect.'],
    denied: ['Not allowed', 'The terminal said no. Ask for a new code or link to try again.'],
    slow: ['Too many tries', 'Wait a minute, then try again.'],
    offline: ['Not reachable', 'This session is not running, or this device is on another network.'],
    paused: ['Not shared right now', 'The host has turned sharing off. This page comes back when it is on again.'],
  };
  let linkCode = '';
  function gate(kind) {
    $('gate').hidden = !kind;
    if (!kind) return;
    $('gate-title').textContent = GATES[kind][0];
    $('gate-text').textContent = GATES[kind][1];
    const form = kind === 'pair' || kind === 'wrong' || kind === 'name' || kind === 'denied';
    $('gate-form').hidden = !form;
    $('gate-name').hidden = kind !== 'name';
    $('gate-code').hidden = kind === 'name';
    if (form) (kind === 'name' ? $('gate-name') : $('gate-code')).focus();
  }
  $('gate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!$('gate-name').hidden) {
      const name = $('gate-name').value.trim();
      if (!name) return;
      store.set('oms-name', name);
      return void hello(linkCode);
    }
    const code = $('gate-code').value.trim();
    if (code) void hello(code);
  });

  async function hello(code) {
    // An invitation is longer than a pairing code, and its guest gives a name first.
    if (code.replace(/[^a-z0-9]/gi, '').length > 12 && !store.get('oms-name')) {
      linkCode = code;
      return gate('name');
    }
    if (code) gate('wait');
    for (;;) {
      let response;
      try {
        response = await fetch('/api/hello', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client: secret, code, name: store.get('oms-name') || '' }),
        });
      } catch {
        gate('offline');
        await sleep(3000);
        continue;
      }
      if (response.status === 200) {
        me = await response.json();
        gate(null);
        return void connect();
      }
      if (response.status === 202) continue;
      if (response.status === 401) return gate(code ? 'wrong' : 'pair');
      if (response.status === 403) return gate('denied');
      if (response.status === 429) return gate('slow');
      gate('offline');
      await sleep(3000);
    }
  }

  // ---------------------------------------------------------------- the live stream

  let lastHeard = 0;
  let stream;
  function handle(event, data) {
    if (event === 'state') {
      me = data.me;
      status = data.status;
      reset(data.entries);
    } else if (event === 'entry') put(data);
    else if (event === 'clear') reset([]);
    else if (event === 'status') status = data;
    else if (event === 'people') return showPeople(data);
    showStatus();
  }
  async function connect() {
    let delay = 500;
    for (;;) {
      stream = new AbortController();
      try {
        const response = await call('/api/events', undefined, stream.signal);
        if (response.status === 401) return void hello('');
        if (response.status === 403) gate('paused');
        if (!response.ok) throw new Error('unavailable');
        gate(null);
        online = true;
        delay = 500;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          lastHeard = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.*)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (event && data) handle(event[1], JSON.parse(data[1]));
          }
        }
      } catch {
        // Dropped: say so and try again.
      }
      online = false;
      showStatus();
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
    }
  }
  // A phone that slept can hold a dead connection open: the server speaks every 20 seconds, so silence means reconnect.
  setInterval(() => {
    if (online && Date.now() - lastHeard > 45000) stream.abort();
  }, 10000);

  // ---------------------------------------------------------------- sending

  const text = $('text');
  const fit = () => {
    text.style.height = 'auto';
    text.style.height = Math.min(text.scrollHeight, innerHeight * 0.4) + 'px';
  };
  text.addEventListener('input', fit);
  text.addEventListener('keydown', (event) => {
    // A keyboard sends on Enter; a touch keyboard's Enter is a new line and its Send button sends.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = text.value.trim();
    if (!message || $('send').disabled) return;
    if (await post('/api/send', { text: message })) {
      text.value = '';
      fit();
    }
  });
  $('stop').addEventListener('click', () => void post('/api/cancel', {}));
  $('approval').addEventListener('click', (event) => {
    const answer = event.target instanceof HTMLElement && event.target.dataset.answer;
    if (answer) void post('/api/approval', { id: Number($('approval').dataset.id), answer });
  });

  // The bot blinks now and then, unless motion is unwelcome.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    setInterval(
      () => {
        document.body.classList.add('blink');
        setTimeout(() => document.body.classList.remove('blink'), 160);
      },
      3200 + Math.random() * 1800,
    );
  if (window.isSecureContext && 'serviceWorker' in navigator)
    navigator.serviceWorker.register('/sw.js').catch(() => {});

  // A link can carry the code after #. It is read once and taken out of the address bar.
  const fromLink = decodeURIComponent(location.hash.slice(1));
  if (fromLink) history.replaceState(null, '', location.pathname);
  void hello(fromLink);
})();
