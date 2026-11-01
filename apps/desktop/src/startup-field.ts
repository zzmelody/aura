interface OrbitPoint {
  x: number;
  y: number;
  z: number;
}

export interface StartupField {
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}

/** Local canvas artwork only: no assets, network calls, or service readiness. */
export function startStartupField(
  canvas: HTMLCanvasElement,
  surface: HTMLElement,
  initiallyReduced: boolean,
): StartupField {
  const context = canvas.getContext("2d");
  if (!context) return { setReducedMotion() {}, dispose() {} };
  const theme = getComputedStyle(surface);
  const accent = theme.getPropertyValue("--startup-accent").trim();
  const accentRgb = theme.getPropertyValue("--startup-accent-rgb").trim();
  const bright = theme.getPropertyValue("--startup-bright").trim();
  const brightRgb = theme.getPropertyValue("--startup-bright-rgb").trim();
  const coreColor = theme.getPropertyValue("--startup-core").trim();
  const deep = theme.getPropertyValue("--startup-deep").trim();
  const atmosphereRgb = theme
    .getPropertyValue("--startup-atmosphere-rgb")
    .trim();
  const started = performance.now();
  const tau = Math.PI * 2;
  let reduced = initiallyReduced;
  let disposed = false;
  let frame = 0;
  let width = 0;
  let height = 0;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));

  function point(
    angle: number,
    radius: number,
    tilt: number,
    twist: number,
    time: number,
  ): OrbitPoint {
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const z = y * Math.sin(tilt + time * 0.1);
    const yy = y * Math.cos(tilt + time * 0.1);
    const perspective = 520 / (520 - z);
    return {
      x: (x * Math.cos(twist) - yy * Math.sin(twist)) * perspective,
      y: (x * Math.sin(twist) + yy * Math.cos(twist)) * perspective,
      z,
    };
  }

  function draw(now: number) {
    if (!context || disposed || document.hidden) return;
    const elapsed = reduced ? 3 : (now - started) / 1000;
    const time = reduced ? 0.7 : elapsed;
    const intro = 1 - (1 - clamp(elapsed / 1.9)) ** 3;
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    const scale = Math.min(width / 660, 1);
    context.scale(scale, scale);
    const radius = 113 * (0.58 + intro * 0.42);
    const halo = context.createRadialGradient(0, 0, 9, 0, 0, 212);
    halo.addColorStop(0, `rgba(${accentRgb},${0.09 + Math.sin(time) * 0.012})`);
    halo.addColorStop(0.46, `rgba(${atmosphereRgb},0.035)`);
    halo.addColorStop(1, "rgba(21,21,23,0)");
    context.fillStyle = halo;
    context.fillRect(-240, -240, 480, 480);

    for (let index = 0; index < 58; index++) {
      const angle = index * 2.39996 + time * (index % 2 ? 0.008 : -0.012);
      const distance = 138 + ((index * 43) % 140);
      const opacity =
        (0.08 + (Math.sin(time * 0.65 + index) + 1) * 0.08) * intro;
      context.fillStyle = `rgba(${brightRgb},${opacity})`;
      context.beginPath();
      context.arc(
        Math.cos(angle) * distance,
        Math.sin(angle) * distance * 0.65,
        index % 7 ? 0.65 : 1,
        0,
        tau,
      );
      context.fill();
    }

    const wave = (time % 4.8) / 4.8;
    if (!reduced && elapsed > 0.45) {
      context.beginPath();
      context.ellipse(0, 0, 72 + wave * 165, 32 + wave * 74, -0.35, 0, tau);
      context.strokeStyle = `rgba(${accentRgb},${(1 - wave) ** 3 * 0.11})`;
      context.lineWidth = 0.8;
      context.stroke();
    }

    const particles: Array<OrbitPoint & { opacity: number }> = [];
    const rings = [
      {
        radius,
        tilt: 1.04,
        twist: -0.52 + Math.sin(time * 0.2) * 0.13,
        speed: 0.48,
        opacity: 1,
      },
      {
        radius: radius * 0.96,
        tilt: 1.21,
        twist: 0.78 + Math.sin(time * 0.18) * 0.17,
        speed: -0.36,
        opacity: 0.43,
      },
      {
        radius: radius * 1.11,
        tilt: 1.39,
        twist: -0.12 + Math.sin(time * 0.16) * 0.16,
        speed: 0.29,
        opacity: 0.36,
      },
    ];

    for (const [ringIndex, ring] of rings.entries()) {
      const growth = clamp((elapsed - ringIndex * 0.13) / 1.2);
      const sweep = reduced ? tau : tau * (1 - (1 - growth) ** 3);
      const orbitOffset = time * ring.speed;
      for (let index = 0; index < 240; index++) {
        const angle = (index / 240) * sweep;
        const a = point(angle, ring.radius, ring.tilt, ring.twist, time);
        const b = point(
          angle + sweep / 240 + 0.002,
          ring.radius,
          ring.tilt,
          ring.twist,
          time,
        );
        const distance = (((angle - orbitOffset) % tau) + tau) % tau;
        const light = Math.exp(-distance * 2.2);
        const front = clamp((a.z + ring.radius) / (ring.radius * 2));
        const opacity =
          (0.15 + light * 0.85 + front * 0.18) * ring.opacity * intro;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.strokeStyle = `rgba(${accentRgb},${opacity})`;
        context.lineWidth = 0.65 + light * 0.9;
        context.stroke();
      }
      particles.push({
        ...point(orbitOffset, ring.radius, ring.tilt, ring.twist, time),
        opacity: intro * (ringIndex === 0 ? 1 : 0.55),
      });
    }

    const coreRadius = (8 + intro * 6) * (1 + Math.sin(time * 1.7) * 0.045);
    const coreGlow = context.createRadialGradient(0, 0, 0, 0, 0, 54);
    coreGlow.addColorStop(0, `rgba(${brightRgb},0.3)`);
    coreGlow.addColorStop(0.24, `rgba(${accentRgb},0.16)`);
    coreGlow.addColorStop(1, `rgba(${accentRgb},0)`);
    context.fillStyle = coreGlow;
    context.fillRect(-54, -54, 108, 108);
    const core = context.createRadialGradient(
      -coreRadius * 0.25,
      -coreRadius * 0.35,
      0,
      0,
      0,
      coreRadius,
    );
    core.addColorStop(0, coreColor);
    core.addColorStop(0.35, bright);
    core.addColorStop(0.78, accent);
    core.addColorStop(1, deep);
    context.fillStyle = core;
    context.shadowColor = `rgba(${accentRgb},0.6)`;
    context.shadowBlur = 17;
    context.beginPath();
    context.arc(0, 0, coreRadius, 0, tau);
    context.fill();
    context.shadowBlur = 0;
    for (const particle of particles) {
      context.fillStyle = `rgba(${brightRgb},${particle.opacity})`;
      context.shadowColor = accent;
      context.shadowBlur = 11;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.z > 0 ? 1.8 : 1.2, 0, tau);
      context.fill();
    }
    context.restore();
    surface.dataset.canvas = "true";
    if (!reduced) frame = requestAnimationFrame(draw);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = canvas.clientWidth || bounds.width;
    height = canvas.clientHeight || bounds.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (reduced) draw(performance.now());
  }

  function resume() {
    cancelAnimationFrame(frame);
    if (!disposed && !document.hidden) frame = requestAnimationFrame(draw);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  document.addEventListener("visibilitychange", resume);
  resize();
  resume();
  return {
    setReducedMotion(value) {
      reduced = value;
      resume();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
