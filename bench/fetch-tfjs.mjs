import fs from 'node:fs'; import path from 'node:path';
const models = {
  'movenet-lightning': 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4',
  'movenet-thunder': 'https://tfhub.dev/google/tfjs-model/movenet/singlepose/thunder/4',
  'blazepose-detector': 'https://tfhub.dev/mediapipe/tfjs-model/blazepose_3d/detector/1',
  'blazepose-lite': 'https://tfhub.dev/mediapipe/tfjs-model/blazepose_3d/landmark/lite/2',
  'blazepose-full': 'https://tfhub.dev/mediapipe/tfjs-model/blazepose_3d/landmark/full/2',
  'blazepose-heavy': 'https://tfhub.dev/mediapipe/tfjs-model/blazepose_3d/landmark/heavy/2',
};
for (const [name, base] of Object.entries(models)) {
  const dir = path.join('models/tfjs', name); fs.mkdirSync(dir, { recursive: true });
  const mj = await (await fetch(base + '/model.json?tfjs-format=file')).json();
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(mj));
  let total = 0;
  for (const g of mj.weightsManifest) for (const p of g.paths) {
    const buf = Buffer.from(await (await fetch(base + '/' + p + '?tfjs-format=file')).arrayBuffer());
    fs.writeFileSync(path.join(dir, p), buf); total += buf.length;
  }
  console.log(name, (total / 1e6).toFixed(2), 'MB');
}
