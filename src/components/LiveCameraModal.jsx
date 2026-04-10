import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ShieldCheck, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { supabase } from '../lib/supabase';

const MODEL_URL = 'https://vladmandic.github.io/face-api/model/';

// ========== DOT-ONLY FACE RENDERER (No real face visible) ==========
function drawDotFace(ctx, landmarks, imgW, imgH, faceBox, phase) {
  ctx.clearRect(0, 0, imgW, imgH);

  // Black out entire canvas — hides real face
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, imgW, imgH);

  const pts = landmarks.positions;
  const fx = faceBox.x, fy = faceBox.y;
  const fw = faceBox.width, fh = faceBox.height;

  // Expand face area
  const expand = 0.2;
  const x0 = Math.max(0, fx - fw * expand);
  const y0 = Math.max(0, fy - fh * expand);
  const x1 = Math.min(imgW, fx + fw * (1 + expand));
  const y1 = Math.min(imgH, fy + fh * (1 + expand));

  // Build face contour polygon (jaw + forehead)
  const jaw = pts.slice(0, 17);
  const browL = pts.slice(17, 22);
  const browR = pts.slice(22, 27);
  const faceOutline = [...jaw];
  faceOutline.push(
    { x: browR[4].x, y: browR[4].y - fh * 0.15 },
    { x: (browL[2].x + browR[2].x) / 2, y: Math.min(browL[2].y, browR[2].y) - fh * 0.22 },
    { x: browL[0].x, y: browL[0].y - fh * 0.15 }
  );

  const pointInPoly = (px, py, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  };

  const nearestDist = (px, py) => {
    let min = Infinity;
    for (const p of pts) {
      const d = Math.sqrt((p.x - px) ** 2 + (p.y - py) ** 2);
      if (d < min) min = d;
    }
    return min;
  };

  const noseTip = pts[30];
  const dotSpacing = 5;
  const cols = Math.floor((x1 - x0) / dotSpacing);
  const rows = Math.floor((y1 - y0) / dotSpacing);

  // Draw dense dots inside face contour
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = x0 + c * dotSpacing + (r % 2 === 0 ? 0 : dotSpacing * 0.5);
      const py = y0 + r * dotSpacing;
      if (!pointInPoly(px, py, faceOutline)) continue;

      const dToLandmark = nearestDist(px, py);
      const maxDist = Math.max(fw, fh) * 0.4;
      const depthFactor = Math.max(0.1, 1 - dToLandmark / maxDist);

      const dToNose = Math.sqrt((px - noseTip.x) ** 2 + (py - noseTip.y) ** 2);
      const noseFactor = Math.max(0, 1 - dToNose / (fw * 0.3));

      const wave = Math.sin((r + c) * 0.25 + phase * 2.5) * 0.12 + 0.88;
      const dotSize = (1.2 + depthFactor * 1.8 + noseFactor * 1.2) * wave;
      const alpha = (0.35 + depthFactor * 0.55) * wave;

      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = `hsl(142, 72%, ${50 + noseFactor * 25 + depthFactor * 10}%)`;
      ctx.beginPath();
      ctx.arc(px, py, dotSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Wireframe lines
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 1;
  const drawPath = (s, e, closed) => {
    ctx.beginPath();
    pts.slice(s, e).forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    if (closed) ctx.closePath();
    ctx.stroke();
  };
  drawPath(0, 17); drawPath(17, 22); drawPath(22, 27);
  drawPath(27, 31); drawPath(31, 36);
  drawPath(36, 42, true); drawPath(42, 48, true);
  drawPath(48, 60, true); drawPath(60, 68, true);

  // Bright landmark dots
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#86efac';
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); });

  // Face outline glow
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  faceOutline.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.stroke();

  ctx.globalAlpha = 1;
}


// ========== LIVE CAMERA MODAL COMPONENT ==========
export default function LiveCameraModal({ isOpen, onClose }) {
  const [loading,     setLoading]     = useState(true);
  const [status,      setStatus]      = useState('idle');
  const [message,     setMessage]     = useState('Waiting for face...');
  const [studentName, setStudentName] = useState('');
  const [faceMatcher, setFaceMatcher] = useState(null);

  const webcamRef       = useRef(null);
  const canvasRef       = useRef(null);
  const isProcessingRef = useRef(false);
  const phaseRef        = useRef(0);
  const scanStateRef    = useRef('IDLE');
  const scanStartRef    = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    const init = async () => {
      try {
        setLoading(true);
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);
        const { data: students } = await supabase.from('students').select('*');
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
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [isOpen]);

  const resetScan = useCallback(() => {
    setStatus('idle');
    setMessage('Waiting for face...');
    setStudentName('');
    scanStateRef.current = 'IDLE';
    scanStartRef.current = 0;
    isProcessingRef.current = false;
  }, []);

  const markAttendance = useCallback(async (studentId, name) => {
    const today = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const { data: existing } = await supabase
      .from('attendance').select('id').eq('student_id', studentId).eq('date', today);
    if (existing && existing.length > 0) {
      setStudentName(name);
      setStatus('success');
      setMessage('Already marked today');
      setTimeout(resetScan, 3000);
      return;
    }
    await supabase.from('attendance')
      .insert([{ student_id: studentId, date: today, time, status: 'Present' }]);
    setStudentName(name);
    setStatus('success');
    setMessage('Attendance Marked!');
    setTimeout(resetScan, 3000);
  }, [resetScan]);

  const autoScan = useCallback(async () => {
    if (!webcamRef.current || isProcessingRef.current || !isOpen) return;
    const imageSrc = webcamRef.current.getScreenshot();
    if (!imageSrc) return;
    isProcessingRef.current = true;

    try {
      const img = new Image();
      img.src = imageSrc;
      await new Promise(r => { img.onload = r; });

      const scanOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 });
      const detection = await faceapi.detectSingleFace(img, scanOptions).withFaceLandmarks().withFaceDescriptor();

      if (!detection) {
        if (scanStateRef.current !== 'IDLE') resetScan();
        else {
          if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            // Show "Waiting" text
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = '#4ade80';
            ctx.font = `${Math.floor(canvasRef.current.width * 0.04)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('Position face in frame', canvasRef.current.width / 2, canvasRef.current.height / 2);
            ctx.globalAlpha = 1;
          }
          isProcessingRef.current = false;
        }
        return;
      }

      const imgW = img.width, imgH = img.height;
      const box = detection.detection.box;

      // Ensure dots draw smoothly
      if (canvasRef.current) {
        canvasRef.current.width = imgW;
        canvasRef.current.height = imgH;
        const ctx = canvasRef.current.getContext('2d');
        phaseRef.current += 0.04;
        drawDotFace(ctx, detection.landmarks, imgW, imgH, box, phaseRef.current);
      }

      // --- LIVENESS / ANTI-SPOOFING (Blink Detection) ---
      const getEAR = (eye) => {
        const norm = (p1, p2) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
        const v1 = norm(eye[1], eye[5]);
        const v2 = norm(eye[2], eye[4]);
        const hz = norm(eye[0], eye[3]);
        return (v1 + v2) / (2.0 * hz);
      };

      const leftEye = detection.landmarks.getLeftEye();
      const rightEye = detection.landmarks.getRightEye();
      const ear = (getEAR(leftEye) + getEAR(rightEye)) / 2;

      // Automatically reset blink status if we lost the face
      if (scanStateRef.current === 'IDLE') {
         isProcessingRef.current = false;
         scanStateRef.current = 'WAITING_FOR_BLINK';
         return;
      }

      if (scanStateRef.current === 'WAITING_FOR_BLINK') {
         // Require physical blink to prove liveness (not a photo)
         if (ear < 0.28) {
             scanStateRef.current = 'MAPPING';  // Blink detected, proceed
             scanStartRef.current = Date.now();
         } else {
             setStatus('scanning');
             setMessage('ANTI-SPOOF: Please BLINK explicitly');
         }
         isProcessingRef.current = false;
         return;
      }

      if (!faceMatcher) { isProcessingRef.current = false; return; }

      if (scanStateRef.current === 'MAPPING') {
        setStatus('scanning');
        setMessage('Blink Verified. Extracting Vector...');
        const elapsed = Date.now() - scanStartRef.current;
        if (elapsed < 1000) {
          isProcessingRef.current = false;
          return;
        }
        scanStateRef.current = 'SUCCESS';

        const match = faceMatcher.findBestMatch(detection.descriptor);
        if (match.label === 'unknown' || match.distance > 0.5)
          throw new Error('Face Not Recognized');

        const student = JSON.parse(match.label);
        await markAttendance(student.id, student.name);
        return;
      }
    } catch (err) {
      console.error(err);
      setStatus('error');
      setMessage(err.message || 'Not Recognized');
      setTimeout(resetScan, 2500);
    } finally {
      isProcessingRef.current = false;
    }
  }, [faceMatcher, markAttendance, resetScan, isOpen]);

  useEffect(() => {
    if (!isOpen || loading || status === 'success') return;
    const interval = setInterval(autoScan, 120);
    return () => clearInterval(interval);
  }, [isOpen, loading, autoScan, status]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      <style>{`
        @keyframes dotPulse {
          0%, 100% { filter: drop-shadow(0 0 4px rgba(74,222,128,0.3)); }
          50%       { filter: drop-shadow(0 0 12px rgba(74,222,128,0.7)); }
        }
      `}</style>

      {/* Top Bar */}
      <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center space-x-3">
          <ShieldCheck className="w-5 h-5 text-green-400" />
          <span className="text-white/90 font-semibold text-sm tracking-wide">ADMIN LIVE CAMERA</span>
        </div>
        <button onClick={onClose}
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors">
          <X className="w-5 h-5 text-white" />
        </button>
      </div>

      {/* Full-screen camera area */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        {loading ? (
          <div className="flex flex-col items-center space-y-4">
            <Loader2 className="w-12 h-12 text-green-400 animate-spin" />
            <p className="text-white/60 text-sm">Loading AI models...</p>
          </div>
        ) : (
          <>
            {/* Hidden webcam (source for screenshots) */}
            <Webcam
              audio={false} ref={webcamRef} mirrored={true}
              screenshotFormat="image/jpeg"
              className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none"
            />

            {/* Dot-face canvas (the only thing visible — hides real face) */}
            <canvas ref={canvasRef}
              className="w-full h-full object-contain"
              style={{ animation: 'dotPulse 3s ease-in-out infinite' }}
            />
          </>
        )}
      </div>

      {/* Bottom Status Bar */}
      <div className="absolute bottom-0 left-0 right-0 z-50 px-6 py-5 bg-gradient-to-t from-black/80 to-transparent">
        <div className="flex items-center justify-center space-x-3">
          {status === 'success' ? (
            <div className="flex items-center space-x-3 bg-green-500/20 px-6 py-3 rounded-full border border-green-500/40">
              <CheckCircle className="w-6 h-6 text-green-400" />
              <div className="text-center">
                <p className="text-green-300 font-bold text-lg">{studentName}</p>
                <p className="text-green-400/70 text-xs">{message}</p>
              </div>
            </div>
          ) : status === 'error' ? (
            <div className="flex items-center space-x-3 bg-red-500/20 px-6 py-3 rounded-full border border-red-500/40">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <p className="text-red-300 font-medium text-sm">{message}</p>
            </div>
          ) : (
            <div className="flex items-center space-x-3 bg-white/5 px-6 py-3 rounded-full border border-white/10">
              <div className={`w-2.5 h-2.5 rounded-full ${status === 'scanning' ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
              <p className="text-white/60 text-sm font-medium">{message}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
