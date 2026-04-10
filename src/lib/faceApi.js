/**
 * Face Detection Backend API Client
 * ==================================
 * Connects the React frontend with the FastAPI Python backend.
 * The backend uses OpenCV Haar Cascade for server-side face detection.
 */

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

/**
 * Send an image to the Python backend for face detection.
 * @param {Blob|File} imageBlob - The image data to process
 * @returns {Promise<{success: boolean, face_count: number, faces: Array, processing_time_ms: number}>}
 */
export async function detectFacesBackend(imageBlob) {
  try {
    const formData = new FormData();
    formData.append('file', imageBlob, 'frame.jpg');

    const response = await fetch(`${BACKEND_URL}/detect`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Backend error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    // If backend is unreachable, return a graceful fallback
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      console.warn('⚠️ Backend not available, using browser-only detection');
      return { success: false, face_count: 0, faces: [], error: 'Backend offline' };
    }
    throw error;
  }
}

/**
 * Check if the Python backend is running and healthy.
 * @returns {Promise<boolean>}
 */
export async function checkBackendHealth() {
  try {
    const response = await fetch(`${BACKEND_URL}/health`, { 
      method: 'GET',
      signal: AbortSignal.timeout(3000),  // 3 second timeout
    });
    if (response.ok) {
      const data = await response.json();
      return data.status === 'healthy' && data.model_loaded === true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Convert a base64 data URL (from webcam screenshot) to a Blob.
 * @param {string} dataUrl - Base64 data URL (e.g. "data:image/jpeg;base64,...")
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const mime = parts[0].match(/:(.*?);/)[1];
  const raw = atob(parts[1]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return new Blob([arr], { type: mime });
}
