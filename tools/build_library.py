"""Build Yogle's pose library from real human skeletons (3DYoga90: BlazePose world landmarks from YouTube yoga videos).

For every pose:
  1. per sequence: median skeleton over its steadiest frames (sequences that never hold still are dropped)
  2. camera view: 'front' (chest towards camera) or 'side' (profile). Majority of the source videos decides, because
     instructors film each pose from the angle that shows it best. Lying poses are always seen in profile.
  3. every sequence is rotated about the vertical axis into that view, and flipped to the same working side
  4. target = per-feature circular median across people; tolerance from the inter-person spread
  5. display skeleton = the medoid sequence: a real person, so the shown pose is achievable
  6. difficulty 1-10 from transparent components (docs/pose-library.md)

Output: site/data/poses.json
python tools/build_library.py bench/data/3dyoga90 bench/data/3dyoga90_repo/data/pose-index.csv
"""
import csv
import json
import math
import os
import sys

import numpy as np
import pandas as pd

# MediaPipe 33-landmark indices
NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR = 0, 11, 12, 13, 14, 15, 16
L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN = 23, 24, 25, 26, 27, 28
L_HEEL, R_HEEL, L_FT, R_FT = 29, 30, 31, 32
SWAP = [0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31]
DISPLAY = [NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN, L_HEEL, R_HEEL, L_FT, R_FT]
BODY = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN]

# Scored features: signed segment orientations in the image plane (degrees; 0 = pointing down, torso 0 = upright,
# +90 = towards image right). Must stay identical to site/js/angles.js.
SEGMENTS = {
    'torso': None,
    'l_upper_arm': (L_SH, L_EL), 'r_upper_arm': (R_SH, R_EL),
    'l_forearm': (L_EL, L_WR), 'r_forearm': (R_EL, R_WR),
    'l_thigh': (L_HIP, L_KN), 'r_thigh': (R_HIP, R_KN),
    'l_shin': (L_KN, L_AN), 'r_shin': (R_KN, R_AN),
}
FEATURES = list(SEGMENTS)
# Provisional: these set difficulty. Full marks within tol; tol is widened where real people disagree.
BASE_TOL = {'torso': 12, 'upper_arm': 15, 'forearm': 20, 'thigh': 12, 'shin': 15}
BASE_WEIGHT = {'torso': 1.5, 'upper_arm': 1.0, 'forearm': 0.5, 'thigh': 1.0, 'shin': 1.0}

# Normal adult active range of motion (deg): AAOS, Greene & Heckman (1994) "The Clinical Measurement of Joint Motion".
ROM = {'hip_flexion': 120, 'knee_flexion': 135, 'shoulder_flexion': 180, 'hip_abduction': 45}

# Category priors from the 3DYoga90 hierarchy (level-2 groups). Used where single-frame geometry can't tell us the demand
# (e.g. whether a lying body is supported, how much spinal extension a backbend needs).
L2_PRIOR = {  # balance, spine (flexion/extension/twist demand), strength, focus
    'standing-straight': (None, 0.0, 0.1, None), 'standing-forward-bend': (0.15, 0.5, 0.2, 'hips'),
    'standing-side-bend': (None, 0.4, 0.4, 'legs'), 'standing-others': (None, 0.2, 0.4, None),
    'sitting-legs-front': (0.0, 0.2, 0.1, 'hips'), 'sitting-legs-behind': (0.0, 0.3, 0.1, 'hips'),
    'sitting-split': (0.0, 0.3, 0.2, 'hips'), 'sitting-forward-bend': (0.0, 0.6, 0.1, 'hips'),
    'sitting-twist': (0.0, 0.6, 0.2, 'hips'),
    'balancing-front': (1.0, 0.3, 0.9, 'balance'), 'balancing-side': (1.0, 0.5, 1.0, 'balance'),
    'inverted-legs-straight-up': (0.9, 0.3, 0.8, 'balance'), 'inverted-legs-bend': (0.9, 0.7, 0.8, 'balance'),
    'reclining-up-facing': (0.0, 0.2, 0.0, 'hips'), 'reclining-down-facing': (0.0, 0.4, 0.3, 'upper body'),
    'reclining-side-facing': (0.5, 0.2, 0.6, 'balance'), 'reclining-plank-balance': (0.3, 0.1, 0.8, 'upper body'),
    'wheel-up-facing': (0.1, 0.8, 0.5, 'upper body'), 'wheel-down-facing': (0.0, 0.4, 0.1, 'upper body'),
    'wheel-others': (0.4, 0.4, 0.5, 'hips'),
}
OVERRIDE_FOCUS = {'peacock': 'balance', 'boat': 'balance', 'pigeon': 'hips', 'bridge': 'legs', 'frog': 'hips',
                  'lizard': 'hips', 'child': 'hips', 'corpse': 'hips', 'downward-dog': 'upper body', 'dolphin': 'upper body'}
OVERRIDE_BALANCE = {'peacock': 1.0, 'scale': 0.9, 'shoulder-stand': 0.6, 'plow': 0.3, 'corpse': 0.0, 'child': 0.0}


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def circ(a):
    return (a + 180) % 360 - 180


def features(P):
    out = {}
    for name, seg in SEGMENTS.items():
        if seg is None:
            d = (P[L_SH, :2] + P[R_SH, :2]) / 2 - (P[L_HIP, :2] + P[R_HIP, :2]) / 2
            out[name] = math.degrees(math.atan2(d[0], -d[1]))
        else:
            d = P[seg[1], :2] - P[seg[0], :2]
            out[name] = math.degrees(math.atan2(d[0], d[1]))
    return out


def fvec(f):
    return np.array([f[k] for k in FEATURES])


def fdist(a, b):
    return float(np.abs(circ(fvec(a) - fvec(b))).mean())


def body_frame(P):
    """spine (hips->shoulders), across (subject's right->left), chest normal (front of the body)."""
    spine = unit((P[L_SH] + P[R_SH]) / 2 - (P[L_HIP] + P[R_HIP]) / 2)
    across = unit(P[L_SH] - P[R_SH] + P[L_HIP] - P[R_HIP])
    normal = unit(np.cross(across, spine))  # MediaPipe world: x right, y down, z away from camera
    return spine, across, normal


def rot_y(P, theta):
    c, s = math.cos(theta), math.sin(theta)
    return P @ np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]).T


def classify(P):
    spine, across, normal = body_frame(P)
    if abs(normal[1]) > 0.7:  # chest faces floor or ceiling: lying / plank / table
        return 'lying' if np.hypot(spine[0], spine[2]) > 0.5 and abs(spine[0]) > abs(spine[2]) * 0.5 else 'end-on'
    if abs(normal[1]) > 0.7 or np.hypot(normal[0], normal[2]) < 0.5:
        return 'unclear'
    return 'front' if abs(normal[2]) >= abs(normal[0]) else 'side'


def to_view(P, view):
    """Rotate about the vertical axis: 'front' => chest towards camera (-z); 'side'/'lying' => profile facing image right."""
    spine, across, normal = body_frame(P)
    if view == 'lying':
        h = np.array([spine[0], 0, spine[2]])  # put the spine in the image plane, head to the right
        target = np.array([1.0, 0, 0])
    else:
        h = np.array([normal[0], 0, normal[2]])
        target = np.array([0, 0, -1.0]) if view == 'front' else np.array([1.0, 0, 0])
    h = unit(h)
    theta = math.atan2(h[0], h[2]) - math.atan2(target[0], target[2])
    Q = rot_y(P, theta)
    s2, a2, n2 = body_frame(Q)
    chk = np.array([s2[0], 0, s2[2]]) if view == 'lying' else np.array([n2[0], 0, n2[2]])
    if np.dot(unit(chk), target) < 0.9:  # wrong rotation sense: rotate the other way
        Q = rot_y(P, -theta)
    return Q


def other_side(P, view):
    """The same pose done on the other side, seen from the same camera: reflect across the body's midline plane."""
    c = (P[L_HIP] + P[R_HIP]) / 2
    _, across, _ = body_frame(P)
    if view == 'front':
        a = np.array([1.0, 0, 0])
    else:
        a = unit(np.array([0, across[1], across[2]])) if view == 'lying' else np.array([0, 0, 1.0])
    Q = P - 2 * np.outer((P - c) @ a, a)
    return Q[SWAP]


def load_sequence(path):
    d = pd.read_parquet(path, columns=['frame', 'type', 'landmark_index', 'x', 'y', 'z'])
    d = d[d['type'] == 'pose'].sort_values(['frame', 'landmark_index'])
    counts = d.groupby('frame').size()
    d = d[d['frame'].isin(counts.index[counts == 33])]
    F = d[['x', 'y', 'z']].to_numpy(dtype=float).reshape(-1, 33, 3)
    return F[~np.isnan(F).any(axis=(1, 2))]


def held_median(F):
    """Median skeleton of the steadiest half of the frames, scaled so torso length = 1. None if it never holds."""
    if len(F) < 10:
        return None
    med = np.median(F, axis=0)
    torso = np.linalg.norm((med[L_SH] + med[R_SH]) / 2 - (med[L_HIP] + med[R_HIP]) / 2)
    if torso < 0.1:
        return None
    dev = np.linalg.norm(F[:, BODY] - med[BODY], axis=2).mean(axis=1) / torso
    keep = F[dev <= np.median(dev)]
    if np.median(dev) > 0.3:
        return None
    P = np.median(keep, axis=0)
    return (P - (P[L_HIP] + P[R_HIP]) / 2) / torso


def posture_ok(pid, l2, P):
    """Drop source sequences that contradict their label (e.g. the standing phase before a forward bend).
    Uses only coarse geometry: spine tilt from vertical and whether the head is above the hips (gravity = +y)."""
    spine, _, _ = body_frame(P)
    tilt = math.degrees(math.acos(np.clip(-spine[1], -1, 1)))  # 0 = upright, 90 = horizontal, 180 = upside down
    mid_hip = (P[L_HIP] + P[R_HIP]) / 2
    head_below_hips = P[NOSE, 1] > mid_hip[1]
    if l2 == 'standing-forward-bend':
        return tilt > (40 if pid in ('half-way-lift',) else 60)
    if l2 == 'standing-straight':
        return tilt < 35 and max(P[L_AN, 1], P[R_AN, 1]) > mid_hip[1]
    if l2.startswith('inverted'):
        return head_below_hips
    if (l2.startswith('reclining') or l2.startswith('wheel')) and pid not in ('camel', 'boat'):
        return tilt > 45
    if l2.startswith('sitting'):
        return not head_below_hips or 'forward-bend' in l2
    return True


def joint3d(P, a, b, c):
    return math.degrees(math.acos(np.clip(np.dot(unit(P[a] - P[b]), unit(P[c] - P[b])), -1, 1)))


def difficulty(pose_id, l2, P3):
    """0-1 components from the 3D skeleton (+ hierarchy priors), combined into 1-10. See docs/pose-library.md."""
    pb, pspine, pstrength, pfocus = L2_PRIOR[l2]
    # single-leg stance for standing poses: one foot clearly off the floor (gravity ~ +y; standing videos are level)
    ankle_gap = abs(P3[L_AN, 1] - P3[R_AN, 1])
    single_leg = l2.startswith('standing') and ankle_gap > 0.45
    hands_down = l2.startswith('standing') and max(P3[L_WR, 1], P3[R_WR, 1]) > max(P3[L_AN, 1], P3[R_AN, 1]) - 0.3
    if pose_id in OVERRIDE_BALANCE:
        balance = OVERRIDE_BALANCE[pose_id]
    elif pb is not None:
        balance = pb
    elif single_leg:
        balance = 0.5 if hands_down else 0.75
    else:
        balance = 0.25 if np.linalg.norm(P3[L_AN] - P3[R_AN]) < 0.6 else 0.1
    # flexibility: fraction of normal ROM used at the two most demanding joints, plus a spine prior
    knee_flex = [max(0, 180 - joint3d(P3, h, k, a)) / ROM['knee_flexion'] for h, k, a in ((L_HIP, L_KN, L_AN), (R_HIP, R_KN, R_AN))]
    hip_flex = [max(0, 180 - joint3d(P3, s, h, k)) / ROM['hip_flexion'] for s, h, k in ((L_SH, L_HIP, L_KN), (R_SH, R_HIP, R_KN))]
    sh_flex = [joint3d(P3, h, s, e) / ROM['shoulder_flexion'] for h, s, e in ((L_HIP, L_SH, L_EL), (R_HIP, R_SH, R_EL))]
    mid = (P3[L_HIP] + P3[R_HIP]) / 2
    split = math.degrees(math.acos(np.clip(np.dot(unit(P3[L_KN] - mid), unit(P3[R_KN] - mid)), -1, 1))) / (2 * ROM['hip_abduction'] + 30)
    joints = sorted(np.clip(hip_flex + sh_flex + [split] + [k * 0.5 for k in knee_flex], 0, 1))
    flex = float(np.clip(0.7 * np.mean(joints[-2:]) + 0.5 * pspine, 0, 1))
    # strength / endurance: weight-bearing knee bend in standing poses, arms held out, category prior
    standing_knee = 0.0
    if l2.startswith('standing'):
        standing_knee = min(1.0, max(180 - joint3d(P3, h, k, a) for h, k, a in ((L_HIP, L_KN, L_AN), (R_HIP, R_KN, R_AN))) / 90)
        if single_leg:  # only the standing leg carries weight
            low = L_AN if P3[L_AN, 1] > P3[R_AN, 1] else R_AN
            h, k = (L_HIP, L_KN) if low == L_AN else (R_HIP, R_KN)
            standing_knee = min(1.0, (180 - joint3d(P3, h, k, low)) / 90)
    arms_out = float(np.mean([1.0 if 60 < joint3d(P3, h, s, w) < 120 else 0.0 for h, s, w in ((L_HIP, L_SH, L_WR), (R_HIP, R_SH, R_WR))]))
    strength = float(np.clip(max(pstrength, 0.6 * standing_knee) + 0.15 * arms_out, 0, 1))
    # coordination: left/right asymmetry of 3D joint angles (view-independent)
    pairs = [((L_SH, L_EL, L_WR), (R_SH, R_EL, R_WR)), ((L_HIP, L_SH, L_EL), (R_HIP, R_SH, R_EL)),
             ((L_SH, L_HIP, L_KN), (R_SH, R_HIP, R_KN)), ((L_HIP, L_KN, L_AN), (R_HIP, R_KN, R_AN))]
    coord = float(np.clip(np.mean([abs(joint3d(P3, *a) - joint3d(P3, *b)) for a, b in pairs]) / 60, 0, 1))
    raw = 0.40 * balance + 0.25 * flex + 0.25 * strength + 0.10 * coord
    score = round(1 + 9 * float(np.clip((raw - 0.05) / 0.75, 0, 1)), 1)
    if pose_id in OVERRIDE_FOCUS:
        focus = OVERRIDE_FOCUS[pose_id]
    elif pfocus:
        focus = pfocus
    elif single_leg:
        focus = 'balance'
    else:
        focus = 'legs'
    return score, {'balance': round(balance, 2), 'flexibility': round(flex, 2), 'strength': round(strength, 2),
                   'coordination': round(coord, 2)}, focus


def title(name):
    return ' '.join(w.capitalize() for w in name.replace('-', ' ').split()).replace("'S", "'s")


def main(root, index_csv):
    meta = json.load(open(os.path.join(root, '3DYoga90.json')))
    hier = {r['13_pose']: r for r in csv.DictReader(open(index_csv))}
    poses, dropped = [], []
    for p in meta:
        pid, l2 = p['pose'], hier[p['pose']]['level2_pose']
        seqs = []
        for inst in p['instances']:
            path = os.path.join(root, 'skel', f"{inst['sequence_id']}.parquet")
            if os.path.exists(path):
                P = held_median(load_sequence(path))
                if P is not None and posture_ok(pid, l2, P):
                    seqs.append((inst['sequence_id'], P, classify(P)))
        cls = [c for _, _, c in seqs]
        n_lying, n_up = cls.count('lying'), cls.count('front') + cls.count('side')
        if max(n_lying, n_up) < 5:
            dropped.append((pid, f'only {max(n_lying, n_up)} usable held sequences (of {len(p["instances"])})')); continue
        if n_lying > n_up:
            view, use = 'lying', [s for s in seqs if s[2] == 'lying']
        else:
            view = 'front' if cls.count('front') >= cls.count('side') else 'side'
            use = [s for s in seqs if s[2] in ('front', 'side')]
        canon = [(sid, to_view(P, view)) for sid, P, _ in use]
        # flip everyone to the same working side, iterating towards the medoid
        cur = [(sid, P, features(P)) for sid, P in canon]
        ref = cur[0][2]
        for _ in range(5):
            aligned = []
            for sid, P, f in cur:
                Q = to_view(other_side(P, view), view)
                fq = features(Q)
                aligned.append((sid, P, f) if fdist(f, ref) <= fdist(fq, ref) else (sid, Q, fq))
            ref = {k: float(np.degrees(np.angle(np.mean([np.exp(1j * np.radians(f[k])) for _, _, f in aligned])))) for k in FEATURES}
            # medoid as the next reference keeps it a real pose
            ref = min(aligned, key=lambda t: fdist(t[2], ref))[2]
        med = {k: float(np.degrees(np.angle(np.mean([np.exp(1j * np.radians(f[k])) for _, _, f in aligned])))) for k in FEATURES}
        spread = {k: float(np.percentile([abs(circ(f[k] - med[k])) for _, _, f in aligned], 75)) for k in FEATURES}
        mean_spread = float(np.mean(list(spread.values())))
        if mean_spread > 35:
            dropped.append((pid, f'people disagree too much on the 2D shape (mean spread {mean_spread:.0f} deg): not legible from one camera view')); continue
        medoid = min(aligned, key=lambda t: fdist(t[2], med))
        diff, comps, focus = difficulty(pid, l2, medoid[1])
        Q = to_view(other_side(medoid[1], view), view)
        symmetric = fdist(features(Q), medoid[2]) < 8
        targets = {}
        for k in FEATURES:
            part = k.split('_', 1)[1] if '_' in k else k
            targets[k] = {'angle': round(med[k], 1), 'tol': round(max(BASE_TOL[part], 0.75 * spread[k]), 1),
                          'weight': round(BASE_WEIGHT[part] / (1 + spread[k] / 30), 2), 'spread': round(spread[k], 1)}
        poses.append({
            'id': pid, 'name': title(pid), 'category': hier[pid]['level1_pose'], 'group': l2,
            'view': 'side' if view == 'lying' else view, 'lying': view == 'lying', 'symmetric': bool(symmetric),
            'difficulty': diff, 'components': comps, 'focus': focus,
            'advanced': hier[pid]['level1_pose'] in ('inverted', 'balancing') or diff >= 8.5,
            'targets': targets, 'skeleton': np.round(medoid[1][DISPLAY], 3).tolist(),
            'n_people': len(aligned), 'spread': round(mean_spread, 1),
            'source': {'dataset': '3DYoga90', 'medoid_sequence': int(medoid[0])},
        })
        print(f"{pid:<31} {view:<5} n={len(aligned):>2} d={diff:>4} {focus:<10} spread={mean_spread:4.1f} sym={int(symmetric)} {comps}")
    poses.sort(key=lambda p: (p['difficulty'], p['id']))
    out = {'version': 2, 'skeleton_landmarks': DISPLAY, 'features': FEATURES, 'poses': poses, 'dropped': dropped,
           'attribution': '3DYoga90 (Kim et al., 2023), annotations CC BY-NC 4.0, https://github.com/seonokkim/3DYoga90'}
    os.makedirs('site/data', exist_ok=True)
    json.dump(out, open('site/data/poses.json', 'w'), separators=(',', ':'))
    print(f'{len(poses)} poses kept, {len(dropped)} dropped')
    for d in dropped:
        print('  dropped', *d)


if __name__ == '__main__':
    main(*sys.argv[1:3])
