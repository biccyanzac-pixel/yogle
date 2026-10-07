"""Pseudo ground truth: RTMPose-x (384x288) + YOLOX-m over a frames dir -> results/gt_<name>.json"""
import json, sys, os, cv2, time
sys.path.insert(0, os.path.dirname(__file__))
from rtm import TopDown
d = sys.argv[1]; name = os.path.basename(d.rstrip('/'))
td = TopDown(); out = {}; t = time.time()
for f in json.load(open(f'{d}/index.json')):
    k, b = td(cv2.imread(f'{d}/{f}'))
    out[f] = None if k is None else {'kps': k.round(2).tolist(), 'box': b[:5].round(2).tolist()}
json.dump(out, open(f'results/gt_{name}.json', 'w'))
print(name, len(out), 'frames', round(time.time() - t), 's', sum(v is None for v in out.values()), 'no-detection')
