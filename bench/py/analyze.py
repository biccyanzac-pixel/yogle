"""Accuracy/robustness analysis of browser model outputs against RTMPose-x pseudo ground truth.

python analyze.py <frames_dir> <results_json> <gt_json> <out_prefix>
"""
import json
import sys
from collections import defaultdict

import numpy as np

L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN = range(5, 17)
BODY = list(range(5, 17))
# name: (a, vertex, c) -> angle at vertex
ANGLES = {
    'l_elbow': (L_SH, L_EL, L_WR), 'r_elbow': (R_SH, R_EL, R_WR),
    'l_shoulder': (L_HIP, L_SH, L_EL), 'r_shoulder': (R_HIP, R_SH, R_EL),
    'l_hip': (L_SH, L_HIP, L_KN), 'r_hip': (R_SH, R_HIP, R_KN),
    'l_knee': (L_HIP, L_KN, L_AN), 'r_knee': (R_HIP, R_KN, R_AN),
}
SWAP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]
GT_THR = 0.5
VIEW = {1: 'front', 2: 'side', 3: 'back', 4: 'side'}  # Yoga-for-all camera angles (checked visually)


def angle(p, a, b, c):
    v1, v2 = p[a, :2] - p[b, :2], p[c, :2] - p[b, :2]
    n = np.linalg.norm(v1) * np.linalg.norm(v2)
    if n < 1e-6:
        return np.nan
    return np.degrees(np.arccos(np.clip(np.dot(v1, v2) / n, -1, 1)))


def torso(gt):
    return max(np.linalg.norm(gt[L_SH, :2] - gt[R_HIP, :2]), np.linalg.norm(gt[R_SH, :2] - gt[L_HIP, :2]))


def auroc(scores, labels):
    """P(score of a correct keypoint > score of an incorrect one)."""
    s, l = np.asarray(scores), np.asarray(labels, bool)
    if l.all() or (~l).all():
        return np.nan
    order = s.argsort()
    ranks = np.empty(len(s)); ranks[order] = np.arange(1, len(s) + 1)
    npos = l.sum(); nneg = len(l) - npos
    return (ranks[l].sum() - npos * (npos + 1) / 2) / (npos * nneg)


def main(frames_dir, res_file, gt_file, out_prefix):
    meta = {m['file']: m for m in json.load(open(f'{frames_dir}/meta.json'))}
    files = json.load(open(f'{frames_dir}/index.json'))
    gt = json.load(open(gt_file))
    runs = json.load(open(res_file))['runs']
    summary = {}
    for model, run in runs.items():
        if 'error' in run:
            summary[model] = {'error': run['error'][:200]}
            continue
        groups = defaultdict(lambda: defaultdict(list))
        conf_s, conf_ok = [], []
        per_joint_conf = defaultdict(list)
        for f, r in zip(files, run['results']):
            m = meta[f]
            keys = ['all', 'pose:' + m['pose'], 'view:' + VIEW.get(m.get('angle'), 'n/a'),
                    'exec:' + ('correct' if m['correct'] else 'wrong')]
            g = gt.get(f)
            if g is None:
                continue
            G = np.array(g['kps'])
            if (G[BODY, 2] > GT_THR).sum() < 6:
                continue  # GT itself unreliable
            for k in keys:
                groups[k]['detected'].append(r is not None)
            if r is None:
                continue
            P = np.array(r['kps'], float)
            T = torso(G)
            valid = [j for j in BODY if G[j, 2] > GT_THR]
            d = np.array([np.linalg.norm(P[j, :2] - G[j, :2]) / T for j in valid])
            dsw = np.array([np.linalg.norm(P[SWAP[j], :2] - G[j, :2]) / T for j in valid])
            swapped = dsw.mean() < 0.6 * d.mean() and d.mean() > 0.1
            for k in keys:
                groups[k]['pck20'].extend(d < 0.2)
                groups[k]['pck10'].extend(d < 0.1)
                groups[k]['lr_swap'].append(swapped)
            for j, dj in zip(valid, d):
                conf_s.append(P[j, 2]); conf_ok.append(dj < 0.2)
                per_joint_conf[j].append(P[j, 2])
            for name, (a, b, c) in ANGLES.items():
                if min(G[a, 2], G[b, 2], G[c, 2]) > GT_THR:
                    e = abs(angle(P, a, b, c) - angle(G, a, b, c))
                    if not np.isnan(e):
                        for k in keys:
                            groups[k]['ang_err'].append(e)
                            groups[k]['ang_err:' + name.split('_')[1]].append(e)
        s = {}
        for k, v in groups.items():
            row = {'n': len(v['detected']), 'det': np.mean(v['detected'])}
            for q in ['pck20', 'pck10', 'lr_swap']:
                if v[q]:
                    row[q] = float(np.mean(v[q]))
            if v['ang_err']:
                a = np.array(v['ang_err'])
                row.update(ang_mae=float(a.mean()), ang_med=float(np.median(a)), ang_p90=float(np.percentile(a, 90)),
                           ang_gt30=float((a > 30).mean()))
                for part in ['elbow', 'shoulder', 'hip', 'knee']:
                    if v['ang_err:' + part]:
                        row['mae_' + part] = float(np.mean(v['ang_err:' + part]))
            s[k] = row
        s['conf_auroc'] = float(auroc(conf_s, conf_ok))
        s['conf_mean_by_joint'] = {j: float(np.mean(v)) for j, v in sorted(per_joint_conf.items())}
        summary[model] = s
    json.dump(summary, open(out_prefix + '.json', 'w'), indent=1)
    # compact table
    cols = ['det', 'pck20', 'pck10', 'ang_mae', 'ang_med', 'ang_p90', 'ang_gt30', 'lr_swap']
    lines = ['model | ' + ' | '.join(cols) + ' | conf_auroc']
    for model, s in summary.items():
        if 'error' in s:
            lines.append(f'{model} | ERROR {s["error"][:80]}'); continue
        a = s['all']
        lines.append(model + ' | ' + ' | '.join(f'{a.get(c, float("nan")):.3f}' if c in ('det', 'pck20', 'pck10', 'ang_gt30', 'lr_swap') else f'{a.get(c, float("nan")):.1f}' for c in cols) + f' | {s["conf_auroc"]:.2f}')
    open(out_prefix + '.txt', 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main(*sys.argv[1:5])
