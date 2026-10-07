"""Make an MJPEG 'camera' for Chrome's fake capture device: crop around the person so they fill ~70% of the height."""
import cv2, sys
video, out, x1, y1, x2, y2 = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:7])
cap = cv2.VideoCapture(video); W = cap.get(3); s = W / 960  # boxes are in 960-wide frame coords
x1, y1, x2, y2 = x1 * s, y1 * s, x2 * s, y2 * s
h = max((y2 - y1) / 0.7, (x2 - x1) / 0.85 * 3 / 4); w = h * 4 / 3; cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
X1, Y1 = int(max(0, cx - w / 2)), int(max(0, cy - h / 2)); X2, Y2 = int(X1 + w), int(Y1 + h)
n = 0
with open(out, 'wb') as f:
    while True:
        ok, fr = cap.read()
        if not ok: break
        crop = fr[Y1:Y2, X1:X2]
        if crop.shape[0] < 10 or crop.shape[1] < 10: break
        f.write(cv2.imencode('.jpg', cv2.resize(crop, (640, 480)), [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()); n += 1
print(out, n, 'frames', (X1, Y1, X2, Y2))
