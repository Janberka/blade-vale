import puppeteer from 'puppeteer-core';
import fs from 'fs'; import { execFileSync } from 'child_process';
// Usage: download the packs listed in assets/sfx/CREDITS.md, unzip them into one folder, cd there, run: node <repo>/tools/sfx-build.mjs
// Writes out/*.m4a (macOS afconvert encodes AAC; headless Chrome decodes and trims). Copy out/*.m4a to assets/sfx/.
const S = process.cwd(), OUT = S + '/out'; fs.mkdirSync(OUT + '/wav', { recursive: true });
const G = 'gregor_quendel_-_free_crowd_cheering_sounds_-_mp3/Gregor Quendel - Free Crowd Cheering Sounds - MP3/Gregor Quendel - Crowd Cheering Sounds - ';
const jobs = [];
for (let i = 1; i <= 10; i++) jobs.push({ src: `sword_-_starninjas_1/sword - StarNinjas/sword.${i}.ogg`, out: `swing${i}`, peak: 0.85 });
for (let i = 1; i <= 10; i++) jobs.push({ src: `sword_clash_-_starninjas_0/sword_clash.${i}.ogg`, out: `clash${i}`, peak: 0.89 });
for (let i = 0; i < 5; i++) jobs.push({ src: `impact/Audio/impactPunch_heavy_00${i}.ogg`, out: `flesh${i + 1}`, peak: 0.89 });
for (let i = 0; i < 5; i++) jobs.push({ src: `impact/Audio/impactPlate_medium_00${i}.ogg`, out: `plate${i + 1}`, peak: 0.89 });
for (let i = 0; i < 5; i++) jobs.push({ src: `impact/Audio/impactSoft_heavy_00${i}.ogg`, out: `body${i + 1}`, peak: 0.89 });
for (let i = 1; i <= 5; i++) jobs.push({ src: `100-CC0-wood-metal-SFX/metal_hit_0${i}.ogg`, out: `ring${i}`, peak: 0.89 });
for (let i = 0; i < 10; i++) jobs.push({ src: `rpg/Audio/footstep0${i}.ogg`, out: `step${i + 1}`, peak: 0.8 });
jobs.push({ src: 'rpg/Audio/knifeSlice.ogg', out: 'slice1', peak: 0.85 }, { src: 'rpg/Audio/knifeSlice2.ogg', out: 'slice2', peak: 0.85 });
jobs.push({ src: 'shoot.ogg', out: 'bow1', peak: 0.89 });
jobs.push({ src: G + '10 - Ambience.mp3', out: 'crowd_loop', loop: { from: 4, len: 20, xf: 2.5, pad: 0.5 }, rms: 0.12, sr: 32000 });
jobs.push({ src: G + '07 - Soft cheering and chatter.mp3', out: 'murmur_loop', loop: { from: 6, len: 20, xf: 2.5, pad: 0.5 }, rms: 0.12, sr: 32000 });
jobs.push({ src: G + '04 - Strong cheering - II - Short.mp3', out: 'cheer_big', seg: { from: 1.4, len: 7, fade: 3 }, rms: 0.16, sr: 32000 });
jobs.push({ src: G + '06 - Soft cheering - II.mp3', out: 'cheer_small', seg: { from: 1.2, len: 5, fade: 2.2 }, rms: 0.14, sr: 32000 });
jobs.push({ src: G + '03 - Strong cheering - I.mp3', out: 'cheer_win', seg: { from: 1.8, len: 13, fade: 4 }, rms: 0.16, sr: 32000 });

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
for (const j of jobs) {
  const b64 = fs.readFileSync(j.src).toString('base64');
  const res = await p.evaluate(async (b64, j) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const sr = j.sr || 44100;
    const buf = await new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes.buffer);   // resampled to sr
    const n = buf.length, m = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) m[i] += d[i] / buf.numberOfChannels; }
    let o;
    if (j.loop) {   // seamless loop of length L with pad seconds of wrapped signal either side (loopStart = pad)
      const { from, len, xf, pad } = j.loop, F = Math.round(from * sr), L = Math.round(len * sr), X = Math.round(xf * sr), P = Math.round(pad * sr);
      const core = new Float32Array(L);
      for (let i = 0; i < L; i++) core[i] = m[F + X + i];
      for (let i = 0; i < X; i++) { const t = i / X; core[L - X + i] = m[F + X + L - X + i] * Math.cos(t * Math.PI / 2) + m[F + i] * Math.sin(t * Math.PI / 2); }   // tail fades into what precedes the head
      o = new Float32Array(L + 2 * P);
      for (let i = 0; i < o.length; i++) o[i] = core[((i - P) % L + L) % L];
    } else if (j.seg) {
      const F = Math.round(j.seg.from * sr), L = Math.round(j.seg.len * sr), FD = Math.round(j.seg.fade * sr);
      o = m.slice(F, F + L);
      for (let i = 0; i < Math.min(2205, L); i++) o[i] *= i / 2205;
      for (let i = 0; i < FD; i++) o[L - FD + i] *= Math.pow(1 - i / FD, 2);
    } else {
      let pk = 0; for (const v of m) pk = Math.max(pk, Math.abs(v));
      let on = 0; while (on < n && Math.abs(m[on]) < pk * 0.06) on++;
      on = Math.max(0, on - Math.round(0.004 * sr));
      let off = n - 1; while (off > on && Math.abs(m[off]) < pk * 0.008) off--;
      off = Math.min(n, off + Math.round(0.03 * sr));
      o = m.slice(on, off); const FD = Math.min(Math.round(0.04 * sr), o.length >> 2);
      for (let i = 0; i < FD; i++) o[o.length - FD + i] *= 1 - i / FD;
    }
    let pk = 0, ss = 0; for (const v of o) { pk = Math.max(pk, Math.abs(v)); ss += v * v; }
    let g = j.rms ? j.rms / Math.sqrt(ss / o.length) : j.peak / pk;
    if (pk * g > 0.95) g = 0.95 / pk;
    const pcm = new Int16Array(o.length); for (let i = 0; i < o.length; i++) pcm[i] = Math.max(-32767, Math.min(32767, Math.round(o[i] * g * 32767)));
    let s = ''; const u8 = new Uint8Array(pcm.buffer); for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return { pcm: btoa(s), sr, dur: o.length / sr };
  }, b64, j);
  const pcm = Buffer.from(res.pcm, 'base64'), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(res.sr, 24); h.writeUInt32LE(res.sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  const wav = `${OUT}/wav/${j.out}.wav`; fs.writeFileSync(wav, Buffer.concat([h, pcm]));
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', j.rms ? '64000' : '96000', wav, `${OUT}/${j.out}.m4a`]);
  console.log(j.out, res.dur.toFixed(2) + 's', fs.statSync(`${OUT}/${j.out}.m4a`).size);
}
await b.close();
