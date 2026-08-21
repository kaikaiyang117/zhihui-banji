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

  const V2_STATES = {
    idle: { row: 0, cols: 6, durations: [280, 110, 110, 140, 140, 320] },
    'running-right': { row: 1, cols: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    'running-left': { row: 2, cols: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    waving: { row: 3, cols: 4, durations: [140, 140, 140, 280] },
    jumping: { row: 4, cols: 5, durations: [140, 140, 140, 140, 280] },
    failed: { row: 5, cols: 8, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
    waiting: { row: 6, cols: 6, durations: [150, 150, 150, 150, 150, 260] },
    running: { row: 7, cols: 6, durations: [120, 120, 120, 120, 120, 220] },
    review: { row: 8, cols: 6, durations: [150, 150, 150, 150, 150, 280] },
  };

  const STATE_ALIASES = {
    success: 'waving',
    sleep: 'idle',
    reminder: 'waiting',
  };

  let currentState = 'idle';
  let frame = 0;
  let lastFrameAt = 0;
  let animId = null;
  let osReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let petWidth = 96;
  let petHeight = 104;
  let bubbleTimer = null;
  let clickTimer = null;
  let pendingSingleClick = false;
  let atlasLoaded = false;
  let atlasImage = null;
  let atlasManifest = null;
  let lookDirection = null;
  let dragging = false;
  let dragState = null;
  let dragLastScreenX = 0;

  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    osReducedMotion = e.matches;
    frame = 0;
    lastFrameAt = 0;
    lookDirection = null;
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
    if (!window.petAPI || !window.petAPI.getManifest) return Promise.resolve(false);
    return window.petAPI.getManifest()
      .then(manifest => {
        if (!manifest || manifest.spriteVersionNumber !== 2) return false;
        atlasManifest = manifest;
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            atlasImage = img;
            atlasLoaded = img.naturalWidth === 1536 && img.naturalHeight === 2288;
            resolve(atlasLoaded);
          };
          img.onerror = () => { atlasLoaded = false; resolve(false); };
          img.src = manifest.spritesheetPath;
        });
      })
      .catch(() => { atlasLoaded = false; return false; });
  }

  function atlasStateDefinition(state) {
    if (!atlasLoaded || !atlasManifest || !atlasImage) return false;
    const mappedState = STATE_ALIASES[state] || state;
    if (atlasManifest.spriteVersionNumber === 2) return V2_STATES[mappedState] || false;
    return atlasManifest.states && atlasManifest.states[mappedState];
  }

  function drawAtlasCell(row, col) {
    if (!atlasLoaded || !atlasImage) return false;
    const fw = 192;
    const fh = 208;
    const sx = col * fw;
    const sy = row * fh;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(atlasImage, sx, sy, fw, fh, 0, 0, canvas.width, canvas.height);
    return true;
  }

  function drawAtlasFrame(state, frameNum) {
    const stateDef = atlasStateDefinition(state);
    if (!stateDef) return false;
    return drawAtlasCell(stateDef.row || 0, frameNum % (stateDef.cols || 1));
  }

  function drawLookFrame(directionIndex) {
    if (!atlasLoaded || atlasManifest.spriteVersionNumber !== 2) return false;
    const row = directionIndex < 8 ? 9 : 10;
    return drawAtlasCell(row, directionIndex % 8);
  }

  function applySettings(settings) {
    if (!settings) return;
    petSettings_reducedMotion = !!settings.reducedMotion;
    const sizeMap = { small: 72, medium: 96, large: 128 };
    petWidth = sizeMap[settings.size] || 96;
    petHeight = Math.round(petWidth * 1.08);
    canvas.width = petWidth;
    canvas.height = petHeight;
    bubble.style.bottom = `${petHeight + 8}px`;
    ctx.imageSmoothingEnabled = true;
  }

  function setState(state) {
    if (!VALID_STATES.has(state)) return;
    if (currentState === state) return;
    currentState = state;
    frame = 0;
    lastFrameAt = 0;
    lookDirection = null;
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

  function showClickReaction() {
    setState('waving');
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => {
      if (currentState === 'waving') setState('idle');
    }, 1200);
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

  function tick(timestamp = performance.now()) {
    draw();
    const effectiveReducedMotion = osReducedMotion || petSettings_reducedMotion;
    if (effectiveReducedMotion) {
      frame = 0;
    } else if (!atlasLoaded) {
      frame++;
    } else {
      const stateDef = atlasStateDefinition(dragState || currentState);
      const durations = stateDef && stateDef.durations;
      const duration = durations ? durations[frame % durations.length] : 120;
      if (!lastFrameAt) lastFrameAt = timestamp;
      if (timestamp - lastFrameAt >= duration) {
        frame = (frame + 1) % ((stateDef && stateDef.cols) || 1);
        lastFrameAt = timestamp;
      }
    }
    animId = requestAnimationFrame(tick);
  }

  function draw() {
    if (lookDirection !== null && currentState === 'idle' && !dragState &&
        !osReducedMotion && !petSettings_reducedMotion && drawLookFrame(lookDirection)) return;
    if (atlasLoaded && drawAtlasFrame(dragState || currentState, frame)) return;
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

  function updateLookDirection(x, y, rect) {
    if (!atlasLoaded || atlasManifest.spriteVersionNumber !== 2 || currentState !== 'idle' ||
        osReducedMotion || petSettings_reducedMotion || dragging) {
      lookDirection = null;
      return;
    }
    const dx = x - rect.width / 2;
    const dy = y - rect.height / 2;
    if (Math.hypot(dx, dy) < 12) {
      lookDirection = null;
      return;
    }
    const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    lookDirection = Math.round(degrees / 22.5) % 16;
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
          showClickReaction();
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
    if (e.button !== 0) return;
    dragging = true;
    dragState = null;
    dragLastScreenX = e.screenX;
    lookDirection = null;
    if (window.petAPI) window.petAPI.notifyDragStart();
  });

  container.addEventListener('mouseup', () => {
    dragging = false;
    dragState = null;
    frame = 0;
    lastFrameAt = 0;
    if (window.petAPI) window.petAPI.notifyDragEnd();
  });

  document.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const onPet = x >= 0 && x <= rect.width && y >= 0 && y <= rect.height;
    if (dragging) {
      const deltaX = e.screenX - dragLastScreenX;
      if (Math.abs(deltaX) >= 1) {
        const nextDragState = deltaX > 0 ? 'running-right' : 'running-left';
        if (dragState !== nextDragState) {
          dragState = nextDragState;
          frame = 0;
          lastFrameAt = 0;
        }
        dragLastScreenX = e.screenX;
      }
    } else if (onPet) {
      updateLookDirection(x, y, rect);
    } else {
      lookDirection = null;
    }
    if (window.petAPI) window.petAPI.notifyMouseMove(onPet);
  });

  document.addEventListener('mouseleave', () => {
    if (!dragging) lookDirection = null;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (animId) cancelAnimationFrame(animId);
      animId = null;
    } else {
      if (!animId) tick(performance.now());
    }
  });

  if (window.petAPI) {
    window.petAPI.onStateChange((state) => setState(state));
    window.petAPI.onBubbleText((text) => setBubbleText(text));
    window.petAPI.onReducedMotionChange((reduced) => {
      petSettings_reducedMotion = !!reduced;
      frame = 0;
      lastFrameAt = 0;
      lookDirection = null;
    });
    window.petAPI.getSettings().then((settings) => applySettings(settings));
    loadSpriteAtlas().then(() => {
      frame = 0;
      lastFrameAt = 0;
    });
  }

  canvas.width = petWidth;
  canvas.height = petHeight;
  bubble.style.bottom = `${petHeight + 8}px`;
  ctx.imageSmoothingEnabled = true;
  tick(performance.now());
})();
