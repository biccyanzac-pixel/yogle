"""Extract frames from a video: python extract.py video out_dir start_frame count step width"""
import cv2, json, os, sys
video, out, start, count, step, width = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])
os.makedirs(out, exist_ok=True)
cap = cv2.VideoCapture(video); cap.set(cv2.CAP_PROP_POS_FRAMES, start)
names = []
i = 0
while len(names) < count:
    ok, f = cap.read()
    if not ok: break
    if i % step == 0:
        h = int(f.shape[0] * width / f.shape[1]) // 2 * 2
        n = f'{len(names):04d}.jpg'; cv2.imwrite(os.path.join(out, n), cv2.resize(f, (width, h), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 90]); names.append(n)
    i += 1
json.dump(names, open(os.path.join(out, 'index.json'), 'w'))
print(len(names), 'frames ->', out)
