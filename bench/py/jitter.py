"""Temporal stability on held-pose clips (sequential 'fps' mode results, i.e. tracking + model smoothing as shipped).

jitter = median |angle_t - angle_{t-1}| over the 8 scoring angles, plus high-frequency noise = std of the residual
after a 9-frame running median. Also counts 'dropouts' (no person, or a scored joint below 0.5 confidence).
python jitter.py results/jit_*.json
"""
import json
import sys
from collections import defaultdict

import numpy as np

from analyze import ANGLES, angle


def running_median(x, k=9):
    h = k // 2
    return np.array([np.nanmedian(x[max(0, i - h):i + h + 1]) for i in range(len(x))])


def main(files):
    agg = defaultdict(lambda: defaultdict(list))
    for fn in files:
        clip = fn.split('jit_')[-1].replace('.json', '')
        runs = json.load(open(fn))['runs']
        for model, run in runs.items():
            if 'error' in run:
                continue
            res = run['results']
            drop = 0
            nop = 0
            scorable = []
            series = {k: [] for k in ANGLES}
            for r in res:
                if r is None:
                    drop += 1
                    nop += 1
                    scorable.append(0)
                    for k in series:
                        series[k].append(np.nan)
                    continue
                P = np.array(r['kps'])
                lowconf = False
                for k, (a, b, c) in ANGLES.items():
                    ok = min(P[a, 2], P[b, 2], P[c, 2]) >= 0.5
                    lowconf |= not ok
                    series[k].append(angle(P, a, b, c) if ok else np.nan)
                drop += lowconf
                scorable.append(np.mean([np.isfinite(series[k][-1]) for k in series]))
            d1, hf = [], []
            for k, s in series.items():
                s = np.array(s, float)
                if np.isfinite(s).sum() < 20:
                    continue
                d = np.abs(np.diff(s)); d1.extend(d[np.isfinite(d)])
                res_ = s - running_median(s); hf.append(np.nanstd(res_))
            agg[model]['jitter_med'].append(np.median(d1) if d1 else np.nan)
            agg[model]['jitter_p90'].append(np.percentile(d1, 90) if d1 else np.nan)
            agg[model]['hf_std'].append(np.nanmean(hf) if hf else np.nan)
            agg[model]['dropout'].append(drop / len(res))
            agg[model]['no_person'].append(nop / len(res))
            agg[model]['scorable_frac'].append(float(np.mean(scorable)))
            agg[model]['clips'].append(clip)
    out = {}
    for model, v in agg.items():
        out[model] = {k: round(float(np.nanmean(x)), 2) for k, x in v.items() if k != 'clips'}
        out[model]['per_clip_scorable'] = dict(zip(v['clips'], [round(x, 2) for x in v['scorable_frac']]))
        print(model.ljust(32), {k: out[model][k] for k in ['jitter_med', 'jitter_p90', 'hf_std', 'no_person', 'scorable_frac']})
    json.dump(out, open('results/jitter_summary.json', 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1:])
