import * as THREE from 'three';

/**
 * NpcOpponentSystem
 * Manages 3 distinct AI-controlled racing opponents (Viper, Blaze, Shadow)
 * with individual liveries, high-poly 3D models, competitive overtaking AI,
 * drafting mechanics, dynamic racing lines, and real-time race standings.
 */

export const NPC_RACERS = [
  {
    id: 'npc_viper',
    name: 'VIPER',
    number: '7',
    colorName: 'NEON LIME',
    colorHex: 0x00ff66,
    accentHex: 0x11161d,
    glowHex: 0x33ff88,
    suitHex: 0x152618,
    helmetHex: 0x00ff66,
    stripeHex: 0xf5f8fc,
    rimHex: 0xffaa22, // Racing gold rims
    topSpeedMult: 1.04,
    accelMult: 1.04,
    corneringSkill: 0.96,
    aggression: 0.94,
    preferredLane: -0.0030, // Hugs inside apex lines
    gridRow: 1,
    gridCol: -1, // Front-Left
  },
  {
    id: 'npc_blaze',
    name: 'BLAZE',
    number: '23',
    colorName: 'SUNSET ORANGE',
    colorHex: 0xff4d00,
    accentHex: 0xffbe0b,
    glowHex: 0xff7b00,
    suitHex: 0x2e1810,
    helmetHex: 0xff8800,
    stripeHex: 0xfff0c2,
    rimHex: 0xdde4ed, // Polished chrome rims
    topSpeedMult: 1.06,
    accelMult: 0.98,
    corneringSkill: 0.90,
    aggression: 0.88,
    preferredLane: 0.0025, // Sweeps high-speed outside-in arcs
    gridRow: 2,
    gridCol: -1, // Mid-Left
  },
  {
    id: 'npc_shadow',
    name: 'SHADOW',
    number: '99',
    colorName: 'COBALT PURPLE',
    colorHex: 0x2944ff,
    accentHex: 0x9b2aff,
    glowHex: 0x6e52ff,
    suitHex: 0x14162e,
    helmetHex: 0x7b2cbf,
    stripeHex: 0xe2d4ff,
    rimHex: 0x444d5c, // Anodized gunmetal rims
    topSpeedMult: 1.02,
    accelMult: 1.06,
    corneringSkill: 0.95,
    aggression: 0.90,
    preferredLane: 0.0000, // Tactical center lane & late braking
    gridRow: 2,
    gridCol: 1, // Mid-Right
  },
];

export function createNpcOpponentSystem({ scene, splineData, startFinishArc }) {
  const totalLength = splineData.total_length_m || 3.8371;
  const samples = splineData.samples;
  const N = samples.length;

  const opponentsRoot = new THREE.Group();
  opponentsRoot.name = 'NpcOpponentsRoot';
  scene.add(opponentsRoot);

  // Re-usable scratch vectors & matrices for zero-GC 60FPS simulation
  const _tangent = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const _rotMat = new THREE.Matrix4();
  const _baseQuat = new THREE.Quaternion();
  const _yawQuat = new THREE.Quaternion();
  const _kartForward = new THREE.Vector3();

  // Create soft contact shadow canvas
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const sCtx = shadowCanvas.getContext('2d');
  const penumbraGrad = sCtx.createRadialGradient(64, 64, 6, 64, 64, 56);
  penumbraGrad.addColorStop(0.0, 'rgba(2, 2, 5, 0.90)');
  penumbraGrad.addColorStop(0.5, 'rgba(3, 3, 7, 0.65)');
  penumbraGrad.addColorStop(0.8, 'rgba(5, 5, 10, 0.25)');
  penumbraGrad.addColorStop(1.0, 'rgba(6, 6, 12, 0.0)');
  sCtx.fillStyle = penumbraGrad;
  sCtx.beginPath();
  sCtx.arc(64, 64, 56, 0, Math.PI * 2);
  sCtx.fill();
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);

  function sampleTrackAtS(s) {
    const sNorm = ((s % totalLength) + totalLength) % totalLength;
    let low = 0;
    let high = N - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (samples[mid].arc_length_m < sNorm) low = mid + 1;
      else high = mid - 1;
    }
    const idx0 = (low - 1 + N) % N;
    const idx1 = low % N;
    const s0 = samples[idx0];
    const s1 = samples[idx1];
    let ds = s1.arc_length_m - s0.arc_length_m;
    if (ds < 0) ds += totalLength;
    let t = ds > 1e-5 ? (sNorm - s0.arc_length_m) / ds : 0.0;
    if (t < 0) t += totalLength / ds;
    t = THREE.MathUtils.clamp(t, 0.0, 1.0);

    const p0 = s0.position;
    const p1 = s1.position;
    _pos.set(
      p0[0] + (p1[0] - p0[0]) * t,
      p0[1] + (p1[1] - p0[1]) * t,
      p0[2] + (p1[2] - p0[2]) * t
    );

    const t0 = s0.tangent;
    const t1 = s1.tangent;
    _tangent.set(
      t0[0] + (t1[0] - t0[0]) * t,
      t0[1] + (t1[1] - t0[1]) * t,
      t0[2] + (t1[2] - t0[2]) * t
    ).normalize();

    const n0 = s0.normal;
    const n1 = s1.normal;
    _normal.set(
      n0[0] + (n1[0] - n0[0]) * t,
      n0[1] + (n1[1] - n0[1]) * t,
      n0[2] + (n1[2] - n0[2]) * t
    ).normalize();

    _right.crossVectors(_tangent, _normal).normalize();
    _normal.crossVectors(_right, _tangent).normalize();

    const curvature = THREE.MathUtils.lerp(s0.signed_curvature || 0, s1.signed_curvature || 0, t);
    const slope = THREE.MathUtils.lerp(s0.slope || 0, s1.slope || 0, t);

    return {
      position: _pos,
      tangent: _tangent,
      normal: _normal,
      right: _right,
      curvature,
      slope,
      sector: s0.sector,
    };
  }

  // ---------------------------------------------------------------------------
  // BUILD 3D KARTS FOR EACH NPC
  // ---------------------------------------------------------------------------
  const opponents = NPC_RACERS.map((profile, index) => {
    const root = new THREE.Group();
    root.name = `NpcKart_${profile.name}`;
    root.scale.setScalar(0.38);
    opponentsRoot.add(root);

    const chassis = new THREE.Group();
    root.add(chassis);

    // Livery materials
    const bodyMat = new THREE.MeshStandardMaterial({
      color: profile.colorHex,
      roughness: 0.18,
      metalness: 0.42,
      emissive: profile.glowHex,
      emissiveIntensity: 0.08,
    });

    const stripeMat = new THREE.MeshStandardMaterial({
      color: profile.stripeHex,
      roughness: 0.22,
      metalness: 0.15,
    });

    const carbonMat = new THREE.MeshStandardMaterial({
      color: profile.accentHex,
      roughness: 0.38,
      metalness: 0.50,
    });

    const rimMat = new THREE.MeshStandardMaterial({
      color: profile.rimHex,
      roughness: 0.22,
      metalness: 0.88,
    });

    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x14161a,
      roughness: 0.82,
      metalness: 0.04,
    });

    const helmetMat = new THREE.MeshStandardMaterial({
      color: profile.helmetHex,
      roughness: 0.20,
      metalness: 0.30,
    });

    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x05070a,
      roughness: 0.12,
      metalness: 0.85,
    });

    const headlightMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xfff6e0,
      emissiveIntensity: 1.8,
      roughness: 0.1,
    });

    const taillightMat = new THREE.MeshStandardMaterial({
      color: 0xff0018,
      emissive: 0xff0024,
      emissiveIntensity: 1.6,
      roughness: 0.1,
    });

    // Shadow decal
    const shadowQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(0.0175, 0.024),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -7,
        polygonOffsetUnits: -7,
      })
    );
    shadowQuad.rotation.x = -Math.PI / 2;
    shadowQuad.position.set(0, 0.00072, -0.0002);
    root.add(shadowQuad);

    // Procedural parts tracking
    const proceduralParts = [];
    const wheelMeshes = [];
    const frontPivots = [];

    // Floor pan
    const floorPan = new THREE.Mesh(new THREE.BoxGeometry(0.0082, 0.0009, 0.0155), carbonMat);
    floorPan.position.set(0, 0.0014, 0);
    chassis.add(floorPan);
    proceduralParts.push(floorPan);

    // Nose cone
    const noseCone = new THREE.Mesh(new THREE.BoxGeometry(0.0086, 0.0021, 0.0044), bodyMat);
    noseCone.position.set(0, 0.0024, 0.0076);
    chassis.add(noseCone);
    proceduralParts.push(noseCone);

    // Nose central stripe
    const noseStripe = new THREE.Mesh(new THREE.BoxGeometry(0.0024, 0.0022, 0.0045), stripeMat);
    noseStripe.position.set(0, 0.00245, 0.0076);
    chassis.add(noseStripe);
    proceduralParts.push(noseStripe);

    // Side pods
    const podL = new THREE.Mesh(new THREE.BoxGeometry(0.0024, 0.0022, 0.0092), bodyMat);
    podL.position.set(-0.0045, 0.0022, 0.0002);
    const podR = podL.clone();
    podR.position.x = 0.0045;
    chassis.add(podL, podR);
    proceduralParts.push(podL, podR);

    // Rear wing
    const rearWing = new THREE.Mesh(new THREE.BoxGeometry(0.0118, 0.0007, 0.0034), bodyMat);
    rearWing.position.set(0, 0.0056, -0.0084);
    const wingStripe = new THREE.Mesh(new THREE.BoxGeometry(0.0119, 0.0008, 0.0008), stripeMat);
    wingStripe.position.set(0, 0.0056, -0.0074);
    chassis.add(rearWing, wingStripe);
    proceduralParts.push(rearWing, wingStripe);

    // Driver helmet
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.0023, 14, 12), helmetMat);
    helmet.position.set(0, 0.0053, -0.001);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.0026, 0.0013, 0.0014), visorMat);
    visor.position.set(0, 0.0054, 0.0011);
    chassis.add(helmet, visor);
    proceduralParts.push(helmet, visor);

    // Wheels
    const tireGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 0.0018, 14);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.0014, 0.0014, 0.00185, 12);
    rimGeo.rotateZ(Math.PI / 2);

    function createWheel() {
      const g = new THREE.Group();
      const t = new THREE.Mesh(tireGeo, tireMat);
      const r = new THREE.Mesh(rimGeo, rimMat);
      g.add(t, r);
      return g;
    }

    // Front Left Pivot & Wheel
    const flPivot = new THREE.Group();
    flPivot.position.set(-0.0056, 0.0022, 0.0055);
    const flW = createWheel();
    flPivot.add(flW);
    chassis.add(flPivot);
    frontPivots.push(flPivot);
    wheelMeshes.push(flW);
    proceduralParts.push(flPivot);

    // Front Right Pivot & Wheel
    const frPivot = new THREE.Group();
    frPivot.position.set(0.0056, 0.0022, 0.0055);
    const frW = createWheel();
    frPivot.add(frW);
    chassis.add(frPivot);
    frontPivots.push(frPivot);
    wheelMeshes.push(frW);
    proceduralParts.push(frPivot);

    // Rear Left Wheel
    const rlW = createWheel();
    rlW.position.set(-0.0058, 0.0024, -0.0055);
    chassis.add(rlW);
    wheelMeshes.push(rlW);
    proceduralParts.push(rlW);

    // Rear Right Wheel
    const rrW = createWheel();
    rrW.position.set(0.0058, 0.0024, -0.0055);
    chassis.add(rrW);
    wheelMeshes.push(rrW);
    proceduralParts.push(rrW);

    // Headlights
    const hlL = new THREE.Mesh(new THREE.SphereGeometry(0.0008, 8, 8), headlightMat);
    hlL.position.set(-0.0032, 0.0028, 0.0096);
    const hlR = hlL.clone();
    hlR.position.x = 0.0032;
    chassis.add(hlL, hlR);
    proceduralParts.push(hlL, hlR);

    // Taillight
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.0008, 0.0006), taillightMat);
    tl.position.set(0, 0.0032, -0.0094);
    chassis.add(tl);
    proceduralParts.push(tl);

    // Staggered grid starting position
    // Row 1: Left = Viper (-0.016m, -0.0035m), Right = Player (-0.025m, +0.0035m)
    // Row 2: Left = Blaze (-0.034m, -0.0035m), Right = Shadow (-0.043m, +0.0035m)
    let gridOffsetS = 0.0;
    let gridLateral = 0.0;
    if (index === 0) {
      gridOffsetS = -0.016; // Viper P1 Pole
      gridLateral = -0.0035;
    } else if (index === 1) {
      gridOffsetS = -0.034; // Blaze P3
      gridLateral = -0.0035;
    } else {
      gridOffsetS = -0.043; // Shadow P4
      gridLateral = 0.0035;
    }

    const initS = (startFinishArc + gridOffsetS + totalLength) % totalLength;

    return {
      profile,
      root,
      chassis,
      wheelMeshes,
      frontPivots,
      proceduralParts,
      materials: {
        body: bodyMat,
        stripe: stripeMat,
        carbon: carbonMat,
        rim: rimMat,
        helmet: helmetMat,
      },
      // Live Physics & AI State
      s: initS,
      initS,
      lateralOffset: gridLateral,
      initLateral: gridLateral,
      targetLateral: gridLateral,
      lateralVel: 0.0,
      speed: 0.0,
      headingYaw: 0.0,
      steerAngle: 0.0,
      steerSmooth: 0.0,
      boostActive: 0.0,
      boostCharge: 0.25,
      isDrifting: false,
      driftAngle: 0.0,
      isDrafting: false,
      lapCount: 1,
      currentLapTime: 0.0,
      totalRaceTime: 0.0,
      lapTimes: [],
      finished: false,
      finishTotalTime: null,
      launchBoostGiven: false,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      tangent: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      right: new THREE.Vector3(),
    };
  });

  // Attach high-poly GLB Kart clone when available
  function attachGlbKart(glbScene) {
    if (!glbScene) return;

    for (const opp of opponents) {
      // Hide procedural parts
      for (const p of opp.proceduralParts) {
        if (p) p.visible = false;
      }

      const cloned = glbScene.clone(true);
      cloned.name = `NpcGlb_${opp.profile.name}`;

      const newWheels = [];
      const newFrontWheels = [];

      cloned.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          const mName = (child.material?.name || '').toLowerCase();
          const nName = (child.name || '').toLowerCase();

          if (mName.includes('helmet') || nName.includes('helmet')) {
            child.material = opp.materials.helmet;
          } else if (mName.includes('red') || mName.includes('crimson') || mName.includes('body')) {
            child.material = opp.materials.body;
          } else if (mName.includes('white') || mName.includes('stripe')) {
            child.material = opp.materials.stripe;
          } else if (mName.includes('gold') || mName.includes('rim')) {
            child.material = opp.materials.rim;
          } else if (mName.includes('carbon') || mName.includes('frame') || mName.includes('gunmetal')) {
            child.material = opp.materials.carbon;
          }
        }

        if (child.name === 'Wheel_FL' || child.name === 'Wheel_FR') {
          newFrontWheels.push(child);
          newWheels.push(child);
        } else if (child.name === 'Wheel_RL' || child.name === 'Wheel_RR') {
          newWheels.push(child);
        }
      });

      opp.chassis.add(cloned);
      if (newWheels.length > 0) opp.wheelMeshes = newWheels;
      if (newFrontWheels.length > 0) opp.frontPivots = newFrontWheels;
    }
  }

  // ---------------------------------------------------------------------------
  // RESET / RESTART GRID
  // ---------------------------------------------------------------------------
  function resetToGrid() {
    for (const opp of opponents) {
      opp.s = opp.initS;
      opp.lateralOffset = opp.initLateral;
      opp.targetLateral = opp.initLateral;
      opp.lateralVel = 0.0;
      opp.speed = 0.0;
      opp.headingYaw = 0.0;
      opp.steerAngle = 0.0;
      opp.steerSmooth = 0.0;
      opp.boostActive = 0.0;
      opp.boostCharge = 0.25;
      opp.isDrifting = false;
      opp.isBraking = false;
      opp.driftAngle = 0.0;
      opp.isDrafting = false;
      opp.lapCount = 1;
      opp.currentLapTime = 0.0;
      opp.totalRaceTime = 0.0;
      opp.lapTimes = [];
      opp.finished = false;
      opp.finishTotalTime = null;
      opp.launchBoostGiven = false;

      // Update 3D pose on the starting grid
      syncOpponentPose(opp);
    }
  }

  function syncOpponentPose(opp) {
    const frame = sampleTrackAtS(opp.s);
    opp.tangent.copy(frame.tangent);
    opp.normal.copy(frame.normal);
    opp.right.copy(frame.right);

    // Apply lateral offset along track normal and right
    opp.position
      .copy(frame.position)
      .addScaledVector(frame.right, opp.lateralOffset)
      .addScaledVector(frame.normal, 0.0028);

    // Calculate orientation with steering/heading yaw
    _rotMat.makeBasis(frame.right, frame.normal, frame.tangent);
    _baseQuat.setFromRotationMatrix(_rotMat);
    _yawQuat.setFromAxisAngle(frame.normal, opp.headingYaw);
    opp.quaternion.multiplyQuaternions(_baseQuat, _yawQuat);

    opp.root.position.copy(opp.position);
    opp.root.quaternion.copy(opp.quaternion);
  }

  // Initial grid alignment
  resetToGrid();

  // ---------------------------------------------------------------------------
  // 60FPS SIMULATION STEP
  // ---------------------------------------------------------------------------
  function update(dt, playerSt, isCountdownLocked, isRaceClockActive) {
    const clampedDt = Math.min(dt, 0.05);

    // Collect all 4 racers' live positions for competitive overtaking / drafting
    const allRacers = [
      {
        id: 'player',
        isPlayer: true,
        s: playerSt.s,
        lateralOffset: playerSt.lateralOffset,
        speed: playerSt.speed,
        position: playerSt.position,
        lapCount: playerSt.lapCount || 1,
        finished: playerSt.raceFinished || false,
      },
      ...opponents.map((o) => ({
        id: o.profile.id,
        isPlayer: false,
        opp: o,
        s: o.s,
        lateralOffset: o.lateralOffset,
        speed: o.speed,
        position: o.position,
        lapCount: o.lapCount,
        finished: o.finished,
      })),
    ];

    // Simulate each AI opponent
    for (const opp of opponents) {
      if (isCountdownLocked) {
        // Idling on the starting grid
        opp.speed = 0.0;
        opp.isDrifting = false;
        opp.isBraking = false;
        opp.headingYaw = THREE.MathUtils.lerp(opp.headingYaw, 0.0, 0.2);
        // Subtle engine rumble vibration
        opp.chassis.position.y = Math.sin(performance.now() * 0.05 + opp.s * 10.0) * 0.00015;
        syncOpponentPose(opp);
        continue;
      }

      opp.chassis.position.y = 0;

      // F1 Grid Launch surge upon lights out!
      if (isRaceClockActive && !opp.launchBoostGiven) {
        opp.launchBoostGiven = true;
        opp.boostActive = 0.85 * opp.profile.accelMult;
        opp.speed = 0.08;
      }

      const frame = sampleTrackAtS(opp.s);

      // Track race times
      if (isRaceClockActive && !opp.finished) {
        opp.currentLapTime += clampedDt;
        opp.totalRaceTime += clampedDt;
      }

      // Base top speeds (calibrated to match player: cruise ~0.202 m/s, boost ~0.285 m/s)
      const baseCruiseSpeed = 0.202 * opp.profile.topSpeedMult;
      const baseBoostSpeed = 0.285 * opp.profile.topSpeedMult;
      const baseAccel = 0.220 * opp.profile.accelMult;

      // Check upcoming track curvature (Cat Helix, Lamp Corkscrew, etc.) for dynamic braking
      const lookAheadS = (opp.s + 0.12) % totalLength;
      const lookAheadFrame = sampleTrackAtS(lookAheadS);
      const absCurvature = Math.abs(lookAheadFrame.curvature);
      const isTightCorner = absCurvature > 0.45;

      let targetSpeed = baseCruiseSpeed;

      // Cornering speed governor
      if (isTightCorner) {
        // Slow down smoothly into tight hairpin/corkscrew curves
        const cornerFactor = THREE.MathUtils.clamp(1.0 - absCurvature * 0.28 * (2.0 - opp.profile.corneringSkill), 0.68, 0.95);
        targetSpeed = baseCruiseSpeed * cornerFactor;
      } else if (frame.sector === 6) {
        // Logitech G915 main straight: full throttle stretch
        targetSpeed = baseCruiseSpeed * 1.05;
      }

      // Handle active turbo boost
      if (opp.boostActive > 0) {
        opp.boostActive = Math.max(0.0, opp.boostActive - clampedDt);
        targetSpeed = baseBoostSpeed;
      } else {
        // Passive boost trickle charge
        opp.boostCharge = Math.min(1.0, opp.boostCharge + clampedDt * 0.08);
      }

      // -----------------------------------------------------------------------
      // COMPETITIVE AI: RACING LINE, DRAFTING & OVERTAKING
      // -----------------------------------------------------------------------
      // Ideal apex line through corners
      let desiredLane = opp.profile.preferredLane;
      if (Math.abs(frame.curvature) > 0.30) {
        // Dive toward inside apex
        const apexDir = -Math.sign(frame.curvature) || 1;
        desiredLane = apexDir * 0.0055 * opp.profile.corneringSkill;
      }

      // Scan all other 3 karts ahead on the track
      let nearestDistAhead = Infinity;
      let carAhead = null;
      let shouldOvertake = false;
      let passDirection = 0;

      for (const other of allRacers) {
        if (other.id === opp.profile.id) continue;
        let dS = ((other.s - opp.s) % totalLength + totalLength) % totalLength;
        if (dS > 0 && dS < nearestDistAhead) {
          nearestDistAhead = dS;
          carAhead = other;
        }
      }

      opp.isDrafting = false;

      // If a car is within 55mm ahead
      if (carAhead && nearestDistAhead < 0.055) {
        const latDelta = opp.lateralOffset - carAhead.lateralOffset;

        // 1. Slipstream Drafting if tucked in behind (within ±3mm laterally)
        if (Math.abs(latDelta) < 0.0035 && nearestDistAhead > 0.016) {
          opp.isDrafting = true;
          opp.boostCharge = Math.min(1.0, opp.boostCharge + clampedDt * 0.45);
          targetSpeed *= 1.12; // 12% slipstream speed surge
        }

        // 2. Overtaking: if moving faster, steer around to pass!
        if (opp.speed >= carAhead.speed * 0.96 && nearestDistAhead < 0.042) {
          shouldOvertake = true;
          // Dive to whichever side has more room
          if (carAhead.lateralOffset > 0) {
            // Car ahead is on right -> pass on left!
            passDirection = -1;
            desiredLane = THREE.MathUtils.clamp(carAhead.lateralOffset - 0.0055, -0.0075, 0.0075);
          } else {
            // Car ahead is on left -> pass on right!
            passDirection = 1;
            desiredLane = THREE.MathUtils.clamp(carAhead.lateralOffset + 0.0055, -0.0075, 0.0075);
          }

          // Trigger tactical boost to execute pass if available!
          if (opp.boostCharge > 0.45 && opp.boostActive <= 0 && Math.random() < 0.35) {
            opp.boostActive = 0.65;
            opp.boostCharge -= 0.40;
          }
        }

        // 3. Anti-Clipping Brake: if right on tail (< 15mm) and cannot clear lane
        if (nearestDistAhead < 0.015 && Math.abs(latDelta) < 0.003) {
          targetSpeed = Math.min(targetSpeed, carAhead.speed * 0.95);
        }
      }

      // Wheel-to-Wheel bump separation: push karts apart if rubbing side-by-side
      for (const other of allRacers) {
        if (other.id === opp.profile.id) continue;
        let dS = Math.abs(other.s - opp.s);
        if (dS > totalLength * 0.5) dS = totalLength - dS;

        if (dS < 0.018) {
          // Within touching distance longitudinally
          const latDiff = opp.lateralOffset - other.lateralOffset;
          if (Math.abs(latDiff) < 0.0075) {
            const pushDir = Math.sign(latDiff) || (opp.profile.gridCol || 1);
            opp.lateralOffset += pushDir * 0.014 * clampedDt;
            // Also nudge player if in contact
            if (other.isPlayer && playerSt) {
              playerSt.lateralOffset -= pushDir * 0.008 * clampedDt;
            }
          }
        }
      }

      // Steer toward desired lane
      opp.targetLateral = desiredLane;
      const latError = opp.targetLateral - opp.lateralOffset;
      const steerP = THREE.MathUtils.clamp(latError * 34.0, -0.42, 0.42);
      opp.steerSmooth = THREE.MathUtils.lerp(opp.steerSmooth, steerP, 1.0 - Math.exp(-12.0 * clampedDt));
      opp.steerAngle = opp.steerSmooth;

      // Update heading yaw toward steer
      const targetYaw = THREE.MathUtils.clamp(-opp.steerSmooth * 0.16, -0.16, 0.16);
      opp.headingYaw = THREE.MathUtils.lerp(opp.headingYaw, targetYaw, 1.0 - Math.exp(-14.0 * clampedDt));

      // Lateral motion
      const latVel = opp.speed * (-Math.sin(opp.headingYaw)) + steerP * 0.022;
      opp.lateralOffset += latVel * clampedDt;
      opp.lateralOffset = THREE.MathUtils.clamp(opp.lateralOffset, -0.0080, 0.0080);

      // Longitudinal acceleration & braking
      const speedErr = targetSpeed - opp.speed;
      const accel = THREE.MathUtils.clamp(speedErr * 5.2, -1.2, baseAccel * 1.5);
      const slopeFactor = -frame.slope * 0.18;
      opp.speed = Math.max(0.0, opp.speed + (accel + slopeFactor) * clampedDt);

      // Detect braking & cornering drift for skid marks and tire smoke
      opp.isBraking = accel < -0.22 && opp.speed > 0.042;
      const cornerSlip = Math.abs(opp.steerSmooth) * (opp.speed / 0.16);
      opp.isDrifting = (cornerSlip > 0.18 && opp.speed > 0.08) || (Math.abs(frame.curvature) > 0.38 && opp.speed > 0.09);

      // Advance arc-length s along track
      const prevS = opp.s;
      const forwardProj = Math.max(0.0, Math.cos(opp.headingYaw));
      const ds = opp.speed * forwardProj * clampedDt;
      opp.s = ((opp.s + ds) % totalLength + totalLength) % totalLength;

      // Lap Detection
      if (!opp.finished && opp.speed > 0 && opp.currentLapTime > 3.0) {
        const distBefore = ((startFinishArc - prevS) % totalLength + totalLength) % totalLength;
        if (distBefore > 0 && distBefore <= ds * 1.8) {
          opp.lapTimes.push(opp.currentLapTime);
          if (opp.lapCount < 3) {
            opp.lapCount++;
            opp.currentLapTime = 0.0;
          } else {
            opp.finished = true;
            opp.finishTotalTime = opp.totalRaceTime;
          }
        }
      }

      // -----------------------------------------------------------------------
      // 3D POSE & WHEEL ROTATIONS
      // -----------------------------------------------------------------------
      syncOpponentPose(opp);

      // Rotate wheels & steer front pivots
      for (const pivot of opp.frontPivots) {
        pivot.rotation.y = opp.steerAngle;
      }
      const wheelSpin = (opp.speed * clampedDt) / 0.0022;
      for (const w of opp.wheelMeshes) {
        w.rotation.x += wheelSpin;
      }
    }
  }

  // Sync scales for camera mode
  function syncKartScale(scale) {
    for (const opp of opponents) {
      opp.root.scale.setScalar(scale);
    }
  }

  // ---------------------------------------------------------------------------
  // LIVE RACE CLASSIFICATION / LEADERBOARD (1ST THROUGH 4TH)
  // ---------------------------------------------------------------------------
  function getLeaderboard(playerSt) {
    const list = [
      {
        id: 'player',
        name: 'YOU',
        number: '4',
        colorHex: 0x00e5ff,
        isPlayer: true,
        lapCount: Math.min(3, Math.max(1, playerSt.lapCount || 1)),
        finished: playerSt.raceFinished || false,
        totalTime: playerSt.finishTotalTime || playerSt.totalRaceTime || 0,
        s: playerSt.s || 0,
        speed: playerSt.speed || 0,
      },
      ...opponents.map((o) => ({
        id: o.profile.id,
        name: o.profile.name,
        number: o.profile.number,
        colorHex: o.profile.colorHex,
        isPlayer: false,
        lapCount: Math.min(3, Math.max(1, o.lapCount)),
        finished: o.finished,
        totalTime: o.finishTotalTime || o.totalRaceTime || 0,
        s: o.s,
        speed: o.speed,
      })),
    ];

    // Compute progress score: completed laps + arc progress
    for (const r of list) {
      if (r.finished) {
        // Finished cars ranked by their total finish time
        r.score = 10000.0 - r.totalTime;
      } else {
        r.score = (r.lapCount - 1) * totalLength + r.s;
      }
    }

    list.sort((a, b) => b.score - a.score);

    const leader = list[0];
    let playerRank = 1;

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      r.rank = i + 1;
      if (r.isPlayer) playerRank = i + 1;

      // Gap calculation in seconds
      if (i === 0) {
        r.gapStr = 'LEADER';
      } else {
        const distBehindLeader = (leader.score - r.score);
        const refSpeed = Math.max(0.12, r.speed);
        const secBehind = distBehindLeader / refSpeed;
        r.gapStr = `+${secBehind.toFixed(1)}s`;
      }

      const m = Math.floor(r.totalTime / 60);
      const s = (r.totalTime % 60).toFixed(2);
      r.timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(5, '0')}`;
    }

    return {
      playerRank,
      racers: list,
    };
  }

  function getOpponentsMinimapPositions() {
    return opponents.map((o) => ({
      name: o.profile.name,
      colorHex: o.profile.colorHex,
      glowHex: o.profile.glowHex,
      position: o.position,
    }));
  }

  return {
    opponentsRoot,
    opponents,
    update,
    syncKartScale,
    attachGlbKart,
    resetToGrid,
    getLeaderboard,
    getOpponentsMinimapPositions,
  };
}
