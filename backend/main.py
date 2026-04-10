"""
Proxy — Face Detection Backend API
====================================
Production-ready FastAPI backend for the Proxy face detection system.
Uses OpenCV Haar Cascade for face detection and connects with the React frontend.

Run with:
    uvicorn main:app --reload --port 8000
"""

import io
import logging
import time
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s │ %(levelname)-7s │ %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("proxy-backend")

# ── Constants ──
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/bmp",
}

# ══════════════════════════════════════════
#  APP INIT
# ══════════════════════════════════════════
app = FastAPI(
    title="Proxy Face Detection API",
    description="Backend API for the Proxy hostel attendance face detection system.",
    version="1.0.0",
)

# ── CORS — allow React frontend (dev + deployed) ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server
        "http://localhost:3000",   # Alternate dev port
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "*",                       # For deployed domains (restrict in production)
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ══════════════════════════════════════════
#  LOAD FACE DETECTION MODEL (ONCE at startup)
# ══════════════════════════════════════════
face_cascade = None


@app.on_event("startup")
async def load_model():
    """Load the Haar Cascade classifier once at server startup for performance."""
    global face_cascade
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    face_cascade = cv2.CascadeClassifier(cascade_path)

    if face_cascade.empty():
        logger.error("❌ Failed to load Haar Cascade classifier from %s", cascade_path)
        raise RuntimeError("Haar Cascade model failed to load.")

    logger.info("✅ Haar Cascade face detector loaded successfully")
    logger.info("🚀 Proxy Face Detection API is ready")


# ══════════════════════════════════════════
#  RESPONSE MODELS
# ══════════════════════════════════════════
class FaceLocation(BaseModel):
    x: int
    y: int
    w: int
    h: int
    confidence: float = 0.0


class DetectionResponse(BaseModel):
    success: bool
    face_count: int
    faces: List[FaceLocation]
    processing_time_ms: float = 0.0


class ErrorResponse(BaseModel):
    success: bool = False
    error: str
    detail: str = ""


# ══════════════════════════════════════════
#  HELPER FUNCTIONS
# ══════════════════════════════════════════
def validate_image_file(content_type: str, file_size: int) -> None:
    """Validate uploaded file type and size."""
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type: {content_type}. Allowed: {', '.join(ALLOWED_CONTENT_TYPES)}",
        )
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large: {file_size / 1024 / 1024:.1f}MB. Maximum: {MAX_FILE_SIZE / 1024 / 1024:.0f}MB",
        )


def decode_image(file_bytes: bytes) -> np.ndarray:
    """Decode raw bytes into an OpenCV image (BGR numpy array)."""
    np_arr = np.frombuffer(file_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Could not decode image. The file may be corrupt or not a valid image.",
        )
    return img


def detect_faces(img: np.ndarray) -> List[FaceLocation]:
    """
    Run face detection on a BGR image using the pre-loaded Haar Cascade.
    Returns a list of FaceLocation objects.
    """
    # Convert to grayscale (required by Haar Cascade)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Histogram equalization for better detection in varying lighting
    gray = cv2.equalizeHist(gray)

    # Detect faces with optimized parameters
    # scaleFactor: How much the image size is reduced at each scale (1.1 = 10% reduction)
    # minNeighbors: Higher = fewer false positives but may miss some faces
    # minSize: Minimum face size to detect (filters out tiny noise detections)
    raw_faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=5,
        minSize=(60, 60),
        flags=cv2.CASCADE_SCALE_IMAGE,
    )

    faces = []
    if len(raw_faces) > 0:
        # Sort by face area (largest first — primary face first)
        sorted_faces = sorted(raw_faces, key=lambda f: f[2] * f[3], reverse=True)

        for x, y, w, h in sorted_faces:
            # Compute a simple confidence score based on face size relative to image
            img_area = img.shape[0] * img.shape[1]
            face_area = w * h
            confidence = min(1.0, round(face_area / img_area * 10, 3))

            faces.append(
                FaceLocation(
                    x=int(x),
                    y=int(y),
                    w=int(w),
                    h=int(h),
                    confidence=confidence,
                )
            )

    return faces


# ══════════════════════════════════════════
#  API ENDPOINTS
# ══════════════════════════════════════════
@app.post(
    "/detect",
    response_model=DetectionResponse,
    summary="Detect faces in an uploaded image",
    responses={
        200: {"description": "Face detection results"},
        400: {"description": "No file uploaded"},
        413: {"description": "File too large"},
        415: {"description": "Unsupported file type"},
        422: {"description": "Invalid image"},
        500: {"description": "Internal server error"},
    },
)
async def detect_endpoint(file: UploadFile = File(...)):
    """
    Accept an image via multipart/form-data and return detected face locations.

    - **file**: Image file (JPEG, PNG, WebP, BMP). Max 10MB.
    """
    start_time = time.perf_counter()

    try:
        # 1. Validate file exists
        if not file or not file.filename:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No file uploaded. Please send an image with key 'file'.",
            )

        # 2. Read file bytes
        file_bytes = await file.read()
        file_size = len(file_bytes)

        if file_size == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is empty.",
            )

        # 3. Validate type + size
        content_type = file.content_type or "application/octet-stream"
        validate_image_file(content_type, file_size)

        logger.info(
            "📸 Processing: %s (%.1f KB, %s)",
            file.filename,
            file_size / 1024,
            content_type,
        )

        # 4. Decode image
        img = decode_image(file_bytes)
        h, w = img.shape[:2]
        logger.info("   Image dimensions: %dx%d", w, h)

        # 5. Detect faces
        faces = detect_faces(img)

        elapsed_ms = (time.perf_counter() - start_time) * 1000
        logger.info(
            "   ✅ Detected %d face(s) in %.1f ms", len(faces), elapsed_ms
        )

        return DetectionResponse(
            success=True,
            face_count=len(faces),
            faces=faces,
            processing_time_ms=round(elapsed_ms, 2),
        )

    except HTTPException:
        raise  # Re-raise known HTTP errors

    except Exception as e:
        logger.exception("❌ Unexpected error during face detection")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal server error: {str(e)}",
        )


# ══════════════════════════════════════════
#  BIOMETRIC SECURE EXTRACTION ENDPOINTS
# ══════════════════════════════════════════

class BiometricResponse(BaseModel):
    success: bool
    face_found: bool
    vector: List[float] = []
    error: str = ""

@app.post("/extract_biometrics", response_model=BiometricResponse, summary="Extract mathematical 128D FaceNet Vector")
async def extract_biometrics(file: UploadFile = File(...)):
    """
    EXTRACT FEATURES (IMPORTANT)
    Instead of saving images, extract a robust mathematical embedding using DeepFace FaceNet.
    This fulfills the exact security requirements for React + Python Backends.
    """
    try:
        file_bytes = await file.read()
        # Decode image using cv2
        np_arr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        
        if img is None:
            return BiometricResponse(success=False, face_found=False, error="Invalid image file")

        from deepface import DeepFace
        
        # Step 3: Extract Features (FaceNet)
        # We set enforce_detection to True so it properly ensures a face exists
        objs = DeepFace.represent(img, model_name="Facenet", enforce_detection=True)
        
        if len(objs) > 0:
            # Successfully mathematically mapped the face
            # Convert list to pure float standard list
            secure_vector = [float(v) for v in objs[0]["embedding"]]
            return BiometricResponse(success=True, face_found=True, vector=secure_vector)
        else:
            return BiometricResponse(success=True, face_found=False, error="No Face Detected")
            
    except ValueError as ve:
        # DeepFace raises ValueError if no face is perfectly detected
        return BiometricResponse(success=True, face_found=False, error="No Face Detected")
    except Exception as e:
        logger.exception("Error extracting deepface")
        return BiometricResponse(success=False, face_found=False, error=str(e))

@app.get("/health", summary="Health check endpoint")
async def health_check():
    """Simple health check to verify the API is running."""
    return {
        "status": "healthy",
        "model_loaded": face_cascade is not None and not face_cascade.empty(),
        "service": "proxy-face-detection",
    }


@app.get("/", summary="API information")
async def root():
    """Root endpoint showing API info."""
    return {
        "name": "Proxy Face Detection API",
        "version": "1.0.0",
        "endpoints": {
            "POST /detect": "Detect faces in an uploaded image",
            "POST /extract_biometrics": "Extract secure FaceNet vectors without storing images",
            "GET /health": "Health check",
        },
    }
