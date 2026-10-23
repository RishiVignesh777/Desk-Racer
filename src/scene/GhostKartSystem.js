import * as THREE from 'three';

/**
 * GhostKartSystem
 * Records the player's best lap and renders a transparent holographic 3D model replay
 * of that lap during subsequent attempts, complete with live delta time and minimap radar marker.
 */

const STORAGE_KEY = 'desk_racer_ghost_best_v1';

// Custom Holographic Ghost Shader
const ghostVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const ghostFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uRimColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uScanlineIntensity;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;

  void main() {
    vec3 viewDir = normalize(vViewPosition);
    vec3 normal = normalize(vNormal);

    // Grazing angle Fresnel glow (silhouettes light up radiantly)
    float NdotV = clamp(abs(dot(normal, viewDir)), 0.0, 1.0);
    float fresnel = pow(1.0 - NdotV, 2.2);

    // Subtle horizontal holographic scanline shimmer
    float scanline = sin(vWorldPosition.y * 1100.0 - uTime * 6.5) * 0.5 + 0.5;
    float scanFactor = mix(1.0, 0.82 + 0.18 * scanline, uScanlineIntensity);

    // Ethereal breathing pulse
    float pulse = 0.94 + 0.06 * sin(uTime * 3.8);

    vec3 baseCol = uColor * 0.95;
    vec3 rimCol = uRimColor * 1.55;
    vec3 finalRgb = mix(baseCol, rimCol, fresnel) * scanFactor * pulse;

    float alpha = clamp(uOpacity * (0.35 + 0.65 * fresnel), 0.0, 0.85);

    gl_FragColor = vec4(finalRgb, alpha);
  }
`;

function createGhostMaterial(colorHex = 0x00d8ff, rimHex = 0xa4f4ff, opacity = 0.48) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uRimColor: { value: new THREE.Color(rimHex) },
      uOpacity: { value: opacity },
      uTime: { value: 0.0 },
      uScanlineIntensity: { value: 0.75 },
    },
    vertexShader: ghostVertexShader,
    fragmentShader: ghostFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
}

export function createGhostKartSystem({ scene, splineData }) {
  const ghostRoot = new THREE.Group();
  ghostRoot.name = 'GhostKartRoot';
  ghostRoot.visible = false;
  scene.add(ghostRoot);

  const chassisGroup = new THREE.Group();
  chassisGroup.name = 'GhostChassisGroup';
  ghostRoot.add(chassisGroup);

  // Ghost holographic materials
  const ghostBodyMat = createGhostMaterial(0x00d8ff, 0x9ef5ff, 0.50); // Electric cyan body
  const ghostWheelMat = createGhostMaterial(0x0077b6, 0x48cae4, 0.45); // Deep cyan/blue wheels
  const ghostVisorMat = createGhostMaterial(0x0a192f, 0x00f5d4, 0.68); // Dark tinted visor with mint rim
  const ghostLightMat = createGhostMaterial(0xffffff, 0xc8f7ff, 0.75); // Radiant white headlights
  const ghostTailMat = createGhostMaterial(0xff0055, 0xff70a6, 0.65); // Ruby red tail indicator

  const ghostMaterials = [
    ghostBodyMat,
    ghostWheelMat,
    ghostVisorMat,
    ghostLightMat,
    ghostTailMat,
  ];

  // Soft cyan holographic ground shadow ellipse directly under the ghost kart
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const sCtx = shadowCanvas.getContext('2d');
  const gGrad = sCtx.createRadialGradient(64, 64, 8, 64, 64, 58);
  gGrad.addColorStop(0.0, 'rgba(0, 230, 255, 0.38)');
  gGrad.addColorStop(0.5, 'rgba(0, 180, 255, 0.18)');
  gGrad.addColorStop(1.0, 'rgba(0, 120, 255, 0.0)');
  sCtx.fillStyle = gGrad;
  sCtx.beginPath();
  sCtx.arc(64, 64, 58, 0, Math.PI * 2);
  sCtx.fill();

  const ghostShadowTex = new THREE.CanvasTexture(shadowCanvas);
  const ghostShadowQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(0.016, 0.022),
    new THREE.MeshBasicMaterial({
      map: ghostShadowTex,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      blending: THREE.AdditiveBlending,
    })
  );
  ghostShadowQuad.rotation.x = -Math.PI / 2;
  ghostShadowQuad.position.set(0, 0.00075, -0.0002);
  ghostRoot.add(ghostShadowQuad);

  // Wheel tracking arrays
  let wheelMeshes = [];
  let frontPivots = [];
  let proceduralParts = [];

  // Build procedural ghost kart geometry matching 1:87 micro kart
  function buildProceduralGhostKart() {
    // 1. Carbon floor pan
    const floorPan = new THREE.Mesh(
      new THREE.BoxGeometry(0.0082, 0.0009, 0.0155),
      ghostBodyMat
    );
    floorPan.position.set(0, 0.0014, 0);
    chassisGroup.add(floorPan);
    proceduralParts.push(floorPan);

    // 2. Aerodynamic nose fairing
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.0086, 0.0021, 0.0044),
      ghostBodyMat
    );
    nose.position.set(0, 0.0024, 0.0076);
    chassisGroup.add(nose);
    proceduralParts.push(nose);

    // 3. Side pods
    const podL = new THREE.Mesh(
      new THREE.BoxGeometry(0.0022, 0.0022, 0.009),
      ghostBodyMat
    );
    podL.position.set(-0.0044, 0.0022, 0);
    const podR = podL.clone();
    podR.position.x = 0.0044;
    chassisGroup.add(podL, podR);
    proceduralParts.push(podL, podR);

    // 4. Rear spoiler
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(0.011, 0.0006, 0.003),
      ghostBodyMat
    );
    wing.position.set(0, 0.0055, -0.0085);
    chassisGroup.add(wing);
    proceduralParts.push(wing);

    // 5. Driver helmet
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.0022, 12, 10),
      ghostBodyMat
    );
    helmet.position.set(0, 0.0052, -0.001);
    chassisGroup.add(helmet);
    proceduralParts.push(helmet);

    // Visor
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.0026, 0.0012, 0.0014),
      ghostVisorMat
    );
    visor.position.set(0, 0.0053, 0.001);
    chassisGroup.add(visor);
    proceduralParts.push(visor);

    // 6. Wheels (Front-Left, Front-Right, Rear-Left, Rear-Right)
    const wheelGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 0.0018, 12);
    wheelGeo.rotateZ(Math.PI / 2);

    // Front Left Pivot & Wheel
    const flPivot = new THREE.Group();
    flPivot.position.set(-0.0056, 0.0022, 0.0055);
    const flWheel = new THREE.Mesh(wheelGeo, ghostWheelMat);
    flPivot.add(flWheel);
    chassisGroup.add(flPivot);
    frontPivots.push(flPivot);
    wheelMeshes.push(flWheel);
    proceduralParts.push(flPivot, flWheel);

    // Front Right Pivot & Wheel
    const frPivot = new THREE.Group();
    frPivot.position.set(0.0056, 0.0022, 0.0055);
    const frWheel = new THREE.Mesh(wheelGeo, ghostWheelMat);
    frPivot.add(frWheel);
    chassisGroup.add(frPivot);
    frontPivots.push(frPivot);
    wheelMeshes.push(frWheel);
    proceduralParts.push(frPivot, frWheel);

    // Rear Left Wheel
    const rlWheel = new THREE.Mesh(wheelGeo, ghostWheelMat);
    rlWheel.position.set(-0.0058, 0.0024, -0.0055);
    chassisGroup.add(rlWheel);
    wheelMeshes.push(rlWheel);
    proceduralParts.push(rlWheel);

    // Rear Right Wheel
    const rrWheel = new THREE.Mesh(wheelGeo, ghostWheelMat);
    rrWheel.position.set(0.0058, 0.0024, -0.0055);
    chassisGroup.add(rrWheel);
    wheelMeshes.push(rrWheel);
    proceduralParts.push(rrWheel);

    // Headlight glow spheres
    const hlL = new THREE.Mesh(new THREE.SphereGeometry(0.0008, 8, 8), ghostLightMat);
    hlL.position.set(-0.0032, 0.0028, 0.0096);
    const hlR = hlL.clone();
    hlR.position.x = 0.0032;
    chassisGroup.add(hlL, hlR);
    proceduralParts.push(hlL, hlR);

    // Tail-light glow
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.0008, 0.0006), ghostTailMat);
    tl.position.set(0, 0.0032, -0.0094);
    chassisGroup.add(tl);
    proceduralParts.push(tl);
  }

  buildProceduralGhostKart();

  // Attach high-poly GLB Kart clone when loaded
  function attachGlbKart(glbScene) {
    if (!glbScene) return;

    // Hide procedural fallback parts
    for (const part of proceduralParts) {
      if (part) part.visible = false;
    }

    const clonedGlb = glbScene.clone(true);
    clonedGlb.name = 'GhostGlbScene';

    const newGlbWheels = [];
    const newGlbFrontWheels = [];

    clonedGlb.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;

        const matName = (child.material && child.material.name
          ? child.material.name
          : ''
        ).toLowerCase();
        const nodeName = (child.name || '').toLowerCase();

        if (matName.includes('visor') || nodeName.includes('visor')) {
          child.material = ghostVisorMat;
        } else if (
          matName.includes('tire') ||
          matName.includes('wheel') ||
          matName.includes('rubber') ||
          nodeName.includes('wheel')
        ) {
          child.material = ghostWheelMat;
        } else if (matName.includes('headlight') || nodeName.includes('headlight')) {
          child.material = ghostLightMat;
        } else if (
          matName.includes('taillight') ||
          matName.includes('rainlight') ||
          nodeName.includes('tail')
        ) {
          child.material = ghostTailMat;
        } else {
          child.material = ghostBodyMat;
        }
      }

      if (child.name === 'Wheel_FL' || child.name === 'Wheel_FR') {
        newGlbFrontWheels.push(child);
        newGlbWheels.push(child);
      } else if (child.name === 'Wheel_RL' || child.name === 'Wheel_RR') {
        newGlbWheels.push(child);
      }
    });

    chassisGroup.add(clonedGlb);

    if (newGlbWheels.length > 0) {
      wheelMeshes = newGlbWheels;
    }
    if (newGlbFrontWheels.length > 0) {
      frontPivots = newGlbFrontWheels;
    }
  }

  // ---------------------------------------------------------------------------
  // RECORDING & PLAYBACK STATE
  // ---------------------------------------------------------------------------
  let isGhostEnabled = true;
  let bestLapTime = null;
  let bestLapRecording = null; // Array of { t, s, pos: [x,y,z], quat: [x,y,z,w], steer, speed }
  let activeLapSamples = [];
  let isRecordingActive = false;
  let lastRecordedTime = -1;
  let currentReplayIdx = 0;
  let isGhostVisible = false;
  let lastDeltaSec = 0.0;
  let lastDeltaStr = '--:--';
  let isPlayerAhead = false;
  const totalLength = splineData.total_length_m || 3.8371;

  // Temporary vectors for zero-GC interpolation
  const _vPosA = new THREE.Vector3();
  const _vPosB = new THREE.Vector3();
  const _vInterpPos = new THREE.Vector3();
  const _qRotA = new THREE.Quaternion();
  const _qRotB = new THREE.Quaternion();
  const _qInterpRot = new THREE.Quaternion();

  // Try to load best lap from localStorage
  function loadSavedBestLap() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && typeof data.bestLapTime === 'number' && Array.isArray(data.samples) && data.samples.length > 20) {
        bestLapTime = data.bestLapTime;
        bestLapRecording = data.samples;
      }
    } catch (err) {
      console.warn('GhostKartSystem: Could not load saved lap:', err);
    }
  }

  loadSavedBestLap();

  function saveBestLap(lapTime, samples) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          bestLapTime: lapTime,
          savedAt: Date.now(),
          samples,
        })
      );
    } catch (err) {
      console.warn('GhostKartSystem: Could not save lap to localStorage:', err);
    }
  }

  // Starts recording a fresh lap
  function startLapRecording() {
    activeLapSamples = [];
    isRecordingActive = true;
    lastRecordedTime = -1;
    currentReplayIdx = 0;
  }

  // Record a physics tick during active lap
  function recordFrame(lapTime, st) {
    if (!isRecordingActive || lapTime === undefined || lapTime < 0) return;

    // Throttle samples to ~45-60Hz (at least 0.016s between samples)
    if (lastRecordedTime >= 0 && lapTime - lastRecordedTime < 0.016) {
      return;
    }
    lastRecordedTime = lapTime;

    activeLapSamples.push({
      t: Math.round(lapTime * 1000) / 1000,
      s: Math.round((st.s || 0) * 10000) / 10000,
      p: [
        Math.round(st.position.x * 100000) / 100000,
        Math.round(st.position.y * 100000) / 100000,
        Math.round(st.position.z * 100000) / 100000,
      ],
      q: [
        Math.round(st.quaternion.x * 10000) / 10000,
        Math.round(st.quaternion.y * 10000) / 10000,
        Math.round(st.quaternion.z * 10000) / 10000,
        Math.round(st.quaternion.w * 10000) / 10000,
      ],
      steer: Math.round((st.steerAngle || 0) * 1000) / 1000,
      speed: Math.round((st.speed || 0) * 1000) / 1000,
    });
  }

  // Called when player finishes a lap
  function onLapComplete(lapTime, completedLapNum) {
    let isNewBest = false;
    const oldBest = bestLapTime;

    // Minimum valid lap threshold: 3.0s
    if (lapTime >= 3.0 && activeLapSamples.length >= 25) {
      if (bestLapTime === null || lapTime < bestLapTime) {
        bestLapTime = lapTime;
        bestLapRecording = activeLapSamples.slice();
        saveBestLap(bestLapTime, bestLapRecording);
        isNewBest = true;
      }
    }

    // Reset recording buffer for subsequent lap
    activeLapSamples = [];
    isRecordingActive = true;
    lastRecordedTime = -1;
    currentReplayIdx = 0;

    return {
      isNewBest,
      oldBest,
      newBest: bestLapTime,
      lapNum: completedLapNum,
    };
  }

  // Interpolates ghost replay pose at current lap time `t`
  function getGhostPoseAtTime(t) {
    if (!bestLapRecording || bestLapRecording.length < 2) return null;
    const n = bestLapRecording.length;

    // Clamp or find binary segment
    if (t <= bestLapRecording[0].t) {
      const s0 = bestLapRecording[0];
      return {
        pos: _vInterpPos.set(s0.p[0], s0.p[1], s0.p[2]),
        rot: _qInterpRot.set(s0.q[0], s0.q[1], s0.q[2], s0.q[3]),
        steer: s0.steer,
        speed: s0.speed,
        fade: 1.0,
      };
    }

    const lastSample = bestLapRecording[n - 1];
    if (t >= lastSample.t) {
      // Finished lap: fade out over 1.4 seconds
      const fadeElapsed = t - lastSample.t;
      if (fadeElapsed > 1.4) {
        return null;
      }
      const fade = Math.max(0.0, 1.0 - fadeElapsed / 1.4);
      return {
        pos: _vInterpPos.set(lastSample.p[0], lastSample.p[1], lastSample.p[2]),
        rot: _qInterpRot.set(lastSample.q[0], lastSample.q[1], lastSample.q[2], lastSample.q[3]),
        steer: 0.0,
        speed: 0.0,
        fade,
      };
    }

    // Fast linear hunt starting from currentReplayIdx
    let idx = currentReplayIdx;
    if (idx < 0 || idx >= n - 1 || bestLapRecording[idx].t > t) {
      idx = 0;
    }
    while (idx < n - 1 && bestLapRecording[idx + 1].t < t) {
      idx++;
    }
    currentReplayIdx = idx;

    const sA = bestLapRecording[idx];
    const sB = bestLapRecording[idx + 1];
    const span = Math.max(1e-5, sB.t - sA.t);
    const alpha = THREE.MathUtils.clamp((t - sA.t) / span, 0.0, 1.0);

    _vPosA.set(sA.p[0], sA.p[1], sA.p[2]);
    _vPosB.set(sB.p[0], sB.p[1], sB.p[2]);
    _vInterpPos.lerpVectors(_vPosA, _vPosB, alpha);

    _qRotA.set(sA.q[0], sA.q[1], sA.q[2], sA.q[3]);
    _qRotB.set(sB.q[0], sB.q[1], sB.q[2], sB.q[3]);
    _qInterpRot.slerpQuaternions(_qRotA, _qRotB, alpha);

    const steer = THREE.MathUtils.lerp(sA.steer, sB.steer, alpha);
    const speed = THREE.MathUtils.lerp(sA.speed, sB.speed, alpha);

    return {
      pos: _vInterpPos,
      rot: _qInterpRot,
      steer,
      speed,
      fade: 1.0,
    };
  }

  // Computes the ghost's lap time at track arc-length `s` to determine exact live delta (+/- seconds)
  function computeGhostTimeAtArcLength(playerS) {
    if (!bestLapRecording || bestLapRecording.length < 2) return null;
    const n = bestLapRecording.length;

    // Normalize playerS into [0, totalLength]
    const sNorm = ((playerS % totalLength) + totalLength) % totalLength;

    // Find the ghost keyframe closest to sNorm
    let bestDist = Infinity;
    let closestTime = null;

    for (let i = 0; i < n; i++) {
      const gs = bestLapRecording[i].s;
      // Circular track distance
      let d = Math.abs(gs - sNorm);
      if (d > totalLength * 0.5) {
        d = totalLength - d;
      }
      if (d < bestDist) {
        bestDist = d;
        closestTime = bestLapRecording[i].t;
      }
    }

    return closestTime;
  }

  // Main update loop called every frame from animate()
  function update(dt, playerLapTime, st, activeCameraMode) {
    // 1. Advance shader time uniform for subtle shimmer pulse
    const nowSec = performance.now() * 0.001;
    for (const mat of ghostMaterials) {
      if (mat.uniforms && mat.uniforms.uTime) {
        mat.uniforms.uTime.value = nowSec;
      }
    }

    // 2. Active lap recording
    if (!st.countdownLocked && st.raceClockActive && !st.autopilot) {
      recordFrame(playerLapTime, st);
    }

    // 3. Playback ghost replay if enabled and a recording exists
    const hasRecording = Boolean(bestLapRecording && bestLapRecording.length >= 20);
    const shouldShow = isGhostEnabled && hasRecording && !st.autopilot && !st.countdownLocked;

    if (!shouldShow) {
      ghostRoot.visible = false;
      isGhostVisible = false;
      return;
    }

    const pose = getGhostPoseAtTime(playerLapTime);
    if (!pose) {
      ghostRoot.visible = false;
      isGhostVisible = false;
      return;
    }

    ghostRoot.visible = true;
    isGhostVisible = true;

    // Update 3D pose
    ghostRoot.position.copy(pose.pos);
    ghostRoot.quaternion.copy(pose.rot);

    // Apply fade opacity if finishing
    const baseOpacity = 0.50 * pose.fade;
    ghostBodyMat.uniforms.uOpacity.value = baseOpacity;
    ghostWheelMat.uniforms.uOpacity.value = 0.44 * pose.fade;
    ghostVisorMat.uniforms.uOpacity.value = 0.65 * pose.fade;
    ghostShadowQuad.material.opacity = 0.70 * pose.fade;

    // Steer front wheels & spin all 4 wheels
    for (const pivot of frontPivots) {
      pivot.rotation.y = THREE.MathUtils.clamp(pose.steer, -0.42, 0.42);
    }
    const spinDelta = (pose.speed * dt) / 0.0022;
    for (const wheel of wheelMeshes) {
      wheel.rotation.x += spinDelta;
    }

    // 4. Calculate live delta (+/- seconds) between player and ghost
    if (playerLapTime > 0.4) {
      const ghostS = computeGhostTimeAtArcLength(st.s);
      if (ghostS !== null) {
        const delta = playerLapTime - ghostS;
        lastDeltaSec = delta;
        isPlayerAhead = delta <= 0;
        const sign = delta > 0 ? '+' : '-';
        const absVal = Math.abs(delta);
        const secs = Math.floor(absVal);
        const centis = Math.floor((absVal - secs) * 100);
        lastDeltaStr = `${sign}${secs}.${String(centis).padStart(2, '0')}s`;
      }
    }
  }

  function syncKartScale(scale) {
    ghostRoot.scale.setScalar(scale);
  }

  function toggleGhost(forceVal) {
    isGhostEnabled = forceVal !== undefined ? Boolean(forceVal) : !isGhostEnabled;
    if (!isGhostEnabled) {
      ghostRoot.visible = false;
      isGhostVisible = false;
    }
    return isGhostEnabled;
  }

  function clearGhost() {
    bestLapTime = null;
    bestLapRecording = null;
    activeLapSamples = [];
    isGhostVisible = false;
    ghostRoot.visible = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_e) {}
  }

  // Pre-seed a clean demonstration ghost (e.g. for testing before lap completion)
  function seedDemoGhost(splineSamples) {
    if (bestLapRecording && bestLapRecording.length > 0) return;
    const samples = [];
    const n = splineSamples.length;
    const lapDuration = 20.85; // ~20.85s reference lap
    for (let i = 0; i < n; i++) {
      const frac = i / (n - 1);
      const sp = splineSamples[i];
      samples.push({
        t: Math.round(frac * lapDuration * 1000) / 1000,
        s: sp.arc_length_m,
        p: [sp.position[0], sp.position[1] + 0.0025, sp.position[2]],
        q: [0, 0, 0, 1], // Neutral frame
        steer: 0,
        speed: 0.19,
      });
    }
    bestLapTime = lapDuration;
    bestLapRecording = samples;
    saveBestLap(bestLapTime, bestLapRecording);
  }

  function getGhostMinimapPosition() {
    if (!isGhostVisible || !ghostRoot.visible) return null;
    return ghostRoot.position;
  }

  function getDeltaInfo() {
    if (!bestLapRecording || !isGhostVisible) {
      return {
        active: false,
        bestTimeStr: bestLapTime ? formatTimeMMSSCC(bestLapTime) : '--:--.--',
        deltaStr: '',
        isAhead: true,
      };
    }
    return {
      active: true,
      bestTimeStr: formatTimeMMSSCC(bestLapTime),
      deltaStr: lastDeltaStr,
      deltaSec: lastDeltaSec,
      isAhead: isPlayerAhead,
    };
  }

  function formatTimeMMSSCC(seconds) {
    const totalCentis = Math.max(0, Math.floor((seconds || 0) * 100));
    const mins = Math.floor(totalCentis / 6000);
    const secs = Math.floor((totalCentis % 6000) / 100);
    const centis = totalCentis % 100;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }

  return {
    ghostRoot,
    attachGlbKart,
    startLapRecording,
    recordFrame,
    onLapComplete,
    update,
    syncKartScale,
    toggleGhost,
    clearGhost,
    seedDemoGhost,
    isGhostEnabled: () => isGhostEnabled,
    isGhostVisible: () => isGhostVisible,
    hasBestLap: () => Boolean(bestLapRecording && bestLapRecording.length > 0),
    getBestLapTime: () => bestLapTime,
    getGhostMinimapPosition,
    getDeltaInfo,
  };
}
