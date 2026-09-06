'use strict';

const http = require('node:http');

async function createGithubFake(options = {}) {
  const issues = [];
  const comments = [];
  const requests = [];
  const labels = [];
  let issueId = 0;
  let commentId = 0;
  let server;
  let lastPort;
  let failure = null;
  const failures = [];
  const sockets = new Set();
  const now = () => new Date(typeof options.now === 'function' ? options.now() : options.now || Date.now());
  const labelObjects = values => (values || []).map(value => typeof value === 'string' ? { name: value } : value);

  const fake = {
    url: '', issues, comments, requests, labels,
    seedIssue(payload = {}) {
      const number = payload.number || ++issueId;
      issueId = Math.max(issueId, number);
      const issue = {
        id: number, number, title: '', body: '', state: 'open', comments: 0,
        created_at: now().toISOString(), updated_at: now().toISOString(),
        html_url: `https://github.com/test/inbox/issues/${number}`,
        ...payload, labels: labelObjects(payload.labels)
      };
      issues.push(issue);
      return issue;
    },
    seedComment(issueNumber, payload = {}) {
      const id = payload.id || ++commentId;
      commentId = Math.max(commentId, id);
      const comment = {
        id, body: '', created_at: now().toISOString(), updated_at: now().toISOString(),
        ...payload, issue_number: Number(issueNumber)
      };
      comments.push(comment);
      const issue = issues.find(item => item.number === Number(issueNumber));
      if (issue) issue.comments = comments.filter(item => item.issue_number === issue.number).length;
      return comment;
    },
    failNext(status = 500, headers = {}, count = 1) {
      for (let i = 0; i < count; i++) failures.push({ status, headers });
    },
    setFailure(value) { failure = value; },
    async start(port = lastPort || options.port || 0) {
      if (server && server.listening) return fake;
      server = http.createServer((req, res) => {
        handle(req, res).catch(error => {
          if (!res.headersSent) reply(res, 500, { message: error.message });
          else res.destroy();
        });
      });
      server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      lastPort = server.address().port;
      fake.url = `http://127.0.0.1:${lastPort}`;
      return fake;
    },
    async close() {
      if (!server || !server.listening) return;
      await new Promise(resolve => {
        server.close(resolve);
        for (const socket of sockets) socket.destroy();
      });
    }
  };

  function reply(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', Date: now().toUTCString(), ...headers });
    res.end(status === 204 ? undefined : JSON.stringify(body));
  }

  function paginated(res, url, values) {
    const requested = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
    const perPage = Math.min(requested, options.pageSize || requested);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const headers = {};
    if (page * perPage < values.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      headers.Link = `<${next}>; rel="next"`;
    }
    reply(res, 200, values.slice((page - 1) * perPage, page * perPage), headers);
  }

  async function handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : undefined; } catch (_) { body = rawBody; }
    const entry = { method: req.method, url: req.url, headers: { ...req.headers }, body, rawBody };
    requests.push(entry);
    if (options.onRequest) await options.onRequest(entry, fake);
    const currentFailure = failures.shift() || failure;
    if (currentFailure) {
      if (currentFailure === 'drop' || currentFailure.drop || currentFailure.status === 'drop') { req.socket.destroy(); return; }
      const status = typeof currentFailure === 'number' ? currentFailure : currentFailure.status || 500;
      reply(res, status, currentFailure.body || { message: 'injected failure' }, currentFailure.headers);
      return;
    }
    const url = new URL(req.url, fake.url);
    const match = /^\/repos\/[^/]+\/[^/]+(.*)$/.exec(url.pathname);
    if (!match) { reply(res, 404, { message: 'Not Found' }); return; }
    const suffix = match[1];
    const method = req.method;
    if ((!suffix || suffix === '/') && method === 'GET') { reply(res, 200, { full_name: url.pathname.slice(7), permissions: { issues: 'write' } }); return; }
    if (/^\/contents\/?$/.test(suffix) && method === 'GET') { reply(res, options.contentsStatus || 403, { message: 'Forbidden' }); return; }
    if (suffix === '/pulls' && method === 'GET') { reply(res, options.pullsStatus || 403, []); return; }
    if (suffix === '/labels' && method === 'POST') {
      if (labels.some(label => label.name === body.name)) reply(res, 422, { message: 'already_exists' });
      else { labels.push(body); reply(res, 201, body); }
      return;
    }
    if (suffix === '/issues' && method === 'GET') {
      const state = url.searchParams.get('state') || 'open';
      const wantedLabels = (url.searchParams.get('labels') || '').split(',').filter(Boolean);
      let found = issues.filter(issue => (state === 'all' || issue.state === state) && wantedLabels.every(label => labelObjects(issue.labels).some(item => item.name === label)));
      const ascending = url.searchParams.get('direction') === 'asc';
      found = found.slice().sort((a, b) => ascending ? a.number - b.number : b.number - a.number);
      paginated(res, url, found); return;
    }
    if (suffix === '/issues' && method === 'POST') { reply(res, 201, fake.seedIssue(body)); return; }
    const commentMatch = /^\/issues\/comments\/(\d+)$/.exec(suffix);
    if (commentMatch) {
      const index = comments.findIndex(comment => comment.id === Number(commentMatch[1]));
      if (index < 0) { reply(res, 404, { message: 'Not Found' }); return; }
      const comment = comments[index];
      if (method === 'GET') { reply(res, 200, comment); return; }
      if (method === 'PATCH') { Object.assign(comment, body, { updated_at: now().toISOString() }); reply(res, 200, comment); return; }
      if (method === 'DELETE') {
        comments.splice(index, 1);
        const issue = issues.find(item => item.number === comment.issue_number);
        if (issue) issue.comments = comments.filter(item => item.issue_number === issue.number).length;
        reply(res, 204); return;
      }
    }
    const issueMatch = /^\/issues\/(\d+)(\/comments|\/labels(?:\/[^/]+)?)?$/.exec(suffix);
    if (issueMatch) {
      const issue = issues.find(item => item.number === Number(issueMatch[1]));
      if (!issue) { reply(res, 404, { message: 'Not Found' }); return; }
      if (!issueMatch[2] && method === 'GET') { reply(res, 200, issue); return; }
      if (!issueMatch[2] && method === 'PATCH') {
        Object.assign(issue, body, { updated_at: now().toISOString() });
        issue.labels = labelObjects(issue.labels);
        reply(res, 200, issue); return;
      }
      if (issueMatch[2] === '/comments' && method === 'GET') {
        paginated(res, url, comments.filter(comment => comment.issue_number === issue.number).sort((a, b) => a.id - b.id)); return;
      }
      if (issueMatch[2] === '/comments' && method === 'POST') { reply(res, 201, fake.seedComment(issue.number, body)); return; }
      if (issueMatch[2] === '/labels' && method === 'POST') {
        const added = labelObjects(Array.isArray(body) ? body : body.labels);
        issue.labels = labelObjects(issue.labels);
        for (const label of added) if (!issue.labels.some(item => item.name === label.name)) issue.labels.push(label);
        reply(res, 200, issue.labels); return;
      }
      if (issueMatch[2] && issueMatch[2].startsWith('/labels/') && method === 'DELETE') {
        const name = decodeURIComponent(issueMatch[2].slice('/labels/'.length));
        issue.labels = labelObjects(issue.labels).filter(label => label.name !== name);
        reply(res, 200, issue.labels); return;
      }
    }
    reply(res, 404, { message: 'Not Found' });
  }

  for (const issue of options.issues || []) fake.seedIssue(issue);
  for (const comment of options.comments || []) fake.seedComment(comment.issue_number, comment);
  await fake.start();
  return fake;
}

module.exports = { createGithubFake };
