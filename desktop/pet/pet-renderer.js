'use strict';
(function () {
  const canvas = document.getElementById('pet-canvas');
  const ctx = canvas.getContext('2d');
  const bubble = document.getElementById('pet-bubble');
  const container = document.getElementById('pet-container');

  const VALID_STATES = new Set([
    'idle', 'running', 'waving', 'jumping',
    'failed', 'waiting', 'review', 'success', 'sleep', 'reminder',
  ]);

  let currentState = 'idle';
  let frame = 0;
  let animId = null;
  let reducedMotion = false;
  let osReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let petWidth = 96;
  let petHeight = 104;
  let bubbleTimer = null;
  let clickTimer = null;
  let pendingSingleClick = false;
  let atlasLoaded = false;
  let atlasImage = null;
  let atlasManifest = null;

  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    osReducedMotion = e.matches;
    reducedMotion = osReducedMotion || (petSettings_reducedMotion || false);
  });

  let petSettings_reducedMotion = false;

  const COLORS = {
    body: '#FFB347',
    bodyDark: '#E8942E',
    eyeOpen: '#333',
    eyeClosed: '#999',
    cheek: '#FF8C94',
    mouth: '#333',
    highlight: '#FFF5E0',
    reminder: '#FF6B6B',
  };

  function loadSpriteAtlas() {
    const basePath = window.petAPI ? window.petAPI.getAtlasBasePath : null;
    if (!basePath) return Promise.resolve(false);
    return fetch('pet.json')
      .then(r => r.json())
      .then(manifest => {
        atlasManifest = manifest;
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => { atlasImage = img; atlasLoaded = true; resolve(true); };
          img.onerror = () => { atlasLoaded = false; resolve(false); };
          img.src = manifest.atlas || 'pet-atlas.png';
        });
      })
      .catch(() => { atlasLoaded = false; return false; });
  }

  function drawAtlasFrame(state, frameNum) {
    if (!atlasLoaded || !atlasManifest || !atlasImage) return false;
    const stateDef = atlasManifest.states && atlasManifest.states[state];
    if (!stateDef) return false;
    const row = stateDef.row || 0;
    const cols = stateDef.cols || 1;
    const duration = stateDef.duration || 1;
    const col = frameNum % cols;
    const fw = atlasManifest.frameWidth || petWidth;
    const fh = atlasManifest.frameHeight || petHeight;
    const sx = col * fw;
    const sy = row * fh;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(atlasImage, sx, sy, fw, fh, 0, 0, canvas.width, canvas.height);
    return true;
  }

  function applySettings(settings) {
    if (!settings) return;
    petSettings_reducedMotion = !!settings.reducedMotion;
    reducedMotion = osReducedMotion || petSettings_reducedMotion;
    const sizeMap = { small: 72, medium: 96, large: 128 };
    petWidth = sizeMap[settings.size] || 96;
    petHeight = Math.round(petWidth * 1.08);
    canvas.width = petWidth;
    canvas.height = petHeight;
    if (animId) cancelAnimationFrame(animId);
    tick();
  }

  function setState(state) {
    if (!VALID_STATES.has(state)) return;
    if (currentState === state) return;
    currentState = state;
    frame = 0;
  }

  function toggleBubble() {
    if (bubble.classList.contains('visible')) {
      bubble.classList.remove('visible');
      bubble.textContent = '';
      clearTimeout(bubbleTimer);
    } else {
      bubble.textContent = '美美在这里~';
      bubble.classList.add('visible');
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => {
        bubble.classList.remove('visible');
      }, 4000);
    }
  }

  function setBubbleText(text) {
    if (!text || typeof text !== 'string') {
      bubble.classList.remove('visible');
      bubble.textContent = '';
      return;
    }
    bubble.textContent = text;
    bubble.classList.add('visible');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.classList.remove('visible');
    }, 4000);
  }

  function tick() {
    draw();
    const effectiveReducedMotion = osReducedMotion || petSettings_reducedMotion;
    if (!effectiveReducedMotion) frame++;
    animId = requestAnimationFrame(tick);
  }

  function draw() {
    if (atlasLoaded && drawAtlasFrame(currentState, frame)) return;
    drawProcedural();
  }

  function drawProcedural() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = petWidth / 2;
    const cy = petHeight / 2;
    const r = petWidth * 0.38;

    let offsetY = 0;
    let eyeOpen = true;
    let mouthType = 'smile';
    let extraDraw = null;

    switch (currentState) {
      case 'idle': {
        offsetY = Math.sin(frame * 0.04) * 3;
        break;
      }
      case 'waving': {
        offsetY = Math.sin(frame * 0.04) * 3;
        extraDraw = 'wave';
        break;
      }
      case 'running': {
        offsetY = Math.sin(frame * 0.1) * 5;
        break;
      }
      case 'jumping': {
        offsetY = -Math.abs(Math.sin(frame * 0.08)) * 12;
        break;
      }
      case 'failed': {
        eyeOpen = false;
        mouthType = 'frown';
        break;
      }
      case 'success': {
        offsetY = Math.sin(frame * 0.04) * 3;
        mouthType = 'grin';
        break;
      }
      case 'waiting': {
        offsetY = Math.sin(frame * 0.03) * 2;
        extraDraw = 'question';
        break;
      }
      case 'review': {
        offsetY = Math.sin(frame * 0.04) * 3;
        extraDraw = 'magnify';
        break;
      }
      case 'sleep': {
        offsetY = Math.sin(frame * 0.02) * 2;
        eyeOpen = false;
        mouthType = 'sleep';
        extraDraw = 'zzz';
        break;
      }
      case 'reminder': {
        offsetY = Math.sin(frame * 0.06) * 4;
        extraDraw = 'bell';
        break;
      }
    }

    const by = cy + offsetY;

    ctx.beginPath();
    ctx.arc(cx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.body;
    ctx.fill();
    ctx.strokeStyle = COLORS.bodyDark;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, by - r * 0.3, r * 0.8, Math.PI, 0);
    ctx.fillStyle = COLORS.highlight;
    ctx.fill();

    const eyeY = by - r * 0.15;
    const eyeSpacing = r * 0.35;
    const eyeR = r * 0.12;

    if (eyeOpen) {
      ctx.fillStyle = COLORS.eyeOpen;
      ctx.beginPath();
      ctx.arc(cx - eyeSpacing, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + eyeSpacing, eyeY, eyeR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = COLORS.eyeClosed;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - eyeSpacing - eyeR, eyeY);
      ctx.lineTo(cx - eyeSpacing + eyeR, eyeY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + eyeSpacing - eyeR, eyeY);
      ctx.lineTo(cx + eyeSpacing + eyeR, eyeY);
      ctx.stroke();
    }

    const cheekR = r * 0.14;
    ctx.fillStyle = COLORS.cheek;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(cx - eyeSpacing - r * 0.1, eyeY + r * 0.25, cheekR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + eyeSpacing + r * 0.1, eyeY + r * 0.25, cheekR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    const mouthY = by + r * 0.25;
    ctx.strokeStyle = COLORS.mouth;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (mouthType === 'smile') {
      ctx.arc(cx, mouthY - r * 0.05, r * 0.2, 0.1 * Math.PI, 0.9 * Math.PI);
    } else if (mouthType === 'grin') {
      ctx.arc(cx, mouthY - r * 0.1, r * 0.25, 0.05 * Math.PI, 0.95 * Math.PI);
    } else if (mouthType === 'frown') {
      ctx.arc(cx, mouthY + r * 0.2, r * 0.18, 1.15 * Math.PI, 1.85 * Math.PI);
    } else if (mouthType === 'sleep') {
      ctx.moveTo(cx - r * 0.1, mouthY);
      ctx.lineTo(cx + r * 0.1, mouthY);
    }
    ctx.stroke();

    if (extraDraw === 'wave') {
      const handX = cx + r * 0.9;
      const handY = by - r * 0.3;
      const waveAngle = Math.sin(frame * 0.15) * 0.5;
      ctx.save();
      ctx.translate(handX, handY);
      ctx.rotate(waveAngle);
      ctx.fillStyle = COLORS.body;
      ctx.beginPath();
      ctx.arc(0, -r * 0.2, r * 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.bodyDark;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    if (extraDraw === 'zzz') {
      const zzX = cx + r * 0.7;
      const zzBaseY = by - r * 0.8;
      ctx.font = `bold ${Math.round(r * 0.25)}px system-ui`;
      ctx.fillStyle = '#8899bb';
      ctx.globalAlpha = 0.7 + Math.sin(frame * 0.05) * 0.3;
      for (let i = 0; i < 3; i++) {
        const alpha = (i + 1) / 3;
        ctx.globalAlpha = alpha * (0.5 + Math.sin(frame * 0.05 + i) * 0.3);
        ctx.fillText('z', zzX + i * r * 0.2, zzBaseY - i * r * 0.25 - Math.sin(frame * 0.03 + i) * 3);
      }
      ctx.globalAlpha = 1;
    }

    if (extraDraw === 'question') {
      ctx.font = `bold ${Math.round(r * 0.5)}px system-ui`;
      ctx.fillStyle = '#6688cc';
      ctx.fillText('?', cx + r * 0.6, by - r * 0.6);
    }

    if (extraDraw === 'magnify') {
      const mx = cx + r * 0.7;
      const my = by - r * 0.4;
      const mr = r * 0.2;
      ctx.strokeStyle = '#6688cc';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx + mr * 0.7, my + mr * 0.7);
      ctx.lineTo(mx + mr * 1.3, my + mr * 1.3);
      ctx.stroke();
    }

    if (extraDraw === 'bell') {
      const bx = cx + r * 0.75;
      const byy = by - r * 0.6;
      const bScale = 1 + Math.sin(frame * 0.12) * 0.15;
      ctx.save();
      ctx.translate(bx, byy);
      ctx.scale(bScale, bScale);
      ctx.fillStyle = COLORS.reminder;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-r * 0.12, r * 0.14);
      ctx.lineTo(r * 0.12, r * 0.14);
      ctx.lineTo(0, r * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  container.addEventListener('click', (e) => {
    if (pendingSingleClick) {
      clearTimeout(clickTimer);
      pendingSingleClick = false;
      if (window.petAPI) window.petAPI.notifyDoubleClick();
    } else {
      pendingSingleClick = true;
      clickTimer = setTimeout(() => {
        if (pendingSingleClick) {
          pendingSingleClick = false;
          toggleBubble();
        }
      }, 300);
    }
  });

  container.addEventListener('dblclick', (e) => {
    e.preventDefault();
  });

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (window.petAPI) window.petAPI.notifyRightClick(e.clientX, e.clientY);
  });

  container.addEventListener('mousedown', (e) => {
    if (e.button === 0 && window.petAPI) window.petAPI.notifyDragStart();
  });

  container.addEventListener('mouseup', () => {
    if (window.petAPI) window.petAPI.notifyDragEnd();
  });

  document.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const onPet = x >= 0 && x <= rect.width && y >= 0 && y <= rect.height;
    if (window.petAPI) window.petAPI.notifyMouseMove(onPet);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (animId) cancelAnimationFrame(animId);
      animId = null;
    } else {
      if (!animId) tick();
    }
  });

  if (window.petAPI) {
    window.petAPI.onStateChange((state) => setState(state));
    window.petAPI.onBubbleText((text) => setBubbleText(text));
    window.petAPI.onReducedMotionChange((reduced) => {
      petSettings_reducedMotion = !!reduced;
      reducedMotion = osReducedMotion || petSettings_reducedMotion;
    });
    window.petAPI.getSettings().then((settings) => applySettings(settings));
    loadSpriteAtlas();
  }

  canvas.width = petWidth;
  canvas.height = petHeight;
  tick();
})();
