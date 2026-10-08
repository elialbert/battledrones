import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Biome } from "../../sim/types";
import { CameraRig } from "./camera";
import { ScreenLayer } from "./screen";

/**
 * The WebGL stage: renderer, scene, sun and sky light per biome, the camera
 * rig, the 2D overlay and a full-screen flash. The sun's shadow frustum
 * follows the camera so shadows stay sharp wherever you look.
 */

interface Look {
  bg: number;
  sky: number;
  ground: number;
  hemi: number;
  sun: number;
  sunI: number;
  exposure: number;
}

const LOOKS: Record<Biome, Look> = {
  temperate: { bg: 0x070a10, sky: 0xc6d8ff, ground: 0x51603a, hemi: 1.45, sun: 0xfff0d8, sunI: 2.3, exposure: 1.0 },
  desert: { bg: 0x0d0a07, sky: 0xdde8ff, ground: 0x8c6c40, hemi: 1.4, sun: 0xffe6bf, sunI: 2.35, exposure: 0.98 },
  arctic: { bg: 0x070a10, sky: 0xd8e8ff, ground: 0x8a98a8, hemi: 1.35, sun: 0xeef4ff, sunI: 2.0, exposure: 0.95 },
  volcanic: { bg: 0x0b0606, sky: 0xb0a0a8, ground: 0x402418, hemi: 1.5, sun: 0xffd2b0, sunI: 2.0, exposure: 1.05 }
};

/** Is this WebGL context rasterising on the CPU (SwiftShader, llvmpipe…)? */
function isSoftwareGl(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    return /swiftshader|llvmpipe|software|softpipe/i.test(name);
  } catch {
    return false;
  }
}

/** Direction the sunlight comes FROM: north-west and high (the painted art's upper-left light). */
export const SUN_DIR = new THREE.Vector3(-0.62, 1.15, -0.55).normalize();

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly screen: ScreenLayer;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private flashEl: HTMLDivElement;
  private shadowHalf = 0;
  /** Adaptive resolution: the 3D view's current pixel ratio and the controller's state. */
  private ratio: number;
  private ema = 16;
  private slowFor = 0;
  private slowFrames = 0;
  private fastFor = 0;
  private settle = 0;
  /** No GPU (Chrome's software fallback): start at the cheapest look. */
  readonly software: boolean;

  constructor(private parent: HTMLElement, public dpr: number) {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", alpha: false });
    this.ratio = dpr;
    r.setPixelRatio(dpr);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.domElement.className = "view3d";
    parent.appendChild(r.domElement);
    this.renderer = r;
    this.screen = new ScreenLayer(parent, this.rig);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.4);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.castShadow = true;
    // phones get a lighter shadow map; desktops a crisper one
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const size = coarse ? 1024 : 2048;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 140;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    this.software = isSoftwareGl(r);
    if (this.software) {
      this.ratio = Math.min(1, dpr);
      r.setPixelRatio(this.ratio);
      r.shadowMap.enabled = false;
      sun.castShadow = false;
    }

    this.flashEl = document.createElement("div");
    this.flashEl.className = "screenflash";
    Object.assign(this.flashEl.style, {
      position: "absolute", inset: "0", pointerEvents: "none", opacity: "0", background: "#fff"
    });
    parent.appendChild(this.flashEl);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setBiome(b: Biome): void {
    const l = LOOKS[b];
    this.scene.background = new THREE.Color(l.bg);
    this.hemi.color.setHex(l.sky);
    this.hemi.groundColor.setHex(l.ground);
    this.hemi.intensity = l.hemi;
    this.sun.color.setHex(l.sun);
    this.sun.intensity = l.sunI;
    this.renderer.toneMappingExposure = l.exposure;
  }

  resize(): void {
    const w = this.parent.clientWidth || window.innerWidth;
    const h = this.parent.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    this.screen.resize(w, h, this.dpr);
  }

  /** Compile every shader the scene needs now (during loading), not mid-battle. */
  precompile(): void {
    this.renderer.compile(this.scene, this.rig.camera);
  }

  /**
   * Adaptive resolution. Fed every frame's real interval: when the view runs
   * slow for a while, the 3D canvas renders fewer pixels (fill cost scales
   * with the pixel ratio squared, so one proportional step usually lands
   * near 30 fps); as a last resort, shadows go. When there's headroom again
   * the resolution creeps back up. The HUD and overlay stay crisp.
   */
  adapt(frameMs: number): void {
    const ms = Math.min(1500, Math.max(1, frameMs));
    this.ema += (ms - this.ema) * 0.2;
    this.settle = Math.max(0, this.settle - ms);
    if (this.settle > 0) return;
    const slow = this.ema > 42;
    this.slowFor = slow ? this.slowFor + ms : 0;
    this.slowFrames = slow ? this.slowFrames + 1 : 0;
    this.fastFor = this.ema < 22 ? this.fastFor + ms : 0;
    // (a crawl acts within a few frames; a mild slump only once it has lasted)
    if (this.slowFor > 1200 || (this.ema > 150 && this.slowFrames >= 3)) {
      this.slowFor = 0;
      this.slowFrames = 0;
      this.degrade();
      this.settle = Math.min(1500, this.ema * 2);
    } else if (this.fastFor > 6000 && this.ratio < this.dpr) {
      this.fastFor = 0;
      this.setRatio(Math.min(this.dpr, this.ratio * 1.2));
      this.settle = 3000;
    }
  }

  /** One step cheaper, in order of what costs most for the least loss: pixels above 1×, the shadow map, shadows, then pixels again. */
  private degrade(): void {
    const k = Math.min(0.85, Math.sqrt(30 / this.ema));
    const shadow = this.sun.shadow;
    if (this.ratio > 1.01) this.setRatio(Math.max(1, this.ratio * k));
    else if (this.renderer.shadowMap.enabled && shadow.mapSize.x > 1024) {
      shadow.mapSize.set(1024, 1024);
      shadow.map?.dispose();
      shadow.map = null;
      this.shadowHalf = 0;
    } else if (this.renderer.shadowMap.enabled) this.setShadows(false);
    else if (this.ratio > 0.5) this.setRatio(Math.max(0.5, this.ratio * k));
  }

  private setRatio(r: number): void {
    this.ratio = r;
    this.renderer.setPixelRatio(r);
    this.resize();
    this.ema = 30;
  }

  private setShadows(on: boolean): void {
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
  }

  /** Current 3D pixel ratio (adaptive). */
  get pixelRatio(): number {
    return this.ratio;
  }

  /** Keep the sun's shadow box over what the camera sees. */
  private fitShadow(): void {
    const v = this.rig.viewRect();
    const cx = (v.x0 + v.x1) / 2;
    const cz = (v.y0 + v.y1) / 2;
    const half = Math.min(60, Math.max(v.x1 - v.x0, v.y1 - v.y0) / 2 + 3);
    // resize in steps (a new projection every frame would shimmer)
    if (Math.abs(half - this.shadowHalf) > this.shadowHalf * 0.12 || this.shadowHalf === 0) {
      this.shadowHalf = Math.ceil(half);
      const cam = this.sun.shadow.camera;
      cam.left = cam.bottom = -this.shadowHalf;
      cam.right = cam.top = this.shadowHalf;
      cam.updateProjectionMatrix();
    }
    // snap to whole shadow texels so edges don't crawl while panning
    const texel = (this.shadowHalf * 2) / this.sun.shadow.mapSize.x;
    const sx = Math.round(cx / texel) * texel;
    const sz = Math.round(cz / texel) * texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + SUN_DIR.x * 60, SUN_DIR.y * 60, sz + SUN_DIR.z * 60);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    this.fitShadow();
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** A full-screen flash that fades over `ms`. */
  flash(ms: number, r: number, g: number, b: number): void {
    const el = this.flashEl;
    el.style.transition = "none";
    el.style.background = `rgb(${r},${g},${b})`;
    el.style.opacity = "1";
    void el.offsetWidth;
    el.style.transition = `opacity ${ms}ms ease-out`;
    el.style.opacity = "0";
  }

  destroy(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.screen.destroy();
    this.flashEl.remove();
  }
}
