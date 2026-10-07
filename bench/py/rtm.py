"""Reference RTMPose top-down pipeline (YOLOX detector + RTMPose SimCC) on onnxruntime CPU.

Used offline to produce pseudo-ground-truth keypoints with a heavy model (RTMPose-x 384x288),
and to sanity-check the browser ports of the lighter models.
"""
import glob
import os

import cv2
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, '..', 'models')

COCO17 = ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear', 'l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow',
          'l_wrist', 'r_wrist', 'l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_ankle', 'r_ankle']


def _find(pattern):
    hits = glob.glob(os.path.join(MODELS, pattern, '**', 'end2end.onnx'), recursive=True)
    assert hits, pattern
    return hits[0]


class Yolox:
    def __init__(self, path, size=640):
        self.sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        self.size = self.sess.get_inputs()[0].shape[2] if isinstance(self.sess.get_inputs()[0].shape[2], int) else size

    def __call__(self, bgr):
        h, w = bgr.shape[:2]
        r = min(self.size / h, self.size / w)
        img = np.full((self.size, self.size, 3), 114, np.uint8)
        img[:int(h * r), :int(w * r)] = cv2.resize(bgr, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
        x = img.transpose(2, 0, 1)[None].astype(np.float32)
        dets, labels = self.sess.run(None, {'input': x})
        dets, labels = dets[0], labels[0]
        keep = (labels == 0) & (dets[:, 4] > 0.3)
        boxes = dets[keep]
        boxes[:, :4] /= r
        return boxes  # x1,y1,x2,y2,score (already NMS'd by the end2end graph)


def _get_warp(center, scale, out_w, out_h):
    # mmpose get_warp_matrix with rot=0: map a box of `scale` around `center` onto out_w x out_h
    src = np.array([center, center + [0, -scale[1] * 0.5], center + [-scale[0] * 0.5, -scale[1] * 0.5]], np.float32)
    dst = np.array([[out_w * 0.5, out_h * 0.5], [out_w * 0.5, 0], [0, 0]], np.float32)
    return cv2.getAffineTransform(src, dst)


class RTMPose:
    MEAN = np.array([123.675, 116.28, 103.53], np.float32)
    STD = np.array([58.395, 57.12, 57.375], np.float32)

    def __init__(self, path):
        self.sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        _, _, self.h, self.w = self.sess.get_inputs()[0].shape

    def __call__(self, bgr, box):
        x1, y1, x2, y2 = box[:4]
        center = np.array([(x1 + x2) / 2, (y1 + y2) / 2], np.float32)
        scale = np.array([x2 - x1, y2 - y1], np.float32) * 1.25
        aspect = self.w / self.h
        if scale[0] > scale[1] * aspect:
            scale[1] = scale[0] / aspect
        else:
            scale[0] = scale[1] * aspect
        M = _get_warp(center, scale, self.w, self.h)
        crop = cv2.warpAffine(bgr, M, (self.w, self.h), flags=cv2.INTER_LINEAR)
        rgb = crop[:, :, ::-1].astype(np.float32)
        x = ((rgb - self.MEAN) / self.STD).transpose(2, 0, 1)[None].astype(np.float32)
        sx, sy = self.sess.run(None, {'input': x})
        sx, sy = sx[0], sy[0]  # (K, W*2), (K, H*2)
        px = sx.argmax(1) / 2.0
        py = sy.argmax(1) / 2.0
        score = np.minimum(sx.max(1), sy.max(1))
        # back to image coords: crop px -> center + (px/w - 0.5) * scale
        kx = center[0] + (px / self.w - 0.5) * scale[0]
        ky = center[1] + (py / self.h - 0.5) * scale[1]
        return np.stack([kx, ky, score], 1)


class TopDown:
    def __init__(self, det='yolox_m*', pose='rtmpose-x*'):
        self.det = Yolox(_find(det))
        self.pose = RTMPose(_find(pose))

    def __call__(self, bgr):
        boxes = self.det(bgr)
        if len(boxes) == 0:
            return None, None
        # single-player game: keep the largest person
        areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        b = boxes[areas.argmax()]
        return self.pose(bgr, b), b


def draw(bgr, kps, thr=0.3, color=(0, 255, 0)):
    edges = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14),
             (14, 16), (0, 5), (0, 6)]
    out = bgr.copy()
    for a, b in edges:
        if kps[a, 2] > thr and kps[b, 2] > thr:
            cv2.line(out, tuple(map(int, kps[a, :2])), tuple(map(int, kps[b, :2])), color, 2)
    for x, y, s in kps:
        if s > thr:
            cv2.circle(out, (int(x), int(y)), 3, (0, 0, 255), -1)
    return out


if __name__ == '__main__':
    import sys
    img = cv2.imread(sys.argv[1])
    td = TopDown()
    k, b = td(img)
    print(np.round(k, 2))
    cv2.imwrite(sys.argv[2], draw(img, k))
