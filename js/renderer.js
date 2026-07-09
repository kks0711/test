"use strict";
/* WebGL 렌더러: 청크 버퍼 관리, 낮/밤 하늘, 안개, 블럭 하이라이트 */

/* ===== 4x4 행렬 유틸 (column-major) ===== */
function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) * nf; out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

function mat4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz); zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1; xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

function mat4Multiply(out, a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let ro = 0; ro < 4; ro++) {
      r[c * 4 + ro] = a[ro] * b[c * 4] + a[4 + ro] * b[c * 4 + 1] + a[8 + ro] * b[c * 4 + 2] + a[12 + ro] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

const VERT_SRC = `
attribute vec3 aPos;
attribute vec2 aUV;
attribute float aShade;
attribute float aEmit;
uniform mat4 uMVP;
uniform vec3 uCamPos;
varying vec2 vUV;
varying float vShade;
varying float vEmit;
varying float vDist;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vUV = aUV;
  vShade = aShade;
  vEmit = aEmit;
  vDist = distance(aPos, uCamPos);
}`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTex;
uniform float uSun;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
varying vec2 vUV;
varying float vShade;
varying float vEmit;
varying float vDist;
void main() {
  vec4 c = texture2D(uTex, vUV);
  if (c.a < 0.08) discard;
  float light = vShade * max(uSun, vEmit);
  vec3 col = c.rgb * light;
  float fog = clamp((vDist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  gl_FragColor = vec4(mix(col, uFogColor, fog), c.a);
}`;

const LINE_VERT = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const LINE_FRAG = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

class Renderer {
  constructor(canvas, atlasCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL을 사용할 수 없어요");
    this.gl = gl;

    this.prog = this.makeProgram(VERT_SRC, FRAG_SRC);
    this.lineProg = this.makeProgram(LINE_VERT, LINE_FRAG);

    this.loc = {
      aPos: gl.getAttribLocation(this.prog, "aPos"),
      aUV: gl.getAttribLocation(this.prog, "aUV"),
      aShade: gl.getAttribLocation(this.prog, "aShade"),
      aEmit: gl.getAttribLocation(this.prog, "aEmit"),
      uMVP: gl.getUniformLocation(this.prog, "uMVP"),
      uCamPos: gl.getUniformLocation(this.prog, "uCamPos"),
      uTex: gl.getUniformLocation(this.prog, "uTex"),
      uSun: gl.getUniformLocation(this.prog, "uSun"),
      uFogColor: gl.getUniformLocation(this.prog, "uFogColor"),
      uFogStart: gl.getUniformLocation(this.prog, "uFogStart"),
      uFogEnd: gl.getUniformLocation(this.prog, "uFogEnd"),
    };
    this.lineLoc = {
      aPos: gl.getAttribLocation(this.lineProg, "aPos"),
      uMVP: gl.getUniformLocation(this.lineProg, "uMVP"),
      uColor: gl.getUniformLocation(this.lineProg, "uColor"),
    };

    // 텍스처 아틀라스
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.lineBuf = gl.createBuffer();
    this.chunks = new Map(); // "cx,cz" -> {opqBuf, opqCount, traBuf, traCount}
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.mvp = new Float32Array(16);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  makeProgram(vsrc, fsrc) {
    const gl = this.gl;
    function shader(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vsrc));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  setChunk(key, geo) {
    const gl = this.gl;
    let c = this.chunks.get(key);
    if (!c) { c = { opqBuf: gl.createBuffer(), traBuf: gl.createBuffer(), opqCount: 0, traCount: 0 }; this.chunks.set(key, c); }
    gl.bindBuffer(gl.ARRAY_BUFFER, c.opqBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geo.opq, gl.STATIC_DRAW);
    c.opqCount = geo.opq.length / 7;
    gl.bindBuffer(gl.ARRAY_BUFFER, c.traBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geo.tra, gl.STATIC_DRAW);
    c.traCount = geo.tra.length / 7;
  }

  dropChunk(key) {
    const c = this.chunks.get(key);
    if (!c) return;
    this.gl.deleteBuffer(c.opqBuf);
    this.gl.deleteBuffer(c.traBuf);
    this.chunks.delete(key);
  }

  bindAttribs(loc) {
    const gl = this.gl;
    const stride = 7 * 4;
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(loc.aUV);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(loc.aShade);
    gl.vertexAttribPointer(loc.aShade, 1, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(loc.aEmit);
    gl.vertexAttribPointer(loc.aEmit, 1, gl.FLOAT, false, stride, 24);
  }

  /* eye=[x,y,z], yaw/pitch, keys: 렌더 파라미터 */
  draw(eye, yaw, pitch, opts) {
    const gl = this.gl;
    this.resize();
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    mat4Perspective(this.proj, 70 * Math.PI / 180, aspect, 0.1, 400);

    const fx = Math.cos(pitch) * Math.sin(yaw);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(pitch) * Math.cos(yaw);
    mat4LookAt(this.view, eye, [eye[0] + fx, eye[1] + fy, eye[2] + fz], [0, 1, 0]);
    mat4Multiply(this.mvp, this.proj, this.view);

    const sky = opts.skyColor;
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMVP, false, this.mvp);
    gl.uniform3fv(this.loc.uCamPos, eye);
    gl.uniform1f(this.loc.uSun, opts.sun);
    gl.uniform3fv(this.loc.uFogColor, sky);
    gl.uniform1f(this.loc.uFogStart, opts.fogStart);
    gl.uniform1f(this.loc.uFogEnd, opts.fogEnd);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc.uTex, 0);

    // 불투명 패스
    const visible = opts.visibleChunks; // [{key, dist}]
    for (const v of visible) {
      const c = this.chunks.get(v.key);
      if (!c || c.opqCount === 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, c.opqBuf);
      this.bindAttribs(this.loc);
      gl.drawArrays(gl.TRIANGLES, 0, c.opqCount);
    }

    // 반투명 패스 (멀리 → 가까이)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const sorted = visible.slice().sort((a, b) => b.dist - a.dist);
    for (const v of sorted) {
      const c = this.chunks.get(v.key);
      if (!c || c.traCount === 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, c.traBuf);
      this.bindAttribs(this.loc);
      gl.drawArrays(gl.TRIANGLES, 0, c.traCount);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // 조준한 블럭 하이라이트 (와이어 큐브)
    if (opts.highlight) {
      const { x, y, z } = opts.highlight;
      const e = 0.004;
      const a = [x - e, y - e, z - e], b = [x + 1 + e, y + 1 + e, z + 1 + e];
      const L = [];
      const P = (i, j, k) => [i ? b[0] : a[0], j ? b[1] : a[1], k ? b[2] : a[2]];
      const edges = [
        [P(0,0,0),P(1,0,0)],[P(1,0,0),P(1,0,1)],[P(1,0,1),P(0,0,1)],[P(0,0,1),P(0,0,0)],
        [P(0,1,0),P(1,1,0)],[P(1,1,0),P(1,1,1)],[P(1,1,1),P(0,1,1)],[P(0,1,1),P(0,1,0)],
        [P(0,0,0),P(0,1,0)],[P(1,0,0),P(1,1,0)],[P(1,0,1),P(1,1,1)],[P(0,0,1),P(0,1,1)],
      ];
      for (const [p, q] of edges) L.push(...p, ...q);
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lineLoc.uMVP, false, this.mvp);
      gl.uniform4f(this.lineLoc.uColor, 0.05, 0.05, 0.05, 0.85);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(L), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.lineLoc.aPos);
      gl.vertexAttribPointer(this.lineLoc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.lineWidth(2);
      gl.drawArrays(gl.LINES, 0, L.length / 3);
    }
  }
}
