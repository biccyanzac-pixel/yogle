"""Does 3D disambiguate 'arm forward' vs 'arm in frontal plane' on front/back-view frames?

Compares, per model with world landmarks, a 3D feature (|cos| between upper-arm+forearm direction and the torso
normal) against the best 2D-only cue (2D arm length relative to torso length: forward arms look short).
Labels are hand-assigned (results/arm_labels.json). Only 'raised' arms (wrist > 0.6 torso from hip in GT) count.
python arm3d.py results/acc_yfa.json
"""
import json
import sys

import numpy as np

from analyze import auroc

ARMS = [(5, 7, 9, 11), (6, 8, 10, 12)]


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def main(res_file):
    files = json.load(open('frames/yfa/index.json'))
    gt = json.load(open('results/gt_yfa.json'))
    labels = {l['file']: l['label'] for l in json.load(open('results/arm_labels.json'))}
    runs = json.load(open(res_file))['runs']
    out = {}
    for model, run in runs.items():
        if 'error' in run:
            continue
        has3d = any(r and 'world' in r for r in run['results'])
        f3, f2, y = [], [], []
        for f, r in zip(files, run['results']):
            if f not in labels or r is None:
                continue
            G = np.array(gt[f]['kps'])
            T = max(np.linalg.norm(G[5, :2] - G[12, :2]), np.linalg.norm(G[6, :2] - G[11, :2]))
            P = np.array(r['kps'])
            W = np.array(r['world']) if has3d else None
            for sh, el, wr, hip in ARMS:
                if min(G[sh, 2], G[el, 2], G[wr, 2]) < 0.5 or np.linalg.norm(G[wr, :2] - G[hip, :2]) < 0.6 * T:
                    continue
                # 2D cue: shoulder->wrist length over shoulder->hip length (same side), from the model's own 2D output
                torso2d = np.linalg.norm(P[sh, :2] - P[hip, :2])
                f2.append(-np.linalg.norm(P[wr, :2] - P[sh, :2]) / max(torso2d, 1e-6))  # shorter => more 'forward'
                if has3d:
                    across = unit(W[6] - W[5])
                    up = unit((W[5] + W[6]) / 2 - (W[11] + W[12]) / 2)
                    normal = unit(np.cross(across, up))
                    arm = unit(W[wr] - W[sh])
                    f3.append(abs(np.dot(arm, normal)))
                y.append(labels[f] == 'FWD')
        y = np.array(y)
        row = {'n_arms': int(len(y)), 'n_fwd': int(y.sum()), 'auroc_2d_foreshortening': round(float(auroc(f2, y)), 3)}
        if has3d:
            f3 = np.array(f3)
            row['auroc_3d_out_of_plane'] = round(float(auroc(f3, y)), 3)
            # accuracy at a fixed, interpretable threshold: > 0.5 => arm more than 30 deg out of the frontal plane
            pred = f3 > 0.5
            row['acc_3d@30deg'] = round(float((pred == y).mean()), 3)
            row['fwd_recall_3d@30deg'] = round(float(pred[y].mean()), 3)
            row['frontal_specificity_3d@30deg'] = round(float((~pred[~y]).mean()), 3)
            row['median_outofplane_fwd'] = round(float(np.degrees(np.arcsin(np.median(f3[y])))), 1)
            row['median_outofplane_frontal'] = round(float(np.degrees(np.arcsin(np.median(f3[~y])))), 1)
        out[model] = row
        print(model.ljust(30), row)
    json.dump(out, open(res_file.replace('.json', '_arm3d.json'), 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1])
