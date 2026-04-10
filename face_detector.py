import cv2
import numpy as np

def main():
    # Initialize webcam (Use CAP_DSHOW on Windows for better compatibility)
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    
    # Load the pre-trained OpenCV face detection classifier
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    
    # Read the first frame for motion detection (background subtraction)
    ret1, frame1 = cap.read()
    ret2, frame2 = cap.read()
    
    if not ret1 or not ret2 or frame1 is None or frame2 is None:
        print("\n[ERROR] Could not read from the webcam!")
        print("Note: On Windows, only one app can use the webcam at a time.")
        print("Please close your browser tab running the React scanner, or any other camera app, and try again.\n")
        cap.release()
        return
    
    print("Python Face & Movement Detection Started. Press 'q' to quit.")
    
    while cap.isOpened():
        # --- 1. MOVEMENT DETECTION ---
        # Calculate the absolute difference between the first and second frames
        diff = cv2.absdiff(frame1, frame2)
        gray_diff = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
        
        # Blur the difference to remove noise
        blur = cv2.GaussianBlur(gray_diff, (5, 5), 0)
        _, thresh = cv2.threshold(blur, 20, 255, cv2.THRESH_BINARY)
        dilated = cv2.dilate(thresh, None, iterations=3)
        
        # Find contours (outlines) of the moving objects
        contours, _ = cv2.findContours(dilated, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        
        movement_detected = False
        for contour in contours:
            # If movement is too small, ignore it
            if cv2.contourArea(contour) < 2000:
                continue
            movement_detected = True
            
        # --- 2. FACE DETECTION ---
        gray_frame = cv2.cvtColor(frame1, cv2.COLOR_BGR2GRAY)
        # Detect faces in the current frame
        faces = face_cascade.detectMultiScale(gray_frame, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
        
        # Draw rectangles around detected faces
        for (x, y, w, h) in faces:
            cv2.rectangle(frame1, (x, y), (x+w, y+h), (0, 255, 0), 2)
            cv2.putText(frame1, 'Face Detected', (x, y-10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

        # Status Overlay Display
        status_text = "Status: "
        if len(faces) > 0:
            status_text += "Face Present "
            color = (0, 255, 0)
        elif movement_detected:
            status_text += "Movement Detected "
            color = (0, 165, 255)
        else:
            status_text += "Idle"
            color = (0, 0, 255)

        # Print the status inside the camera window
        cv2.putText(frame1, status_text, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)

        # Display the live window
        cv2.imshow("Proxy - AI Face & Motion Detection", frame1)
        
        # Prepare frames for the next loop
        frame1 = frame2
        ret, frame2 = cap.read()
        
        if not ret or frame2 is None:
            print("Webcam feed was interrupted.")
            break
        
        # Break loop if 'q' is pressed
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    # Clean up
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
