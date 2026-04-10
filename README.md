# Proxy - AI Biometric Attendance System

**Proxy** is a modern, high-security Face Recognition Attendance System designed specifically for hostels, universities, and corporate environments. Using cutting-edge Machine Learning running entirely in the browser, Proxy eliminates the need for manual ID cards, physical registers, or expensive biometric hardware.

## 🚀 Key Features

*   **Real-time AI Face Scanning:** Utilizes TensorFlow.js (`face-api.js`) to autonomously map facial landmarks and recognize registered students instantly via any standard webcam.
*   **Anti-Spoofing & Liveness Detection:** Built-in Eye Aspect Ratio (EAR) calculations detect human blinking, actively blocking attempts to manipulate the system using photographs or recorded videos playing on mobile screens.
*   **Dynamic Visual ML Tracker:** Features a futuristic UI overlaid on the camera feed with a green bounding box and animated sweeping laser that physically tracks faces around the screen in real-time.
*   **Automated Data Logging:** Matches biometric encodings against a secure cloud database and logs the student's daily attendance timestamp automatically, preventing duplicate entries.
*   **Comprehensive Admin Dashboard:** Real-time metrics showing total registrations and live daily attendance counts.
*   **Instant PDF Export:** Filter attendance by student name and export perfectly formatted PDF reports (via `jsPDF`) with a single click.
*   **Secure Multi-Angle Registration:** When onboarding new students, the system captures multiple spatial angles to generate highly accurate, 128-dimensional Float32 biometric descriptors.

## 💻 Technology Stack

*   **Frontend:** React.js, Vite, Tailwind CSS, Lucide React
*   **Machine Learning:** face-api.js (SSD MobileNet V1, 68-Point Face Landmark Net, Face Recognition Net)
*   **Backend & Database:** Supabase (PostgreSQL, Row Level Security, Supabase Auth)
*   **Hardware Interface:** React Webcam
*   **Export:** jsPDF & jsPDF-AutoTable

## 🔒 Security & Privacy First
Because Proxy executes its Machine Learning models via WebGL directly inside the user's browser, camera feeds are **never** transmitted or saved to external servers. Only mathematical encrypted arrays representing facial structures are communicated to the database, ensuring unparalleled user privacy.
