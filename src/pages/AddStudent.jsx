import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Camera, User, ClipboardList, CheckCircle, Loader2, ArrowRight, ArrowLeft } from 'lucide-react';
import Webcam from 'react-webcam';
import * as faceapi from 'face-api.js';
import { useNavigate } from 'react-router-dom';

const MODEL_URL = 'https://vladmandic.github.io/face-api/model/';

// ========== HIGH-DENSITY LIVENESS DOT RENDERER ==========
function drawDotFace(ctx, landmarks, imgW, imgH, faceBox, phase) {
  ctx.clearRect(0, 0, imgW, imgH);
  
  // Draw a very light digital tint instead of a pitch black screen so real face is visible
  ctx.fillStyle = 'rgba(0, 15, 30, 0.2)';
  ctx.fillRect(0, 0, imgW, imgH);

  const pts = landmarks.positions;
  const fx = faceBox.x, fy = faceBox.y;
  const fw = faceBox.width, fh = faceBox.height;

  const expand = 0.2;
  const x0 = Math.max(0, fx - fw * expand);
  const y0 = Math.max(0, fy - fh * expand);
  const x1 = Math.min(imgW, fx + fw * (1 + expand));
  const y1 = Math.min(imgH, fy + fh * (1 + expand));

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
  const dotSpacing = 6; // Optimizing dot density to prevent UI freezing
  const cols = Math.floor((x1 - x0) / dotSpacing);
  const rows = Math.floor((y1 - y0) / dotSpacing);

  const maxDist = Math.max(fw, fh) * 0.4;
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = x0 + c * dotSpacing + (r % 2 === 0 ? 0 : dotSpacing * 0.5);
      const py = y0 + r * dotSpacing;
      if (!pointInPoly(px, py, faceOutline)) continue;

      // Dramatically optimized nearest distance (check only key facial regions instead of 68 points)
      let minLandmarkDist = Infinity;
      // Eyes, Nose tip, Mouth edges (just 6 points for depth calculation to save CPU)
      const keyPoints = [pts[30], pts[39], pts[42], pts[48], pts[54], pts[8]];
      for (const p of keyPoints) {
        const d = Math.abs(p.x - px) + Math.abs(p.y - py); // Manhattan distance for extreme speed
        if (d < minLandmarkDist) minLandmarkDist = d;
      }
      
      const depthFactor = Math.max(0.1, 1 - minLandmarkDist / maxDist);

      // Fast Manhattan distance to nose
      const dToNose = Math.abs(px - noseTip.x) + Math.abs(py - noseTip.y);
      const noseFactor = Math.max(0, 1 - dToNose / (fw * 0.3));

      const wave = Math.sin((r + c) * 0.25 + phase * 2.5) * 0.12 + 0.88;
      const dotSize = (0.8 + depthFactor * 2.0 + noseFactor * 1.5) * wave; 
      const alpha = (0.4 + depthFactor * 0.5) * wave;

      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = `hsl(190, 80%, ${50 + noseFactor * 25 + depthFactor * 10}%)`;
      ctx.beginPath();
      ctx.arc(px, py, dotSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#22d3ee';
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

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#67e8f9';
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill(); });

  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  faceOutline.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.stroke();

  ctx.globalAlpha = 1;
}

export default function AddStudent() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const [faceDescriptors, setFaceDescriptors] = useState([]);
  const [error, setError] = useState('');
  
  const navigate = useNavigate();
  const webcamRef = useRef(null);
  const canvasRef = useRef(null);
  const isProcessingRef = useRef(false);
  const phaseRef = useRef(0);
  const lastCaptureTimeRef = useRef(Date.now());
  const scanLoopRef = useRef(null);
  const blinkedRef = useRef(false);

  // EAR calculation for liveness
  const getEAR = (eye) => {
    const norm = (p1, p2) => Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    const v1 = norm(eye[1], eye[5]);
    const v2 = norm(eye[2], eye[4]);
    const hz = norm(eye[0], eye[3]);
    return (v1 + v2) / (2.0 * hz);
  };

  // Form Data
  const [formData, setFormData] = useState({
    name: '',
    college_name: '',
    hostel_name: '',
    age: '',
    phone: '',
    email: '',
    parent_phone: ''
  });

  useEffect(() => {
    if (step === 2 && !modelsLoaded) {
      loadModels();
    }
  }, [step]);

  const loadModels = async () => {
    try {
      setLoading(true);
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      setModelsLoaded(true);
    } catch (err) {
      setError('Failed to load face recognition models. Please check your connection.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const nextStep = (e) => {
    e.preventDefault();
    setStep(2);
  };

  const executeTick = async () => {
    if (!webcamRef.current || step !== 2 || captureCount >= 3) {
      isProcessingRef.current = false;
      return;
    }

    try {
      const imageSrc = webcamRef.current.getScreenshot();
      if (!imageSrc) {
        return;
      }

      const img = new Image();
      img.src = imageSrc;
      await new Promise(resolve => { img.onload = resolve; });

      const now = Date.now();
      // Only do the heavy descriptor extraction periodically to prevent freezing
      const needsCapture = (now - lastCaptureTimeRef.current > 1500) && (captureCount < 3);

      // We lower minConfidence to 0.25 (default 0.5) to ensure it scans even if the background is messy
      const scanOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 });

      let detection;
      if (needsCapture) {
        // Heavy path - computes descriptor array
        detection = await faceapi.detectSingleFace(img, scanOptions).withFaceLandmarks().withFaceDescriptor();
      } else {
        // Fast path - only computes UI dots
        detection = await faceapi.detectSingleFace(img, scanOptions).withFaceLandmarks();
      }
      
      if (!detection) {
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d');
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.fillStyle = '#0a0a0a';
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = '#22d3ee';
          ctx.font = `${Math.floor(canvasRef.current.width * 0.04)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('Align face in frame', canvasRef.current.width / 2, canvasRef.current.height / 2);
          ctx.globalAlpha = 1;
        }
        return;
      }

      const imgW = img.width, imgH = img.height;
      if (canvasRef.current) {
        canvasRef.current.width = imgW;
        canvasRef.current.height = imgH;
        const ctx = canvasRef.current.getContext('2d');
        phaseRef.current += 0.04;
        
        drawDotFace(ctx, detection.landmarks, imgW, imgH, detection.detection.box, phaseRef.current);

        // -- LIVENESS CHECK (Anti-Spoofing)--
        const leftEye = detection.landmarks.getLeftEye();
        const rightEye = detection.landmarks.getRightEye();
        const ear = (getEAR(leftEye) + getEAR(rightEye)) / 2;
        
        // Debugging the Eye Aspect Ratio. Lower value means eyes are closed.
        // Relaxing the threshold from 0.22 to 0.28 makes it much easier to detect blinks.
        if (ear < 0.28) {
          blinkedRef.current = true;
        }

        if (!blinkedRef.current) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(0, 0, imgW, imgH);
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#facc15';
          ctx.font = `bold ${Math.floor(imgW * 0.05)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('LIVENESS CHECK: PLEASE BLINK', imgW / 2, imgH / 2);
        }
      }

      if (needsCapture && detection.descriptor && blinkedRef.current) {
        setFaceDescriptors(prev => [...prev, Array.from(detection.descriptor)]);
        setCaptureCount(prev => prev + 1);
        lastCaptureTimeRef.current = now;
      }
    } catch (err) {
      console.error(err);
    }
  };

  const autoEyeScanLive = useCallback(async () => {
    if (isProcessingRef.current || captureCount >= 3) return;
    
    isProcessingRef.current = true;
    await executeTick();
    isProcessingRef.current = false;
    
    // Self-calling loop with delay to free up UI thread
    if (step === 2 && captureCount < 3) {
      scanLoopRef.current = setTimeout(autoEyeScanLive, 100);
    }
  }, [step, captureCount]);

  useEffect(() => {
    if (step === 2 && modelsLoaded && captureCount < 3) {
      clearTimeout(scanLoopRef.current);
      scanLoopRef.current = setTimeout(autoEyeScanLive, 100);
    } else if (captureCount >= 3 && canvasRef.current) {
      clearTimeout(scanLoopRef.current);
      const ctx = canvasRef.current.getContext('2d');
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#4ade80';
      ctx.font = `${Math.floor(canvasRef.current.width * 0.06)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Registration Complete', canvasRef.current.width / 2, canvasRef.current.height / 2);
      ctx.globalAlpha = 1;
    }
    return () => clearTimeout(scanLoopRef.current);
  }, [step, modelsLoaded, captureCount, autoEyeScanLive]);

  const submitStudent = async () => {
    if (captureCount < 3) {
      setError("Please capture your face from at least 3 different angles.");
      return;
    }

    try {
      setLoading(true);
      setError('');

      // Save to database, WITHOUT storing physical images
      const { error: dbError } = await supabase
        .from('students')
        .insert([
          {
            ...formData,
            age: parseInt(formData.age),
            face_data: faceDescriptors // Array of numeric descriptors
          }
        ]);

      if (dbError) throw dbError;

      // Reset and redirect
      navigate('/dashboard');

    } catch (err) {
      setError(err.message);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Add New Student</h1>
        <p className="text-gray-500 mt-1">Register a new student mapping (Numeric Data Only)</p>
      </div>

      {/* Progress Steps */}
      <div className="mb-8 flex items-center justify-between relative">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-gray-200 rounded-full z-0"></div>
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1/2 h-1 bg-black rounded-full z-0 transition-all" style={{ width: step === 2 ? '100%' : '50%' }}></div>
        
        <div className={`relative z-10 hidden sm:flex flex-col items-center justify-center w-10 h-10 ${step >= 1 ? 'bg-black text-white' : 'bg-gray-200 text-gray-500'} rounded-full transition-colors`}>
          <ClipboardList className="w-5 h-5" />
        </div>
        
        <div className={`relative z-10 flex flex-col items-center justify-center w-10 h-10 ${step >= 2 ? 'bg-black text-white' : 'bg-white border-2 border-gray-200 text-gray-400'} rounded-full transition-colors`}>
          <Camera className="w-5 h-5" />
        </div>
      </div>

      {error && (
        <div className="mb-6 bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm border border-red-100">
          {error}
        </div>
      )}

      {step === 1 && (
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100">
          <h2 className="text-lg font-medium text-gray-900 mb-6">Step 1: Basic Details</h2>
          <form onSubmit={nextStep} className="space-y-5">
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input required type="text" name="name" value={formData.name} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="Jane Doe" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Age</label>
                <input required type="number" name="age" value={formData.age} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="20" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">College Name</label>
                <input required type="text" name="college_name" value={formData.college_name} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="State University" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Hostel Name</label>
                <input required type="text" name="hostel_name" value={formData.hostel_name} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="Block A" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input required type="email" name="email" value={formData.email} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="jane@example.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                <input required type="tel" name="phone" value={formData.phone} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="+1..." />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Parent's Phone Number</label>
                <input required type="tel" name="parent_phone" value={formData.parent_phone} onChange={handleInputChange} className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-black focus:border-black sm:text-sm" placeholder="+1..." />
              </div>
            </div>
            <div className="flex justify-end pt-4 border-t border-gray-100">
              <button type="submit" className="inline-flex items-center space-x-2 px-6 py-2.5 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors">
                <span>Continue to Registration</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </form>
        </div>
      )}

      {step === 2 && (
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-medium text-gray-900">Step 2: 3D Face Mapping</h2>
            <div className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm font-medium">
              Mapping: {captureCount} / 3+
            </div>
          </div>

          <div className="text-center mb-6 text-sm text-gray-600">
            Please align your face inside the scanner box. The system captures numeric biometric distances and does NOT record images.
          </div>

          {!modelsLoaded ? (
            <div className="flex flex-col items-center justify-center h-64 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
              <Loader2 className="w-8 h-8 text-black animate-spin mb-3" />
              <p className="text-gray-500 font-medium">Loading AI Models...</p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="relative overflow-hidden bg-black aspect-video flex items-center justify-center rounded-2xl border-4 border-gray-900 shadow-2xl">
                {/* Hidden physical camera feed ensuring no raw images are retained */}
                <Webcam
                  audio={false}
                  ref={webcamRef}
                  mirrored={true}
                  screenshotFormat="image/jpeg"
                  className="absolute inset-0 w-full h-full object-cover opacity-0 pointer-events-none"
                />

                {/* Visible Canvas plotting live biometric dots map */}
                <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />

                {/* Frame overlay */}
                {captureCount < 3 && (
                  <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                    <div className="w-[60%] h-[60%] border-2 border-cyan-500/30 relative rounded-lg">
                      <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-cyan-400"></div>
                      <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-cyan-400"></div>
                      <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-cyan-400"></div>
                      <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-cyan-400"></div>
                      <div className="w-full h-[2px] bg-cyan-400 shadow-[0_0_8px_2px_rgba(34,211,238,0.8)] absolute left-0" style={{ animation: 'scanLine 2s linear infinite' }}></div>
                    </div>
                  </div>
                )}
                
                <style>{`
                  @keyframes scanLine { 0% { top: 0%; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
                `}</style>
              </div>

              <div className="flex justify-center flex-wrap gap-4">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="flex flex-col items-center space-y-2">
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center border-2 transition-colors ${captureCount > idx ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                      {captureCount > idx ? <CheckCircle className="w-8 h-8 text-green-500" /> : <div className="w-4 h-4 rounded-full bg-gray-300" />}
                    </div>
                    <span className="text-xs font-medium text-gray-500">Scan {idx + 1}</span>
                  </div>
                ))}
              </div>

              <div className="flex justify-between pt-6 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="inline-flex items-center space-x-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>
                <button
                  type="button"
                  onClick={submitStudent}
                  disabled={captureCount < 3 || loading}
                  className="inline-flex items-center space-x-2 px-6 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:bg-gray-400"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{loading ? 'Saving...' : 'Complete Registration'}</span>
                  {!loading && <CheckCircle className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

