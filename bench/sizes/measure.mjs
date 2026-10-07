import fs from 'node:fs'; import zlib from 'node:zlib';
const sz = (f) => { const b = fs.readFileSync(f); return { raw: b.length, gz: zlib.gzipSync(b, { level: 9 }).length, br: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length }; };
const sum = (fs_) => fs_.map(sz).reduce((a, b) => ({ raw: a.raw + b.raw, gz: a.gz + b.gz, br: a.br + b.br }));
const MB = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(v / 1e6).toFixed(2)]));
const tf = (n) => fs.readdirSync(`models/tfjs/${n}`).map((f) => `models/tfjs/${n}/${f}`);
const ORTW = 'node_modules/onnxruntime-web/dist/';
const stacks = {
  'runtime: mediapipe tasks-vision (js+wasm)': ['sizes/mp.out.js', 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm'],
  'runtime: tfjs core+webgl+pose-detection js': ['sizes/tfjs.out.js'],
  'runtime: onnxruntime-web webgpu js + jsep wasm': ['sizes/ort.out.js', ORTW + 'ort-wasm-simd-threaded.jsep.wasm'],
  'runtime: onnxruntime-web asyncify wasm (alt)': [ORTW + 'ort-wasm-simd-threaded.asyncify.wasm'],
  'runtime: onnxruntime-web plain wasm (cpu only)': [ORTW + 'ort-wasm-simd-threaded.wasm'],
  'weights: mp lite': ['models/pose_landmarker_lite.task'], 'weights: mp full': ['models/pose_landmarker_full.task'], 'weights: mp heavy': ['models/pose_landmarker_heavy.task'],
  'weights: movenet lightning': tf('movenet-lightning'), 'weights: movenet thunder': tf('movenet-thunder'),
  'weights: tfjs blazepose det+lite': [...tf('blazepose-detector'), ...tf('blazepose-lite')], 'weights: tfjs blazepose det+full': [...tf('blazepose-detector'), ...tf('blazepose-full')],
};
for (const p of ['fp32', 'fp16', 'int8']) {
  stacks[`weights: rtmpose-s+yolox-tiny ${p}`] = [`models/onnx/rtmpose-s.${p}.onnx`, `models/onnx/yolox-tiny.${p}.onnx`];
  stacks[`weights: rtmpose-m+yolox-tiny ${p}`] = [`models/onnx/rtmpose-m.${p}.onnx`, `models/onnx/yolox-tiny.${p}.onnx`];
  stacks[`weights: rtmo-s ${p}`] = [`models/onnx/rtmo-s.${p}.onnx`];
}
const out = {}; for (const [k, v] of Object.entries(stacks)) { out[k] = MB(sum(v)); console.log(k.padEnd(48), JSON.stringify(out[k])); }
fs.writeFileSync('results/sizes.json', JSON.stringify(out, null, 1));
