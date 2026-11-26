/**
 * Scan a QR code with the phone's camera (the pairing code on the computer). Resolves the text, or null when cancelled.
 * Uses the system's BarcodeDetector when the WebView has it, otherwise the bundled jsQR (ui/vendor/jsqr). Nothing is recorded or kept.
 */
import { h } from './util.js';

let jsqrLoad = null;
const loadJsQR = () => (jsqrLoad ||= new Promise((resolve, reject) => {
  if (window.jsQR) return resolve(window.jsQR);
  const s = document.createElement('script');
  s.src = 'vendor/jsqr/jsQR.js';
  s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('The code reader did not load')));
  s.onerror = () => reject(new Error('The code reader did not load'));
  document.head.appendChild(s);
}));

export function scanQr(hint = 'Point the camera at the code on your computer') {
  return new Promise((resolve) => {
    const video = h('video', { playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    const msg = h('div', { class: 'qs-msg' }, hint);
    const box = h('div', { class: 'qs' },
      video,
      h('div', { class: 'qs-frame' }),
      msg,
      h('button', { class: 'btn qs-x', onclick: () => finish(null) }, 'Cancel'));
    document.body.appendChild(box);
    let stream = null, done = false, timer = 0;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      box.remove();
      resolve(v);
    };
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This phone does not let the app use the camera');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (done) return stream.getTracks().forEach((t) => t.stop());
        video.srcObject = stream;
        await video.play();
        let detector = null;
        try { if (window.BarcodeDetector) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
        const jsQR = detector ? null : await loadJsQR();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const look = async () => {
          if (done) return;
          try {
            if (video.videoWidth) {
              let text = '';
              if (detector) {
                const r = await detector.detect(video);
                text = r[0]?.rawValue || '';
              } else {
                const k = Math.min(1, 720 / video.videoWidth);
                canvas.width = Math.round(video.videoWidth * k);
                canvas.height = Math.round(video.videoHeight * k);
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const q = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
                text = q?.data || '';
              }
              if (text) return finish(text);
            }
          } catch { /* try the next frame */ }
          timer = setTimeout(look, 120);
        };
        look();
      } catch (e) {
        msg.textContent = e && e.name === 'NotAllowedError' ? 'The camera is not allowed. Allow it for Board Roamer in Android settings, or type the code instead.' : (e && e.message) || 'The camera could not be opened';
        msg.classList.add('bad');
      }
    })();
  });
}
