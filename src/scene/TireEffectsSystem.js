import * as THREE from 'three';

/**
 * TireEffectsSystem
 * High-performance 60FPS skid marks ribbon system and micro-scale dust particle
 * emitter for all cars (player and AI opponents) when drifting or braking
 * on the desk or banked track surface.
 *
 * - Ring-buffered dynamic quad geometry for zero-GC continuous rubber tire marks
 * - Feathered edge shader with polygon offset to prevent Z-fighting
 * - Micro dust & tire smoke particle cloud with procedural soft puff texture
 * - Multi-car tracking for Player + Viper + Blaze + Shadow
 */

// Local contact patch offsets for 1:87 micro-kart chassis
const WHEEL_OFFSETS = {
  rl: new THREE.Vector3(-0.00585, 0.00032, -0.00545), // Rear-Left
  rr: new THREE.Vector3( 0.00585, 0.00032, -0.00545), // Rear-Right
  fl: new THREE.Vector3(-0.00560, 0.00032,  0.00545), // Front-Left
  fr: new THREE.Vector3( 0.00560, 0.00032,  0.00545), // Front-Right
};

const WHEEL_KEYS = ['rl', 'rr', 'fl', 'fr'];

// Max capacity constants
const MAX_SKID_QUADS = 2400;      // 2400 quad segments = 9600 vertices
const MAX_DUST_PARTICLES = 384;   // 384 active billboarded dust puffs

export function createTireEffectsSystem({ scene }) {
  const effectsRoot = new THREE.Group();
  effectsRoot.name = 'TireEffectsSystem';
  scene.add(effectsRoot);

  // Scratch vectors for zero GC
  const _wheelLocal = new THREE.Vector3();
  const _wheelWorld = new THREE.Vector3();
  const _segDir = new THREE.Vector3();
  const _segRight = new THREE.Vector3();
  const _segNormal = new THREE.Vector3();
  const _v0 = new THREE.Vector3();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _tempDustPos = new THREE.Vector3();
  const _tempDustVel = new THREE.Vector3();

  // ---------------------------------------------------------------------------
  // 1. PROCEDURAL DUST PUFF CANVAS TEXTURE (Zero External Image Requests)
  // ---------------------------------------------------------------------------
  const dustCanvas = document.createElement('canvas');
  dustCanvas.width = 64;
  dustCanvas.height = 64;
  const dCtx = dustCanvas.getContext('2d');
  dCtx.clearRect(0, 0, 64, 64);

  // Soft billowing radial puff with multi-ring falloff
  const radGrad = dCtx.createRadialGradient(32, 32, 2, 32, 32, 30);
  radGrad.addColorStop(0.0, 'rgba(242, 238, 230, 0.95)');
  radGrad.addColorStop(0.25, 'rgba(230, 224, 214, 0.75)');
  radGrad.addColorStop(0.55, 'rgba(210, 204, 194, 0.40)');
  radGrad.addColorStop(0.85, 'rgba(185, 180, 172, 0.12)');
  radGrad.addColorStop(1.0, 'rgba(170, 165, 158, 0.0)');

  dCtx.fillStyle = radGrad;
  dCtx.beginPath();
  dCtx.arc(32, 32, 30, 0, Math.PI * 2);
  dCtx.fill();

  const dustTexture = new THREE.CanvasTexture(dustCanvas);
  dustTexture.generateMipmaps = true;

  // ---------------------------------------------------------------------------
  // 2. SKID MARKS RIBBON MESH (Circular Ring Buffer)
  // ---------------------------------------------------------------------------
  const totalVerts = MAX_SKID_QUADS * 4;
  const totalIndices = MAX_SKID_QUADS * 6;

  const skidPositions = new Float32Array(totalVerts * 3);
  const skidNormals = new Float32Array(totalVerts * 3);
  const skidUvs = new Float32Array(totalVerts * 2);
  const skidAlphas = new Float32Array(totalVerts); // Per-vertex opacity
  const skidIndices = new Uint32Array(totalIndices);

  // Pre-generate static quad index buffer: [0, 1, 2, 2, 1, 3] pattern
  for (let k = 0; k < MAX_SKID_QUADS; k++) {
    const vBase = k * 4;
    const iBase = k * 6;
    skidIndices[iBase + 0] = vBase + 0;
    skidIndices[iBase + 1] = vBase + 1;
    skidIndices[iBase + 2] = vBase + 2;
    skidIndices[iBase + 3] = vBase + 2;
    skidIndices[iBase + 4] = vBase + 1;
    skidIndices[iBase + 5] = vBase + 3;

    // UV coordinates: U across tire width [0..1], V along segment [0..1]
    skidUvs[vBase * 2 + 0] = 0.0;
    skidUvs[vBase * 2 + 1] = 0.0;
    skidUvs[vBase * 2 + 2] = 1.0;
    skidUvs[vBase * 2 + 3] = 0.0;
    skidUvs[vBase * 2 + 4] = 0.0;
    skidUvs[vBase * 2 + 5] = 1.0;
    skidUvs[vBase * 2 + 6] = 1.0;
    skidUvs[vBase * 2 + 7] = 1.0;

    // Initialize invisible
    skidAlphas[vBase + 0] = 0.0;
    skidAlphas[vBase + 1] = 0.0;
    skidAlphas[vBase + 2] = 0.0;
    skidAlphas[vBase + 3] = 0.0;
  }

  const skidGeo = new THREE.BufferGeometry();
  skidGeo.setAttribute('position', new THREE.BufferAttribute(skidPositions, 3));
  skidGeo.setAttribute('normal', new THREE.BufferAttribute(skidNormals, 3));
  skidGeo.setAttribute('uv', new THREE.BufferAttribute(skidUvs, 2));
  skidGeo.setAttribute('aAlpha', new THREE.BufferAttribute(skidAlphas, 1));
  skidGeo.setIndex(new THREE.BufferAttribute(skidIndices, 1));

  // Skid Material with polygonOffset to guarantee zero Z-fighting with desk or coaster road
  const skidMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x0e0e11) }, // Deep matte burnt rubber
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.005) discard;
        // Soft feathered edges across tire width (vUv.x 0..1)
        float edgeMask = smoothstep(0.0, 0.24, vUv.x) * smoothstep(1.0, 0.76, vUv.x);
        // Slight tire groove striation
        float groove = 0.90 + 0.10 * cos(vUv.x * 24.0);
        float finalAlpha = vAlpha * edgeMask * groove * 0.78;
        gl_FragColor = vec4(uColor, finalAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4.0,
    polygonOffsetUnits: -4.0,
    side: THREE.DoubleSide,
  });

  const skidMesh = new THREE.Mesh(skidGeo, skidMaterial);
  skidMesh.frustumCulled = false;
  skidMesh.renderOrder = 3;
  effectsRoot.add(skidMesh);

  // Skid quad tracking arrays
  const quadLife = new Float32Array(MAX_SKID_QUADS);
  const quadMaxLife = new Float32Array(MAX_SKID_QUADS);
  const quadBaseAlpha = new Float32Array(MAX_SKID_QUADS);
  let nextQuadIndex = 0;
  let activeQuadCount = 0;

  // ---------------------------------------------------------------------------
  // 3. DUST / TIRE SMOKE PARTICLE SYSTEM (Point Billboard Pool)
  // ---------------------------------------------------------------------------
  const dustPositions = new Float32Array(MAX_DUST_PARTICLES * 3);
  const dustColors = new Float32Array(MAX_DUST_PARTICLES * 3);
  const dustAlphas = new Float32Array(MAX_DUST_PARTICLES);
  const dustLifes = new Float32Array(MAX_DUST_PARTICLES); // 0.0 (fresh) -> 1.0 (dead)
  const dustSizes = new Float32Array(MAX_DUST_PARTICLES);

  const dustVelocities = [];
  const dustAges = new Float32Array(MAX_DUST_PARTICLES);
  const dustMaxAges = new Float32Array(MAX_DUST_PARTICLES);
  const dustBaseAlphas = new Float32Array(MAX_DUST_PARTICLES);
  const dustBaseSizes = new Float32Array(MAX_DUST_PARTICLES);

  for (let i = 0; i < MAX_DUST_PARTICLES; i++) {
    dustPositions[i * 3 + 1] = -10.0; // Hide underground initially
    dustVelocities.push(new THREE.Vector3());
    dustAges[i] = 999.0;
    dustMaxAges[i] = 0.50;
    dustLifes[i] = 1.0;
    dustSizes[i] = 0.0025;
    dustAlphas[i] = 0.0;
    dustColors[i * 3 + 0] = 0.82;
    dustColors[i * 3 + 1] = 0.79;
    dustColors[i * 3 + 2] = 0.74;
  }

  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  dustGeo.setAttribute('aColor', new THREE.BufferAttribute(dustColors, 3));
  dustGeo.setAttribute('aAlpha', new THREE.BufferAttribute(dustAlphas, 1));
  dustGeo.setAttribute('aLife', new THREE.BufferAttribute(dustLifes, 1));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dustSizes, 1));

  const dustMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDust: { value: dustTexture },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aLife;
      attribute float aSize;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        vColor = aColor;
        // Smooth fade-in then gentle long fade-out
        vAlpha = aAlpha * smoothstep(0.0, 0.12, aLife) * smoothstep(1.0, 0.35, aLife);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // Micro-dust puff expansion as it diffuses into the air
        float expansion = 1.0 + aLife * 2.2;
        // Point size screen-space attenuation
        gl_PointSize = (aLife < 1.0 && vAlpha > 0.005) ? clamp((aSize * expansion * 520.0) / -mvPosition.z, 0.0, 36.0) : 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDust;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        if (vAlpha <= 0.005) discard;
        vec4 tex = texture2D(tDust, gl_PointCoord);
        float alpha = tex.a * vAlpha;
        if (alpha <= 0.005) discard;
        gl_FragColor = vec4(vColor * tex.rgb, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });

  const dustPoints = new THREE.Points(dustGeo, dustMaterial);
  dustPoints.frustumCulled = false;
  dustPoints.renderOrder = 4;
  effectsRoot.add(dustPoints);

  let nextDustIndex = 0;

  // ---------------------------------------------------------------------------
  // 4. PER-CAR WHEEL TRAIL STATE (Tracks last contact point for skid ribbons)
  // ---------------------------------------------------------------------------
  const carWheelStates = new Map();

  function getCarWheelState(carId) {
    let ws = carWheelStates.get(carId);
    if (!ws) {
      ws = {};
      for (const k of WHEEL_KEYS) {
        ws[k] = {
          lastPos: new THREE.Vector3(),
          lastNormal: new THREE.Vector3(),
          wasSkidding: false,
          dustTimer: Math.random() * 0.02,
        };
      }
      carWheelStates.set(carId, ws);
    }
    return ws;
  }

  // ---------------------------------------------------------------------------
  // 5. EMISSION HELPERS
  // ---------------------------------------------------------------------------
  function addSkidSegment(pA, pB, normal, halfWidth, intensity) {
    _segDir.subVectors(pB, pA);
    const dist = _segDir.length();
    if (dist < 0.0016) return;
    _segDir.divideScalar(dist); // Normalize

    _segNormal.copy(normal);
    // Vector perpendicular to travel across the tire tread
    _segRight.crossVectors(_segDir, _segNormal).normalize().multiplyScalar(halfWidth);

    _v0.subVectors(pA, _segRight);
    _v1.addVectors(pA, _segRight);
    _v2.subVectors(pB, _segRight);
    _v3.addVectors(pB, _segRight);

    const qIdx = nextQuadIndex;
    const vBase = qIdx * 4;

    // Set vertex positions
    skidPositions[vBase * 3 + 0] = _v0.x;
    skidPositions[vBase * 3 + 1] = _v0.y;
    skidPositions[vBase * 3 + 2] = _v0.z;

    skidPositions[vBase * 3 + 3] = _v1.x;
    skidPositions[vBase * 3 + 4] = _v1.y;
    skidPositions[vBase * 3 + 5] = _v1.z;

    skidPositions[vBase * 3 + 6] = _v2.x;
    skidPositions[vBase * 3 + 7] = _v2.y;
    skidPositions[vBase * 3 + 8] = _v2.z;

    skidPositions[vBase * 3 + 9] = _v3.x;
    skidPositions[vBase * 3 + 10] = _v3.y;
    skidPositions[vBase * 3 + 11] = _v3.z;

    // Set vertex normals
    for (let i = 0; i < 4; i++) {
      skidNormals[(vBase + i) * 3 + 0] = _segNormal.x;
      skidNormals[(vBase + i) * 3 + 1] = _segNormal.y;
      skidNormals[(vBase + i) * 3 + 2] = _segNormal.z;
    }

    const baseAlpha = THREE.MathUtils.clamp(intensity * 0.88, 0.35, 0.90);
    quadBaseAlpha[qIdx] = baseAlpha;
    quadLife[qIdx] = 16.0; // Lasts 16 seconds
    quadMaxLife[qIdx] = 16.0;

    for (let i = 0; i < 4; i++) {
      skidAlphas[vBase + i] = baseAlpha;
    }

    nextQuadIndex = (nextQuadIndex + 1) % MAX_SKID_QUADS;
    activeQuadCount = Math.min(activeQuadCount + 1, MAX_SKID_QUADS);

    skidGeo.attributes.position.needsUpdate = true;
    skidGeo.attributes.normal.needsUpdate = true;
    skidGeo.attributes.aAlpha.needsUpdate = true;
  }

  function spawnDustPuff(contactPos, tangent, normal, right, speed, isBraking) {
    const idx = nextDustIndex;
    nextDustIndex = (nextDustIndex + 1) % MAX_DUST_PARTICLES;

    // Spawn at tire contact patch with subtle micro-jitter
    _tempDustPos.copy(contactPos);
    _tempDustPos.addScaledVector(right, (Math.random() - 0.5) * 0.0014);
    _tempDustPos.addScaledVector(tangent, (Math.random() - 0.5) * 0.0012);
    _tempDustPos.addScaledVector(normal, 0.0004);

    dustPositions[idx * 3 + 0] = _tempDustPos.x;
    dustPositions[idx * 3 + 1] = _tempDustPos.y;
    dustPositions[idx * 3 + 2] = _tempDustPos.z;

    // Trailing velocity: kicks back opposite travel, micro-lift upwards, slight lateral spread
    const kickSpeed = speed * (isBraking ? 0.45 : 0.35) + 0.018;
    dustVelocities[idx]
      .copy(tangent)
      .multiplyScalar(-kickSpeed)
      .addScaledVector(normal, 0.010 + Math.random() * 0.018)
      .addScaledVector(right, (Math.random() - 0.5) * 0.016);

    const maxAge = 0.38 + Math.random() * 0.28;
    dustAges[idx] = 0.0;
    dustMaxAges[idx] = maxAge;
    dustLifes[idx] = 0.0;

    const baseSize = 0.0022 + Math.random() * 0.0015;
    dustBaseSizes[idx] = baseSize;
    dustSizes[idx] = baseSize;

    const baseAlpha = 0.36 + Math.random() * 0.18;
    dustBaseAlphas[idx] = baseAlpha;
    dustAlphas[idx] = baseAlpha;

    // Warm desk oak & tire friction smoke palette
    dustColors[idx * 3 + 0] = 0.83 + (Math.random() - 0.5) * 0.08;
    dustColors[idx * 3 + 1] = 0.80 + (Math.random() - 0.5) * 0.08;
    dustColors[idx * 3 + 2] = 0.74 + (Math.random() - 0.5) * 0.08;
  }

  // ---------------------------------------------------------------------------
  // 6. 60FPS SIMULATION STEP
  // ---------------------------------------------------------------------------
  function update(dt, cars) {
    const clampedDt = Math.min(dt, 0.05);

    // 1. Process Skid & Dust Emission for All Cars (Player & NPCs)
    for (const car of cars) {
      if (!car || !car.position || !car.quaternion) continue;

      const speed = Math.abs(car.speed || 0.0);
      const isDrifting = Boolean(car.isDrifting);
      const isBraking = Boolean(car.isBraking);
      const isSkidding = (isDrifting || isBraking) && speed > 0.032;

      const ws = getCarWheelState(car.id || 'default');

      // Intensity: higher during high speed or hard braking/drifting
      const intensity = THREE.MathUtils.clamp(
        (isBraking ? 0.75 : 0.55) + (speed / 0.22) * 0.35,
        0.4,
        1.0
      );

      // Determine which wheels skid:
      // Rear wheels (rl, rr) ALWAYS skid during drift or braking.
      // Front wheels (fl, fr) skid during hard braking or aggressive drifting.
      const activeWheelKeys = (isBraking && speed > 0.12) || (isDrifting && speed > 0.14)
        ? WHEEL_KEYS
        : ['rl', 'rr'];

      for (const key of WHEEL_KEYS) {
        const wheelState = ws[key];
        const isActiveWheel = activeWheelKeys.includes(key);
        const shouldSkid = isSkidding && isActiveWheel;

        // Calculate world 3D position of wheel contact patch
        _wheelLocal.copy(WHEEL_OFFSETS[key]);
        _wheelWorld.copy(_wheelLocal).applyQuaternion(car.quaternion).add(car.position);

        const surfaceNormal = car.normal || new THREE.Vector3(0, 1, 0);
        const carTangent = car.tangent || new THREE.Vector3(-1, 0, 0);
        const carRight = car.right || new THREE.Vector3(0, 0, -1);

        if (shouldSkid) {
          if (wheelState.wasSkidding) {
            const dist = _wheelWorld.distanceTo(wheelState.lastPos);
            // Continuous segment check: 2.0mm to 28mm travel
            if (dist >= 0.0020 && dist < 0.028) {
              const tireHalfWidth = (key === 'rl' || key === 'rr') ? 0.0011 : 0.0009;
              addSkidSegment(
                wheelState.lastPos,
                _wheelWorld,
                surfaceNormal,
                tireHalfWidth,
                intensity
              );
              wheelState.lastPos.copy(_wheelWorld);
              wheelState.lastNormal.copy(surfaceNormal);
            } else if (dist >= 0.028) {
              // Gap too large (e.g. teleport/respawn), reset start point
              wheelState.lastPos.copy(_wheelWorld);
              wheelState.lastNormal.copy(surfaceNormal);
            }
          } else {
            // First contact frame of this skid
            wheelState.wasSkidding = true;
            wheelState.lastPos.copy(_wheelWorld);
            wheelState.lastNormal.copy(surfaceNormal);
          }

          // Emit small dust / smoke puffs at contact patch
          wheelState.dustTimer += clampedDt;
          const dustInterval = isBraking ? 0.024 : 0.032;
          if (wheelState.dustTimer >= dustInterval) {
            wheelState.dustTimer = 0.0;
            spawnDustPuff(_wheelWorld, carTangent, surfaceNormal, carRight, speed, isBraking);
          }
        } else {
          wheelState.wasSkidding = false;
        }
      }
    }

    // 2. Age & Fade Out Active Skid Mark Quads
    let anySkidChanged = false;
    if (activeQuadCount > 0) {
      for (let k = 0; k < MAX_SKID_QUADS; k++) {
        if (quadLife[k] > 0) {
          quadLife[k] -= clampedDt;
          const vBase = k * 4;
          if (quadLife[k] <= 0) {
            quadLife[k] = 0;
            skidAlphas[vBase + 0] = 0.0;
            skidAlphas[vBase + 1] = 0.0;
            skidAlphas[vBase + 2] = 0.0;
            skidAlphas[vBase + 3] = 0.0;
            anySkidChanged = true;
          } else if (quadLife[k] < 5.0) {
            // Smooth fade out during last 5 seconds
            const fade = quadLife[k] / 5.0;
            const currentAlpha = quadBaseAlpha[k] * fade;
            skidAlphas[vBase + 0] = currentAlpha;
            skidAlphas[vBase + 1] = currentAlpha;
            skidAlphas[vBase + 2] = currentAlpha;
            skidAlphas[vBase + 3] = currentAlpha;
            anySkidChanged = true;
          }
        }
      }
      if (anySkidChanged) {
        skidGeo.attributes.aAlpha.needsUpdate = true;
      }
    }

    // 3. Update Active Dust Particles (Micro-Physics & Diffusion)
    let activeDustFound = false;
    for (let i = 0; i < MAX_DUST_PARTICLES; i++) {
      if (dustAges[i] < dustMaxAges[i]) {
        activeDustFound = true;
        dustAges[i] += clampedDt;
        const normLife = Math.min(1.0, dustAges[i] / dustMaxAges[i]);
        dustLifes[i] = normLife;

        // Position integration
        dustPositions[i * 3 + 0] += dustVelocities[i].x * clampedDt;
        dustPositions[i * 3 + 1] += dustVelocities[i].y * clampedDt;
        dustPositions[i * 3 + 2] += dustVelocities[i].z * clampedDt;

        // Air drag & gentle micro-gravity
        dustVelocities[i].multiplyScalar(Math.max(0.82, 1.0 - 3.4 * clampedDt));
        dustVelocities[i].y -= 0.008 * clampedDt;

        // Alpha envelope
        dustAlphas[i] = dustBaseAlphas[i];
      } else {
        dustLifes[i] = 1.0;
        dustAlphas[i] = 0.0;
        dustPositions[i * 3 + 1] = -10.0; // Keep parked out of view
      }
    }

    if (activeDustFound) {
      dustGeo.attributes.position.needsUpdate = true;
      dustGeo.attributes.aLife.needsUpdate = true;
      dustGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  // Clear all trails upon race reset (e.g. 'R' key)
  function reset() {
    for (let k = 0; k < MAX_SKID_QUADS; k++) {
      quadLife[k] = 0.0;
      const vBase = k * 4;
      skidAlphas[vBase + 0] = 0.0;
      skidAlphas[vBase + 1] = 0.0;
      skidAlphas[vBase + 2] = 0.0;
      skidAlphas[vBase + 3] = 0.0;
    }
    skidGeo.attributes.aAlpha.needsUpdate = true;
    activeQuadCount = 0;
    nextQuadIndex = 0;

    for (let i = 0; i < MAX_DUST_PARTICLES; i++) {
      dustAges[i] = 999.0;
      dustLifes[i] = 1.0;
      dustAlphas[i] = 0.0;
      dustPositions[i * 3 + 1] = -10.0;
    }
    dustGeo.attributes.position.needsUpdate = true;
    dustGeo.attributes.aLife.needsUpdate = true;
    dustGeo.attributes.aAlpha.needsUpdate = true;
    nextDustIndex = 0;

    carWheelStates.clear();
  }

  return {
    effectsRoot,
    skidMesh,
    dustPoints,
    update,
    reset,
  };
}
