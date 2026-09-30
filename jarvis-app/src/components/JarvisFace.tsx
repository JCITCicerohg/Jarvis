import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { FaceState } from '../types';

const NOISE = `vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
 const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
 vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
 vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
 vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
 i=mod289(i);
 vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
 float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
 vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
 vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
 vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
 vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
 vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
 vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
 vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
 p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
 vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
 return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;
const VS = `uniform float uTime;uniform float uAmp;uniform float uFreq;
varying vec3 vN;varying float vD;
${NOISE}
void main(){
 vec3 n=normalize(normal);
 float d=snoise(n*uFreq+vec3(0.0,0.0,uTime*0.6))*uAmp+snoise(n*uFreq*2.6-vec3(uTime*0.8))*uAmp*0.35;
 vD=d;vN=normalize(normalMatrix*n);
 gl_Position=projectionMatrix*modelViewMatrix*vec4(position+n*d,1.0);
}`;
const FS = `uniform vec3 uC1;uniform vec3 uC2;uniform vec3 uC3;uniform float uGlow;
varying vec3 vN;varying float vD;
void main(){
 float f=pow(1.0-abs(dot(normalize(vN),vec3(0.0,0.0,1.0))),2.4);
 vec3 c=mix(uC3,uC2,smoothstep(-0.25,0.35,vD)*0.7);
 c+=uC1*f*(0.9+uGlow*0.6);
 gl_FragColor=vec4(c,0.92+f*0.08);
}`;
const FSW = `uniform vec3 uC1;uniform float uGlow;varying vec3 vN;varying float vD;
void main(){float f=pow(1.0-abs(dot(normalize(vN),vec3(0.0,0.0,1.0))),1.6);gl_FragColor=vec4(uC1,(0.05+f*0.22)*(0.7+uGlow*0.5));}`;

type Params = { amp: number; freq: number; speed: number; spin: number; bars: number; glow: number };
const TARGETS: Record<FaceState, Params> = {
  idle: { amp: 0.1, freq: 1.1, speed: 0.35, spin: 0.05, bars: 0.12, glow: 0.2 },
  listening: { amp: 0.2, freq: 1.6, speed: 0.7, spin: 0.12, bars: 0.8, glow: 0.7 },
  thinking: { amp: 0.16, freq: 2.4, speed: 1.5, spin: 0.6, bars: 0.3, glow: 0.5 },
  speaking: { amp: 0.12, freq: 1.4, speed: 0.8, spin: 0.15, bars: 1, glow: 0.9 },
};
const LABELS: Record<FaceState, string> = { idle: 'Standing by', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };

interface Props { state?: FaceState; hud?: boolean; label?: boolean }

export function JarvisFace({ state = 'idle', hud = true, label = true }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ state, hud });
  props.current = { state, hud };
  const ptr = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = wrapRef.current!, glCanvas = glRef.current!, hudCanvas = hudRef.current!;
    const cs = getComputedStyle(el);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    const css = { accent: v('--color-accent'), a300: v('--color-accent-300'), a500: v('--color-accent-500'), n600: v('--color-neutral-600'), n700: v('--color-neutral-700') };
    const col = (n: string) => new THREE.Color(v(n) || '#9184d9');

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true });
    } catch (e) {
      console.warn('JarvisFace', e);
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    cam.position.z = 6;
    const uni = {
      uTime: { value: 0 }, uAmp: { value: 0.1 }, uFreq: { value: 1.1 }, uGlow: { value: 0.2 },
      uC1: { value: col('--color-accent-300') }, uC2: { value: col('--color-accent-600') }, uC3: { value: col('--color-accent-900') },
    };
    const blobGeo = new THREE.IcosahedronGeometry(1, 64), wireGeo = new THREE.IcosahedronGeometry(1, 10);
    const blobMat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: VS, fragmentShader: FS, transparent: true });
    const wireMat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: VS, fragmentShader: FSW, wireframe: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const blob = new THREE.Mesh(blobGeo, blobMat), wire = new THREE.Mesh(wireGeo, wireMat);
    wire.scale.setScalar(1.12);
    const group = new THREE.Group();
    group.add(blob); group.add(wire); scene.add(group);

    let size = { w: 1, h: 1, dpr: 1, rb: 1 }, hudOn = props.current.hud;
    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      cam.aspect = w / h;
      hudOn = props.current.hud;
      const rb = Math.min(w, h) / 2 / (hudOn ? 2.0 : 1.45);
      const tan = Math.tan((cam.fov / 2) * Math.PI / 180);
      cam.position.z = h / (2 * rb * tan);
      cam.updateProjectionMatrix();
      const dpr = Math.min(devicePixelRatio, 2);
      hudCanvas.width = w * dpr; hudCanvas.height = h * dpr;
      size = { w, h, dpr, rb };
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const cur: Params = { ...TARGETS.idle };
    let t = 0, rot = 0, env = 0, raf = 0, last = performance.now();
    const ctx = hudCanvas.getContext('2d')!;

    const drawHud = (dt: number, now: number) => {
      const { w, h, dpr, rb } = size;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, c = cur;
      const halo = ctx.createRadialGradient(cx, cy, rb * 0.9, cx, cy, rb * 1.9);
      halo.addColorStop(0, css.accent); halo.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.08 + c.glow * 0.1; ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(cx, cy, rb * 1.9, 0, Math.PI * 2); ctx.fill();
      if (!props.current.hud) { ctx.globalAlpha = 1; return; }
      rot += dt * c.spin;
      ctx.lineCap = 'round';
      // radial level bars
      const N = 120, r0 = rb * 1.2;
      for (let i = 0; i < N; i++) {
        const a = i / N * Math.PI * 2 - Math.PI / 2;
        const n = 0.5 + 0.5 * Math.sin(i * 0.9 + now * 5) * Math.sin(i * 0.37 - now * 3.3);
        const len = rb * (0.02 + c.bars * n * (0.08 + env * 0.16));
        ctx.globalAlpha = 0.25 + c.bars * n * 0.6; ctx.strokeStyle = i % 2 ? css.a500 : css.a300; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); ctx.stroke();
      }
      // accent arcs
      const r1 = rb * 1.55;
      ctx.lineWidth = 2; ctx.strokeStyle = css.accent;
      ([[0, 0.9], [1.3, 0.35], [2.2, 1.6], [4.3, 0.5]] as const).forEach(([s, l], i) => {
        ctx.globalAlpha = i % 2 ? 0.45 : 0.9;
        const o = -rot * (i % 2 ? 1.6 : 1);
        ctx.beginPath(); ctx.arc(cx, cy, r1, s + o, s + l + o); ctx.stroke();
      });
      ctx.globalAlpha = 0.35; ctx.lineWidth = 1; ctx.strokeStyle = css.n700;
      ctx.beginPath(); ctx.arc(cx, cy, r1 - 6, 0, Math.PI * 2); ctx.stroke();
      // tick ring
      const r2 = rb * 1.72, T = 144, scan = (now * 0.6) % (Math.PI * 2);
      for (let i = 0; i < T; i++) {
        const a = i / T * Math.PI * 2 + rot * 0.3;
        const big = i % 12 === 0, len = big ? rb * 0.07 : rb * 0.03;
        const dA = Math.abs(((a - scan) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
        const hot = Math.max(0, 1 - dA / 0.6);
        ctx.globalAlpha = 0.35 + hot * 0.6; ctx.strokeStyle = hot > 0.05 ? css.a300 : css.n600; ctx.lineWidth = big ? 1.6 : 1;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); ctx.lineTo(cx + Math.cos(a) * (r2 + len), cy + Math.sin(a) * (r2 + len)); ctx.stroke();
      }
      // outer ring, fading
      const r3 = rb * 1.9;
      for (let i = 0; i < 2; i++) {
        ctx.globalAlpha = 0.5; ctx.strokeStyle = css.n700; ctx.lineWidth = 1;
        const s = i * Math.PI + now * 0.03;
        ctx.beginPath(); ctx.arc(cx, cy, r3, s, s + Math.PI * 0.7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const frame = (dt: number, now: number) => {
      const st = props.current.state;
      if (props.current.hud !== hudOn) resize();
      const T = TARGETS[st] || TARGETS.idle, k = 1 - Math.pow(0.02, dt);
      for (const key in T) cur[key as keyof Params] += (T[key as keyof Params] - cur[key as keyof Params]) * k;
      t += dt * cur.speed;
      let target = 0;
      if (st === 'speaking') target = Math.abs(Math.sin(now * 8.5) * Math.sin(now * 2.7 + 1)) * 0.9 + 0.1;
      else if (st === 'listening') target = 0.4 + 0.6 * Math.abs(Math.sin(now * 3.1) * Math.cos(now * 1.7));
      env += (target - env) * Math.min(1, dt * 14);
      uni.uTime.value = t; uni.uFreq.value = cur.freq; uni.uGlow.value = cur.glow;
      uni.uAmp.value = cur.amp + (st === 'speaking' ? env * 0.18 : st === 'listening' ? env * 0.06 : 0);
      group.rotation.y += dt * (0.08 + cur.spin * 0.3);
      group.rotation.x += ((ptr.current.y * 0.35) - group.rotation.x) * Math.min(1, dt * 3);
      wire.rotation.z += dt * 0.05;
      group.scale.setScalar(1 + Math.sin(now * 0.9) * 0.015);
      renderer.render(scene, cam);
      drawHud(dt, now);
    };

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      frame(dt, now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      blobGeo.dispose(); wireGeo.dispose(); blobMat.dispose(); wireMat.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      onPointerMove={e => {
        const r = e.currentTarget.getBoundingClientRect();
        ptr.current = { x: (e.clientX - r.left) / r.width * 2 - 1, y: (e.clientY - r.top) / r.height * 2 - 1 };
      }}
      onPointerLeave={() => { ptr.current = { x: 0, y: 0 }; }}
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 160, overflow: 'hidden' }}
    >
      <canvas ref={glRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      <canvas ref={hudRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }} />
      {label && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: '5%', display: 'flex', justifyContent: 'center', fontSize: 11, letterSpacing: '.24em', textTransform: 'uppercase', color: 'var(--color-accent-300)' }}>
          {LABELS[state] || LABELS.idle}
        </div>
      )}
    </div>
  );
}
