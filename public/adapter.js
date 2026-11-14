/* Connects the CRM page to this server's API. The page asks for capabilities by name
   (db, sample, user, app); here they are backed by REST calls instead of the Claude viewer. */
(function () {
  async function call(method, url, body) {
    let r;
    try {
      r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw { code: 'unavailable', message: 'The server could not be reached.' }; }
    if (r.status === 401) { location.href = '/login'; throw { code: 'revoked', message: 'Signed out.' }; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: r.status === 429 ? 'rate_limited' : r.status === 400 ? 'invalid_argument' : 'unavailable', message: data.error || 'The request failed.' };
    return data;
  }

  const collections = {};
  function collection(name) {
    if (collections[name]) return collections[name];
    const real = name === 'leads' || name === 'deals';
    const subs = [];
    let last = null;
    const snapshot = rows => ({ docs: rows.map(r => ({ id: r.id, data: () => r })), metadata: { fromCache: false } });
    async function refresh(force) {
      if (!subs.length) return;
      let rows = [];
      if (real) { try { rows = (await call('GET', '/api/' + name)).rows; } catch (e) { return; } }
      const key = JSON.stringify(rows);
      if (!force && key === last) return;
      last = key;
      subs.forEach(fn => fn(snapshot(rows)));
    }
    const write = p => (real ? p().then(r => { refresh(); return r; }) : Promise.resolve());
    const api = {
      add: data => write(() => call('POST', '/api/' + name, data)),
      doc: id => ({
        id,
        set: data => write(() => call('PUT', '/api/' + name + '/' + encodeURIComponent(id), data)),
        update: data => write(() => call('PATCH', '/api/' + name + '/' + encodeURIComponent(id), data)),
        delete: () => write(() => call('DELETE', '/api/' + name + '/' + encodeURIComponent(id))),
      }),
      onSnapshot(next) {
        subs.push(next);
        refresh(true);
        if (real && subs.length === 1) {
          setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
          document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
        }
        return () => { const i = subs.indexOf(next); if (i >= 0) subs.splice(i, 1); };
      },
    };
    collections[name] = api;
    return api;
  }

  const me = call('GET', '/api/me');
  const caps = {
    db: async () => ({ collection }),
    user: async () => ({ can: async () => true }),
    sample: async () => {
      if (!(await me).ai) return null;
      return async (prompt, opts) => {
        const d = await call('POST', '/api/ai', { prompt: String(prompt) });
        if (opts && opts.onText) opts.onText({ text: d.text, delta: d.text });
        return { text: d.text };
      };
    },
    app: async () => ({
      me: (await me).user,
      orderFormUrl: location.origin + '/order',
      users: {
        list: async () => (await call('GET', '/api/users')).rows,
        add: u => call('POST', '/api/users', u),
        remove: id => call('DELETE', '/api/users/' + encodeURIComponent(id)),
      },
      changePassword: (current, next) => call('POST', '/api/password', { current, next }),
      logout: async () => { await call('POST', '/api/logout'); location.href = '/login'; },
    }),
  };
  window.claude = { use: name => (caps[name] ? caps[name]() : Promise.resolve(null)) };
})();
