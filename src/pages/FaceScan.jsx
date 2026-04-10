import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { detectFacesBackend, checkBackendHealth, dataUrlToBlob } from '../lib/faceApi';
import { CheckCircle, XCircle, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';

const MODEL_URL = 'https://vladmandic.github.io/face-api/model/';
const CAMERA_KEY = 'proxy_camera_enabled';

// ========== QUICK SCREEN CHECK (runs BEFORE face detection) ==========
// Detects a phone screen in the frame WITHOUT needing a face bounding box.
// Checks if there's a bright rectangular region in the center of the frame
// surrounded by significantly darker areas (phone body, hands, background).
function quickScreenCheck(imageElement) {
  const W = imageElement.width, H = imageElement.height;
  if (W < 50 || H < 50) return false;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imageElement, 0, 0);
  const { data } = ctx.getImageData(0, 0, W, H);

  const lum = (x, y) => {
    const cx = Math.max(0, Math.min(W - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(H - 1, Math.round(y)));
    const i = (cy * W + cx) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };

  // CENTER region (inner 50% of frame — where phone screen would be)
  const cx1 = W * 0.25, cx2 = W * 0.75;
  const cy1 = H * 0.15, cy2 = H * 0.85;

  let centerSum = 0, centerN = 0;
  let borderSum = 0, borderN = 0;

  for (let y = 0; y < H; y += 8) {
    for (let x = 0; x < W; x += 8) {
      const l = lum(x, y);
      if (x >= cx1 && x <= cx2 && y >= cy1 && y <= cy2) {
        centerSum += l; centerN++;
      } else {
        borderSum += l; borderN++;
      }
    }
  }

  const centerBright = centerN > 0 ? centerSum / centerN : 128;
  const borderBright = borderN > 0 ? borderSum / borderN : 128;
  const ratio = borderBright / Math.max(1, centerBright);

  // Also check 4 corners specifically (usually very dark when phone held up)
  const cs = 40;
  let cornerSum = 0, cornerN = 0;
  // Top-left
  for (let y = 0; y < cs; y += 5) for (let x = 0; x < cs; x += 5) { cornerSum += lum(x, y); cornerN++; }
  // Top-right
  for (let y = 0; y < cs; y += 5) for (let x = W - cs; x < W; x += 5) { cornerSum += lum(x, y); cornerN++; }
  // Bottom-left
  for (let y = H - cs; y < H; y += 5) for (let x = 0; x < cs; x += 5) { cornerSum += lum(x, y); cornerN++; }
  // Bottom-right
  for (let y = H - cs; y < H; y += 5) for (let x = W - cs; x < W; x += 5) { cornerSum += lum(x, y); cornerN++; }
  const cornerBright = cornerN > 0 ? cornerSum / cornerN : 128;
  const cornerRatio = cornerBright / Math.max(1, centerBright);

  // Sharp vertical edges: scan horizontal line through center
  // Look for bright → very dark transitions (screen edge)
  let leftEdge = false, rightEdge = false;
  const midY = Math.floor(H / 2);
  for (let x = Math.floor(W * 0.15); x < W * 0.45; x += 2) {
    if (lum(x + 3, midY) - lum(x, midY) > 25) { leftEdge = true; break; }
  }
  for (let x = Math.floor(W * 0.55); x < W * 0.85; x += 2) {
    if (lum(x, midY) - lum(x + 3, midY) > 25) { rightEdge = true; break; }
  }

  const hasScreenEdges = leftEdge && rightEdge;
  const isScreen = ratio < 0.55 || cornerRatio < 0.40 || (ratio < 0.65 && hasScreenEdges);

  console.log('⚡ Quick Screen Check:', {
    centerBright: centerBright.toFixed(0),
    borderBright: borderBright.toFixed(0),
    ratio: ratio.toFixed(3),
    cornerBright: cornerBright.toFixed(0),
    cornerRatio: cornerRatio.toFixed(3),
    hasScreenEdges,
    isScreen
  });

  return isScreen;
}

// ========== PHONE FRAME DETECTION (v5 — Direct Edge Scan) ==========
// Detects the physical phone border (dark bezel around bright screen).
// Relies solely on extremely sharp, instantaneous brightness drops radiating
// from the face, which are physiologically impossible on a rounded human head
// but standard for backlit rectangular digital screens with bezels.
function detectPhoneFrame(imageElement, faceBox) {
  const W = imageElement.width, H = imageElement.height;
  if (!faceBox || W < 50 || H < 50) return { isSpoof: false };

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imageElement, 0, 0);
  const { data } = ctx.getImageData(0, 0, W, H);

  const lum = (x, y) => {
    const cx = Math.max(0, Math.min(W - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(H - 1, Math.round(y)));
    const i = (cy * W + cx) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };

  const { x: fx, y: fy, width: fw, height: fh } = faceBox;
  const fcx = fx + fw / 2, fcy = fy + fh / 2;

  // === CHECK: SHARP EDGE DETECTION ===
  let sharpEdges = 0;
  const totalRays = 16;

  for (let a = 0; a < totalRays; a++) {
    const angle = (a / totalRays) * 2 * Math.PI;
    const dx = Math.cos(angle), dy = Math.sin(angle);

    // Start very tight to the face (0.55). If the phone is held far, the bezel is
    // close to the face box.
    const startDist = Math.max(fw, fh) * 0.55;
    const maxDist = Math.max(W, H);

    let prevLum = lum(fcx + dx * startDist, fcy + dy * startDist);

    // 2-pixel step searches for instantaneous, digital hardware edges
    for (let d = startDist + 2; d < maxDist; d += 2) {
      const px = fcx + dx * d, py = fcy + dy * d;
      if (px < 0 || px >= W || py < 0 || py >= H) break;

      const curLum = lum(px, py);
      // Hard hardware line creates massive instantaneous drop (Bright screen -> Dark bezel)
      // A drop of 35 luminance in just 2 pixels is characteristic of a digital bezel.
      if (prevLum - curLum > 35) {
        sharpEdges++;
        break;
      }
      prevLum = curLum;
    }
  }

  console.log('📱 Phone Detection v5:', {
    sharpEdges: `${sharpEdges}/${totalRays}`,
  });

  // If a massive portion of the radial rays hit an instantaneous brightness drop,
  // it's a rectangular screen framing the face.
  if (sharpEdges >= 6) {
    return { isSpoof: true, reason: 'Device screen borders detected' };
  }

  return { isSpoof: false };
}

// ========== LIVENESS: Rigid Body Detection via Landmark Ratios ==========
// A photo on a phone is FLAT — when the phone moves, ALL landmarks move
// together as a rigid body, keeping their relative distances CONSTANT.
// A real face has micro-expressions (blinks, lip twitches, breathing)
// that change the ratios between landmarks.
//
// We track key facial ratios across multiple frames:
// - Eye aspect ratio (EAR) — changes with blinks
// - Mouth aspect ratio (MAR) — changes with breathing/talking
// - Nose-to-chin ratio — changes with head tilt
// - Inter-eye distance ratio — changes with head rotation
//
// If ALL ratios are perfectly stable = rigid body = phone/photo.

class LivenessChecker {
  constructor() {
    this.ratioHistory = [];
    this.maxFrames = 12; // Wait longer to get a true read of liveness vs noise
  }

  reset() {
    this.ratioHistory = [];
  }

  // Extract key facial ratios from 68-point landmarks
  _computeRatios(landmarks) {
    const p = landmarks.positions;

    // Eye Aspect Ratio (EAR) — left eye
    // EAR = (|p37-p41| + |p38-p40|) / (2 * |p36-p39|)
    const eyeH1 = Math.hypot(p[37].x - p[41].x, p[37].y - p[41].y);
    const eyeH2 = Math.hypot(p[38].x - p[40].x, p[38].y - p[40].y);
    const eyeW = Math.hypot(p[36].x - p[39].x, p[36].y - p[39].y);
    const earL = (eyeH1 + eyeH2) / (2 * Math.max(1, eyeW));

    // Eye Aspect Ratio — right eye
    const rEyeH1 = Math.hypot(p[43].x - p[47].x, p[43].y - p[47].y);
    const rEyeH2 = Math.hypot(p[44].x - p[46].x, p[44].y - p[46].y);
    const rEyeW = Math.hypot(p[42].x - p[45].x, p[42].y - p[45].y);
    const earR = (rEyeH1 + rEyeH2) / (2 * Math.max(1, rEyeW));

    // Mouth Aspect Ratio (MAR)
    // MAR = (|p51-p57| + |p52-p56| + |p53-p55|) / (3 * |p48-p54|)
    const mouthH1 = Math.hypot(p[51].x - p[57].x, p[51].y - p[57].y);
    const mouthH2 = Math.hypot(p[52].x - p[56].x, p[52].y - p[56].y);
    const mouthH3 = Math.hypot(p[53].x - p[55].x, p[53].y - p[55].y);
    const mouthW = Math.hypot(p[48].x - p[54].x, p[48].y - p[54].y);
    const mar = (mouthH1 + mouthH2 + mouthH3) / (3 * Math.max(1, mouthW));

    // Nose tip to chin ratio (normalized by face height)
    const noseChin = Math.hypot(p[30].x - p[8].x, p[30].y - p[8].y);
    const faceH = Math.hypot(p[27].x - p[8].x, p[27].y - p[8].y);
    const ncRatio = noseChin / Math.max(1, faceH);

    // Brow-to-eye ratio (how raised are eyebrows)
    const browEyeL = Math.hypot(p[19].x - p[37].x, p[19].y - p[37].y);
    const browEyeR = Math.hypot(p[24].x - p[44].x, p[24].y - p[44].y);
    const browRatio = (browEyeL + browEyeR) / (2 * Math.max(1, eyeW));

    return { earL, earR, mar, ncRatio, browRatio };
  }

  addFrame(landmarks) {
    const ratios = this._computeRatios(landmarks);
    if (this.ratioHistory.length >= this.maxFrames) {
      this.ratioHistory.shift();
    }
    this.ratioHistory.push(ratios);
  }

  check() {
    // Collect at least 6 frames to properly measure micro-expressions
    // This stops photos with hand-jitter from immediately bypassing the check
    if (this.ratioHistory.length < 6) return { ready: false, isLive: true };

    // Calculate standard deviation of each ratio across all frames
    const keys = ['earL', 'earR', 'mar', 'ncRatio', 'browRatio'];
    const stdDevs = {};

    for (const key of keys) {
      const values = this.ratioHistory.map(r => r[key]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      stdDevs[key] = Math.sqrt(variance);
    }

    // Total variation score — sum of all standard deviations
    const totalVariation = Object.values(stdDevs).reduce((a, b) => a + b, 0);

    // Real face: totalVariation typically > 0.020 (eye blinks / expressions)
    // Photo on phone: totalVariation is just noise, usually < 0.015
    const isStatic = totalVariation < 0.015;

    console.log('🧬 Liveness:', {
      frames: this.ratioHistory.length,
      stdDevs: Object.fromEntries(Object.entries(stdDevs).map(([k, v]) => [k, v.toFixed(5)])),
      totalVariation: totalVariation.toFixed(5),
      isStatic,
      verdict: isStatic ? '⚠️ RIGID BODY (photo/screen)' : '✅ LIVE (real face)'
    });

    return { ready: true, isLive: !isStatic, totalVariation };
  }
}


// ========== EMOJI SVG ==========
function HappyEmoji({ color = '#22c55e', size = 120 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="48" stroke={color} strokeWidth="3" fill={color + '15'} />
      <ellipse cx="35" cy="40" rx="6" ry="7" fill={color} />
      <ellipse cx="65" cy="40" rx="6" ry="7" fill={color} />
      <path d="M 28 58 Q 50 78 72 58" stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function SadEmoji({ color = '#ef4444', size = 120 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="48" stroke={color} strokeWidth="3" fill={color + '15'} />
      <ellipse cx="35" cy="40" rx="6" ry="7" fill={color} />
      <ellipse cx="65" cy="40" rx="6" ry="7" fill={color} />
      <path d="M 30 72 Q 50 56 70 72" stroke={color} strokeWidth="3.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function NeutralEmoji({ color = '#9ca3af', size = 120 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="48" stroke={color} strokeWidth="3" fill={color + '10'} />
      <ellipse cx="35" cy="40" rx="6" ry="7" fill={color} />
      <ellipse cx="65" cy="40" rx="6" ry="7" fill={color} />
      <line x1="32" y1="65" x2="68" y2="65" stroke={color} strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

function ScanEmoji({ color = '#facc15', size = 120 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      <circle cx="50" cy="50" r="48" stroke={color} strokeWidth="3" fill={color + '12'} />
      <ellipse cx="35" cy="40" rx="6" ry="7" fill={color} />
      <ellipse cx="65" cy="40" rx="6" ry="7" fill={color} />
      <ellipse cx="50" cy="66" rx="10" ry="6" stroke={color} strokeWidth="3" fill="none" />
    </svg>
  );
}


// ========== MAIN COMPONENT ==========
export default function FaceScan() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('Position your face in the frame');
  const [studentName, setStudentName] = useState('');
  const [faceMatcher, setFaceMatcher] = useState(null);
  const [progress, setProgress] = useState(0);
  const [spoofReason, setSpoofReason] = useState('');
  const [backendOnline, setBackendOnline] = useState(false);
  const [showVideo, setShowVideo] = useState(() => {
    const saved = localStorage.getItem(CAMERA_KEY);
    return saved === null ? true : saved === 'true';
  });

  const webcamRef = useRef(null);
  const isProcessingRef = useRef(false);
  const scanStateRef = useRef('IDLE');
  const scanStartRef = useRef(0);
  const spoofCooldownRef = useRef(0);
  const livenessRef = useRef(new LivenessChecker());
  const alarmRef = useRef(null);

  // Listen for admin toggle
  useEffect(() => {
    const ch = new BroadcastChannel('proxy_camera');
    ch.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === 'boolean') setShowVideo(e.data.enabled);
    };
    const onStorage = (e) => { if (e.key === CAMERA_KEY) setShowVideo(e.newValue === 'true'); };
    window.addEventListener('storage', onStorage);
    return () => { ch.close(); window.removeEventListener('storage', onStorage); };
  }, []);

  // Init — use ssdMobilenetv1 (reliable with landmarks + descriptors)
  // Also check if Python backend is available for server-side validation
  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true);

        // Check backend health in parallel with model loading
        const [, , , backendHealthy] = await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
          checkBackendHealth().catch(() => false),
        ]);
        setBackendOnline(backendHealthy);
        if (backendHealthy) {
          console.log('🟢 Python backend is online — server-side face detection enabled');
        } else {
          console.log('🟡 Python backend offline — using browser-only detection');
        }

        const { data: students, error } = await supabase.from('students').select('*');
        if (error) throw error;
        if (students && students.length > 0) {
          const valid = students.filter(s => s.face_data && Array.isArray(s.face_data) && s.face_data.length > 0);
          if (valid.length > 0) {
            const labeled = valid.map(s => {
              const desc = s.face_data.map(d => new Float32Array(d));
              return new faceapi.LabeledFaceDescriptors(JSON.stringify({ id: s.id, name: s.name }), desc);
            });
            setFaceMatcher(new faceapi.FaceMatcher(labeled, 0.6));
          }
        }
      } catch (err) {
        console.error('Init error:', err);
        setStatus('error');
        setMessage('Failed to initialize. Please refresh.');
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  const resetSystem = useCallback(() => {
    setStatus('idle');
    setMessage('Position your face in the frame');
    setStudentName('');
    setProgress(0);
    setSpoofReason('');
    scanStateRef.current = 'IDLE';
    scanStartRef.current = 0;
    isProcessingRef.current = false;
    livenessRef.current.reset();
    if (alarmRef.current) {
      alarmRef.current.pause();
      alarmRef.current.currentTime = 0;
    }
  }, []);

  const markAttendance = useCallback(async (studentId, name) => {
    const today = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const { data: existing } = await supabase
      .from('attendance').select('id').eq('student_id', studentId).eq('date', today);
    if (existing && existing.length > 0) {
      setStudentName(name);
      setStatus('success');
      setMessage('Attendance already marked for today.');
      setTimeout(resetSystem, 3000);
      return;
    }
    await supabase.from('attendance')
      .insert([{ student_id: studentId, date: today, time, status: 'Present' }]);
    setStudentName(name);
    setStatus('success');
    setMessage('Attendance Marked Successfully!');
    setTimeout(resetSystem, 3000);
  }, [resetSystem]);

  // Main scan loop — uses browser face-api.js + optional Python backend validation
  const autoScan = useCallback(async () => {
    if (!webcamRef.current || isProcessingRef.current) return;
    const src = webcamRef.current.getScreenshot();
    if (!src) return;
    isProcessingRef.current = true;

    if (spoofCooldownRef.current && Date.now() - spoofCooldownRef.current < 4000) {
      isProcessingRef.current = false;
      return;
    }

    try {
      const img = new Image();
      img.src = src;
      await new Promise(r => { img.onload = r; });

      // ===== PERFORM SINGLE AI INFERENCE =====
      // Detect all faces in one pass to prevent running the expensive model twice
      const allFaces = await faceapi.detectAllFaces(img).withFaceLandmarks().withFaceDescriptors();

      // ===== MULTI-FACE CHECK =====
      if (allFaces.length >= 2) {
        console.warn('🚨 MULTI-FACE:', allFaces.length, 'faces detected');
        spoofCooldownRef.current = Date.now();
        setSpoofReason(`Multiple faces detected (${allFaces.length}) — phone held up`);
        setStatus('spoof');
        setMessage('⚠️ Illegal Activity Detected');
        setProgress(0);
        scanStateRef.current = 'IDLE';
        try {
          const alarm = new Audio('/alarm.mp3');
          alarm.volume = 1.0;
          alarm.play();
          alarmRef.current = alarm;
        } catch (e) { console.error('Audio error:', e); }
        setTimeout(() => { spoofCooldownRef.current = 0; resetSystem(); }, 5000);
        isProcessingRef.current = false;
        return;
      }

      if (allFaces.length === 0) {
        if (scanStateRef.current !== 'IDLE') resetSystem();
        else isProcessingRef.current = false;
        return;
      }

      // We only have exactly 1 face at this point.
      const det = allFaces[0];

      if (!faceMatcher) throw new Error('No students registered.');

      // ===== PHONE FRAME CHECK v2 (fixed for busy backgrounds) =====
      const box = det.detection.box;
      const phoneCheck = detectPhoneFrame(img, { x: box.x, y: box.y, width: box.width, height: box.height });
      if (phoneCheck.isSpoof) {
        console.warn('🚨 PHONE FRAME:', phoneCheck.reason);
        spoofCooldownRef.current = Date.now();
        setSpoofReason(phoneCheck.reason);
        setStatus('spoof');
        setMessage('⚠️ Illegal Activity Detected');
        setProgress(0);
        scanStateRef.current = 'IDLE';
        try {
          const alarm = new Audio('/alarm.mp3');
          alarm.volume = 1.0;
          alarm.play();
          alarmRef.current = alarm;
        } catch (e) { console.error('Audio error:', e); }
        setTimeout(() => { spoofCooldownRef.current = 0; resetSystem(); }, 5000);
        isProcessingRef.current = false;
        return;
      }

      // ===== COLLECT LIVENESS DATA (every frame during scan) =====
      livenessRef.current.addFrame(det.landmarks);

      if (scanStateRef.current === 'IDLE') {
        scanStateRef.current = 'MAPPING';
        scanStartRef.current = Date.now();
        livenessRef.current.reset();
        livenessRef.current.addFrame(det.landmarks);
        setStatus('scanning');
        setMessage('Scanning face...');
        setProgress(0);
        isProcessingRef.current = false;
        return;
      }

      if (scanStateRef.current === 'MAPPING') {
        if (livenessRef.current.ratioHistory.length < 6) {
          setMessage('Analyzing biometrics...');
          isProcessingRef.current = false;
          return;
        }

        // ===== LIVENESS CHECK =====
        const liveness = livenessRef.current.check();
        if (liveness.ready && !liveness.isLive) {
          spoofCooldownRef.current = Date.now();
          setSpoofReason('Static face detected — photo or screen');
          setStatus('spoof');
          setMessage('⚠️ Illegal Activity Detected');
          setProgress(0);
          scanStateRef.current = 'IDLE';
          try {
            const alarm = new Audio('/alarm.mp3');
            alarm.volume = 1.0;
            alarm.play();
            alarmRef.current = alarm;
          } catch (e) { console.error('Audio error:', e); }
          setTimeout(() => { spoofCooldownRef.current = 0; resetSystem(); }, 5000);
          isProcessingRef.current = false;
          return;
        }

        // ===== BACKEND VALIDATION (if Python server is online) =====
        // Double-check face detection server-side for extra confidence
        if (backendOnline) {
          try {
            const blob = dataUrlToBlob(src);
            const backendResult = await detectFacesBackend(blob);
            if (backendResult.success && backendResult.face_count === 0) {
              // Backend found no faces — possible spoofing artifact
              console.warn('⚠️ Backend detected 0 faces — skipping');
              isProcessingRef.current = false;
              return;
            }
            console.log(`🖥️ Backend confirmed ${backendResult.face_count} face(s) in ${backendResult.processing_time_ms}ms`);
          } catch (e) {
            // Backend error — continue with browser-only detection
            console.warn('Backend validation failed, continuing with browser detection:', e.message);
          }
        }

        // ===== IDENTIFY =====
        scanStateRef.current = 'SUCCESS';
        setProgress(100);
        const match = faceMatcher.findBestMatch(det.descriptor);
        if (match.label === 'unknown' || match.distance > 0.6) throw new Error('Face Not Recognized');
        const st = JSON.parse(match.label);
        await markAttendance(st.id, st.name);
        return;
      }
    } catch (err) {
      console.error(err);
      setStatus('error');
      setMessage(err.message || 'Face Not Recognized');
      setProgress(0);
      setTimeout(resetSystem, 2500);
    } finally {
      isProcessingRef.current = false;
    }
  }, [faceMatcher, markAttendance, resetSystem, backendOnline]);

  useEffect(() => {
    if (loading || status === 'success') return;
    const interval = setInterval(autoScan, 200);
    return () => clearInterval(interval);
  }, [loading, autoScan, status]);

  const R = 54, C = 2 * Math.PI * R;
  const off = C - (progress / 100) * C;
  const isSpoof = status === 'spoof';

  const getPrivacyEmoji = () => {
    if (status === 'success') return <HappyEmoji color="#22c55e" size={100} />;
    if (status === 'error') return <SadEmoji color="#ef4444" size={100} />;
    if (isSpoof) return <SadEmoji color="#ef4444" size={100} />;
    if (status === 'scanning') return <ScanEmoji color="#facc15" size={100} />;
    return <NeutralEmoji color="#d1d5db" size={100} />;
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh]">
      <style>{`
        @keyframes scanLine { 0%{top:0%;opacity:0}10%{opacity:.7}90%{opacity:.7}100%{top:100%;opacity:0} }
        @keyframes ringGlow { 0%,100%{filter:drop-shadow(0 0 6px rgba(74,222,128,.3))}50%{filter:drop-shadow(0 0 14px rgba(74,222,128,.8))} }
        @keyframes spoofBorder { 0%,100%{border-color:#ef4444;box-shadow:0 0 0 4px rgba(239,68,68,.2)}50%{border-color:#f97316;box-shadow:0 0 0 10px rgba(239,68,68,.4)} }
        @keyframes emojiPop { 0%{transform:scale(0);opacity:0}50%{transform:scale(1.15)}100%{transform:scale(1);opacity:1} }
        @keyframes emojiBounce { 0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)} }
        @keyframes emojiPulse { 0%,100%{transform:scale(1)}50%{transform:scale(1.05)} }
      `}</style>

      <div className="w-full max-w-2xl text-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight mb-2">Proxy FaceScan</h1>
        <p className="text-gray-500 text-sm font-medium">Powered by Devsofft innovations</p>
      </div>

      <div className="bg-white p-6 md:p-8 rounded-3xl shadow-xl shadow-gray-200/50 border border-gray-100 w-full max-w-md mx-auto">
        {loading ? (
          <div className="fixed inset-0 z-50 bg-gray-50 flex flex-col items-center justify-center space-y-4">
            <Loader2 className="w-12 h-12 text-black animate-spin mb-4" />
            <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Loading Proxy Engine</h2>
            <p className="text-gray-500 font-medium animate-pulse">Initializing AI Models...</p>
            <p className="absolute bottom-10 text-gray-400 text-sm font-medium">Powered by Devsofft innovations</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="relative flex items-center justify-center">

              {/* Removed slow Progress Ring animation to make scanning feel instant */}

              <div className={`relative rounded-2xl overflow-hidden border-4 w-full transition-all duration-300 ${isSpoof ? 'border-red-500 bg-red-50' :
                  status === 'success' ? 'border-green-500 bg-green-50' :
                    status === 'error' ? 'border-red-400 bg-red-50' :
                      status === 'scanning' ? 'border-green-400 bg-gray-50' :
                        'border-gray-200 bg-gray-50'
                }`} style={isSpoof ? { animation: 'spoofBorder .5s ease-in-out infinite' } : {}}>

                {/* Webcam: always runs, visibility controlled by admin */}
                <Webcam audio={false} ref={webcamRef} mirrored={true}
                  screenshotFormat="image/jpeg"
                  className={`w-full h-auto object-contain ${showVideo ? '' : 'invisible absolute inset-0 h-0 overflow-hidden'}`}
                />

                {/* === WHEN VIDEO HIDDEN: emoji center === */}
                {!showVideo && (
                  <div className={`aspect-[4/3] flex flex-col items-center justify-center ${isSpoof ? 'bg-red-50' : status === 'success' ? 'bg-green-50' :
                      status === 'error' ? 'bg-red-50' : status === 'scanning' ? 'bg-white' : 'bg-gray-50'
                    }`}>
                    <div style={{
                      animation: status === 'success' ? 'emojiBounce 1.5s ease-in-out infinite' :
                        status === 'scanning' ? 'emojiPulse 1.5s ease-in-out infinite' :
                          status === 'error' || isSpoof ? 'emojiPop 0.4s ease-out' : 'none'
                    }}>
                      {getPrivacyEmoji()}
                    </div>
                    {status === 'success' && <p className="text-green-700 font-bold text-base mt-4">{studentName}</p>}
                    {isSpoof && <p className="text-red-600 font-extrabold text-sm mt-4 tracking-wide">ILLEGAL ACTIVITY</p>}
                  </div>
                )}

                {/* === WHEN VIDEO VISIBLE: overlays === */}
                {showVideo && (
                  <>
                    {/* IDLE */}
                    {status === 'idle' && (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/25 pointer-events-none">
                        <NeutralEmoji color="#d1d5db" size={80} />
                        <p className="text-white/80 text-xs mt-2 font-medium">Position your face</p>
                      </div>
                    )}

                    {/* Scan laser */}
                    {status === 'scanning' && (
                      <div className="absolute left-0 w-full h-[2px] bg-green-400/60 shadow-[0_0_8px_2px_rgba(74,222,128,.5)] z-20 pointer-events-none"
                        style={{ animation: 'scanLine 2s linear infinite' }} />
                    )}

                    {/* Scanning emoji corner */}
                    {status === 'scanning' && (
                      <div className="absolute bottom-3 right-3 z-20 opacity-80" style={{ animation: 'emojiPulse 1.5s ease-in-out infinite' }}>
                        <ScanEmoji color="#facc15" size={40} />
                      </div>
                    )}

                    {/* SUCCESS */}
                    {status === 'success' && (
                      <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm"
                        style={{ animation: 'emojiPop 0.4s ease-out' }}>
                        <div style={{ animation: 'emojiBounce 1.5s ease-in-out infinite' }}>
                          <HappyEmoji color="#22c55e" size={110} />
                        </div>
                        <p className="text-green-700 font-bold text-lg mt-4">{studentName}</p>
                        <p className="text-green-600 text-sm">{message}</p>
                      </div>
                    )}

                    {/* ERROR */}
                    {status === 'error' && (
                      <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/80 backdrop-blur-sm"
                        style={{ animation: 'emojiPop 0.4s ease-out' }}>
                        <SadEmoji color="#ef4444" size={110} />
                        <p className="text-red-600 font-bold text-sm mt-4">{message}</p>
                      </div>
                    )}

                    {/* SPOOF */}
                    {isSpoof && (
                      <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black">
                        <SadEmoji color="#ef4444" size={110} />
                        <p className="text-red-500 font-bold text-2xl tracking-widest mt-4">ILLEGAL ACTIVITY</p>
                        <p className="text-red-400 text-sm font-semibold mt-2">{spoofReason}</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Status Text */}
            <div className="flex flex-col items-center min-h-[50px]">
              {status === 'success' && showVideo && (
                <div className="flex items-center space-x-2 text-green-600 mb-1">
                  <CheckCircle className="w-5 h-5" />
                  <span className="font-semibold text-lg">{studentName}</span>
                </div>
              )}
              {(status !== 'success' || !showVideo) && !isSpoof && status !== 'error' && (
                <p className={`text-sm font-medium text-center ${status === 'success' ? 'text-green-600' :
                    status === 'scanning' ? 'text-green-600 font-bold animate-pulse' :
                      'text-gray-500'
                  }`}>{message}</p>
              )}
              {status === 'error' && !showVideo && (
                <p className="text-red-500 text-sm font-semibold text-center">{message}</p>
              )}
              {isSpoof && !showVideo && (
                <p className="text-red-600 text-sm font-bold text-center">{spoofReason}</p>
              )}
            </div>

            {/* Bottom Pill */}
            <div className="flex justify-center">
              <div className={`inline-flex items-center space-x-2 px-4 py-2 rounded-full text-sm font-medium border transition-all ${isSpoof ? 'bg-red-50 border-red-400 text-red-700 font-bold' :
                  status === 'scanning' ? 'bg-green-50 border-green-300 text-green-700' :
                    status === 'success' ? 'bg-green-50 border-green-300 text-green-700' :
                      'bg-gray-50 border-gray-200 text-gray-500'
                }`}>
                {isSpoof
                  ? <><AlertTriangle className="w-4 h-4 animate-bounce" /><span>Spoof Blocked</span></>
                  : <><ShieldCheck className={`w-4 h-4 ${status === 'scanning' ? 'animate-pulse' : ''}`} />
                    <span>{status === 'scanning' ? 'Scanning...' : 'System Ready'}</span></>
                }
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
