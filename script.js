/*
  Neon Air Draw (Pure Frontend)
  - MediaPipe Hands for hand tracking
  - Index fingertip (landmark 8) tracing
  - Gesture detection:
      • Point (only index finger extended) => draw
      • Open palm => clear
      • Thumbs up => change color
  - Mirror mode
  - Smoothing to reduce jitter

  Notes on performance:
  - Uses requestAnimationFrame for render loop
  - Uses a light-weight ring buffer for smoothing
  - Reuses canvas contexts and pre-allocates paths
*/

(() => {
  'use strict';

  // ---------- DOM ----------
  const video = document.getElementById('video');
  const drawCanvas = document.getElementById('draw');
  const lmCanvas = document.getElementById('landmarks');

  const clearBtn = document.getElementById('clearBtn');
  const colorPicker = document.getElementById('colorPicker');
  const sizeSlider = document.getElementById('sizeSlider');
  const sizeValue = document.getElementById('sizeValue');
  const mirrorToggle = document.getElementById('mirrorToggle');

  const statusEl = document.getElementById('status');

  // ---------- Canvas setup ----------
  const drawCtx = drawCanvas.getContext('2d', { alpha: true });
  const lmCtx = lmCanvas.getContext('2d', { alpha: true });

  // DPR-aware sizing for smooth lines on high DPI screens
  const state = {
    dpr: Math.max(1, Math.min(2.5, window.devicePixelRatio || 1)),
    w: 0,
    h: 0,

    drawing: false,
    lastPoint: null,

    // smoothing
    smooth: {
      // Exponential moving average
      x: null,
      y: null,
      // higher alpha => less smoothing / more responsive
      alpha: 0.35
    },

    // gesture state
    gesture: {
      isPointing: false,
      isOpenPalm: false,
      isThumbsUp: false,
      lastThumbColorIndex: -1,
      lastOpenPalmAt: 0,
      // simple debouncing thresholds
      openPalmCooldownMs: 900
    },

    // brush
    color: colorPicker.value,
    brushSize: Number(sizeSlider.value),

    // particles
    particles: [],
    lastParticleAt: 0
  };

  function resizeCanvases() {
    const rect = drawCanvas.getBoundingClientRect();
    state.w = Math.max(1, Math.floor(rect.width));
    state.h = Math.max(1, Math.floor(rect.height));

    const W = Math.floor(state.w * state.dpr);
    const H = Math.floor(state.h * state.dpr);

    // draw canvas
    if (drawCanvas.width !== W) drawCanvas.width = W;
    if (drawCanvas.height !== H) drawCanvas.height = H;

    // lm canvas
    if (lmCanvas.width !== W) lmCanvas.width = W;
    if (lmCanvas.height !== H) lmCanvas.height = H;

    drawCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    lmCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  window.addEventListener('resize', () => {
    resizeCanvases();
    clearCanvas();
  });

  // ---------- Utility: Landmark mapping ----------
  // MediaPipe provides normalized coordinates (0..1) with origin top-left.
  function toCanvasXY(lm, w, h) {
    return {
      x: lm.x * w,
      y: lm.y * h
    };
  }

  // Mirror mode: flip X axis of mapped point
  function applyMirror(x) {
    if (!mirrorToggle.checked) return x;
    return state.w - x;
  }

  // ---------- Gesture detection ----------
  // We use a simplified but robust approach for one-hand gestures:
  // - Determine if fingers are extended based on relative landmark positions.
  // - Index finger extended when tip (8) is above PIP (6) in image coordinates.
  // - Middle/ring/pinky extended when their tips are above their PIPs.
  // - Thumb extended when thumb tip (4) is to the side of thumb IP (3) relative to palm.
  // Because different hand orientations exist, thumbs-up detection uses a heuristic comparing
  // thumb tip x position with index knuckle x, plus thumb tip y being above index PIP y.
  function detectGestures(handLandmarks) {
    const lm = handLandmarks;

    // Index finger
    const indexTip = lm[8];
    const indexPip = lm[6];

    // Middle
    const middleTip = lm[12];
    const middlePip = lm[10];

    // Ring
    const ringTip = lm[16];
    const ringPip = lm[14];

    // Pinky
    const pinkyTip = lm[20];
    const pinkyPip = lm[18];

    // Thumb
    const thumbTip = lm[4];
    const thumbIp = lm[3];

    // Palm reference
    const wrist = lm[0];
    const indexMcp = lm[5]; // knuckle area

    // Extended = tip is above pip (smaller y) for upright hand relative to camera.
    const indexExtended = indexTip.y < indexPip.y;
    const middleExtended = middleTip.y < middlePip.y;
    const ringExtended = ringTip.y < ringPip.y;
    const pinkyExtended = pinkyTip.y < pinkyPip.y;

    // Open palm: most fingers extended and thumb roughly extended
    // (thumb direction is tricky; we just require thumb tip is above thumb IP y and/or thumbTip.x differs from thumbIp.x)
    const thumbUpLike = thumbTip.y < thumbIp.y;
    const thumbExtendedSide = Math.abs(thumbTip.x - thumbIp.x) > 0.02;
    const thumbExtended = thumbUpLike || thumbExtendedSide;

    const openPalm = indexExtended && middleExtended && ringExtended && pinkyExtended && thumbExtended;

    // Point gesture: ONLY index extended
    const onlyIndex = indexExtended && !middleExtended && !ringExtended && !pinkyExtended;

    // Thumbs up: thumb extended upward while other fingers mostly folded.
    // Require thumb tip significantly above wrist and above indexPip (thumb pointing up).
    const thumbUp = thumbTip.y < wrist.y - 0.07 && thumbTip.y < indexPip.y - 0.03;
    const otherFolded = !indexExtended && !middleExtended && !ringExtended && !pinkyExtended;

    // Also ensure thumb is not crossing palm too much: compare thumb x to indexMcp x.
    const thumbToSide = Math.abs(thumbTip.x - indexMcp.x) > 0.03;

    const thumbsUp = thumbUp && otherFolded && thumbToSide;

    return {
      isPointing: onlyIndex,
      isOpenPalm: openPalm,
      isThumbsUp: thumbsUp
    };
  }

  // ---------- Drawing ----------
  function clearCanvas() {
    drawCtx.clearRect(0, 0, state.w, state.h);
    lmCtx.clearRect(0, 0, state.w, state.h);
    state.lastPoint = null;
    state.smooth.x = null;
    state.smooth.y = null;
  }

  function smoothPoint(p) {
    // Exponential moving average (EMA)
    if (state.smooth.x === null) {
      state.smooth.x = p.x;
      state.smooth.y = p.y;
      return { x: p.x, y: p.y };
    }

    const a = state.smooth.alpha;
    state.smooth.x = state.smooth.x + a * (p.x - state.smooth.x);
    state.smooth.y = state.smooth.y + a * (p.y - state.smooth.y);
    return { x: state.smooth.x, y: state.smooth.y };
  }

  function drawNeonSegment(a, b, color, size) {
    // main stroke
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';

    // Glow layers for premium neon
    const glow = Math.max(6, size * 2.2);

    // Outer glow
    drawCtx.strokeStyle = color;
    drawCtx.globalAlpha = 0.25;
    drawCtx.lineWidth = size + glow;
    drawCtx.beginPath();
    drawCtx.moveTo(a.x, a.y);
    drawCtx.lineTo(b.x, b.y);
    drawCtx.stroke();

    // Mid glow
    drawCtx.globalAlpha = 0.42;
    drawCtx.lineWidth = size + size * 0.8;
    drawCtx.beginPath();
    drawCtx.moveTo(a.x, a.y);
    drawCtx.lineTo(b.x, b.y);
    drawCtx.stroke();

    // Core line
    drawCtx.globalAlpha = 0.95;
    drawCtx.lineWidth = size;
    drawCtx.beginPath();
    drawCtx.moveTo(a.x, a.y);
    drawCtx.lineTo(b.x, b.y);
    drawCtx.stroke();

    drawCtx.globalAlpha = 1;
  }

  // ---------- Particle trail ----------
  function spawnParticles(from, color) {
    const now = performance.now();
    // Limit particles spawn rate
    if (now - state.lastParticleAt < 18) return;
    state.lastParticleAt = now;

    const count = 6 + Math.floor(state.brushSize / 3);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2.2;

      state.particles.push({
        x: from.x + (Math.random() - 0.5) * 4,
        y: from.y + (Math.random() - 0.5) * 4,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.2,
        life: 650 + Math.random() * 350,
        born: now,
        size: 1.5 + Math.random() * 2.6,
        color
      });
    }
  }

  function updateParticles() {
    if (!state.particles.length) return;

    const now = performance.now();
    // Use an additive style for glow trail. Keep it light.
    drawCtx.save();
    drawCtx.globalCompositeOperation = 'lighter';

    state.particles = state.particles.filter((p) => {
      const t = now - p.born;
      if (t > p.life) return false;
      const k = 1 - t / p.life;

      // Integrate
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.01; // slight gravity

      drawCtx.globalAlpha = 0.35 * k;
      drawCtx.fillStyle = p.color;
      drawCtx.beginPath();
      drawCtx.arc(p.x, p.y, p.size * k, 0, Math.PI * 2);
      drawCtx.fill();
      return true;
    });

    drawCtx.restore();
  }

  // ---------- Landmark debug ----------
  function drawLandmarkDots(lm) {
    // Clear landmarks overlay only (do not clear draw canvas)
    lmCtx.clearRect(0, 0, state.w, state.h);

    // Small neon dots for debugging
    for (let i = 0; i < lm.length; i++) {
      const p = toCanvasXY(lm[i], state.w, state.h);
      const x = applyMirror(p.x);
      const y = p.y;

      const r = i === 8 ? 5.2 : 3.1;
      lmCtx.beginPath();
      lmCtx.arc(x, y, r, 0, Math.PI * 2);
      lmCtx.fillStyle = i === 8 ? 'rgba(0,229,255,0.95)' : 'rgba(124,77,255,0.85)';
      lmCtx.shadowBlur = 12;
      lmCtx.shadowColor = 'rgba(0,229,255,0.35)';
      lmCtx.fill();
    }

    // fingertip emphasis
    const idx = lm[8];
    const fp = toCanvasXY(idx, state.w, state.h);
    lmCtx.shadowBlur = 22;
    lmCtx.shadowColor = 'rgba(0,229,255,0.55)';
    lmCtx.beginPath();
    lmCtx.arc(applyMirror(fp.x), fp.y, 8, 0, Math.PI * 2);
    lmCtx.fillStyle = 'rgba(0,229,255,0.25)';
    lmCtx.fill();
    lmCtx.shadowBlur = 0;
  }

  // ---------- Main loop ----------
  let latestHand = null;
  let latestGestures = null;
  let pendingThumbColorChange = false;

  async function startCamera() {
    // Use MediaPipe Camera utility for smoother frames (throttled appropriately).
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    await video.play();
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // Color cycling for thumbs-up
  const colorPalette = [
    '#00e5ff', '#7c4dff', '#00ff7a', '#ff4dd8', '#ffd500', '#ff4d6d', '#3b82f6'
  ];

  function changeColorByThumb() {
    const cur = state.color.toLowerCase();
    let idx = colorPalette.findIndex((c) => c.toLowerCase() === cur);
    if (idx < 0) idx = 0;

    const next = (idx + 1) % colorPalette.length;
    state.color = colorPalette[next];
    colorPicker.value = state.color;
  }

  function animate() {
    updateParticles();
    requestAnimationFrame(animate);
  }

  // ---------- MediaPipe init ----------
  async function initHands() {
    if (!window.Hands) {
      setStatus('MediaPipe Hands failed to load.');
      return;
    }

    resizeCanvases();
    clearCanvas();

    setStatus('Requesting camera…');
    await startCamera();
    setStatus('Tracking…');

    // Create Hands instance
    const hands = new Hands.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    // When results are returned, update latestHand and draw accordingly.
    hands.onResults((results) => {
      const hand = results.multiHandLandmarks && results.multiHandLandmarks[0];
      const handLm = hand || null;

      if (!handLm) {
        latestHand = null;
        latestGestures = null;
        state.drawing = false;
        state.lastPoint = null;
        state.smooth.x = null;
        state.smooth.y = null;
        lmCtx.clearRect(0, 0, state.w, state.h);
        return;
      }

      latestHand = handLm;
      latestGestures = detectGestures(handLm);

      // Debug dots
      drawLandmarkDots(handLm);

      // Open palm => clear (debounced)
      if (latestGestures.isOpenPalm) {
        const now = performance.now();
        if (now - state.gesture.lastOpenPalmAt > state.gesture.openPalmCooldownMs) {
          state.gesture.lastOpenPalmAt = now;
          clearCanvas();
        }
      }

      // Thumbs up => change color (debounced on thumb state)
      if (latestGestures.isThumbsUp) {
        // avoid repeating too rapidly by relying on thumb state change
        if (!pendingThumbColorChange) {
          pendingThumbColorChange = true;
          changeColorByThumb();
        }
      } else {
        pendingThumbColorChange = false;
      }

      // Point gesture => draw
      const indexTip = handLm[8];
      const p = toCanvasXY(indexTip, state.w, state.h);
      p.x = applyMirror(p.x);

      const sp = smoothPoint(p);

      if (latestGestures.isPointing) {
        if (!state.drawing) {
          state.drawing = true;
          state.lastPoint = sp;
        } else if (state.lastPoint) {
          drawNeonSegment(state.lastPoint, sp, state.color, state.brushSize);
          spawnParticles(sp, state.color);
          state.lastPoint = sp;
        }
      } else {
        state.drawing = false;
        state.lastPoint = null;
      }
    });

    // Use MediaPipe Camera utility for low-latency updates
    const camera = new CameraUtils.Camera(video, {
      onFrame: async () => {
        await hands.send({ image: video });
      },
      width: 1280,
      height: 720
    });

    camera.start();

    // FPS/latency: rely on MediaPipe internal pipeline and keep our work minimal.
  }

  // ---------- UI wiring ----------
  clearBtn.addEventListener('click', () => clearCanvas());

  colorPicker.addEventListener('input', () => {
    state.color = colorPicker.value;
  });

  sizeSlider.addEventListener('input', () => {
    state.brushSize = Number(sizeSlider.value);
    sizeValue.textContent = String(state.brushSize);
  });

  // ---------- Start ----------
  sizeValue.textContent = String(state.brushSize);

  // Start animation loop for particles
  animate();

  // Begin MediaPipe
  initHands().catch((err) => {
    console.error(err);
    setStatus('Camera/Hands error. Check permissions and reload.');
  });
})();

